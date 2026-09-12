(() => {
  'use strict';

  const YT_API = 'https://music.youtube.com/youtubei/v1';
  const CACHE = new Map();
  const MIRRORS = {
    invidious: ['https://iv.datura.network/api/v1', 'https://iv.nboej.de/api/v1', 'https://invidious.nerdvpn.de/api/v1', 'https://invidious.privacyredirect.com/api/v1', 'https://invidious.jing.yn.cn/api/v1'],
    piped: ['https://pipedapi.moomoo.me', 'https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://pipedapi.reallyaweso.me', 'https://pipedapi.drgns.space'],
    listenfree: ['https://backend.listenfree.in/api', 'https://backend2.listenfree.in/api', 'https://music-api.albatross00731.workers.dev/api']
  };
  const health = new Map();
  const timeout = 8000;
  const context = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'US' } };
  const ok = data => ({ ok: true, data: JSON.stringify(data) });
  const fail = message => ({ ok: false, error: { message: String(message || 'Source unavailable') } });
  const now = () => Date.now();
  const cached = (key, ttl) => { const item = CACHE.get(key); return item && now() - item.time < ttl ? item.value : null; };
  const remember = (key, value) => { CACHE.set(key, { time: now(), value }); return value; };
  const request = async (url, options = {}, retries = 2) => {
    let last;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeout * (attempt + 1)) : null;
      try {
        const response = await fetch(url, { ...options, signal: controller?.signal, headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate', ...(options.headers || {}) } });
        if (response.status === 429) throw new Error('rate limited');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) { last = error; if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt))); }
      finally { if (timer) clearTimeout(timer); }
    }
    throw last;
  };
  const post = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rank = url => health.get(url)?.latency || Number.MAX_SAFE_INTEGER;
  const mark = (url, latency, good) => health.set(url, { latency, failures: good ? 0 : (health.get(url)?.failures || 0) + 1, checked: now() });
  const mirrors = pool => MIRRORS[pool].filter(url => (health.get(url)?.failures || 0) < 3).sort((a, b) => rank(a) - rank(b));
  const cleanId = value => String(value || '').replace(/^(freefy|yt|youtube|song|track):/i, '').trim();
  const image = value => Array.isArray(value) ? value[value.length - 1]?.url : value;
  const text = value => Array.isArray(value) ? value.map(item => item.text || '').join('') : String(value || '');
  const videoId = item => item?.videoId || item?.playlistItemData?.videoId || item?.doubleTapCommand?.watchEndpoint?.videoId || item?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  const mapTrack = item => {
    const id = videoId(item) || item?.id;
    if (!id) return null;
    const columns = item?.flexColumns || [];
    const runs = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const sub = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    return { id: `freefy:${id}`, href: `freefy:${id}`, type: 'track', title: text(runs[0]?.text || item?.title) || 'Track', artist: text(sub[0]?.text || item?.artist) || 'Unknown Artist', album: text(sub[2]?.text || item?.album) || undefined, image: image(item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || item?.image), durationSeconds: Number(item?.lengthSeconds || item?.duration) || undefined };
  };
  const extractSearch = data => {
    const contents = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    return contents.flatMap(section => (section.musicShelfRenderer?.contents || section.musicCardShelfRenderer?.contents || []).map(mapTrack).filter(Boolean));
  };
  async function searchResults(query, page = 0, options = {}) {
    const term = String(query || '').trim(); if (!term) return ok([]);
    const key = `search:${term}:${page}:${JSON.stringify(options)}`; const hit = cached(key, 300000); if (hit) return ok(hit);
    try { const data = await post(`${YT_API}/search?alt=json`, { context, query: term, params: options.params }); const tracks = extractSearch(data); if (tracks.length) return ok(remember(key, tracks)); } catch (_) {}
    for (const base of mirrors('listenfree')) try { const data = await request(`${base}/search/songs?query=${encodeURIComponent(term)}&limit=20&page=${page}`); const rows = data?.data?.results || data?.results || []; if (rows.length) return ok(remember(key, rows.map(row => ({ id: `freefy:${row.id}`, href: `freefy:${row.id}`, type: 'track', title: row.name || row.title || 'Track', artist: row.primaryArtists || row.artists?.primary?.[0]?.name || 'Unknown Artist', album: row.album?.name, image: image(row.image), durationSeconds: Number(row.duration) || undefined })))); } catch (_) {}
    return ok([]);
  }
  const choose = (formats, quality) => { const audio = formats.filter(format => format.url && (!format.mimeType || format.mimeType.startsWith('audio/'))); const target = Number(String(quality || '320').replace(/\D/g, '')) || 320; return audio.sort((a, b) => Math.abs((Number(b.bitrate || 0) / 1000) - target) - Math.abs((Number(a.bitrate || 0) / 1000) - target))[0]; };
  async function extractAudioUrl(trackId, quality = '320') {
    const id = cleanId(trackId); const key = `audio:${id}:${quality}`; const hit = cached(key, 180000); if (hit) return ok(hit);
    try { const data = await post(`${YT_API}/player?alt=json`, { context, videoId: id, contentCheckOk: true, racyCheckOk: true }); const format = choose(data?.streamingData?.adaptiveFormats || [], quality); if (format?.url) return ok(remember(key, { url: format.url, mimeType: format.mimeType || 'audio/mp4', quality, title: data.videoDetails?.title, artist: data.videoDetails?.author })); } catch (_) {}
    for (const base of mirrors('invidious')) try { const started = now(); const data = await request(`${base}/videos/${encodeURIComponent(id)}`); const format = choose(data?.adaptiveFormats || data?.formatStreams || [], quality); if (format?.url) { mark(base, now() - started, true); return ok(remember(key, { url: format.url, mimeType: format.type || 'audio/mp4', quality })); } } catch (_) { mark(base, timeout, false); }
    for (const base of mirrors('piped')) try { const started = now(); const data = await request(`${base}/streams/${encodeURIComponent(id)}`); const format = choose(data?.audioStreams || [], quality); if (format?.url) { mark(base, now() - started, true); return ok(remember(key, { url: format.url, mimeType: format.mimeType || 'audio/mp4', quality })); } } catch (_) { mark(base, timeout, false); }
    for (const base of mirrors('listenfree')) try { const data = await request(`${base}/songs/${encodeURIComponent(id)}`); const rows = data?.data?.[0]?.downloadUrl || data?.data?.downloadUrl || []; const format = choose(rows, quality) || rows[0]; if (format?.url) return ok(remember(key, { url: format.url, mimeType: 'audio/mp4', quality })); } catch (_) {}
    return fail('Content unavailable');
  }
  async function extractDetails(id) { const clean = cleanId(id); const key = `details:${clean}`; const hit = cached(key, 3600000); if (hit) return ok(hit); for (const base of mirrors('listenfree')) try { const data = await request(`${base}/albums?id=${encodeURIComponent(clean)}`); if (data?.data) return ok(remember(key, data.data)); } catch (_) {} return fail('Album details unavailable'); }
  async function extractTracks(id) { const details = await extractDetails(id); if (!details.ok) return details; return ok(JSON.parse(details.data).tracks || []); }
  async function homeSections(page = 0) { if (Number(page) > 0) return ok([]); const rows = await Promise.all(['trending music', 'new music releases', 'popular hip hop'].map(query => searchResults(query, 0))); return ok(rows.filter(row => row.ok).map((row, index) => ({ title: ['Trending', 'New Releases', 'Popular'][index], type: 'track', items: JSON.parse(row.data).slice(0, 12) }))); }

  const browse = async browseId => post(`${YT_API}/browse?alt=json`, { context, browseId });
  const shelfItems = data => {
    const tabs = data?.contents?.singleColumnBrowseResultsRenderer?.tabs || data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || data?.contents?.sectionListRenderer?.contents || [];
    return sections.flatMap(section => section.musicShelfRenderer?.contents || section.musicCarouselShelfRenderer?.contents?.flatMap(shelf => shelf.musicResponsiveListItemRenderer ? [shelf] : shelf.musicTwoRowItemRenderer ? [shelf] : []) || []);
  };
  const parseListItem = item => {
    const columns = item?.musicResponsiveListItemRenderer?.flexColumns || item?.musicTwoRowItemRenderer;
    if (!columns) return null;
    const rows = Array.isArray(columns) ? columns : columns.title ? [{ ...columns.title, musicResponsiveListItemFlexColumnRenderer: columns.title }, columns.subtitle && { musicResponsiveListItemFlexColumnRenderer: { text: columns.subtitle } }].filter(Boolean) : [];
    const runsOf = column => column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const id = item?.musicResponsiveListItemRenderer?.playlistItemData?.videoId || item?.musicResponsiveListItemRenderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId || item?.musicTwoRowItemRenderer?.navigationEndpoint?.watchEndpoint?.videoId || item?.musicTwoRowItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const titleRuns = runsOf(rows[0]);
    const subRuns = runsOf(rows[1]);
    const thumbs = item?.musicResponsiveListItemRenderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || item?.musicTwoRowItemRenderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails;
    const isBrowse = id.startsWith('MPRE') || id.startsWith('MPUC') || id.startsWith('VL') || id.startsWith('MP') || id.startsWith('UC');
    return { id: `freefy:${id}`, href: `freefy:${id}`, type: isBrowse ? 'collection' : 'track', title: text(titleRuns[0]?.text) || 'Track', artist: text(subRuns[0]?.text) || 'Unknown Artist', album: subRuns.length > 2 ? text(subRuns[2]?.text) : undefined, image: image(thumbs), durationSeconds: (() => { const m = text(subRuns[subRuns.length - 1]?.text).match(/(\d+):(\d+)/); return m ? Number(m[1]) * 60 + Number(m[2]) : undefined; })() };
  };

  async function getRadio(seedId) {
    const seed = cleanId(seedId); if (!seed) return fail('Seed track required');
    const key = `radio:${seed}`; const hit = cached(key, 1800000); if (hit) return ok(hit);
    try {
      const data = await post(`${YT_API}/next?alt=json`, { context, videoId: seed, playlistId: `RDAMVM${seed}` });
      const panel = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;
      const items = (panel?.contents || []).map(entry => parseListItem(entry.playlistPanelVideoRenderer || entry)).filter(Boolean);
      if (items.length) return ok(remember(key, items));
    } catch (_) {}
    const seedRes = await searchResults(seed, 0); const first = seedRes.ok ? JSON.parse(seedRes.data)[0] : null;
    return first ? getRadio(first.id) : fail('Radio unavailable');
  }

  async function getAlbum(albumIdOrQuery) {
    const clean = cleanId(albumIdOrQuery); const key = `album:${clean}`; const hit = cached(key, 3600000); if (hit) return ok(hit);
    let browseId = clean.startsWith('MPRE') ? clean : null;
    if (!browseId) {
      try {
        const data = await post(`${YT_API}/search?alt=json`, { context, query: clean, params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' });
        const first = (data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []).flatMap(section => section.musicShelfRenderer?.contents || [])[0];
        const found = first?.playlistItemData?.videoId ? null : first?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
        if (found) browseId = found;
      } catch (_) {}
    }
    if (browseId) {
      try {
        const data = await browse(browseId);
        const items = shelfItems(data).map(parseListItem).filter(Boolean);
        const header = data?.header?.musicDetailHeaderRenderer || data?.header?.musicImmersiveHeaderRenderer;
        const album = { id: `freefy:${browseId}`, href: `freefy:${browseId}`, type: 'album', title: text(header?.title?.runs) || 'Album', artist: text(header?.subtitle?.runs?.[0]?.text) || 'Unknown Artist', year: text(header?.subtitle?.runs?.map(run => run.text).find(t => /^\d{4}/.test(t || ''))) || undefined, image: image(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails), tracks: items };
        if (album.tracks.length) return ok(remember(key, album));
      } catch (_) {}
    }
    const details = await extractDetails(albumIdOrQuery);
    return details.ok ? details : fail('Album unavailable');
  }

  async function getArtist(artistId) {
    const clean = cleanId(artistId); const key = `artist:${clean}`; const hit = cached(key, 3600000); if (hit) return ok(hit);
    try {
      const data = await browse(clean);
      const header = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicDetailHeaderRenderer;
      const shelves = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const artist = { id: `freefy:${clean}`, href: `freefy:${clean}`, type: 'artist', name: text(header?.title?.runs) || 'Artist', image: image(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails), description: text(header?.description?.runs) || undefined, sections: [] };
      for (const shelf of shelves) {
        const renderer = shelf.musicCarouselShelfRenderer;
        const title = text(renderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs);
        const items = (renderer?.contents || []).map(parseListItem).filter(Boolean);
        if (title && items.length) artist.sections.push({ title, type: items[0].type === 'collection' ? 'collection' : 'track', items });
      }
      if (artist.sections.length) return ok(remember(key, artist));
    } catch (_) {}
    return fail('Artist unavailable');
  }

  const GENRES = { pop: 'zgUgcG9w', hiphop: 'zgUdG9w', dance: 'zgUgZGFuY2U', rock: 'zgUgcm9jaw', lofi: 'zgUgbG9maQ', jazz: 'zgUgamF6eg', classical: 'zgUgY2xhc3NpY2Fs', latin: 'zgUgbGF0aW4', kpop: 'zgUga3BvcA', afrobeats: 'zgUgYWZyb2JlYXRz', rnb: 'zgUgcm5i', workout: 'zgUgd29ya291dA', chill: 'zgUgY2hpbGw', country: 'zgUgY291bnRyeQ', metal: 'zgUgbWV0YWw', indie: 'zgUgaW5kaWU' };
  async function getGenreCharts(genreKey, page = 0) {
    if (Number(page) > 0) return ok([]);
    const params = GENRES[String(genreKey || 'pop').toLowerCase()]; if (!params) return fail('Unknown genre');
    const key = `charts:${genreKey}`; const hit = cached(key, 900000); if (hit) return ok(hit);
    try {
      const data = await post(`${YT_API}/search?alt=json`, { context, query: '', params: `${params}IAwoAEAM` });
      const items = (data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []).flatMap(section => section.musicShelfRenderer?.contents || []).map(parseListItem).filter(Boolean);
      return ok(remember(key, items));
    } catch (_) { return fail('Charts unavailable'); }
  }
  async function getLyrics(trackId) {
    const seed = cleanId(trackId); if (!seed) return fail('Track required');
    const key = `lyrics:${seed}`; const hit = cached(key, 86400000); if (hit) return ok(hit);
    try {
      const next = await post(`${YT_API}/next?alt=json`, { context, videoId: seed });
      const tabs = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
      const lyricTab = tabs.find(tab => tab.tabRenderer?.title === 'Lyrics');
      const params = lyricTab?.tabRenderer?.endpoint?.watchEndpoint?.params;
      if (params) {
        const data = await post(`${YT_API}/get_lyrics?alt=json`, { context, videoId: seed, params });
        const lines = (data?.contents?.segmentedLyricsRenderer?.contents || []).map(segment => segment.lyricRun?.text || '').filter(Boolean);
        if (lines.length) return ok(remember(key, { lines }));
      }
    } catch (_) {}
    try { const data = await request(`https://lrclib.net/api/search?q=${encodeURIComponent(seed)}`); if (Array.isArray(data) && data[0]?.plainLyrics) return ok(remember(key, { lines: data[0].plainLyrics.split('\n') })); } catch (_) {}
    return fail('Lyrics unavailable');
  }

  globalThis.searchResults = searchResults; globalThis.homeSections = homeSections; globalThis.extractDetails = extractDetails; globalThis.extractTracks = extractTracks; globalThis.extractAudioUrl = extractAudioUrl; globalThis.getRadio = getRadio; globalThis.getAlbum = getAlbum; globalThis.getArtist = getArtist; globalThis.getGenreCharts = getGenreCharts; globalThis.getLyrics = getLyrics;
})();