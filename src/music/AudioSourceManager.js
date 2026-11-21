'use strict';

const { parseHttpUrl } = require('../utils/net');
const { UserError, UnsupportedSourceError, ProviderError, KingsrockError, TrackUnavailableError } = require('../utils/errors');

/**
 * Platforms KINGSROCK deliberately does not play, with the reason shown to users.
 * These services do not offer a public API that allows streaming their audio
 * into Discord, so playing them would require scraping / DRM circumvention.
 */
const BLOCKED_PLATFORMS = [
  { pattern: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i, name: 'YouTube' },
  { pattern: /(^|\.)(spotify\.com|spotify\.link)$/i, name: 'Spotify' },
  { pattern: /(^|\.)(soundcloud\.com|snd\.sc)$/i, name: 'SoundCloud' },
  { pattern: /(^|\.)music\.apple\.com$/i, name: 'Apple Music' },
  { pattern: /(^|\.)(deezer\.com|deezer\.page\.link)$/i, name: 'Deezer' },
  { pattern: /(^|\.)tidal\.com$/i, name: 'TIDAL' },
  { pattern: /(^|\.)music\.amazon\.[a-z.]+$/i, name: 'Amazon Music' },
  { pattern: /(^|\.)bandcamp\.com$/i, name: 'Bandcamp' },
  { pattern: /(^|\.)(twitch\.tv)$/i, name: 'Twitch' },
];

const SOURCE_PREFIX = /^(audius|radio|archive|jamendo|youtube|yt)\s*:\s*(.+)$/i;
const PREFIX_ALIASES = { yt: 'youtube' };
const MAX_QUERY_LENGTH = 500;

/**
 * Routes requests to providers:
 *   - URLs   -> the provider that owns the domain, else the direct provider
 *   - text   -> a search provider (explicit, prefixed "radio: lofi", or default)
 *   - stream -> provider.getStream(track) right before playback
 */
class AudioSourceManager {
  constructor({ providers = [], defaultSearch = 'audius', logger = null } = {}) {
    this.providers = new Map();
    this.logger = logger;
    for (const p of providers) this.register(p);
    this.defaultSearch = defaultSearch;
  }

  register(provider) {
    if (!provider || !provider.name) throw new TypeError('Provider must have a name');
    this.providers.set(provider.name, provider);
  }

  get(name) {
    return this.providers.get(name) || null;
  }

  /** Enabled providers that support text search, default first. */
  searchProviders() {
    const list = [...this.providers.values()].filter((p) => p.searchable && p.isAvailable);
    list.sort((a, b) => (a.name === this.defaultSearch ? -1 : b.name === this.defaultSearch ? 1 : 0));
    return list;
  }

  /** Splits "radio: lofi" into { source: 'radio', query: 'lofi' }. */
  parseQuery(raw, source = 'auto') {
    const query = String(raw || '').trim();
    if (!query) throw new UserError('Please type a song, artist, radio station or link.');
    if (query.length > MAX_QUERY_LENGTH) throw new UserError(`That request is too long (max ${MAX_QUERY_LENGTH} characters).`);
    const prefixed = query.match(SOURCE_PREFIX);
    if (prefixed && (!source || source === 'auto')) {
      const name = prefixed[1].toLowerCase();
      return { source: PREFIX_ALIASES[name] || name, query: prefixed[2].trim() };
    }
    return { source: source || 'auto', query };
  }

  /** Throws a clear message for platforms that cannot be played legitimately. */
  assertAllowedUrl(url) {
    const host = url.hostname.toLowerCase();
    const blocked = BLOCKED_PLATFORMS.find((b) => b.pattern.test(host));
    if (blocked && blocked.name === 'YouTube') {
      throw new UnsupportedSourceError(
        'YouTube playback is turned off on this bot. The bot owner can enable it with `YOUTUBE_ENABLED=true` (see SETUP.md). '
        + 'Meanwhile, search by name or use radio / direct audio links.',
      );
    }
    if (blocked) {
      throw new UnsupportedSourceError(
        `${blocked.name} links can't be played. ${blocked.name} does not provide an authorized way to stream its audio into Discord, `
        + 'and KINGSROCK does not scrape or bypass protections. Try searching by name instead '
        + '(Audius, Internet Archive, Jamendo or radio), or use a direct audio / radio stream link.',
      );
    }
  }

  /**
   * Resolves a /play request into tracks (a URL may yield several, e.g. a playlist).
   * @returns {Promise<import('./Track').Track[]>}
   */
  async resolve(rawQuery, { source = 'auto', requestedBy = null } = {}) {
    const parsed = this.parseQuery(rawQuery, source);
    const url = parseHttpUrl(parsed.query);

    if (url) {
      // An enabled provider that owns the domain (e.g. YouTube when enabled) wins over the block list.
      const owner = [...this.providers.values()].find((p) => p.name !== 'direct' && p.isAvailable && p.canResolve(url.toString()));
      if (!owner) this.assertAllowedUrl(url);
      const provider = owner || this.get('direct');
      if (!provider) throw new UnsupportedSourceError('Direct links are disabled on this bot.');
      const tracks = await this.wrap(provider, () => provider.resolve(url.toString(), { requestedBy }));
      if (!tracks.length) throw new TrackUnavailableError('Nothing playable was found at that link.');
      return tracks;
    }

    const results = await this.search(parsed.query, { source: parsed.source, limit: 1, requestedBy });
    if (!results.length) {
      throw new TrackUnavailableError(`No results for **${parsed.query.slice(0, 100)}**. Try different words or another source.`);
    }
    return [await this.hydrate(results[0])];
  }

  /**
   * Text search. With source "auto", tries the default provider first and
   * falls back to the others until something is found.
   */
  async search(rawQuery, { source = 'auto', limit = 5, requestedBy = null } = {}) {
    const parsed = this.parseQuery(rawQuery, source);
    if (parseHttpUrl(parsed.query)) throw new UserError('Use /play for links. /search is for searching by name.');

    let providers;
    if (parsed.source === 'auto') {
      providers = this.searchProviders().filter((p) => p.name !== 'radio');
      if (!providers.length) providers = this.searchProviders();
    } else {
      const p = this.get(parsed.source);
      if (!p || !p.searchable) throw new UserError(`Unknown source "${parsed.source}".`);
      if (!p.isAvailable) throw new UserError(`${p.displayName} is not configured on this bot.`);
      providers = [p];
    }
    if (!providers.length) throw new UnsupportedSourceError('No search providers are enabled. You can still play direct audio links.');

    let lastError = null;
    for (const provider of providers) {
      try {
        const results = await this.wrap(provider, () => provider.search(parsed.query, { limit, requestedBy }));
        if (results.length) return results;
      } catch (err) {
        lastError = err;
        if (this.logger) this.logger.warn(`Search failed on ${provider.name}: ${err.message}`);
      }
    }
    if (lastError && providers.length === 1) throw lastError;
    return [];
  }

  /** Lets a provider complete lightweight search results (e.g. pick an archive file). */
  async hydrate(track) {
    const provider = this.get(track.source);
    if (provider && typeof provider.hydrate === 'function') {
      return this.wrap(provider, () => provider.hydrate(track));
    }
    return track;
  }

  /** Fresh playable stream info for a track. */
  async getStream(track) {
    const provider = this.get(track.source);
    if (!provider) throw new UnsupportedSourceError(`The ${track.source} source is not enabled anymore.`);
    const stream = await this.wrap(provider, () => provider.getStream(track));
    if (!stream || !stream.url) throw new TrackUnavailableError('No playable stream was found for this track.');
    return stream;
  }

  /** Converts unexpected provider exceptions into ProviderError. */
  async wrap(provider, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof KingsrockError) throw err;
      if (this.logger) this.logger.error(`Provider ${provider.name} failed:`, err);
      throw new ProviderError(`${provider.displayName} is having problems right now. Try again shortly.`, { cause: err });
    }
  }
}

module.exports = { AudioSourceManager, BLOCKED_PLATFORMS };
