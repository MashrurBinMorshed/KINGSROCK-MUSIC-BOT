'use strict';

const { BaseProvider } = require('./BaseProvider');
const { Track } = require('../Track');
const { fetchJson, assertPublicUrl } = require('../../utils/net');
const { TrackUnavailableError, ProviderError } = require('../../utils/errors');

const API = 'https://api.jamendo.com/v3.0';

/**
 * Jamendo (https://www.jamendo.com) hosts independent music released under
 * Creative Commons licenses and offers a free API for non-commercial use.
 *
 * Requires a free client ID from https://devportal.jamendo.com. Without
 * JAMENDO_CLIENT_ID this provider is disabled automatically.
 */
class JamendoProvider extends BaseProvider {
  constructor({ clientId = null, timeoutMs = 10000, fetchImpl = globalThis.fetch, lookup } = {}) {
    super({ name: 'jamendo', displayName: 'Jamendo (Creative Commons)', searchable: true });
    this.clientId = clientId;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
  }

  get isAvailable() {
    return Boolean(this.clientId);
  }

  canResolve(url) {
    try {
      const u = new URL(url);
      return /(^|\.)jamendo\.com$/i.test(u.hostname) && /\/track\/\d+/.test(u.pathname);
    } catch {
      return false;
    }
  }

  async query(params) {
    if (!this.clientId) throw new ProviderError('Jamendo is not configured on this bot (JAMENDO_CLIENT_ID is missing).');
    const url = new URL(`${API}/tracks/`);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('audioformat', 'mp32');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const body = await fetchJson(url, { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, provider: 'Jamendo' });
    const headers = (body && body.headers) || {};
    if (headers.status && headers.status !== 'success') {
      throw new ProviderError(`Jamendo rejected the request: ${headers.error_message || 'unknown error'}`);
    }
    return Array.isArray(body && body.results) ? body.results : [];
  }

  async search(query, { limit = 5, requestedBy = null } = {}) {
    const results = await this.query({ search: query, limit: Math.min(limit, 25) });
    return results.filter((r) => r.id && r.audio).map((r) => this.toTrack(r, requestedBy));
  }

  async resolve(url, { requestedBy = null } = {}) {
    const id = new URL(url).pathname.match(/\/track\/(\d+)/)[1];
    const [result] = await this.query({ id });
    if (!result) throw new TrackUnavailableError('That Jamendo track was not found.');
    return [this.toTrack(result, requestedBy)];
  }

  toTrack(r, requestedBy) {
    return new Track({
      source: this.name,
      sourceId: String(r.id),
      title: r.name,
      artist: r.artist_name,
      durationMs: Number(r.duration) * 1000,
      thumbnail: r.album_image || r.image || null,
      url: r.shareurl || `https://www.jamendo.com/track/${r.id}`,
      streamUrl: r.audio,
      requestedBy,
      extra: { license: r.license_ccurl || null },
    });
  }

  async getStream(track) {
    // Re-query for a fresh audio URL rather than trusting a possibly stale one.
    const [result] = await this.query({ id: track.sourceId });
    if (!result || !result.audio) throw new TrackUnavailableError('This Jamendo track is no longer available.');
    const checked = await assertPublicUrl(result.audio, { lookup: this.lookup });
    return { url: checked.toString(), isLive: false };
  }
}

module.exports = { JamendoProvider };
