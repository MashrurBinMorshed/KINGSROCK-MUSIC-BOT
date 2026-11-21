'use strict';

const crypto = require('node:crypto');

/**
 * Track metadata. A Track never holds an open stream: it describes *what* to
 * play. The playable stream URL is resolved by the owning provider right
 * before playback (AudioSourceManager.getStream), because many providers hand
 * out signed URLs that expire.
 */
class Track {
  /**
   * @param {object} data
   * @param {string} data.source        provider name (direct, audius, radio, archive, jamendo)
   * @param {string} data.title
   * @param {string} [data.sourceId]    provider specific id used to re-resolve the stream
   * @param {string|null} [data.artist]
   * @param {number|null} [data.durationMs]
   * @param {string|null} [data.thumbnail]
   * @param {string|null} [data.url]    human facing link (track page / original URL)
   * @param {string|null} [data.streamUrl] already known playable URL (direct sources)
   * @param {boolean} [data.isLive]     live stream / radio (no duration, no seeking)
   * @param {object|null} [data.requestedBy] { id, tag }
   * @param {object} [data.extra]       provider specific data
   */
  constructor(data) {
    if (!data || typeof data !== 'object') throw new TypeError('Track data is required');
    if (!data.source) throw new TypeError('Track.source is required');
    this.id = crypto.randomUUID();
    this.source = data.source;
    this.sourceId = data.sourceId ?? null;
    this.title = String(data.title || 'Unknown track').slice(0, 256);
    this.artist = data.artist ? String(data.artist).slice(0, 256) : null;
    this.durationMs = Number.isFinite(data.durationMs) && data.durationMs > 0 ? Math.round(data.durationMs) : null;
    this.thumbnail = data.thumbnail || null;
    this.url = data.url || null;
    this.streamUrl = data.streamUrl || null;
    this.isLive = Boolean(data.isLive);
    this.requestedBy = data.requestedBy || null;
    this.extra = data.extra || {};
  }

  /** Copy of this track for another requester (keeps metadata, new id). */
  withRequester(requestedBy) {
    const copy = new Track({ ...this, requestedBy });
    return copy;
  }

  get displayTitle() {
    return this.artist ? `${this.title} — ${this.artist}` : this.title;
  }

  toJSON() {
    return {
      id: this.id,
      source: this.source,
      title: this.title,
      artist: this.artist,
      durationMs: this.durationMs,
      isLive: this.isLive,
      url: this.url,
      requestedBy: this.requestedBy,
    };
  }
}

module.exports = { Track };
