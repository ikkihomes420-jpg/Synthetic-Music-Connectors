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
  const YT_CONTEXT = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'US' } };
  const ytCached = (key, ttl) => { const item = YT_CACHE.get(key); return item && Date.now() - item.time < ttl ? item.value : null; };
  const ytRemember = (key, value) => { YT_CACHE.set(key, { time: Date.now(), value }); return value; };
  async function ytPost(path, body) {
    const res = await fetch(YT_API + path + '?alt=json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36' },
      body: JSON.stringify({ context: YT_CONTEXT, ...body })
    });
    if (!res.ok) throw new Error('YT HTTP ' + res.status);
    return res.json();
  }
  function ytText(value) { return Array.isArray(value) ? value.map(item => item.text || '').join('') : String(value || ''); }
  function ytVideoId(item) {
    return item?.videoId || item?.playlistItemData?.videoId || item?.doubleTapCommand?.watchEndpoint?.videoId || item?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  }
  function ytToTrack(item) {
    const videoId = ytVideoId(item);
    if (!videoId) return null;
    const columns = item?.flexColumns || [];
    const runs = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const sub = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const thumbs = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
    const durationMatch = ytText(sub[sub.length - 1]?.text).match(/(\d+):(\d+)/);
    return {
      id: 'synthetiq_music_gateway:yt:' + videoId,
      href: 'synthetiq_music_gateway:yt:' + videoId,
      type: 'track',
      title: ytText(runs[0]?.text) || 'Track',
      artist: ytText(sub[0]?.text) || 'Unknown Artist',
      album: sub.length > 2 ? ytText(sub[2]?.text) : undefined,
      image: Array.isArray(thumbs) ? thumbs[thumbs.length - 1]?.url?.replace(/=w\d+-h\d+.*$/, '=w544-h544') : undefined,
      durationSeconds: durationMatch ? Number(durationMatch[1]) * 60 + Number(durationMatch[2]) : Number(item?.lengthSeconds) || undefined
    };
  }
  async function ytSearch(term, params) {
    const data = await ytPost('/search', { query: term, params });
    const sections = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    return sections.flatMap(section => section.musicShelfRenderer?.contents || section.musicCardShelfRenderer?.contents || []).map(ytToTrack).filter(Boolean);
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
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

  async function searchResults(query, page) {
    const term = String(query || '').trim();
    if (!term) return ok([]);

    // 1. YouTube Music full catalog (primary)
    try {
      const cacheKey = 'search:' + term + ':' + Number(page || 0);
      const cachedResults = ytCached(cacheKey, 300000);
      if (cachedResults) return ok(cachedResults);
      const tracks = await ytSearch(term);
      if (tracks.length) return ok(ytRemember(cacheKey, tracks));
    } catch (_) {}

    // 2. ListenFree mirrors
    try {
      const p = Number(page) + 1 || 1;
      const res = await mirrorGet('/search/songs?query=' + encodeURIComponent(term) + '&page=' + p + '&limit=24');
      const results = res?.data?.results || res?.results || [];
      if (results.length) {
        return ok(results.map(toTrack).filter(Boolean));
      }
    } catch (_) {}

    // 2. Try direct JioSaavn API
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

  async function extractAudioUrl(trackId, quality) {
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

    // 1. YouTube Music stream extraction (full catalog, all regions)
    if (ytVideo) {
      const cacheKey = 'audio:' + ytVideo;
      const cachedAudio = ytCached(cacheKey, 180000);
      if (cachedAudio) return ok(cachedAudio);
      try {
        const audio = await ytAudio(ytVideo, quality);
        if (audio) return ok(ytRemember(cacheKey, audio));
      } catch (_) {}
      return fail('This YouTube track could not be streamed.');
    }

    // 2. Direct mirror lookup by clean song ID
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

      // 2. Direct JioSaavn API + DES-ECB decryption
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

    // 3. Fallback: Search by decoded query or title to find and extract the 320kbps audio link
    const query = queryForFallback || cleanId;
    if (query && query.length > 1) {
      try {
        const searchRes = await searchResults(query, 0);
        if (searchRes.ok) {
          const items = JSON.parse(searchRes.data);
          for (const item of items) {
            if (item.id && item.id !== trackId) {
              const res = await extractAudioUrl(item.id, quality);
              if (res.ok) return res;
            }
          }
        }
      } catch (_) {}
    }

    return fail('No authorised full-length route is available for this track.');
  }

  async function extractDetails(id) {
    const cleanId = String(id || '').replace(/^(album|playlist|synthetiq_music_gateway|synthetiq_music_hub):/, '').trim();

    // 1. YouTube album via browse (full ordered tracklist)
    if (cleanId.startsWith('MPRE')) {
      const cacheKey = 'album:' + cleanId;
      const cachedAlbum = ytCached(cacheKey, 3600000);
      if (cachedAlbum) return ok(cachedAlbum);
      try {
        const data = await ytPost('/browse', { browseId: cleanId });
        const tabs = data?.contents?.singleColumnBrowseResultsRenderer?.tabs || [];
        const shelfContents = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        const tracks = shelfContents.flatMap(section => section.musicShelfRenderer?.contents || [])
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
        const header = data?.header?.musicDetailHeaderRenderer || data?.header?.musicImmersiveHeaderRenderer;
        if (tracks.length) {
          const album = {
            id: cleanId,
            title: ytText(header?.title?.runs) || 'Album',
            artist: ytText(header?.subtitle?.runs?.[0]?.text) || 'Various Artists',
            image: Array.isArray(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails) ? header.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails.slice(-1)[0]?.url : undefined,
            year: ytText(header?.subtitle?.runs?.map(run => run.text).find(t => /^\d{4}/.test(t || ''))) || undefined,
            tracks
          };
          return ok(ytRemember(cacheKey, album));
        }
      } catch (_) {}
      return fail('Album details unavailable.');
    }

    // 2. ListenFree mirrors
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

  async function homeSections(page) {
    if (Number(page) > 0) return ok([]);
    const sections = [];
    // 1. YouTube Music charts (real trending, refreshed by YouTube)
    try {
      const cachedSections = ytCached('home', 900000);
      if (cachedSections) return ok(cachedSections);
      const charts = [
        { title: 'Trending Worldwide', params: 'Ege4w7uDmZoHAxIQk7LNpI0RUq5cUNhSYQ%3D%3D' },
        { title: 'Top Music Videos', params: 'Ege4w7uDmZoHAxIQk7LNpI0RUq5cUNhSYQ%3D%3D' }
      ];
      for (const chart of charts) {
        try {
          const data = await ytPost('/search', { query: '', params: chart.params });
          const items = (data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [])
            .flatMap(section => section.musicShelfRenderer?.contents || [])
            .map(ytToTrack).filter(Boolean);
          if (items.length) sections.push({ title: chart.title, type: 'track', items: items.slice(0, 24) });
        } catch (_) {}
      }
    } catch (_) {}
    // 2. Search-based fallback sections
    const queries = [
      { title: 'Top Hits & Trending', query: 'top hits' },
      { title: 'New Releases', query: 'latest songs' },
      { title: 'Popular Worldwide', query: 'global hits' }
    ];
    for (const row of queries) {
      if (sections.length >= 3) break;
      const result = await searchResults(row.query, 0);
      if (result.ok) {
        const items = JSON.parse(result.data);
        if (items.length) sections.push({ title: row.title, type: 'track', items: items.slice(0, 12) });
      }
    }
    return sections.length ? ok(sections) : fail('Music discovery is temporarily unavailable.');
  }

  async function getRelatedTracks(seedId) {
    const seed = String(seedId || '').trim();
    let ytVideo = null;
    if (/^(synthetiq_music_gateway|synthetiq_music_hub|freefy):yt:/.test(seed)) {
      ytVideo = seed.split(':yt:')[1];
    } else if (seed && !seed.startsWith('catalogue:') && seed.indexOf(':') === -1 && seed.length >= 8) {
      ytVideo = seed;
    }
    // 1. YouTube radio engine (real recommendations from the seed track)
    if (ytVideo) {
      const cacheKey = 'radio:' + ytVideo;
      const cachedRadio = ytCached(cacheKey, 1800000);
      if (cachedRadio) return ok(cachedRadio);
      try {
        const tracks = await ytRadio(ytVideo);
        if (tracks.length) return ok(ytRemember(cacheKey, tracks.filter(t => t.id !== seedId)));
      } catch (_) {}
    }
    // 2. Seed by searching the track title, then build radio from top hit
    if (seed.startsWith('catalogue:')) {
      const query = parseTrackQuery(seed);
      if (query) {
        try {
          const results = await ytSearch(query);
          if (results.length) return getRelatedTracks(results[0].id);
        } catch (_) {}
      }
    }
    // 3. Fallback: same-artist tracks via YouTube search
    if (ytVideo) {
      try {
        const details = await ytSearch(ytVideo);
        if (details.length) {
          const artist = details[0].artist;
          const tracks = await ytSearch(artist);
          if (tracks.length) return ok(tracks.filter(t => t.id !== seedId));
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
})();

