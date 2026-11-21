'use strict';

const { BaseProvider } = require('./BaseProvider');
const { Track } = require('../Track');
const { fetchJson } = require('../../utils/net');
const { TrackUnavailableError, UnsupportedSourceError } = require('../../utils/errors');
const { parseDurationToMs } = require('../../utils/format');

const SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA = 'https://archive.org/metadata';
const MAX_ITEM_TRACKS = 50;

/** Only items explicitly released under Creative Commons or into the public domain. */
const LICENSE_FILTER = '(licenseurl:*creativecommons.org* OR licenseurl:*publicdomain*)';
const OPEN_LICENSE = /creativecommons\.org|publicdomain/i;

/** Preferred file formats, best first (small, widely supported). */
const FORMAT_RANK = ['VBR MP3', '128Kbps MP3', 'MP3', '64Kbps MP3', 'Ogg Vorbis', 'Opus', 'Flac', '24bit Flac', 'Apple Lossless Audio', 'WAVE'];

/**
 * Internet Archive (https://archive.org) audio items that carry a Creative
 * Commons or public-domain license. Items without such a license are refused,
 * even when pasted as a link.
 *
 * Search returns items; when an item is queued it is "hydrated" into its
 * first audio file. Pasting an archive.org/details/<id> link queues every
 * audio file of the item (up to 50).
 */
class InternetArchiveProvider extends BaseProvider {
  constructor({ timeoutMs = 10000, fetchImpl = globalThis.fetch } = {}) {
    super({ name: 'archive', displayName: 'Internet Archive (CC / public domain)', searchable: true });
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  canResolve(url) {
    try {
      const u = new URL(url);
      return /(^|\.)archive\.org$/i.test(u.hostname) && /^\/(details|download)\/[^/]+/.test(u.pathname);
    } catch {
      return false;
    }
  }

  async search(query, { limit = 5, requestedBy = null } = {}) {
    const clean = sanitizeQuery(query);
    if (!clean) return [];
    const url = new URL(SEARCH);
    url.searchParams.set('q', `(${clean}) AND mediatype:(audio OR etree) AND ${LICENSE_FILTER}`);
    for (const f of ['identifier', 'title', 'creator', 'licenseurl']) url.searchParams.append('fl[]', f);
    url.searchParams.append('sort[]', 'downloads desc');
    url.searchParams.set('rows', String(Math.min(limit, 25)));
    url.searchParams.set('output', 'json');
    const body = await fetchJson(url, { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, provider: 'Internet Archive' });
    const docs = (body && body.response && Array.isArray(body.response.docs)) ? body.response.docs : [];
    return docs
      .filter((d) => d.identifier && OPEN_LICENSE.test(String(d.licenseurl || '')))
      .slice(0, limit)
      .map((d) => new Track({
        source: this.name,
        sourceId: d.identifier,
        title: firstString(d.title) || d.identifier,
        artist: firstString(d.creator),
        thumbnail: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
        url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
        requestedBy,
        extra: { item: true },
      }));
  }

  /** Turns a search result (an item) into its first playable audio file. */
  async hydrate(track) {
    if (!track.extra.item) return track;
    const [first] = await this.itemTracks(track.sourceId, { requestedBy: track.requestedBy, limit: 1 });
    return first;
  }

  async resolve(url, { requestedBy = null } = {}) {
    const u = new URL(url);
    const [, , identifier, ...fileParts] = u.pathname.split('/');
    const fileName = fileParts.length ? decodeURIComponent(fileParts.join('/')) : null;
    const tracks = await this.itemTracks(decodeURIComponent(identifier), { requestedBy, limit: MAX_ITEM_TRACKS });
    if (fileName) {
      const match = tracks.find((t) => t.extra.fileName === fileName || t.extra.original === fileName);
      if (match) return [match];
    }
    return tracks;
  }

  async itemTracks(identifier, { requestedBy, limit }) {
    let meta;
    try {
      meta = await fetchJson(`${METADATA}/${encodeURIComponent(identifier)}`, { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, provider: 'Internet Archive' });
    } catch (err) {
      if (err.status === 404) throw new TrackUnavailableError('That Internet Archive item was not found.');
      throw err;
    }
    if (!meta || !meta.metadata || !Array.isArray(meta.files)) throw new TrackUnavailableError('That Internet Archive item was not found.');
    if (meta.is_dark || meta.metadata.access_restricted_item) throw new TrackUnavailableError('That Internet Archive item is not publicly available.');

    const license = String(meta.metadata.licenseurl || '');
    if (!OPEN_LICENSE.test(license)) {
      throw new UnsupportedSourceError('That Internet Archive item has no Creative Commons or public-domain license, so KINGSROCK will not stream it.');
    }

    const files = pickAudioFiles(meta.files).slice(0, limit);
    if (!files.length) throw new TrackUnavailableError('That Internet Archive item has no playable audio files.');

    const itemTitle = firstString(meta.metadata.title) || identifier;
    const itemCreator = firstString(meta.metadata.creator);
    return files.map((f) => new Track({
      source: this.name,
      sourceId: identifier,
      title: f.title || (files.length === 1 ? itemTitle : stripExtension(f.name)),
      artist: f.artist || f.creator || itemCreator,
      durationMs: parseDurationToMs(f.length),
      thumbnail: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
      url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
      streamUrl: `https://archive.org/download/${encodeURIComponent(identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      requestedBy,
      extra: { fileName: f.name, original: f.original || null, license },
    }));
  }

  async getStream(track) {
    if (track.extra.item) {
      const hydrated = await this.hydrate(track);
      return { url: hydrated.streamUrl, isLive: false };
    }
    if (!track.streamUrl) throw new TrackUnavailableError('This Internet Archive track has no audio file.');
    return { url: track.streamUrl, isLive: false };
  }
}

/** One file per original recording, best format first, ordered by track number. */
function pickAudioFiles(files) {
  const groups = new Map();
  for (const f of files) {
    const rank = FORMAT_RANK.indexOf(f.format);
    if (rank === -1 || !f.name) continue;
    const key = f.source === 'derivative' && f.original ? f.original : f.name;
    const existing = groups.get(key);
    if (!existing || rank < existing.rank) groups.set(key, { ...f, rank });
  }
  return [...groups.values()].sort((a, b) => {
    const ta = parseInt(a.track, 10);
    const tb = parseInt(b.track, 10);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

/** Removes Lucene syntax characters so user input is treated as plain words. */
function sanitizeQuery(q) {
  return String(q || '')
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function firstString(v) {
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return v ? String(v) : null;
}

function stripExtension(name) {
  return String(name).split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
}

module.exports = { InternetArchiveProvider, pickAudioFiles, sanitizeQuery };
