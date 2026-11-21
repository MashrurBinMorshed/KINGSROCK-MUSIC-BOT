'use strict';

/**
 * Interface every music provider implements.
 *
 * Providers separate three concerns:
 *   1. search(query)       -> Track[]   (metadata only)
 *   2. resolve(url)        -> Track[]   (metadata for a link this provider owns)
 *   3. getStream(track)    -> { url, isLive }  (a fresh playable URL, right before playback)
 *
 * Keeping getStream() separate lets providers hand out short-lived signed
 * URLs: the stream URL is fetched again every time a track starts, so expired
 * links are never reused.
 *
 * To add a provider, extend this class, implement the methods you support,
 * and register it in src/music/providers/index.js.
 */
class BaseProvider {
  /**
   * @param {object} opts
   * @param {string} opts.name         machine name (used in /play source option)
   * @param {string} opts.displayName  shown to users
   * @param {boolean} [opts.searchable]
   */
  constructor({ name, displayName, searchable = false }) {
    this.name = name;
    this.displayName = displayName;
    this.searchable = searchable;
  }

  /** False when the provider is missing required configuration (e.g. an API key). */
  get isAvailable() {
    return true;
  }

  /** True if this provider owns the given URL (e.g. https://audius.co/...). */
  // eslint-disable-next-line no-unused-vars
  canResolve(url) {
    return false;
  }

  /** @returns {Promise<import('../Track').Track[]>} */
  // eslint-disable-next-line no-unused-vars
  async resolve(url, context) {
    throw new Error(`${this.name} cannot resolve URLs`);
  }

  /** @returns {Promise<import('../Track').Track[]>} */
  // eslint-disable-next-line no-unused-vars
  async search(query, { limit = 5 } = {}) {
    throw new Error(`${this.name} does not support search`);
  }

  /** @returns {Promise<{ url: string, isLive?: boolean }>} */
  // eslint-disable-next-line no-unused-vars
  async getStream(track) {
    throw new Error(`${this.name} cannot stream`);
  }
}

module.exports = { BaseProvider };
