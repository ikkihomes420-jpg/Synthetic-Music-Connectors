(() => {
  'use strict';

  const API = 'https://one.synthetiq.uk/music-gateway-staging/v1';
  const REQUEST_TIMEOUT_MS = 12000;

  function ok(data) { return { ok: true, data: JSON.stringify(data) }; }
  function fail(message) { return { ok: false, error: { message: String(message || 'Music gateway unavailable') } }; }

  async function request(path, body) {
    const url = API + path;
    const headers = { Accept: 'application/json' };
    let response;
    if (typeof fetchv2 === 'function') {
      if (body) headers['Content-Type'] = 'application/json';
      response = await fetchv2(url, headers, body ? 'POST' : 'GET', body ? JSON.stringify(body) : null);
    } else if (typeof fetch === 'function') {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
      try {
        response = await fetch(url, {
          method: body ? 'POST' : 'GET',
          headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller ? controller.signal : undefined,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const status = Number(response && response.status || 0);
    if (!response || status < 200 || status >= 300) throw new Error('gateway_http_' + status);
    if (typeof response.json === 'function') return await response.json();
    return JSON.parse(await response.text());
  }

  function toTrack(item) {
    if (!item || !item.providerId || !item.providerItemId || !item.title) return null;
    return {
      id: item.providerId + ':song:' + item.providerItemId,
      href: item.providerId + ':song:' + item.providerItemId,
      type: 'track',
      title: String(item.title),
      artist: String(item.artist || 'Unknown Artist'),
      album: item.album || undefined,
      image: item.image || undefined,
      durationSeconds: Number(item.durationSeconds) || undefined,
    };
  }

  function parseTrack(id) {
    const match = String(id || '').match(/^([^:]+):song:(.+)$/);
    return match ? { providerId: match[1], providerItemId: match[2] } : null;
  }

  async function searchResults(query, page) {
    try {
      const term = String(query || '').trim();
      if (!term) return ok([]);
      const result = await request('/search', { query: term, page: Number(page) + 1 || 1, limit: 24 });
      return ok((result.items || []).map(toTrack).filter(Boolean));
    } catch (_) {
      return fail('Music search is temporarily unavailable.');
    }
  }

  async function extractAudioUrl(trackId, quality) {
    try {
      const track = parseTrack(trackId);
      if (!track) throw new Error('invalid_track');
      const resolved = await request('/resolve', { track });
      if (!resolved.streamUrl) throw new Error('missing_stream');
      return ok({
        url: new URL(resolved.streamUrl, API).toString(),
        headers: {},
        mimeType: 'audio/mp4',
        extension: 'mp4',
        title: resolved.track && resolved.track.title || 'Track',
        artist: resolved.track && resolved.track.artist || 'Unknown Artist',
        album: resolved.track && resolved.track.album || '',
        artwork: resolved.track && resolved.track.image || '',
        durationSeconds: resolved.track && resolved.track.durationSeconds,
        quality: resolved.quality || quality || 'high',
      });
    } catch (_) {
      return fail('No authorised full-length route is available for this track.');
    }
  }

  async function extractDetails() { return fail('This source publishes songs directly.'); }
  async function extractTracks() { return fail('This source publishes songs directly.'); }

  async function homeSections(page) {
    if (Number(page) > 0) return ok([]);
    const sections = [];
    for (const row of [{ title: 'Popular now', query: 'popular music' }, { title: 'Recently released', query: 'new music' }]) {
      const result = await searchResults(row.query, 0);
      if (!result.ok) continue;
      const items = JSON.parse(result.data);
      if (items.length) sections.push({ title: row.title, type: 'track', items: items.slice(0, 12) });
    }
    return sections.length ? ok(sections) : fail('Music discovery is temporarily unavailable.');
  }

  globalThis.searchResults = searchResults;
  globalThis.homeSections = homeSections;
  globalThis.extractDetails = extractDetails;
  globalThis.extractTracks = extractTracks;
  globalThis.extractAudioUrl = extractAudioUrl;
})();
