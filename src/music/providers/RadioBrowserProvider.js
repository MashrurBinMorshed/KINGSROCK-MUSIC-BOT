'use strict';

const { BaseProvider } = require('./BaseProvider');
const { Track } = require('../Track');
const { fetchJson, assertPublicUrl } = require('../../utils/net');
const { TrackUnavailableError } = require('../../utils/errors');

const SERVER_LIST = 'https://all.api.radio-browser.info/json/servers';
const FALLBACK_SERVERS = ['de1.api.radio-browser.info'];
const SERVER_CACHE_MS = 60 * 60 * 1000;
const PLAYLIST_EXTENSIONS = /\.(m3u|pls)(\?|$)/i;

/**
 * Radio Browser (https://www.radio-browser.info) is a free, community-run,
 * open database of public internet radio stations. No API key needed.
 *
 * These are stations that broadcast publicly on the internet. Responsibility
 * for what is broadcast lies with each station; check local rules if you run a
 * large public server.
 */
class RadioBrowserProvider extends BaseProvider {
  constructor({ timeoutMs = 10000, fetchImpl = globalThis.fetch, directProvider = null, lookup } = {}) {
    super({ name: 'radio', displayName: 'Internet radio (Radio Browser)', searchable: true });
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.directProvider = directProvider;
    this.lookup = lookup;
    this.servers = null;
    this.serversFetchedAt = 0;
  }

  async server() {
    const now = Date.now();
    if (!this.servers || now - this.serversFetchedAt > SERVER_CACHE_MS) {
      try {
        const list = await fetchJson(SERVER_LIST, { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, provider: 'Radio Browser' });
        const names = [...new Set((Array.isArray(list) ? list : []).map((s) => s && s.name).filter(Boolean))];
        this.servers = names.length ? names : FALLBACK_SERVERS;
      } catch {
        this.servers = FALLBACK_SERVERS;
      }
      this.serversFetchedAt = now;
    }
    return this.servers[Math.floor(Math.random() * this.servers.length)];
  }

  async get(path, params = {}) {
    const url = new URL(`https://${await this.server()}/json${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return fetchJson(url, { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, provider: 'Radio Browser' });
  }

  async search(query, { limit = 5, requestedBy = null } = {}) {
    const common = { limit: Math.min(limit, 25), hidebroken: 'true', order: 'clickcount', reverse: 'true' };
    const byName = await this.get('/stations/search', { ...common, name: query });
    let stations = Array.isArray(byName) ? byName : [];
    if (stations.length < limit) {
      const byTag = await this.get('/stations/search', { ...common, tag: query.toLowerCase() }).catch(() => []);
      const seen = new Set(stations.map((s) => s.stationuuid));
      for (const s of Array.isArray(byTag) ? byTag : []) if (!seen.has(s.stationuuid)) stations.push(s);
    }
    return stations
      .filter((s) => s && s.stationuuid && (s.url_resolved || s.url))
      .slice(0, limit)
      .map((s) => this.toTrack(s, requestedBy));
  }

  toTrack(s, requestedBy) {
    const details = [s.country, s.codec && s.bitrate ? `${s.codec} ${s.bitrate} kbps` : s.codec].filter(Boolean).join(' · ');
    return new Track({
      source: this.name,
      sourceId: s.stationuuid,
      title: String(s.name || 'Radio station').trim(),
      artist: details || 'Internet radio',
      thumbnail: /^https:\/\//i.test(s.favicon || '') ? s.favicon : null,
      url: /^https?:\/\//i.test(s.homepage || '') ? s.homepage : null,
      streamUrl: s.url_resolved || s.url,
      isLive: true,
      requestedBy,
      extra: { hls: Boolean(s.hls), tags: s.tags || '' },
    });
  }

  async getStream(track) {
    // /json/url/<uuid> returns the current stream URL and registers a "click",
    // which Radio Browser asks clients to do when a station is played.
    let url = track.streamUrl;
    try {
      const res = await this.get(`/url/${encodeURIComponent(track.sourceId)}`);
      if (res && res.ok !== false && res.url) url = res.url;
    } catch (err) {
      if (err.status === 404) throw new TrackUnavailableError('This radio station is no longer listed.');
      // keep the cached URL if the API is briefly unavailable
    }
    if (!url) throw new TrackUnavailableError('This radio station has no stream URL.');

    if (!track.extra.hls && PLAYLIST_EXTENSIONS.test(url) && this.directProvider) {
      const info = await this.directProvider.inspect(url, 0);
      return { url: info.streamUrl, isLive: true };
    }
    const checked = await assertPublicUrl(url, { lookup: this.lookup });
    return { url: checked.toString(), isLive: true };
  }
}

module.exports = { RadioBrowserProvider };
