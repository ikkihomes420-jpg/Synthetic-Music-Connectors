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

  // LRU-capped cache: touch on read, evict oldest on insert
  function cacheSet(key, value) {
    YT_CACHE.delete(key);
    YT_CACHE.set(key, { time: Date.now(), value });
    while (YT_CACHE.size > CACHE_MAX) YT_CACHE.delete(YT_CACHE.keys().next().value);
  }
  const ytRemember = (key, value) => { cacheSet(key, value); return value; };
  const ytCached = (key, ttl) => {
    const item = YT_CACHE.get(key);
    if (!item) return null;
    if (Date.now() - item.time < ttl) { YT_CACHE.delete(key); YT_CACHE.set(key, item); return item.value; }
    return null;
  };
  const ytStale = (key) => YT_CACHE.get(key)?.value ?? null;
  const ytRefreshing = new Set();
  // Stale-while-revalidate: serve stale instantly, refresh once in background
  async function swr(key, ttl, refresh) {
    const fresh = ytCached(key, ttl);
    if (fresh) return fresh;
    if (ytRefreshing.has(key)) return ytStale(key);
    ytRefreshing.add(key);
    try {
      const value = await refresh();
      if (value) ytRemember(key, value);
      return value ?? ytStale(key);
    } catch (_) {
      return ytStale(key);
    } finally {
      ytRefreshing.delete(key);
    }
  }
  const slimTrack = t => {
    if (!t) return t;
    const out = { id: t.id, type: t.type, title: t.title, artist: t.artist };
    if (t.album) out.album = t.album;
    if (t.image) out.image = t.image;
    if (t.durationSeconds) out.durationSeconds = t.durationSeconds;
    return out;
  };
  
  async function ytPost(path, body) {
    const doFetch = async () => {
      const res = await fetch(YT_API + path + '?alt=json', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ context: YT_CONTEXT, ...body })
      });
      if (!res.ok) throw new Error('YT HTTP ' + res.status);
      return res.json();
    };
    try { return await doFetch(); } catch (_) { return doFetch(); }
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
    const runs = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      || (isCard ? card.title?.runs : isTwoRow ? item.title?.runs : []);
    const sub = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      || (isCard ? card.subtitle?.runs : isTwoRow ? item.subtitle?.runs : []);
    const thumbs = source.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || card?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || (isTwoRow ? item.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails : undefined);
    const durationMatch = ytText(sub[sub.length - 1]?.text).match(/(\d+):(\d+)/);
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
    return { tracks, continuation: data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.continuations?.[0]?.nextContinuationData?.continuation };
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
    const { tracks: tracks2, continuation: cont2 } = extractSearchTracks(page2Data);
    for (const t of tracks2) {
      if (!dedup.has(t.id)) {
        allTracks.push(t);
        dedup.add(t.id);
      }
    }
    
    if (pageCount <= 2 || !cont2) return allTracks;
    
    let page3Data = await ytPost('/search', { continuation: cont2 });
    const { tracks: tracks3 } = extractSearchTracks(page3Data);
    for (const t of tracks3) {
      if (!dedup.has(t.id)) {
        allTracks.push(t);
        dedup.add(t.id);
      }
    }
    
    return allTracks;
  }

  // Sharded search: songs-filter shard + broad shard race in parallel, merged & deduped.
  // Continuation chains are inherently sequential, but two independent queries are not.
  async function ytSearchSharded(term, params, pageCount = 3) {
    const songsParams = params || SEARCH_FILTERS.type.songs;
    const [primary, broad] = await Promise.allSettled([
      ytSearchPipelined(term, songsParams, pageCount),
      pageCount > 1 ? ytSearchPipelined(term, undefined, 1) : Promise.resolve([])
    ]);
    const allTracks = [];
    const dedup = new Set();
    for (const result of [primary, broad]) {
      if (result.status !== 'fulfilled') continue;
      for (const t of result.value) {
        if (!dedup.has(t.id)) {
          allTracks.push(slimTrack(t));
          dedup.add(t.id);
        }
      }
    }
    return allTracks;
  }

  async function ytAudio(videoId, quality) {
    const data = await ytPost('/player', { videoId, contentCheckOk: true, racyCheckOk: true });
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
  
  async function ytRadio(seedVideoId) {
    const data = await ytPost('/next', { videoId: seedVideoId, playlistId: 'RDAMVM' + seedVideoId });
    const panel = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;
    return (panel?.contents || []).map(entry => ytToTrack(entry.playlistPanelVideoRenderer || entry)).filter(Boolean);
  }

  const MIRROR_POOLS = {
    invidious: ['https://iv.datura.network/api/v1', 'https://invidious.nerdvpn.de/api/v1', 'https://iv.melmac.space/api/v1', 'https://invidious.privacyredirect.com/api/v1', 'https://inv.tux.pizza/api/v1', 'https://invidious.f5.si/api/v1', 'https://invidious.materialio.us/api/v1'],
    piped: ['https://pipedapi.moomoo.me', 'https://pipedapi.adminforge.de', 'https://api.piped.yt', 'https://pipedapi.drgns.space', 'https://pipedapi.reallyaweso.me']
  };
  const mirrorHealth = new Map();
  const mirrorMark = (url, latency, good) => mirrorHealth.set(url, { latency, failures: good ? 0 : (mirrorHealth.get(url)?.failures || 0) + 1, checked: Date.now() });
  function mirrors(pool) {
    return (MIRROR_POOLS[pool] || []).filter(url => (mirrorHealth.get(url)?.failures || 0) < 3)
      .sort((a, b) => (mirrorHealth.get(a)?.latency || Number.MAX_SAFE_INTEGER) - (mirrorHealth.get(b)?.latency || Number.MAX_SAFE_INTEGER));
  }
  async function mirrorGetJson(url) {
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      mirrorMark(url, Date.now() - started, true);
      return data;
    } catch (error) {
      mirrorMark(url, 8000, false);
      throw error;
    }
  }
  async function raceMirrors(pool, makeUrl) {
    const candidates = mirrors(pool).slice(0, 3);
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
  async function getRealCharts(chartType = 'songs') {
    const cacheKey = 'charts:' + chartType;
    const cached = ytCached(cacheKey, 3600000);
    if (cached) return cached;
    
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

  // --- Taste engine (v1.8): learns from implicit play signals ---
  // No app changes required: every playback routes through extractAudioUrl and
  // every radio start through getRelatedTracks, so those calls ARE the signal.
  const TASTE_KEY = 'synthetiq_gateway_taste_v1';
  const taste = { artists: new Map(), tracks: new Set(), sessions: 0 };

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
  function tasteSave() {
    const store = detectStorage();
    if (!store) return;
    try {
      const artists = [...taste.artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
      const tracks = [...taste.tracks].slice(-500);
      store.setItem(TASTE_KEY, JSON.stringify({ artists, tracks, sessions: taste.sessions, savedAt: Date.now() }));
    } catch (_) {}
  }
  tasteLoad();
  taste.sessions += 1;
  tasteSave();

  function noteImplicitPlay(trackId, weight = 1) {
    try {
      const id = String(trackId || '');
      if (!id || id.startsWith('catalogue:')) return;
      if (!/^synthetiq_music_gateway:(yt|song):/.test(id)) return;
      taste.tracks.add(id);
      if (taste.tracks.size > 500) taste.tracks.delete(taste.tracks.values().next().value);
      // Artist resolution: check cached search/album/radio data first (free), else 0 cost skip.
      // The play is still counted by track; artist is backfilled when cache has the track.
      for (const key of YT_CACHE.keys()) {
        const item = YT_CACHE.get(key);
        if (Date.now() - item.time > 3600000) continue;
        const value = item.value;
        if (!Array.isArray(value)) continue;
        const hit = value.find(t => t && t.id === id && t.artist && t.artist !== 'Unknown Artist');
        if (hit) {
          const artist = hit.artist.replace(/(,| feat\.| ft\.| &).*$/i, '').trim();
          if (artist) {
            taste.artists.set(artist, (taste.artists.get(artist) || 0) + weight);
          }
          break;
        }
      }
      tasteSave();
    } catch (_) {}
  }

  function topArtists(n = 5) {
    return [...taste.artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([artist]) => artist);
  }

  function affinityBoost(track) {
    if (!track) return 0;
    let score = 0;
    const artist = String(track.artist || '');
    for (const [name, weight] of taste.artists) {
      if (artist.includes(name)) score += weight;
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
        tasteSave();
      }
      if (trackId) noteImplicitPlay(trackId, Number(weight || 1));
    } catch (_) {}
  }
  
  async function getSmartRecommendations(limit = 24) {
    const artists = topArtists(5);
    if (!artists.length) {
      return await getRealCharts('songs');
    }

    const allRecommended = [];
    const dedup = new Set();

    const artistPromises = artists.map(artist =>
      ytSearchPipelined(artist + ' top songs', null, 1).catch(() => [])
    );

    const results = await Promise.all(artistPromises);
    for (const tracks of results) {
      for (const t of tracks) {
        if (!dedup.has(t.id) && !taste.tracks.has(t.id)) {
          allRecommended.push(t);
          dedup.add(t.id);
        }
      }
    }

    return rerankByAffinity(allRecommended).slice(0, limit);
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

  async function httpGet(url) {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (res.status === 200) {
        return await res.json();
      }
    } catch (_) {}
    return null;
  }

  async function mirrorGet(path) {
    for (const mirror of MIRRORS) {
      const data = await httpGet(mirror + path);
      if (data && (data.data || data.results || data.success || data.status === 'SUCCESS')) {
        return data;
      }
    }
    return null;
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

    try {
      const cacheKey = 'search:' + term + ':' + Number(page || 0) + ':' + JSON.stringify(options || null);
      // SWR: 5-min fresh window, then serve stale (0ms) while refreshing once in background
      const tracks = await swr(cacheKey, 300000, () =>
        ytSearchSharded(term, buildSearchParams(options), page === 0 ? 3 : 1)
      );
      if (tracks?.length) return ok(rerankByAffinity(tracks));
    } catch (_) {}

    try {
      const p = Number(page) + 1 || 1;
      const res = await mirrorGet('/search/songs?query=' + encodeURIComponent(term) + '&page=' + p + '&limit=24');
      const results = res?.data?.results || res?.results || [];
      if (results.length) {
        return ok(results.map(toTrack).filter(Boolean));
      }
    } catch (_) {}

    try {
      const p = Number(page) + 1 || 1;
      const jio = await directJioSaavn({
        '__call': 'search.getSongSearchResults',
        'q': term,
        'p': p,
        'n': 24
      });
      const results = jio?.results || jio?.songs?.data || [];
      if (results.length) {
        return ok(results.map(toTrack).filter(Boolean));
      }
    } catch (_) {}

    return ok([]);
  }

  async function extractAudioUrl(trackId, quality, depth = 0) {
    // Implicit play signal: a stream resolution IS a play (v1.8 taste engine)
    noteImplicitPlay(trackId, 1);
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
      const cachedAudio = ytCached(cacheKey, 180000);
      if (cachedAudio) return ok(cachedAudio);
      if (ytCached('audioFail:' + ytVideo, 60000)) return fail('This YouTube track could not be streamed.');
      try {
        const audio = await ytAudio(ytVideo, quality);
        if (audio) return ok(ytRemember(cacheKey, audio));
      } catch (_) {}
      for (const pool of ['invidious', 'piped']) {
        try {
          const makeUrl = base => pool === 'invidious' ? base + '/videos/' + encodeURIComponent(ytVideo) : base + '/streams/' + encodeURIComponent(ytVideo);
          const { data } = await raceMirrors(pool, makeUrl);
          const format = pickAudioFormat(data?.adaptiveFormats || data?.audioStreams || [], quality);
          if (format?.url) {
            return ok(ytRemember(cacheKey, {
              url: format.url,
              headers: {},
              mimeType: format.type || format.mimeType || 'audio/mp4',
              extension: 'mp4',
              title: data?.title || 'Track',
              artist: data?.author || 'Unknown Artist',
              album: '',
              artwork: Array.isArray(data?.videoThumbnails) ? data.videoThumbnails.slice(-1)[0]?.url : '',
              quality: String(Math.round(Number(format.bitrate || 0) / 1000)) + 'kbps'
            }));
          }
        } catch (_) {}
      }
      ytRemember('audioFail:' + ytVideo, true);
      return fail('This YouTube track could not be streamed.');
    }

    if (cleanId && !cleanId.startsWith('catalogue:') && cleanId.length >= 4 && cleanId.indexOf(':') === -1) {
      try {
        const res = await mirrorGet('/songs/' + cleanId);
        const songData = Array.isArray(res?.data) ? res.data[0] : res?.data;
        if (songData && Array.isArray(songData.downloadUrl)) {
          let stream320 = null;
          let streamFallback = null;
          for (const d of songData.downloadUrl) {
            if (d?.url) {
              if (String(d.quality).indexOf('320') !== -1) stream320 = d.url;
              streamFallback = d.url;
            }
          }
          const bestUrl = stream320 || streamFallback;
          if (bestUrl) {
            const track = toTrack(songData);
            return ok({
              url: bestUrl,
              headers: {},
              mimeType: 'audio/mp4',
              extension: 'mp4',
              title: track?.title || 'Track',
              artist: track?.artist || 'Unknown Artist',
              album: track?.album || '',
              artwork: track?.image || '',
              durationSeconds: track?.durationSeconds,
              quality: quality || 'high'
            });
          }
        }
      } catch (_) {}

      try {
        const jioRes = await directJioSaavn({
          '__call': 'song.getDetails',
          'pids': cleanId
        });
        let songData = null;
        if (jioRes) {
          if (jioRes[cleanId]) songData = jioRes[cleanId];
          else if (Array.isArray(jioRes.songs) && jioRes.songs.length) songData = jioRes.songs[0];
          else if (jioRes.id) songData = jioRes;
        }
        const encUrl = songData?.more_info?.encrypted_media_url;
        if (encUrl) {
          const dec = decryptMediaUrl(encUrl);
          if (dec && dec.indexOf('http') === 0) {
            let streamUrl = dec;
            if (String(quality || 'high').toLowerCase().indexOf('320') !== -1 || String(quality || 'high').toLowerCase().indexOf('high') !== -1) {
              streamUrl = dec.replace('_96.mp4', '_320.mp4').replace('_160.mp4', '_320.mp4').replace('_48.mp4', '_320.mp4');
            }
            const track = toTrack(songData);
            return ok({
              url: streamUrl,
              headers: {},
              mimeType: 'audio/mp4',
              extension: 'mp4',
              title: track?.title || 'Track',
              artist: track?.artist || 'Unknown Artist',
              album: track?.album || '',
              artwork: track?.image || '',
              durationSeconds: track?.durationSeconds,
              quality: quality || 'high'
            });
          }
        }
      } catch (_) {}
    }

    const query = queryForFallback || cleanId;
    if (query && query.length > 1) {
      try {
        const searchRes = await searchResults(query, 0);
        if (searchRes.ok) {
          const items = JSON.parse(searchRes.data);
          if (depth < 2) {
            for (const item of items) {
              if (item.id && item.id !== trackId) {
                const res = await extractAudioUrl(item.id, quality, depth + 1);
                if (res.ok) return res;
              }
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
  function withinBudget(sections) {
    try {
      let size = JSON.stringify(sections).length * 2; // conservative UTF-16 estimate
      return size <= HOME_BUDGET_BYTES;
    } catch (_) { return true; }
  }

  // New-release radar: query known artists with an upload-date filter so fresh
  // drops surface without the app needing a follow list.
  async function getNewReleases(limit = 12) {
    const artists = topArtists(3);
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
    const buildSections = async () => {
      const sections = [];
      try {
        const chartsPromise = getRealCharts('songs');
        const trendingPromise = ytPost('/search', { query: 'trending music hits', params: SEARCH_FILTERS.type.songs }).catch(() => null);
        const smartPromise = getSmartRecommendations(24);
        const radarPromise = getNewReleases(12);
        const tasteTrendPromise = getTrendingInTaste(12);

        const [charts, trendingData, smart, radar, tasteTrend] = await Promise.all([
          chartsPromise, trendingPromise, smartPromise, radarPromise, tasteTrendPromise
        ]);

        if (radar?.length) {
          sections.push({ title: 'New Releases From Your Artists', type: 'track', items: radar });
        }
        if (tasteTrend?.length) {
          sections.push({ title: 'Trending In Your Taste', type: 'track', items: tasteTrend });
        }
        if (charts?.length) {
          sections.push({ title: 'Charts & Top Hits', type: 'track', items: charts.slice(0, 24) });
        }

        if (trendingData) {
          const items = (trendingData?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [])
            .flatMap(section =>
              section.musicShelfRenderer?.contents
              || (section.musicCardShelfRenderer ? [section] : [])
              || (section.itemSectionRenderer?.contents || []).map(inner => inner.musicResponsiveListItemRenderer || inner).filter(Boolean)
            )
            .map(item => ytToTrack(item.musicResponsiveListItemRenderer || item)).filter(Boolean).map(slimTrack);
          if (items.length) sections.push({ title: 'Trending Worldwide', type: 'track', items: items.slice(0, 24) });
        }

        if (smart?.length && taste.artists.size > 0) {
          sections.push({ title: 'For You (Your Taste)', type: 'track', items: smart });
        }

        // Budget guard: drop lowest-priority shelves (end of array) until within budget
        while (sections.length > 1 && !withinBudget(sections)) sections.pop();
      } catch (_) {}
      return sections;
    };
    // SWR for home: fresh 15 min, stale served at 0ms while revalidating
    const sections = await swr('home', 900000, buildSections);
    return sections?.length ? ok(sections) : fail('Music discovery is temporarily unavailable.');
  }

  async function getRelatedTracks(seedId) {
    // Stronger signal: the user explicitly asked for more like this
    noteImplicitPlay(seedId, 1.5);
    const seed = String(seedId || '').trim();
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
      const seedQualified = 'synthetiq_music_gateway:yt:' + ytVideo;
      try {
        const tracks = await ytRadio(ytVideo);
        if (tracks.length) return ok(ytRemember(cacheKey, tracks.filter(t => t.id !== seedQualified && t.id !== seedId)));
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
