'use strict';

const { BaseProvider } = require('./BaseProvider');
const { Track } = require('../Track');
const { fetchJson, assertPublicUrl, USER_AGENT } = require('../../utils/net');
const { TrackUnavailableError, ProviderError, UnsupportedSourceError } = require('../../utils/errors');

const API = 'https://api.audius.co/v1';
const MAX_PLAYLIST_TRACKS = 50;

/**
 * Audius (https://audius.co) is a music streaming platform with a free,
 * public API intended for third-party apps. Artists upload their own music
 * and the API exposes a stream endpoint for public tracks. No API key is
 * required; requests identify the app with `app_name`.
 *
 * Gated (premium / token-gated) or non-streamable tracks are filtered out.
 * Stream URLs are signed and short-lived, so a fresh one is fetched every
 * time a track starts.
 */
class AudiusProvider extends BaseProvider {
  constructor({ appName = 'KINGSROCK', timeoutMs = 10000, fetchImpl = globalThis.fetch, lookup } = {}) {
    super({ name: 'audius', displayName: 'Audius', searchable: true });
    this.appName = appName;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
  }

  api(path, params = {}) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('app_name', this.appName);
    return url;
  }

  get(path, params) {
    return fetchJson(this.api(path, params), { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, provider: 'Audius' });
  }

  canResolve(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'audius.co' || host === 'www.audius.co';
    } catch {
      return false;
    }
  }

  async search(query, { limit = 5, requestedBy = null } = {}) {
    const body = await this.get('/tracks/search', { query, limit: Math.min(Math.max(limit * 3, 10), 50) });
    const tracks = (Array.isArray(body && body.data) ? body.data : [])
      .filter(isPlayable)
      .slice(0, limit)
      .map((t) => this.toTrack(t, requestedBy));
    return tracks;
  }

  async resolve(url, { requestedBy = null } = {}) {
    let body;
    try {
      body = await this.get('/resolve', { url });
    } catch (err) {
      if (err.status === 404) throw new TrackUnavailableError('That Audius link was not found.');
      throw err;
    }
    const data = body && body.data;
    if (!data) throw new TrackUnavailableError('That Audius link was not found.');

    if (Array.isArray(data)) {
      // Some resolve responses return a list (e.g. playlist)
      return this.mapPlaylist(data, requestedBy);
    }
    if (data.playlist_name !== undefined || data.playlist_id !== undefined) {
      const list = await this.get(`/playlists/${encodeURIComponent(data.id)}/tracks`, {});
      return this.mapPlaylist(list && list.data, requestedBy);
    }
    if (data.title !== undefined && data.duration !== undefined) {
      if (!isPlayable(data)) throw new TrackUnavailableError('That Audius track is not available for streaming (it may be gated or private).');
      return [this.toTrack(data, requestedBy)];
    }
    throw new UnsupportedSourceError('Only Audius track and playlist links are supported.');
  }

  mapPlaylist(list, requestedBy) {
    const tracks = (Array.isArray(list) ? list : []).filter(isPlayable).slice(0, MAX_PLAYLIST_TRACKS);
    if (!tracks.length) throw new TrackUnavailableError('That Audius playlist has no streamable tracks.');
    return tracks.map((t) => this.toTrack(t, requestedBy));
  }

  toTrack(t, requestedBy) {
    const art = t.artwork || {};
    return new Track({
      source: this.name,
      sourceId: t.id,
      title: t.title,
      artist: t.user && t.user.name,
      durationMs: Number(t.duration) * 1000,
      thumbnail: art['480x480'] || art['150x150'] || null,
      url: t.permalink ? `https://audius.co${t.permalink}` : null,
      isLive: false,
      requestedBy,
    });
  }

  async getStream(track) {
    const url = this.api(`/tracks/${encodeURIComponent(track.sourceId)}/stream`);
    let response;
    try {
      response = await this.fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      throw new ProviderError('Could not reach Audius. Try again shortly.', { cause: err });
    }
    try {
      if (response.body) await response.body.cancel();
    } catch {
      /* ignore */
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const target = await assertPublicUrl(new URL(location, url), { lookup: this.lookup });
      return { url: target.toString(), isLive: false };
    }
    if (response.status === 404 || response.status === 403) {
      throw new TrackUnavailableError('This Audius track is no longer available for streaming.');
    }
    throw new ProviderError(`Audius returned an unexpected response (HTTP ${response.status}).`);
  }
}

function isPlayable(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.is_delete || t.is_available === false) return false;
  if (t.is_streamable === false) return false;
  if (t.is_stream_gated || t.stream_conditions) return false;
  if (t.access && t.access.stream === false) return false;
  return Boolean(t.id && t.title);
}

module.exports = { AudiusProvider, isPlayable };
