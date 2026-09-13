(() => {
  'use strict';

  const MIRRORS = [
    'https://backend.listenfree.in/api',
    'https://backend2.listenfree.in/api',
    'https://music-api.albatross0071.workers.dev/api',
    'https://music-api2.albatross0071.workers.dev/api'
  ];

  const YT_API = 'https://music.youtube.com/youtubei/v1';
  const YT_CACHE = new Map();
  const CACHE_MAX = 300;
  const YT_CONTEXT = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'US' } };

  // --- v1.9.2 latency budget -------------------------------------------------
  // Every network path is time-boxed. The old httpGet() had no timeout at all,
  // so one stalled mirror could park a play/search request for minutes.
  const YT_TIMEOUT_MS = 5000;
  const MIRROR_TIMEOUT_MS = 4000;
  const SEARCH_TTL_MS = 300000;
  const AUDIO_TTL_MS = 900000;
  const SEARCH_FIRST_PAINT_MS = 1100;
  const SEARCH_FIRST_PAINT_TRACKS = 40;
  const SEARCH_EXPAND_WAIT_MS = 2200;
  const HOME_SOFT_DEADLINE_MS = 1300;
  const HOME_HARD_DEADLINE_MS = 3500;
  const SEARCH_MAX_TRACKS = 150;
  const SEARCH_STATE_MAX = 40;

  function timeoutSignal(ms) {
    try { return AbortSignal.timeout(ms); } catch (_) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    }
  }

  // Poll a cheap predicate so callers can bail out early instead of always
  // waiting for the worst case.
  function waitFor(predicate, timeoutMs) {
    return new Promise(resolve => {
      if (predicate()) return resolve(true);
      const started = Date.now();
      const tick = () => {
        if (predicate()) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(tick, 20);
      };
      setTimeout(tick, 20);
    });
  }

  // Bounded concurrency + priority, applied at the fetch layer only: playback
  // (0) always beats catalogue/search/home work (1).
  const MAX_CONCURRENT_REQUESTS = 6;
  let activeRequests = 0;
  const requestQueue = [];
  function schedule(priority, run) {
    return new Promise((resolve, reject) => {
      const task = { priority: priority || 0, run, resolve, reject };
      let i = requestQueue.length;
      while (i > 0 && requestQueue[i - 1].priority > task.priority) i--;
      requestQueue.splice(i, 0, task);
      pumpRequests();
    });
  }
  function pumpRequests() {
    while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length) {
      const task = requestQueue.shift();
      activeRequests++;
      Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => { activeRequests--; pumpRequests(); });
    }
  }

  // In-flight dedupe: skipping tracks quickly used to fire identical requests
  // over and over, and every one of them raced to slow the next one down.
  const inflight = new Map();
  function dedupe(key, run) {
    const hit = inflight.get(key);
    if (hit) return hit;
    const promise = Promise.resolve().then(run).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  // LRU-capped cache: touch on read, evict oldest on insert
  const CACHE_MAX_BYTES = 10485760; // 10MB hard limit
  let cacheBytesUsed = 0;
  
  // Cheap structural estimate. The old version JSON.stringify()'d the whole
  // value on every cache write, which cost hundreds of KB of stringify work per
  // home/search cache set - measured as main-thread jank on track changes.
  function estimateCacheBytes(value) {
    if (value == null) return 64;
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number' || typeof value === 'boolean') return 16;
    if (Array.isArray(value)) {
      let total = 48;
      for (const item of value) total += estimateItemBytes(item);
      return total;
    }
    let total = 96;
    if (Array.isArray(value.tracks)) total += estimateCacheBytes(value.tracks);
    for (const field of ['url', 'title', 'artist', 'album', 'artwork', 'mimeType']) {
      if (typeof value[field] === 'string') total += value[field].length * 2;
    }
    return total;
  }

  function estimateItemBytes(item) {
    if (!item || typeof item !== 'object') return 16;
    return 110 + String(item.id || '').length + String(item.title || '').length
      + String(item.artist || '').length + String(item.image || item.artwork || '').length;
  }

  // Artist lookup index: play signals resolve in O(1) instead of scanning every
  // cached array on every single play.
  const trackArtists = new Map();
  function indexTrackArtists(value) {
    const list = Array.isArray(value) ? value : (Array.isArray(value && value.tracks) ? value.tracks : null);
    if (!list) return;
    if (trackArtists.size > 3000) trackArtists.clear();
    for (const item of list) {
      if (item && item.id && item.artist && item.artist !== 'Unknown Artist' && !trackArtists.has(item.id)) {
        trackArtists.set(item.id, item.artist);
      }
    }
  }
  
  function cacheSet(key, value) {
    // Remove old entry if exists
    const oldEntry = YT_CACHE.get(key);
    if (oldEntry && oldEntry.size) {
      cacheBytesUsed -= oldEntry.size;
    }
    
    YT_CACHE.delete(key);
    
    // Create new entry with size
    const size = estimateCacheBytes(value);
    const entry = { time: Date.now(), value, size };
    indexTrackArtists(value);
    
    YT_CACHE.set(key, entry);
    cacheBytesUsed += size;
    
    // Cleanup if over budget
    if (cacheBytesUsed > CACHE_MAX_BYTES || YT_CACHE.size > CACHE_MAX) {
      // Sort by size (largest first)
      const entries = Array.from(YT_CACHE.entries())
        .sort((a, b) => (b[1].size || 1000) - (a[1].size || 1000));
      
      // Remove largest entries until under 80% target
      const targetBytes = CACHE_MAX_BYTES * 0.8;
      for (const [k, v] of entries) {
        if (cacheBytesUsed <= targetBytes && YT_CACHE.size <= CACHE_MAX) break;
        
        cacheBytesUsed -= (v.size || 1000);
        YT_CACHE.delete(k);
      }
    }
  }
  const ytRemember = (key, value) => { cacheSet(key, value); return value; };
  const ytCached = (key, ttl) => {
    const item = YT_CACHE.get(key);
    if (!item) return null;
    if (Date.now() - item.time < ttl) { YT_CACHE.delete(key); YT_CACHE.set(key, item); return item.value; }
    return null;
  };
  const ytRefreshing = new Set();
  const dirtyKeys = new Set();
  const markStale = key => { dirtyKeys.add(key); };

  // One in-flight rebuild per key; the caller never waits for it.
  function refreshInBackground(key, refresh) {
    if (ytRefreshing.has(key)) return;
    ytRefreshing.add(key);
    Promise.resolve()
      .then(() => refresh())
      .then(value => { if (value) ytRemember(key, value); })
      .catch(() => {})
      .finally(() => { ytRefreshing.delete(key); dirtyKeys.delete(key); });
  }

  // Fresh -> cached value. Stale -> cached value now, rebuild in background.
  // Cold -> the shared rebuild promise, so concurrent callers never get null.
  function readThrough(key, ttl, refresh) {
    const cached = YT_CACHE.get(key);
    if (cached) {
      const fresh = (Date.now() - (cached.time || 0)) < ttl && !dirtyKeys.has(key);
      if (fresh) {
        YT_CACHE.delete(key);
        YT_CACHE.set(key, cached);
        return Promise.resolve(cached.value);
      }
      refreshInBackground(key, refresh);
      return Promise.resolve(cached.value);
    }
    return dedupe('rt:' + key, async () => {
      const value = await refresh();
      if (value) ytRemember(key, value);
      return value;
    });
  }
  const slimTrack = t => {
    if (!t) return t;
    const out = { id: t.id, type: t.type, title: t.title, artist: t.artist };
    if (t.album) out.album = t.album;
    if (t.image) out.image = t.image;
    if (t.durationSeconds) out.durationSeconds = t.durationSeconds;
    return out;
  };
  
  async function ytPost(path, body, priority) {
    const payload = JSON.stringify({ context: YT_CONTEXT, ...body });
    return dedupe('yt:' + path + ':' + payload, () => schedule(priority == null ? 1 : priority, async () => {
      const request = async () => {
        const res = await fetch(YT_API + path + '?alt=json', {
          method: 'POST',
          signal: timeoutSignal(YT_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
          body: payload
        });
        if (!res.ok) throw new Error('YT HTTP ' + res.status);
        return res.json();
      };
      try {
        return await request();
      } catch (error) {
        // Retry once for transient failures, but never after a timeout: the
        // old 8s + 8s retry chain is what made a bad network feel frozen.
        if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
        return await request();
      }
    }));
  }
  
  function ytText(value) { return Array.isArray(value) ? value.map(item => item.text || '').join('') : String(value || ''); }
  
  function ytVideoId(item) {
    return item?.videoId || item?.playlistItemData?.videoId || item?.doubleTapCommand?.watchEndpoint?.videoId || item?.navigationEndpoint?.watchEndpoint?.videoId || item?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  }
  
  function ytToTrack(item) {
    if (!item) return null;
    if (item.messageRenderer || item.musicResponsiveHeaderRenderer) return null;
    const isCard = !!item.musicCardShelfRenderer;
    let isTwoRow = false;
    if (item.musicTwoRowItemRenderer) { item = item.musicTwoRowItemRenderer; isTwoRow = true; }
    else if ((item.title?.runs || item.subtitle?.runs) && item.navigationEndpoint && !item.flexColumns && !item.videoId) isTwoRow = true;
    const card = isCard ? item.musicCardShelfRenderer : null;
    const source = card || item;
    let videoId = ytVideoId(source);
    if (!videoId && card) {
      videoId = card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId
        || card.buttons?.find(button => button.buttonRenderer?.navigationEndpoint?.watchEndpoint?.videoId)?.buttonRenderer?.navigationEndpoint?.watchEndpoint?.videoId;
    }
    const browseId = source.navigationEndpoint?.browseEndpoint?.browseId
      || source.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
      || card?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
    if (!videoId && !browseId) return null;
    const isCollection = !videoId && browseId;
    const columns = source.flexColumns || [];
    // Queue entries (playlistPanelVideoRenderer, used by radio and the /next
    // response) carry their title in title.runs and the artist in the byline,
    // not in flexColumns - without these fallbacks every radio row came back as
    // "Track / Unknown Artist", which also starved the taste engine.
    const runs = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      || (isCard ? card.title?.runs : (item.title?.runs || []));
    const sub = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      || (isCard ? card.subtitle?.runs : (item.subtitle?.runs || item.longBylineText?.runs || item.shortBylineText?.runs || []));
    const thumbs = source.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || card?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || (isTwoRow ? item.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails : undefined);
    const durationMatch = ytText(sub[sub.length - 1]?.text).match(/(\d+):(\d+)/)
      || ytText(item.lengthText?.runs || item.durationText?.runs).match(/(\d+):(\d+)/);
    const rawId = videoId || browseId;
    const kind = isCollection
      ? (browseId.startsWith('MPRE') ? 'album' : browseId.startsWith('MPUC') || browseId.startsWith('UC') ? 'artist' : 'playlist')
      : 'track';
    return {
      id: kind === 'track' ? 'synthetiq_music_gateway:yt:' + rawId : 'synthetiq_music_gateway:' + kind + ':' + rawId,
      href: kind === 'track' ? 'synthetiq_music_gateway:yt:' + rawId : 'synthetiq_music_gateway:' + kind + ':' + rawId,
      type: kind === 'track' ? 'track' : kind,
      title: ytText(runs[0]?.text) || 'Track',
      artist: ytText(sub[0]?.text) || 'Unknown Artist',
      album: sub.length > 2 ? ytText(sub[2]?.text) : undefined,
      image: Array.isArray(thumbs) ? thumbs[thumbs.length - 1]?.url?.replace(/=w\d+-h\d+.*$/, '=w544-h544') : undefined,
      durationSeconds: durationMatch ? Number(durationMatch[1]) * 60 + Number(durationMatch[2]) : Number(source.lengthSeconds) || undefined
    };
  }

  function extractSearchTracks(data) {
    const sections = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const tracks = [];
    for (const section of sections) {
      if (section.musicShelfRenderer?.contents) {
        for (const item of section.musicShelfRenderer.contents) {
          const track = ytToTrack(item.musicResponsiveListItemRenderer || item);
          if (track) tracks.push(track);
        }
      } else if (section.musicCardShelfRenderer) {
        const track = ytToTrack(section);
        if (track) tracks.push(track);
      } else if (section.itemSectionRenderer?.contents) {
        for (const item of section.itemSectionRenderer.contents) {
          const track = ytToTrack(item.musicResponsiveListItemRenderer || item);
          if (track) tracks.push(track);
        }
      }
    }
    const slr = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer;
    const shelfContinuation = sections.find(section => section.musicShelfRenderer?.continuations)?.musicShelfRenderer?.continuations?.[0]?.nextContinuationData?.continuation;
    return { tracks, continuation: slr?.continuations?.[0]?.nextContinuationData?.continuation || shelfContinuation };
  }

  // Continuation pages land in continuationContents.musicShelfContinuation,
  // a different shape from the initial search response.
  function extractContinuationTracks(data) {
    const shelf = data?.continuationContents?.musicShelfContinuation;
    const tracks = (shelf?.contents || []).map(item => ytToTrack(item.musicResponsiveListItemRenderer || item)).filter(Boolean);
    const continuation = shelf?.continuations?.[0]?.nextContinuationData?.continuation || null;
    return { tracks, continuation };
  }

  async function ytSearchPipelined(term, params, pageCount = 3) {
    const allTracks = [];
    const dedup = new Set();
    
    let page1Promise = ytPost('/search', { query: term, params });
    let page1Data = await page1Promise;
    const { tracks: tracks1, continuation: cont1 } = extractSearchTracks(page1Data);
    for (const t of tracks1) {
      if (!dedup.has(t.id)) {
        allTracks.push(t);
        dedup.add(t.id);
      }
    }
    
    if (pageCount <= 1 || !cont1) return allTracks;
    
    let page2Promise = ytPost('/search', { continuation: cont1 });
    let page2Data = await page2Promise;
    const { tracks: tracks2, continuation: cont2 } = extractContinuationTracks(page2Data);
    for (const t of tracks2) {
      if (!dedup.has(t.id)) {
        allTracks.push(t);
        dedup.add(t.id);
      }
    }
    
    if (pageCount <= 2 || !cont2) return allTracks;
    
    let page3Data = await ytPost('/search', { continuation: cont2 });
    const { tracks: tracks3 } = extractContinuationTracks(page3Data);
    for (const t of tracks3) {
      if (!dedup.has(t.id)) {
        allTracks.push(t);
        dedup.add(t.id);
      }
    }
    
    return allTracks;
  }

  // --- Search state machine (v1.9.2) ----------------------------------------
  // Three shards (songs filter, broad, music videos) fire in parallel and every
  // page they return is merged into ONE growing result set. The first paint
  // never waits for continuations, and page 2/3 requests read the same expanding
  // set instead of re-running page 1 - which is why the app used to see ~26
  // songs no matter how many pages it asked for.
  const SEARCH_PAGE_DEPTH = 3;
  const SEARCH_BROAD_DEPTH = 2;
  const searchStates = new Map();
  const searchComplete = new Set();

  function newSearchState() {
    return { key: null, tracks: [], seen: new Set(), done: false, cancelled: false, promise: null };
  }

  function pushSearchTracks(state, tracks) {
    let added = 0;
    for (const track of tracks || []) {
      if (!track || !track.id || state.seen.has(track.id)) continue;
      if (state.tracks.length >= SEARCH_MAX_TRACKS) break;
      state.seen.add(track.id);
      const slim = slimTrack(track);
      state.tracks.push(slim);
      indexTrackArtists([slim]);
      added++;
    }
    if (added && state.key) ytRemember(state.key, state.tracks);
    return added;
  }

  async function runSearchShard(state, term, params, maxPages) {
    let continuation = null;
    for (let page = 0; page < maxPages; page++) {
      if (state.cancelled) return;
      const data = page === 0
        ? await ytPost('/search', { query: term, params }, 1)
        : (continuation ? await ytPost('/search', { continuation }, 1) : null);
      if (!data) return;
      const parsed = page === 0 ? extractSearchTracks(data) : extractContinuationTracks(data);
      pushSearchTracks(state, parsed.tracks);
      continuation = parsed.continuation;
      if (!continuation) return;
    }
  }

  function searchKey(term, options) {
    return 'search:' + term + '|' + (buildSearchParams(options) || 'all');
  }

  function searchStateFor(key, term, options) {
    const existing = searchStates.get(key);
    if (existing) return existing;

    const cached = YT_CACHE.get(key);
    const state = newSearchState();
    state.key = key;
    if (cached && Array.isArray(cached.value)) pushSearchTracks(state, cached.value);

    const cacheFresh = !!cached && (Date.now() - (cached.time || 0)) < SEARCH_TTL_MS;
    if (cacheFresh && searchComplete.has(key)) {
      state.done = true;
      searchStates.set(key, state);
      return state;
    }

    if (searchStates.size >= SEARCH_STATE_MAX) {
      const oldestKey = searchStates.keys().next().value;
      const oldest = searchStates.get(oldestKey);
      if (oldest) oldest.cancelled = true;
      searchStates.delete(oldestKey);
    }
    searchStates.set(key, state);

    const params = buildSearchParams(options);
    const songsParams = params || SEARCH_FILTERS.type.songs;
    const shards = [runSearchShard(state, term, songsParams, SEARCH_PAGE_DEPTH)];
    // The extra shards only make sense for a plain track search, and they are
    // free on the wall clock because they run alongside the songs shard.
    if (!params || params === SEARCH_FILTERS.type.songs) {
      shards.push(runSearchShard(state, term, undefined, SEARCH_BROAD_DEPTH));
      shards.push(runSearchShard(state, term, SEARCH_FILTERS.type.videos, 1));
    }

    state.promise = Promise.allSettled(shards).then(() => {
      state.done = true;
      if (searchComplete.size >= 200) searchComplete.delete(searchComplete.values().next().value);
      searchComplete.add(key);
      if (state.tracks.length) ytRemember(key, state.tracks);
      return state.tracks;
    });
    return state;
  }

  async function ytAudio(videoId, quality) {
    const data = await ytPost('/player', { videoId, contentCheckOk: true, racyCheckOk: true }, 0);
    const formats = (data?.streamingData?.adaptiveFormats || []).filter(f => f.url && (!f.mimeType || f.mimeType.startsWith('audio/')));
    const target = Number(String(quality || '320').replace(/\D/g, '')) || 320;
    const best = formats.sort((a, b) => Math.abs((Number(b.bitrate || 0) / 1000) - target) - Math.abs((Number(a.bitrate || 0) / 1000) - target))[0];
    if (!best?.url) return null;
    return {
      url: best.url,
      headers: {},
      mimeType: best.mimeType || 'audio/mp4',
      extension: 'mp4',
      title: data?.videoDetails?.title || 'Track',
      artist: data?.videoDetails?.author || 'Unknown Artist',
      album: '',
      artwork: data?.videoDetails?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
      durationSeconds: Number(data?.videoDetails?.lengthSeconds) || undefined,
      quality: String(Math.round(Number(best.bitrate || 0) / 1000)) + 'kbps'
    };
  }
  
  async function ytRadio(seedVideoId, priority) {
    const data = await ytPost('/next', { videoId: seedVideoId, playlistId: 'RDAMVM' + seedVideoId }, priority);
    const panel = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;
    return (panel?.contents || []).map(entry => ytToTrack(entry.playlistPanelVideoRenderer || entry)).filter(Boolean);
  }

  const MIRROR_POOLS = {
    invidious: ['https://iv.datura.network/api/v1', 'https://invidious.nerdvpn.de/api/v1', 'https://iv.melmac.space/api/v1', 'https://invidious.privacyredirect.com/api/v1', 'https://inv.tux.pizza/api/v1', 'https://invidious.f5.si/api/v1', 'https://invidious.materialio.us/api/v1'],
    piped: ['https://pipedapi.moomoo.me', 'https://pipedapi.adminforge.de', 'https://api.piped.yt', 'https://pipedapi.drgns.space', 'https://pipedapi.reallyaweso.me']
  };
  const mirrorHealth = new Map();
  const MIRROR_HEALTH_TTL = 3600000; // 1 hour
  
  function mirrorMark(url, latency, good) {
    const existing = mirrorHealth.get(url) || { failures: 0 };
    mirrorHealth.set(url, {
      latency: good ? latency : (existing.latency || 200),
      failures: good ? 0 : Math.min((existing.failures || 0) + 1, 3),
      checked: Date.now()
    });
  }
  
  function mirrors(pool) {
    const now = Date.now();
    const candidates = [];
    
    for (const url of (MIRROR_POOLS[pool] || [])) {
      const health = mirrorHealth.get(url);
      
      // If no health data or health expired, treat as healthy (warm up)
      if (!health || (now - health.checked) > MIRROR_HEALTH_TTL) {
        candidates.push({ url, latency: 100, failures: 0 });
        continue;
      }
      
      // Skip if too many recent failures
      if (health.failures >= 3) continue;
      
      // Include with actual latency
      candidates.push({ url, latency: health.latency || 200, failures: health.failures });
    }
    
    // Sort by score (latency + penalty for failures)
    return candidates
      .sort((a, b) => {
        const scoreA = a.latency + (a.failures * 2000);
        const scoreB = b.latency + (b.failures * 2000);
        return scoreA - scoreB;
      })
      .map(x => x.url);
  }
  async function mirrorGetJson(url) {
    const started = Date.now();
    try {
      const res = await schedule(0, () => fetch(url, { signal: timeoutSignal(MIRROR_TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      mirrorMark(url, Date.now() - started, true);
      return data;
    } catch (error) {
      mirrorMark(url, 8000, false);
      throw error;
    }
  }
  // Race the top candidates instead of stacking their timeouts one after another.
  async function raceMirrors(pool, makeUrl, limit) {
    const candidates = mirrors(pool).slice(0, limit || 2);
    if (!candidates.length) throw new Error('no healthy mirrors');
    return Promise.any(candidates.map(async base => {
      const data = await mirrorGetJson(makeUrl(base));
      if (!data) throw new Error('empty response');
      return { base, data };
    }));
  }
  const pickAudioFormat = (formats, quality) => {
    const audio = (formats || []).filter(f => f.url && (!f.mimeType || f.mimeType.startsWith('audio/')));
    if (!audio.length) return null;
    const target = Number(String(quality || '320').replace(/\D/g, '')) || 320;
    const sorted = audio.sort((a, b) => Math.abs((Number(b.bitrate || 0) / 1000) - target) - Math.abs((Number(a.bitrate || 0) / 1000) - target));
    return sorted[0];
  };

  const SEARCH_FILTERS = {
    type: { songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D', videos: 'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D', albums: 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D', artists: 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D', playlists: 'EgeKAQQoAEABagoQAxoEEAMQBQ%3D%3D', podcasts: 'EgeKAQQoADgBagwQAiABCAVSAA%3D%3D', featured_playlists: 'EgeKAQQoAEABagoQAxoEEAMQBQ%3D%3D' },
    uploadDate: { lastHour: 'EgIIAQ%3D%3D', today: 'EgIIAg%3D%3D', thisWeek: 'EgIIAw%3D%3D', thisMonth: 'EgIIBA%3D%3D', thisYear: 'EgIIBQ%3D%3D' },
    duration: { short: 'EgIYAQ%3D%3D', medium: 'EgIYAw%3D%3D', long: 'EgIYAg%3D%3D' },
    feature: { live: 'EgJAAQ%3D%3D', hd: 'EgIgAQ%3D%3D', subtitles: 'EgIoAQ%3D%3D', creativeCommons: 'EgIwAQ%3D%3D' },
    sort: { relevance: '', uploadDate: 'CAI%3D', viewCount: 'CAM%3D', rating: 'CAE%3D' }
  };
  function buildSearchParams(options) {
    if (!options) return undefined;
    if (typeof options === 'string') return SEARCH_FILTERS.type[options] ? SEARCH_FILTERS.type[options] : options;
    const parts = [];
    if (options.type && SEARCH_FILTERS.type[options.type]) parts.push(SEARCH_FILTERS.type[options.type]);
    if (options.uploadDate && SEARCH_FILTERS.uploadDate[options.uploadDate]) parts.push(SEARCH_FILTERS.uploadDate[options.uploadDate]);
    if (options.duration && SEARCH_FILTERS.duration[options.duration]) parts.push(SEARCH_FILTERS.duration[options.duration]);
    if (options.feature && SEARCH_FILTERS.feature[options.feature]) parts.push(SEARCH_FILTERS.feature[options.feature]);
    if (options.sort && SEARCH_FILTERS.sort[options.sort]) parts.push(SEARCH_FILTERS.sort[options.sort]);
    return parts.length ? parts[0] : undefined;
  }

  // Live charts source: the legacy per-type browseIds (FEmusic_chart_top_*)
  // return 400; the charts page is now FEmusic_charts with carousels whose
  // items are chart playlists. For 'songs' we resolve the most relevant chart
  // playlist and return its real track list; other types map to carousels.
  function pickChartPlaylist(carousel) {
    const entries = (carousel?.contents || [])
      .map(item => item.musicTwoRowItemRenderer)
      .filter(Boolean)
      .map(two => ({ title: ytText(two.title?.runs), browseId: two.navigationEndpoint?.browseEndpoint?.browseId }))
      .filter(e => e.browseId);
    const score = e => /trending 20/i.test(e.title) ? 3 : /daily top/i.test(e.title) ? 2 : /top \d+/i.test(e.title) ? 1 : 0;
    return entries.sort((a, b) => score(b) - score(a))[0] || null;
  }
  async function fetchRealCharts(chartType = 'songs') {
    const cacheKey = 'charts:' + chartType;
    
    try {
      const data = await ytPost('/browse', { browseId: 'FEmusic_charts' });
      const shelves = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const items = [];
      const pushItem = (item) => {
        const track = ytToTrack(item);
        if (track) items.push(track);
      };
      const carouselTitle = carousel => ytText(carousel?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs);
      const carouselFor = type => shelves.find(s => {
        const t = carouselTitle(s.musicCarouselShelfRenderer).toLowerCase();
        return type === 'albums' ? t.includes('album') : type === 'artists' ? t.includes('artist') : type === 'videos' ? t.includes('video') : false;
      })?.musicCarouselShelfRenderer;
      
      if (chartType === 'albums' || chartType === 'artists' || chartType === 'videos') {
        const carousel = carouselFor(chartType);
        if (carousel?.contents) {
          for (const item of carousel.contents) pushItem(item.musicTwoRowItemRenderer || item.musicResponsiveListItemRenderer || item);
        }
      } else {
        // 'songs': resolve the strongest chart playlist and pull its real tracks
        let best = null;
        for (const shelf of shelves) {
          const carousel = shelf.musicCarouselShelfRenderer;
          if (!carousel?.contents) continue;
          const pick = pickChartPlaylist(carousel);
          if (pick) {
            const rank = /trending 20/i.test(pick.title) ? 3 : /daily top/i.test(pick.title) ? 2 : /top \d+/i.test(pick.title) ? 1 : 0;
            if (!best || rank > best.rank) best = { ...pick, rank };
          }
        }
        if (best) {
          try {
            const pl = await getPlaylist(best.browseId);
            if (pl?.ok) {
              const parsed = JSON.parse(pl.data);
              for (const track of parsed.tracks || []) items.push(track);
            }
          } catch (_) {}
        }
        if (!items.length) {
          // last resort: flatten any direct track lists on the charts page
          for (const shelf of shelves) {
            if (shelf.musicShelfRenderer?.contents) {
              for (const item of shelf.musicShelfRenderer.contents) pushItem(item.musicResponsiveListItemRenderer || item);
            } else if (shelf.musicCarouselShelfRenderer?.contents) {
              for (const item of shelf.musicCarouselShelfRenderer.contents) {
                pushItem(item.musicTwoRowItemRenderer || item.musicResponsiveListItemRenderer || item);
              }
            }
          }
        }
      }
      
      if (!items.length) return [];
      ytRemember(cacheKey, items);
      return items;
    } catch (_) {
      return [];
    }
  }

  // Charts are read through the SWR helper: previous charts return at 0ms and a
  // refresh runs in the background once the hour is up.
  async function getRealCharts(chartType = 'songs') {
    return readThrough('charts:' + chartType, 3600000, () => fetchRealCharts(chartType));
  }

  // --- Taste engine (v1.8): learns from implicit play signals ---
  // No app changes required: every playback routes through extractAudioUrl and
  // every radio start through getRelatedTracks, so those calls ARE the signal.
  const TASTE_KEY = 'synthetiq_gateway_taste_v1';
  const taste = { artists: new Map(), tracks: new Set(), sessions: 0, revision: 0 };
  // Set whenever a play changes what "your taste" means, so home sections can be
  // rebuilt before the user refreshes instead of after.
  let tasteDirty = false;
  let tasteWarmTimer = null;
  let tasteSaveTimer = null;
  const TASTE_SAVE_DEBOUNCE_MS = 1200;

  // Normalised single-artist key: 'A feat. B' and 'A, B' both key to 'a'.
  function artistKey(artist) {
    const first = String(artist || '').split(/,| feat\.| ft\.| & | x | with /i)[0];
    return first.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'unknown';
  }

  function artistNames(artist) {
    return String(artist || '')
      .split(/,| feat\.| ft\.| & | x | with /i)
      .map(part => part.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
      .filter(Boolean);
  }

  function topArtistsForMatch(key) {
    for (const name of taste.artists.keys()) {
      if (artistKey(name) === key) return name;
    }
    return null;
  }

  // A resolved stream tells us the real artist, so the profile learns even when
  // the track never appeared in a cached list before.
  function rememberArtist(trackId, artist, weight) {
    try {
      const name = String(artist || '').trim();
      if (!name || name === 'Unknown Artist') return;
      const id = normalizeTrackId(String(trackId || ''));
      if (id) trackArtists.set(id, name);
      const key = artistKey(name);
      if (!key || key === 'unknown') return;
      const existing = topArtistsForMatch(key) || name;
      taste.artists.set(existing, (taste.artists.get(existing) || 0) + (weight == null ? 1 : weight));
      touchTaste();
    } catch (_) {}
  }

  function touchTaste() {
    taste.revision++;
    tasteDirty = true;
    invalidateTasteSections();
  }

  // Rebuild taste-driven home sections shortly after a play, so a refresh finds
  // the new taste already cached rather than the previous track's shelves.
  function invalidateTasteSections() {
    try {
      for (const entry of homePlan()) {
        if (!entry.taste) continue;
        markStale(entry.key);
        const state = sectionCache.get(entry.key);
        if (state) state.time = 0;
      }
    } catch (_) {}
    if (tasteWarmTimer) return;
    tasteWarmTimer = setTimeout(() => {
      tasteWarmTimer = null;
      try { primeHomeSections(true); } catch (_) {}
    }, 2000);
  }

  function detectStorage() {
    try { if (globalThis.localStorage) return globalThis.localStorage; } catch (_) {}
    return null;
  }
  function tasteLoad() {
    const store = detectStorage();
    if (!store) return;
    try {
      const raw = store.getItem(TASTE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const [artist, weight] of saved.artists || []) taste.artists.set(artist, weight);
      for (const id of saved.tracks || []) taste.tracks.add(id);
      taste.sessions = saved.sessions || 0;
    } catch (_) {}
  }
  function tasteSaveNow() {
    const store = detectStorage();
    if (!store) return;
    try {
      const artists = [...taste.artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
      const tracks = [...taste.tracks].slice(-500);
      store.setItem(TASTE_KEY, JSON.stringify({ artists, tracks, sessions: taste.sessions, savedAt: Date.now() }));
    } catch (_) {}
  }
  function flushTasteSave() {
    if (tasteSaveTimer) {
      clearTimeout(tasteSaveTimer);
      tasteSaveTimer = null;
    }
    tasteSaveNow();
  }
  // The profile write is 10-20KB of JSON; doing it synchronously on every play was
  // visible as jank while skipping tracks, so writes are coalesced.
  function tasteSave() {
    if (tasteSaveTimer) return;
    tasteSaveTimer = setTimeout(() => { tasteSaveTimer = null; tasteSaveNow(); }, TASTE_SAVE_DEBOUNCE_MS);
  }
  tasteLoad();
  taste.sessions += 1;
  tasteSaveNow();
  try {
    if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('pagehide', flushTasteSave);
  } catch (_) {}

  function normalizeTrackId(id) {
    if (!id) return id;
    if (/^synthetiq_music_gateway:/.test(id)) return id;
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return 'synthetiq_music_gateway:yt:' + id;
    return id;
  }

  function noteImplicitPlay(trackId, weight = 1, dontSave = false) {
    try {
      const id = String(trackId || '');
      if (!id || id.startsWith('catalogue:')) return;
      if (!/^synthetiq_music_gateway:(yt|song):/.test(id)) return;
      taste.tracks.add(id);
      if (taste.tracks.size > 500) taste.tracks.delete(taste.tracks.values().next().value);
      // Artist resolution: O(1) index first, cache scan only as a fallback.
      let artist = trackArtists.get(id);
      if (!artist) {
        for (const key of YT_CACHE.keys()) {
          const item = YT_CACHE.get(key);
          if (!item || Date.now() - (item.time || 0) > 3600000) continue;
          const value = item.value;
          if (!Array.isArray(value)) continue;
          const hit = value.find(t => t && t.id === id && t.artist && t.artist !== 'Unknown Artist');
          if (hit) {
            artist = hit.artist;
            indexTrackArtists([hit]);
            break;
          }
        }
      }
      if (artist) {
        const name = artist.replace(/(,| feat\.| ft\.| &).*$/i, '').trim();
        if (name) {
          const existing = topArtistsForMatch(artistKey(name)) || name;
          taste.artists.set(existing, (taste.artists.get(existing) || 0) + weight);
        }
      }
      touchTaste();
      // Only save if not suppressed by caller
      if (!dontSave) tasteSave();
    } catch (_) {}
  }

  function topArtists(n = 5) {
    return [...taste.artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([artist]) => artist);
  }

  function affinityBoost(track) {
    if (!track) return 0;
    const names = artistNames(track.artist);
    if (!names.length) return 0;
    let score = 0;
    for (const [name, weight] of taste.artists) {
      const key = artistKey(name);
      if (key && names.indexOf(key) !== -1) score += weight;
    }
    return score;
  }

  function rerankByAffinity(tracks) {
    if (!taste.artists.size || !Array.isArray(tracks)) return tracks;
    return tracks.map(t => ({ t, s: affinityBoost(t) }))
      .sort((a, b) => b.s - a.s)
      .map(({ t }) => t);
  }

  function recordListen(trackId, artist, weight = 1) {
    // Public API: kept for future app integration; feeds the same profile.
    try {
      if (artist && artist !== 'Unknown Artist') {
        taste.artists.set(artist, (taste.artists.get(artist) || 0) + Number(weight || 1));
      }
      if (trackId) noteImplicitPlay(trackId, Number(weight || 1), true);  // Don't save yet
      touchTaste();
      tasteSave();  // Coalesced write
    } catch (_) {}
  }
  
  function recentSeedVideoIds(count) {
    const seeds = [];
    for (const id of taste.tracks) {
      const match = /^synthetiq_music_gateway:yt:([A-Za-z0-9_-]{6,})/.exec(id);
      if (match) seeds.push(match[1]);
    }
    return seeds.slice(-count).reverse();
  }

  // Diversity pass: round-robin across sources with a per-artist cap, so neither
  // one artist nor one source can fill the whole shelf. This is what makes the
  // recommendations move genre-first instead of artist-only.
  function diversify(buckets, target) {
    const maxPerArtist = Math.max(2, Math.min(5, Math.ceil(target / 8)));
    const counts = new Map();
    const used = new Set();
    const picked = [];
    const queues = buckets
      .filter(b => b && Array.isArray(b.tracks) && b.tracks.length)
      .map(b => ({ items: b.tracks.slice() }));

    let progress = true;
    while (picked.length < target && progress) {
      progress = false;
      for (const queue of queues) {
        while (queue.items.length) {
          const track = queue.items.shift();
          if (!track || !track.id || used.has(track.id)) continue;
          const key = artistKey(track.artist);
          if ((counts.get(key) || 0) >= maxPerArtist) continue;
          counts.set(key, (counts.get(key) || 0) + 1);
          used.add(track.id);
          picked.push(track);
          progress = true;
          break;
        }
      }
    }

    // Small catalogs: top up without the artist cap instead of returning short.
    for (const queue of queues) {
      for (const track of queue.items) {
        if (picked.length >= target) break;
        if (!track || !track.id || used.has(track.id)) continue;
        used.add(track.id);
        picked.push(track);
      }
    }
    return picked.slice(0, target);
  }

  async function getSmartRecommendations(limit = 24) {
    const target = Math.max(6, Number(limit) || 24);
    const hasTaste = taste.artists.size > 0 || taste.tracks.size > 0;
    if (!hasTaste) {
      const fresh = await ytSearchPipelined('popular music hits', SEARCH_FILTERS.type.songs, 1).catch(() => []);
      return fresh.slice(0, target);
    }

    const artists = topArtists(4);
    const jobs = [];
    // 1) Radio from what you actually played: walks into neighbouring artists and
    //    genres instead of replaying the one artist you just heard.
    for (const seed of recentSeedVideoIds(3)) jobs.push(() => ytRadio(seed, 2));
    // 2) A minority share of the artists you already love.
    for (const artist of artists.slice(0, 3)) jobs.push(() => ytSearchPipelined(artist + ' top songs', null, 1));
    // 3) Charts for popular, non-affinity variety (cached, usually free).
    jobs.push(() => getRealCharts('songs'));

    const settled = await Promise.allSettled(jobs.map(job => job().catch(() => [])));
    const buckets = settled.map(result => ({
      tracks: (result.status === 'fulfilled' ? result.value || [] : []).filter(t => t && t.id && !taste.tracks.has(t.id))
    }));
    return diversify(buckets, target);
  }

  const _cipherKey = '38346591';
  const _ip = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
  const _fp = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
  const _e = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
  const _p = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
  const _pc1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
  const _pc2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
  const _shifts = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
  const _sBox = [
    [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
    [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
    [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
    [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
    [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
    [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
    [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
    [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
  ];

  function base64ToBytes(b64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let str = String(b64 || '').replace(/=+$/, '');
    let bytes = [];
    for (let bc = 0, bs = 0, buffer, idx = 0; buffer = str.charAt(idx++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? bytes.push(255 & bs >> (-2 * bc & 6)) : 0) {
      buffer = chars.indexOf(buffer);
    }
    return bytes;
  }

  function bytesToBits(bytes) {
    let bits = [];
    for (let b of bytes) {
      for (let j = 7; j >= 0; j--) bits.push((b >> j) & 1);
    }
    return bits;
  }

  function bitsToBytes(bits) {
    let bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      bytes.push(b);
    }
    return bytes;
  }

  function permute(bits, table) {
    return table.map(idx => bits[idx - 1]);
  }

  function generateSubkeys(keyBytes) {
    let keyBits = bytesToBits(keyBytes);
    let permutedKey = permute(keyBits, _pc1);
    let c = permutedKey.slice(0, 28);
    let d = permutedKey.slice(28, 56);
    let subkeys = [];
    for (let i = 0; i < 16; i++) {
      let shift = _shifts[i];
      c = c.slice(shift).concat(c.slice(0, shift));
      d = d.slice(shift).concat(d.slice(0, shift));
      subkeys.push(permute(c.concat(d), _pc2));
    }
    return subkeys;
  }

  function feistel(r, subkey) {
    let er = permute(r, _e);
    let xored = er.map((bit, idx) => bit ^ subkey[idx]);
    let sboxOut = [];
    for (let i = 0; i < 8; i++) {
      let block = xored.slice(i * 6, (i + 1) * 6);
      let row = (block[0] << 1) | block[5];
      let col = (block[1] << 3) | (block[2] << 2) | (block[3] << 1) | block[4];
      let val = _sBox[i][row * 16 + col];
      for (let j = 3; j >= 0; j--) sboxOut.push((val >> j) & 1);
    }
    return permute(sboxOut, _p);
  }

  function decryptBlock(blockBytes, subkeys) {
    let bits = permute(bytesToBits(blockBytes), _ip);
    let l = bits.slice(0, 32);
    let r = bits.slice(32, 64);
    for (let i = 15; i >= 0; i--) {
      let f = feistel(r, subkeys[i]);
      let nextR = l.map((bit, idx) => bit ^ f[idx]);
      l = r;
      r = nextR;
    }
    return bitsToBytes(permute(r.concat(l), _fp));
  }

  function decryptMediaUrl(b64) {
    try {
      let rawBytes = base64ToBytes(b64);
      let keyBytes = [];
      for (let i = 0; i < _cipherKey.length; i++) keyBytes.push(_cipherKey.charCodeAt(i));
      let subkeys = generateSubkeys(keyBytes);
      let decryptedBytes = [];
      for (let i = 0; i < rawBytes.length; i += 8) {
        let block = rawBytes.slice(i, i + 8);
        decryptedBytes = decryptedBytes.concat(decryptBlock(block, subkeys));
      }
      let pad = decryptedBytes[decryptedBytes.length - 1];
      if (pad > 0 && pad <= 8) decryptedBytes.splice(decryptedBytes.length - pad, pad);
      let result = '';
      for (let i = 0; i < decryptedBytes.length; i++) result += String.fromCharCode(decryptedBytes[i]);
      return result;
    } catch (_) {
      return '';
    }
  }

  function decodeBase64(input) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let str = String(input || '').replace(/=+$/, '');
    let output = '';
    for (let bc = 0, bs = 0, buffer, idx = 0; buffer = str.charAt(idx++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
      buffer = chars.indexOf(buffer);
    }
    return output;
  }

  function parseTrackQuery(trackId) {
    let clean = String(trackId || '').replace(/^catalogue:/, '').trim();
    let decoded = decodeBase64(clean);
    if (decoded.indexOf('\x00') !== -1) {
      let parts = decoded.split('\x00');
      return (parts[0] + ' ' + (parts[1] || '')).trim();
    }
    return clean;
  }

  function ok(data) { return { ok: true, data: JSON.stringify(data) }; }
  function fail(message) { return { ok: false, error: { message: String(message || 'Music gateway unavailable') } }; }

  async function httpGet(url, timeoutMs) {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    try {
      const res = await schedule(0, () => fetch(url, { method: 'GET', headers, signal: timeoutSignal(timeoutMs || MIRROR_TIMEOUT_MS) }));
      if (res.status === 200) {
        return await res.json();
      }
    } catch (_) {}
    return null;
  }

  const hasMirrorPayload = data => !!(data && (data.data || data.results || data.success || data.status === 'SUCCESS'));

  // Mirrors are raced in parallel. Walking them one-by-one used to add the full
  // timeout of every dead mirror to each search / album / song resolution.
  async function mirrorGet(path, timeoutMs) {
    const candidates = MIRRORS.slice(0, 3);
    if (!candidates.length) return null;
    try {
      return await Promise.any(candidates.map(base =>
        httpGet(base + path, timeoutMs).then(data => {
          if (!hasMirrorPayload(data)) throw new Error('unusable mirror response');
          return data;
        })
      ));
    } catch (_) {
      return null;
    }
  }

  async function directJioSaavn(params) {
    const query = Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    const url = 'https://www.jiosaavn.com/api.php?_format=json&_marker=0&ctx=web6dot0&' + query;
    return await httpGet(url);
  }

  function toTrack(item) {
    if (!item) return null;
    const id = item.providerItemId || item.id || item.songId;
    if (!id) return null;
    const title = String(item.title || item.name || 'Track');
    let artist = 'Unknown Artist';
    if (item.artist) artist = String(item.artist);
    else if (item.primaryArtists) artist = String(item.primaryArtists);
    else if (item.primary_artists) artist = String(item.primary_artists);
    else if (item.artists && Array.isArray(item.artists.primary) && item.artists.primary.length) {
      artist = item.artists.primary.map(a => a.name).join(', ');
    }

    let image = item.image || item.imageUrl;
    if (Array.isArray(image) && image.length) {
      image = image[image.length - 1]?.url || image[image.length - 1];
    }

    let album = item.album?.name || (typeof item.album === 'string' ? item.album : undefined);
    let durationSeconds = Number(item.durationSeconds || item.duration) || undefined;

    return {
      id: 'synthetiq_music_gateway:song:' + id,
      href: 'synthetiq_music_gateway:song:' + id,
      type: 'track',
      title,
      artist,
      album,
      image,
      durationSeconds
    };
  }

  async function searchResults(query, page, options) {
    const term = String(query || '').trim();
    if (!term) return ok([]);

    const pageNumber = Math.max(0, Number(page) || 0);
    const key = searchKey(term, options);

    try {
      // Fast path: one shared, growing result set per query. Page 1 returns the
      // moment a shard lands; page 2/3 read the fully expanded set.
      const state = searchStateFor(key, term, options);
      if (!state.done) {
        await waitFor(
          pageNumber === 0
            ? () => state.done || state.tracks.length >= SEARCH_FIRST_PAINT_TRACKS || (state.tracks.length > 0 && idleSearchShards(state))
            : () => state.done,
          pageNumber === 0 ? SEARCH_FIRST_PAINT_MS : SEARCH_EXPAND_WAIT_MS
        );
      }
      if (state.tracks.length) {
        return ok(pageNumber === 0 ? state.tracks : rerankByAffinity(state.tracks));
      }
    } catch (_) {}

    const mirrorPage = pageNumber + 1 || 1;
    try {
      // Mirror fallback: both pages raced at once, so the fallback is one round
      // trip instead of two sequential ones.
      const res = await mirrorGet('/search/songs?query=' + encodeURIComponent(term) + '&page=' + mirrorPage + '&limit=50');
      const results = res?.data?.results || res?.results || [];
      if (results.length) {
        const tracks = dedupeTracks(results.map(toTrack).filter(Boolean));
        ytRemember(key, tracks);
        return ok(tracks);
      }
    } catch (_) {}

    try {
      const jio = await directJioSaavn({
        '__call': 'search.getSongSearchResults',
        'q': term,
        'p': mirrorPage,
        'n': 50
      });
      const results = jio?.results || jio?.songs?.data || [];
      if (results.length) {
        const tracks = dedupeTracks(results.map(toTrack).filter(Boolean));
        ytRemember(key, tracks);
        return ok(tracks);
      }
    } catch (_) {}

    return ok([]);
  }

  // True once every shard has stopped pushing new tracks into the result set.
  function idleSearchShards(state) {
    return state.done || state.promise === null;
  }

  function dedupeTracks(tracks) {
    const seen = new Set();
    const out = [];
    for (const track of tracks || []) {
      if (!track || !track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      out.push(track);
    }
    return out;
  }

  // First success wins; the slow routes are left running in the background
  // instead of holding the play button hostage.
  function firstSuccess(promises) {
    return new Promise((resolve, reject) => {
      if (!promises.length) return reject(new Error('nothing to race'));
      let failures = 0;
      for (const promise of promises) {
        Promise.resolve(promise).then(resolve, () => {
          failures++;
          if (failures === promises.length) reject(new Error('all routes failed'));
        });
      }
    });
  }

  function mirrorAudioPayload(data, format, quality) {
    return {
      url: format.url,
      headers: {},
      mimeType: format.type || format.mimeType || 'audio/mp4',
      extension: 'mp4',
      title: data?.title || 'Track',
      artist: data?.author || 'Unknown Artist',
      album: '',
      artwork: Array.isArray(data?.videoThumbnails) ? data.videoThumbnails.slice(-1)[0]?.url : '',
      quality: String(Math.round(Number(format.bitrate || 0) / 1000)) + 'kbps'
    };
  }

  function songAudioPayload(songData, url, quality) {
    const track = toTrack(songData);
    return {
      url,
      headers: {},
      mimeType: 'audio/mp4',
      extension: 'mp4',
      title: track?.title || 'Track',
      artist: track?.artist || 'Unknown Artist',
      album: track?.album || '',
      artwork: track?.image || '',
      durationSeconds: track?.durationSeconds,
      quality: quality || 'high'
    };
  }

  // YouTube routes raced together: the official player plus the best invidious
  // and piped mirrors. Whichever answers first plays; no sequential timeouts.
  async function resolveYoutubeAudio(videoId, quality) {
    return dedupe('audio:' + videoId + ':' + (quality || ''), async () => {
      const routes = [
        ytAudio(videoId, quality),
        (async () => {
          const { data } = await raceMirrors('invidious', base => base + '/videos/' + encodeURIComponent(videoId), 2);
          const format = pickAudioFormat(data?.adaptiveFormats || data?.audioStreams || [], quality);
          if (!format?.url) throw new Error('no invidious format');
          return mirrorAudioPayload(data, format, quality);
        })(),
        (async () => {
          const { data } = await raceMirrors('piped', base => base + '/streams/' + encodeURIComponent(videoId), 1);
          const format = pickAudioFormat(data?.adaptiveFormats || data?.audioStreams || [], quality);
          if (!format?.url) throw new Error('no piped format');
          return mirrorAudioPayload(data, format, quality);
        })()
      ];
      return firstSuccess(routes);
    });
  }

  // Catalogue/song routes raced together: mirror lookup and the direct provider
  // call used to run one after the other, so a slow mirror doubled the wait.
  async function resolveSongAudio(songId, quality, depth) {
    return dedupe('songaudio:' + songId + ':' + (quality || ''), async () => {
      const routes = [
        (async () => {
          const res = await mirrorGet('/songs/' + encodeURIComponent(songId), MIRROR_TIMEOUT_MS);
          const songData = Array.isArray(res?.data) ? res.data[0] : res?.data;
          if (!songData || !Array.isArray(songData.downloadUrl)) throw new Error('no downloadUrl');
          let stream320 = null;
          let streamFallback = null;
          for (const candidate of songData.downloadUrl) {
            if (!candidate?.url) continue;
            if (String(candidate.quality).indexOf('320') !== -1) stream320 = candidate.url;
            streamFallback = candidate.url;
          }
          const url = stream320 || streamFallback;
          if (!url) throw new Error('no stream');
          return songAudioPayload(songData, url, quality);
        })(),
        (async () => {
          const jioRes = await directJioSaavn({ '__call': 'song.getDetails', 'pids': songId });
          let songData = null;
          if (jioRes) {
            if (jioRes[songId]) songData = jioRes[songId];
            else if (Array.isArray(jioRes.songs) && jioRes.songs.length) songData = jioRes.songs[0];
            else if (jioRes.id) songData = jioRes;
          }
          const encUrl = songData?.more_info?.encrypted_media_url;
          if (!encUrl) throw new Error('no encrypted url');
          const decrypted = decryptMediaUrl(encUrl);
          if (!decrypted || decrypted.indexOf('http') !== 0) throw new Error('undecryptable url');
          let streamUrl = decrypted;
          const wanted = String(quality || 'high').toLowerCase();
          if (wanted.indexOf('320') !== -1 || wanted.indexOf('high') !== -1) {
            streamUrl = decrypted.replace('_96.mp4', '_320.mp4').replace('_160.mp4', '_320.mp4').replace('_48.mp4', '_320.mp4');
          }
          return songAudioPayload(songData, streamUrl, quality);
        })()
      ];
      if (!depth) {
        // Authorised fallback: resolve the title instead, but only on the first
        // hop so a dead provider cannot recurse through the whole catalogue.
        routes.push((async () => {
          const search = await searchResults(songId, 0);
          if (!search.ok) throw new Error('no search');
          const items = JSON.parse(search.data);
          if (!items.length) throw new Error('no match');
          const resolved = await extractAudioUrl(items[0].id, quality, 1, { silent: true });
          if (!resolved?.ok) throw new Error('no resolved match');
          const payload = JSON.parse(resolved.data);
          if (!payload?.url) throw new Error('no url');
          return payload;
        })());
      }
      return firstSuccess(routes);
    });
  }

  async function extractAudioUrl(trackId, quality, depth = 0, options = {}) {
    // Implicit play signal: a stream resolution IS a play (v1.8 taste engine).
    if (!options.silent) noteImplicitPlay(trackId, 1, false);  // Allow save
    let cleanId = String(trackId || '').trim();
    let queryForFallback = null;
    let ytVideo = null;

    if (/^(synthetiq_music_gateway|synthetiq_music_hub|freefy):yt:/.test(cleanId)) {
      ytVideo = cleanId.split(':yt:')[1];
      cleanId = ytVideo;
    } else if (cleanId.startsWith('catalogue:')) {
      queryForFallback = parseTrackQuery(cleanId);
    } else {
      cleanId = cleanId.replace(/^([^:]+:song:|synthetiq_music_gateway:|synthetiq_music_hub:|saavn:|song:|track:)/, '').trim();
    }

    if (ytVideo) {
      const cacheKey = 'audio:' + ytVideo;
      const cachedAudio = ytCached(cacheKey, AUDIO_TTL_MS);
      if (cachedAudio) return ok(cachedAudio);
      if (ytCached('audioFail:' + ytVideo, 60000)) return fail('This YouTube track could not be streamed.');
      try {
        const audio = await resolveYoutubeAudio(ytVideo, quality);
        if (audio) {
          if (!options.silent) rememberArtist(ytVideo, audio.artist);
          return ok(ytRemember(cacheKey, audio));
        }
      } catch (_) {}
      ytRemember('audioFail:' + ytVideo, true);
      return fail('This YouTube track could not be streamed.');
    }

    if (cleanId && !cleanId.startsWith('catalogue:') && cleanId.length >= 4 && cleanId.indexOf(':') === -1) {
      const songCacheKey = 'audio:song:' + cleanId;
      const cachedSong = ytCached(songCacheKey, AUDIO_TTL_MS);
      if (cachedSong) return ok(cachedSong);
      try {
        const song = await resolveSongAudio(cleanId, quality, depth);
        if (song) {
          if (!options.silent) rememberArtist('synthetiq_music_gateway:song:' + cleanId, song.artist);
          return ok(ytRemember(songCacheKey, song));
        }
      } catch (_) {}
    }

    const query = queryForFallback || cleanId;
    if (query && query.length > 1 && depth < 1) {  // Max 1 recursion level
      try {
        const searchRes = await searchResults(query, 0);
        if (searchRes.ok) {
          const items = JSON.parse(searchRes.data);

          // Try top 3 results in parallel
          const attempts = items
            .slice(0, 3)
            .map(item =>
              (item.id && item.id !== trackId)
                ? extractAudioUrl(item.id, quality, depth + 1, { silent: true })
                    .catch(() => ({ ok: false }))
                : Promise.resolve({ ok: false })
            );

          // Return first successful result
          const results = await Promise.allSettled(attempts);
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value?.ok) {
              return result.value;
            }
          }
        }
      } catch (_) {}
    }

    return fail('No authorised full-length route is available for this track.');
  }

  async function extractDetails(id) {
    const KNOWN_PREFIXES = ['synthetiq_music_gateway', 'synthetiq_music_hub', 'freefy', 'album', 'playlist', 'artist', 'yt', 'song', 'track'];
    const cleanId = String(id || '').split(':').filter(part => part && !KNOWN_PREFIXES.includes(part)).join(':').trim();

    if (cleanId.startsWith('MPRE')) {
      const cacheKey = 'album:' + cleanId;
      const cachedAlbum = ytCached(cacheKey, 3600000);
      if (cachedAlbum) return ok(cachedAlbum);
      try {
        const data = await ytPost('/browse', { browseId: cleanId });
        const two = data?.contents?.twoColumnBrowseResultsRenderer;
        const single = data?.contents?.singleColumnBrowseResultsRenderer;
        const headerSection = (two?.tabs?.[0] || single?.tabs?.[0])?.tabRenderer?.content?.sectionListRenderer?.contents?.[0] || {};
        const shelfSources = [
          two?.secondaryContents?.sectionListRenderer?.contents || [],
          single?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [],
          data?.contents?.sectionListRenderer?.contents || []
        ];
        const header = headerSection.musicResponsiveHeaderRenderer || headerSection.musicDetailHeaderRenderer || data?.header?.musicDetailHeaderRenderer || data?.header?.musicImmersiveHeaderRenderer;
        const trackLists = [];
        for (const source of shelfSources) {
          for (const section of source) {
            const items = section.musicShelfRenderer?.contents;
            if (items?.length) trackLists.push(items);
          }
        }
        const tracks = trackLists.flat().map(item => {
          const videoId = ytVideoId(item.musicResponsiveListItemRenderer || item);
          if (!videoId) return null;
          const columns = item.musicResponsiveListItemRenderer?.flexColumns || [];
          const runs = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const sub = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          return {
            id: 'synthetiq_music_gateway:yt:' + videoId,
            href: 'synthetiq_music_gateway:yt:' + videoId,
            type: 'track',
            title: ytText(runs[0]?.text) || 'Track',
            artist: ytText(sub[0]?.text) || 'Unknown Artist',
            album: ytText(header?.title?.runs) || undefined,
            durationSeconds: (() => { const m = ytText(sub[sub.length - 1]?.text).match(/(\d+):(\d+)/); return m ? Number(m[1]) * 60 + Number(m[2]) : undefined; })()
          };
        }).filter(Boolean);
        if (tracks.length) {
          const subtitleRuns = header?.subtitle?.runs?.map(run => run.text) || [];
          const album = {
            id: cleanId,
            title: ytText(header?.title?.runs) || 'Album',
            artist: ytText(header?.straplineTextOne?.runs) || ytText(subtitleRuns[0]) || 'Various Artists',
            image: Array.isArray(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails) ? header.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails.slice(-1)[0]?.url : undefined,
            year: ytText(subtitleRuns.find(t => /^\d{4}/.test(t || ''))) || undefined,
            tracks
          };
          return ok(ytRemember(cacheKey, album));
        }
      } catch (_) {}
      return fail('Album details unavailable.');
    }

    try {
      const res = await mirrorGet('/albums?id=' + encodeURIComponent(cleanId));
      const data = res?.data;
      if (data) {
        const tracks = (data.songs || []).map(toTrack).filter(Boolean);
        return ok({
          id: cleanId,
          title: String(data.name || 'Album'),
          artist: String(data.primaryArtists || 'Various Artists'),
          image: Array.isArray(data.image) ? data.image[data.image.length - 1]?.url : data.image,
          year: data.year ? String(data.year) : undefined,
          tracks
        });
      }
    } catch (_) {}
    return fail('Album details unavailable.');
  }

  async function extractTracks(containerId) {
    const details = await extractDetails(containerId);
    if (!details.ok) return details;
    const parsed = JSON.parse(details.data);
    return ok(parsed.tracks || []);
  }

  // Response budget guard: stop adding shelves once projected JSON nears the
  // app's 512KB maxResponseBytes cap (soft 450KB target), trimming lowest priority.
  const HOME_BUDGET_BYTES = 450000;
  function estimatePayloadBytes(sections) {
    let total = 32;
    for (const section of sections || []) {
      total += 64 + String(section.title || '').length * 2;
      if (Array.isArray(section.items)) total += estimateCacheBytes(section.items);
    }
    return total;
  }
  function withinBudget(sections) {
    try { return estimatePayloadBytes(sections) <= HOME_BUDGET_BYTES; } catch (_) { return true; }
  }

  // --- Home shelves: cached per section (v1.9.2) ------------------------------
  // Home used to be a single 15-minute SWR blob, so every refresh either waited
  // for ~12 upstream calls or served shelves built from the previous taste.
  // Each shelf now caches on its own and home paints from whatever is ready.
  const SECTION_TTL_MS = 900000;
  const sectionCache = new Map();

  function homePlan() {
    return [
      { key: 'section:smart', title: taste.artists.size || taste.tracks.size ? 'For You (Your Taste)' : 'Popular Right Now', taste: true, max: 24, build: () => getSmartRecommendations(24) },
      { key: 'section:radar', title: 'New Releases From Your Artists', taste: true, max: 12, build: () => getNewReleases(12) },
      { key: 'section:tasteTrend', title: 'Trending In Your Taste', taste: true, max: 12, build: () => getTrendingInTaste(12) },
      { key: 'section:charts', title: 'Charts & Top Hits', taste: false, max: 24, build: () => getRealCharts('songs') },
      { key: 'section:trending', title: 'Trending Worldwide', taste: false, max: 24, build: buildTrendingSection }
    ];
  }

  function ensureSection(entry, force) {
    let state = sectionCache.get(entry.key);
    if (!state) {
      state = { value: null, time: 0, promise: null };
      sectionCache.set(entry.key, state);
    }
    const fresh = state.value !== null && !force && (Date.now() - state.time) < SECTION_TTL_MS;
    if (fresh || state.promise) return state;
    state.promise = Promise.resolve().then(() => entry.build()).then(
      value => {
        state.value = Array.isArray(value) ? value : [];
        state.time = Date.now();
        state.promise = null;
        return state.value;
      },
      () => {
        state.promise = null;
        return state.value || [];
      }
    );
    return state;
  }

  function primeHomeSections(forceTaste) {
    for (const entry of homePlan()) ensureSection(entry, !!forceTaste && entry.taste);
  }

  async function buildTrendingSection() {
    const data = await ytPost('/search', { query: 'trending music hits', params: SEARCH_FILTERS.type.songs }, 1).catch(() => null);
    if (!data) return [];
    const items = (data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [])
      .flatMap(section =>
        section.musicShelfRenderer?.contents
        || (section.musicCardShelfRenderer ? [section] : [])
        || (section.itemSectionRenderer?.contents || []).map(inner => inner.musicResponsiveListItemRenderer || inner).filter(Boolean)
      )
      .map(item => ytToTrack(item.musicResponsiveListItemRenderer || item)).filter(Boolean).map(slimTrack);
    const dedup = new Set();
    const out = [];
    for (const track of items) {
      if (!track || !track.id || dedup.has(track.id)) continue;
      dedup.add(track.id);
      out.push(track);
    }
    return out.slice(0, 24);
  }

  // New-release radar: query known artists with an upload-date filter so fresh
  // drops surface without the app needing a follow list.
  async function getNewReleases(limit = 12) {
    const artists = topArtists(2);
    if (!artists.length) return [];
    const results = await Promise.allSettled(artists.map(artist =>
      ytSearchPipelined(artist + ' new song', SEARCH_FILTERS.uploadDate.thisMonth, 1)
    ));
    const out = [];
    const dedup = new Set();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const t of r.value) {
        if (!dedup.has(t.id) && !taste.tracks.has(t.id)) {
          out.push(t);
          dedup.add(t.id);
        }
      }
    }
    return out.slice(0, limit);
  }

  // Trending within the user's taste genres: intersect charts with top artists
  async function getTrendingInTaste(limit = 12) {
    const artists = topArtists(5);
    if (!artists.length) return [];
    const charts = await getRealCharts('songs');
    if (!charts?.length) return [];
    const scored = charts
      .filter(t => !taste.tracks.has(t.id))
      .map(t => ({ t, s: affinityBoost(t) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map(({ t }) => t);
  }

  async function homeSections(page) {
    if (Number(page) > 0) return ok([]);
    const forceTaste = tasteDirty;
    tasteDirty = false;
    const entries = homePlan();
    const states = entries.map(entry => ({ entry, state: ensureSection(entry, forceTaste && entry.taste) }));

    const readyCount = () => states.filter(s => s.state.value !== null).length;
    const initialized = () => states.every(s => s.state.value !== null);
    const idle = () => states.every(s => s.state.promise === null);
    const tasteSettled = () => !forceTaste || states.filter(s => s.entry.taste).every(s => s.state.promise === null);

    // Progressive paint: hand back the shelves that are ready and never block
    // past the soft deadline just to fill in the last one.
    await waitFor(() => tasteSettled() && (initialized() || idle()), HOME_SOFT_DEADLINE_MS);
    if (readyCount() === 0) await waitFor(() => readyCount() > 0, HOME_HARD_DEADLINE_MS);

    const sections = [];
    for (const { entry, state } of states) {
      const items = Array.isArray(state.value) ? state.value : [];
      if (!items.length) continue;
      sections.push({ title: entry.title, type: 'track', items: items.slice(0, entry.max || 24) });
    }
    if (!sections.length) return fail('Music discovery is temporarily unavailable.');
    // Budget guard: drop lowest-priority shelves (end of array) until within budget
    while (sections.length > 1 && !withinBudget(sections)) sections.pop();
    return ok(sections);
  }

  async function getRelatedTracks(seedId) {
    // Stronger signal: the user explicitly asked for more like this
    noteImplicitPlay(seedId, 1.5, false);  // Allow save
    const seed = String(seedId || '').trim();
    const seedNormalized = normalizeTrackId(seed);
    
    let ytVideo = null;
    if (/^(synthetiq_music_gateway|synthetiq_music_hub|freefy):yt:/.test(seed)) {
      ytVideo = seed.split(':yt:')[1];
    } else if (seed && !seed.startsWith('catalogue:') && seed.indexOf(':') === -1 && seed.length >= 8) {
      ytVideo = seed;
    }
    
    if (ytVideo) {
      const cacheKey = 'radio:' + ytVideo;
      const cachedRadio = ytCached(cacheKey, 1800000);
      if (cachedRadio) return ok(cachedRadio);
      
      try {
        const tracks = await ytRadio(ytVideo);
        if (tracks.length) {
          // Filter using normalized IDs consistently
          const filtered = tracks.filter(t => {
            const tNormalized = normalizeTrackId(t.id);
            return tNormalized !== seedNormalized && 
                   tNormalized !== seed &&
                   normalizeTrackId(seedId) !== tNormalized;
          });
          return ok(ytRemember(cacheKey, filtered));
        }
      } catch (_) {}
    }
    if (seed.startsWith('catalogue:')) {
      const query = parseTrackQuery(seed);
      if (query) {
        try {
          const results = await ytSearchPipelined(query, null, 1);
          if (results.length) return getRelatedTracks(results[0].id);
        } catch (_) {}
      }
    }
    if (ytVideo) {
      try {
        const details = await ytSearchPipelined(ytVideo, null, 1);
        if (details.length) {
          const artist = details[0].artist;
          const tracks = await ytSearchPipelined(artist, null, 2);
          if (tracks.length) return ok(tracks.filter(t => t.id !== seedId && t.id !== 'synthetiq_music_gateway:yt:' + ytVideo));
        }
      } catch (_) {}
    }
    return searchResults('recommended hits', 0);
  }

  globalThis.searchResults = searchResults;
  globalThis.homeSections = homeSections;
  globalThis.extractDetails = extractDetails;
  globalThis.extractTracks = extractTracks;
  globalThis.extractAudioUrl = extractAudioUrl;
  globalThis.getRelatedTracks = getRelatedTracks;
  globalThis.getSmartRecommendations = getSmartRecommendations;
  globalThis.recordListen = recordListen;

  async function searchAdvanced(query, options) {
    return searchResults(query, 0, options);
  }

  async function getLyrics(trackId) {
    const seed = String(trackId || '').trim();
    let ytVideo = null;
    if (/^(synthetiq_music_gateway|synthetiq_music_hub|freefy):yt:/.test(seed)) ytVideo = seed.split(':yt:')[1];
    else if (seed && seed.indexOf(':') === -1 && seed.length >= 8) ytVideo = seed;
    if (ytVideo) {
      const cacheKey = 'lyrics:' + ytVideo;
      const cachedLyrics = ytCached(cacheKey, 86400000);
      if (cachedLyrics) return ok(cachedLyrics);
      try {
        const next = await ytPost('/next', { videoId: ytVideo });
        const tabs = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
        const lyricTab = tabs.find(tab => tab.tabRenderer?.title === 'Lyrics');
        const params = lyricTab?.tabRenderer?.endpoint?.watchEndpoint?.params;
        if (params) {
          const data = await ytPost('/get_lyrics', { videoId: ytVideo, params });
          const lines = (data?.contents?.segmentedLyricsRenderer?.contents || []).map(segment => segment.lyricRun?.text || '').filter(Boolean);
          if (lines.length) return ok(ytRemember(cacheKey, { source: 'youtube', lines }));
        }
      } catch (_) {}
    }
    let query = seed.startsWith('catalogue:') ? parseTrackQuery(seed) : null;
    if (!query && ytVideo) {
      try {
        const next = await ytPost('/next', { videoId: ytVideo });
        const panel = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;
        const current = (panel?.contents || []).find(entry => (entry.playlistPanelVideoRenderer?.title?.runs?.[0]?.text || '').length > 0)
          || panel?.contents?.[0];
        const title = ytText(current?.playlistPanelVideoRenderer?.title?.runs);
        if (title) query = title.replace(/\((official|lyric|audio|video)[^)]*\)/i, '').trim();
      } catch (_) {}
      if (!query) {
        try {
          const results = await ytSearchPipelined(ytVideo, null, 1);
          if (results.length) query = (results[0].title.replace(/\((official|lyric|audio|video).*$/i, '').trim() + ' ' + results[0].artist).trim();
        } catch (_) {}
      }
    }
    if (!query) query = seed.split(':').pop();
    if (query && query.length > 1) {
      try {
        const res = await httpGet('https://lrclib.net/api/search?q=' + encodeURIComponent(query));
        if (Array.isArray(res) && res.length) {
          const best = res.find(item => item.plainLyrics || item.syncedLyrics) || res[0];
          if (best?.syncedLyrics) {
            const lines = best.syncedLyrics.split('\n').map(line => {
              const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
              return m ? { timeSeconds: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() } : { text: line };
            });
            return ok({ source: 'lrclib', synced: true, lines });
          }
          if (best?.plainLyrics) return ok({ source: 'lrclib', lines: best.plainLyrics.split('\n') });
        }
      } catch (_) {}
    }
    return fail('Lyrics unavailable.');
  }

  async function getArtist(artistId) {
    const clean = String(artistId || '').trim().replace(/^(synthetiq_music_gateway|freefy):(artist:)?/, '');
    if (!clean || !/^(UC|MPUC)[A-Za-z0-9_-]{10,}$/.test(clean)) return fail('Artist ID required.');
    const cacheKey = 'artist:' + clean;
    const cachedArtist = ytCached(cacheKey, 3600000);
    if (cachedArtist) return ok(cachedArtist);
    try {
      const data = await ytPost('/browse', { browseId: clean });
      const header = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicDetailHeaderRenderer;
      const shelves = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const artist = {
        id: clean,
        type: 'artist',
        name: ytText(header?.title?.runs) || 'Artist',
        image: Array.isArray(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails) ? header.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails.slice(-1)[0]?.url : undefined,
        description: ytText(header?.description?.runs) || undefined,
        monthlyListeners: (() => { const m = ytText(header?.subtitle?.runs).match(/([\d,.]+)\s+monthly listeners/i); return m ? Number(m[1].replace(/,/g, '')) : undefined; })(),
        sections: []
      };
      for (const shelf of shelves) {
        const renderer = shelf.musicCarouselShelfRenderer;
        const title = ytText(renderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs);
        const items = (renderer?.contents || []).map(item => {
          const twoRow = item.musicTwoRowItemRenderer;
          if (twoRow) {
            const browseId = twoRow.navigationEndpoint?.browseEndpoint?.browseId;
            const videoId = twoRow.navigationEndpoint?.watchEndpoint?.videoId;
            const id = videoId || browseId;
            if (!id) return null;
            return {
              id: videoId ? 'synthetiq_music_gateway:yt:' + videoId : id,
              href: videoId ? 'synthetiq_music_gateway:yt:' + videoId : id,
              type: videoId ? 'track' : 'collection',
              title: ytText(twoRow.title?.runs) || 'Item',
              artist: ytText(twoRow.subtitle?.runs) || 'Unknown Artist',
              image: Array.isArray(twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails) ? twoRow.thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails.slice(-1)[0]?.url : undefined
            };
          }
          return ytToTrack(item.musicResponsiveListItemRenderer || item);
        }).filter(Boolean);
        if (title && items.length) artist.sections.push({ title, type: items[0].type === 'collection' ? 'collection' : 'track', items });
      }
      if (artist.sections.length) return ok(ytRemember(cacheKey, artist));
    } catch (_) {}
    return fail('Artist unavailable.');
  }

  async function getPlaylist(playlistId) {
    let browseId = String(playlistId || '').trim().replace(/^(synthetiq_music_gateway|freefy):(playlist:)?/, '');
    if (!browseId) return fail('Playlist ID required.');
    if (/^(VL|PL|RD|OL|UU)/.test(browseId) && !browseId.startsWith('VL')) browseId = 'VL' + browseId;
    const cacheKey = 'playlist:' + browseId;
    const cachedPlaylist = ytCached(cacheKey, 1800000);
    if (cachedPlaylist) return ok(cachedPlaylist);
    try {
      const data = await ytPost('/browse', { browseId });
      const header = data?.header?.musicDetailHeaderRenderer || data?.header?.playlistHeaderRenderer;
      const shelfContents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const tracks = shelfContents.flatMap(section => section.musicPlaylistShelfRenderer?.contents || section.musicShelfRenderer?.contents || [])
        .map(item => {
          const videoId = ytVideoId(item.musicResponsiveListItemRenderer || item);
          if (!videoId) return null;
          const columns = item.musicResponsiveListItemRenderer?.flexColumns || [];
          const runs = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const sub = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          return {
            id: 'synthetiq_music_gateway:yt:' + videoId,
            href: 'synthetiq_music_gateway:yt:' + videoId,
            type: 'track',
            title: ytText(runs[0]?.text) || 'Track',
            artist: ytText(sub[0]?.text) || 'Unknown Artist',
            durationSeconds: (() => { const m = ytText(sub[sub.length - 1]?.text).match(/(\d+):(\d+)/); return m ? Number(m[1]) * 60 + Number(m[2]) : undefined; })()
          };
        }).filter(Boolean);
      if (tracks.length) {
        return ok(ytRemember(cacheKey, {
          id: browseId,
          type: 'playlist',
          title: ytText(header?.title?.runs) || 'Playlist',
          creator: ytText(header?.ownerText?.runs) || ytText(header?.subtitle?.runs?.[0]?.text) || 'Unknown',
          trackCount: tracks.length,
          tracks
        }));
      }
    } catch (_) {}
    try {
      const plainId = browseId.replace(/^VL/, '');
      const data = await ytPost('/next', { playlistId: plainId });
      const header = data?.header?.musicDetailHeaderRenderer || data?.header?.playlistHeaderRenderer;
      const panel = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;
      const title = ytText(panel?.title?.runs) || ytText(header?.title?.runs) || 'Playlist';
      const seen = new Set();
      const tracks = (panel?.contents || []).map(entry => ytToTrack(entry.playlistPanelVideoRenderer || entry)).filter(Boolean)
        .filter(track => { if (seen.has(track.id)) return false; seen.add(track.id); return true; });
      if (tracks.length) {
        return ok(ytRemember(cacheKey, {
          id: plainId,
          type: 'playlist',
          title,
          creator: 'YouTube Music',
          trackCount: tracks.length,
          tracks
        }));
      }
    } catch (_) {}
    return fail('Playlist unavailable.');
  }

  globalThis.searchAdvanced = searchAdvanced;
  globalThis.getLyrics = getLyrics;
  globalThis.getArtist = getArtist;
  globalThis.getPlaylist = getPlaylist;
})();
