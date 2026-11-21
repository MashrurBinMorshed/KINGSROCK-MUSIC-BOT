'use strict';

const { BaseProvider } = require('./BaseProvider');
const { Track } = require('../Track');
const { safeFetch, readBodyPrefix, discardBody, assertPublicUrl, parseHttpUrl } = require('../../utils/net');
const { UnsupportedSourceError, TrackUnavailableError, ProviderError } = require('../../utils/errors');
const { titleFromUrl } = require('../../utils/format');
const { probe: defaultProbe, describeFfmpegError } = require('../FFmpeg');

const AUDIO_EXTENSIONS = /\.(mp3|ogg|oga|opus|m4a|aac|flac|wav|webm|weba|mka|mp4|m4b|wma|aiff?)$/i;
const PLAYLIST_EXTENSIONS = /\.(m3u8?|pls)$/i;
const PLAYLIST_TYPES = [
  'audio/x-mpegurl', 'audio/mpegurl', 'application/x-mpegurl', 'application/vnd.apple.mpegurl',
  'audio/x-scpls', 'application/pls+xml', 'audio/scpls',
];
const MAX_PLAYLIST_DEPTH = 2;

/**
 * Plays legitimate direct audio links and public radio streams:
 *   - audio files: .mp3 .ogg .opus .m4a .aac .flac .wav .webm ...
 *   - Icecast / Shoutcast radio streams
 *   - .m3u / .pls playlists (resolved to the first working stream)
 *   - HLS (.m3u8) streams
 *
 * Every hop is validated against private / internal addresses (SSRF
 * protection), because the bot fetches URLs on behalf of Discord users while
 * running on a cloud VM.
 */
class DirectUrlProvider extends BaseProvider {
  constructor({ timeoutMs = 10000, allowPrivate = false, ffprobePath = 'ffprobe', probe = defaultProbe, fetchImpl, lookup } = {}) {
    super({ name: 'direct', displayName: 'Direct link / radio stream', searchable: false });
    this.timeoutMs = timeoutMs;
    this.allowPrivate = allowPrivate;
    this.ffprobePath = ffprobePath;
    this.probe = probe;
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
  }

  canResolve(url) {
    return Boolean(parseHttpUrl(String(url)));
  }

  async resolve(url, { requestedBy = null } = {}) {
    const info = await this.inspect(String(url), 0);
    return [
      new Track({
        source: this.name,
        sourceId: info.streamUrl,
        title: info.title,
        artist: info.artist,
        durationMs: info.isLive ? null : info.durationMs,
        url: String(url),
        streamUrl: info.streamUrl,
        isLive: info.isLive,
        requestedBy,
        extra: { contentType: info.contentType, hls: info.hls },
      }),
    ];
  }

  async getStream(track) {
    // Re-check at play time: DNS may have changed since the track was queued.
    await assertPublicUrl(track.streamUrl, { allowPrivate: this.allowPrivate, lookup: this.lookup });
    return { url: track.streamUrl, isLive: track.isLive };
  }

  /** Inspects a URL and returns stream info, following playlists. */
  async inspect(url, depth) {
    let response;
    try {
      response = await safeFetch(url, {
        timeoutMs: this.timeoutMs,
        allowPrivate: this.allowPrivate,
        fetchImpl: this.fetchImpl,
        lookup: this.lookup,
        headers: { 'Icy-MetaData': '0' },
      });
    } catch (err) {
      // Old Shoutcast servers answer "ICY 200 OK", which is not valid HTTP for
      // fetch(). FFmpeg understands it, so let ffprobe decide.
      if (err.networkError && isHttpParseError(err.cause)) {
        return this.inspectWithProbe(url);
      }
      throw err;
    }

    const finalUrl = response.finalUrl;
    if (response.status === 401 || response.status === 403) {
      await discardBody(response);
      throw new UnsupportedSourceError('That link needs a login or blocks access. KINGSROCK can only play publicly accessible audio.');
    }
    if (response.status === 404 || response.status === 410) {
      await discardBody(response);
      throw new TrackUnavailableError('Nothing was found at that link (it may have been removed or expired).');
    }
    if (!response.ok) {
      await discardBody(response);
      throw new ProviderError(`That server returned an error (HTTP ${response.status}).`);
    }

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const pathName = safePath(finalUrl);
    const icyName = response.headers.get('icy-name');
    const hasIcy = Boolean(icyName || response.headers.get('icy-br') || response.headers.get('icy-metaint'));

    const looksLikePlaylist = PLAYLIST_TYPES.includes(contentType) || PLAYLIST_EXTENSIONS.test(pathName);
    if (looksLikePlaylist) {
      const text = (await readBodyPrefix(response, 65536)).toString('utf8');
      return this.handlePlaylist(text, finalUrl, depth);
    }

    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      await discardBody(response);
      throw new UnsupportedSourceError(
        'That link is a web page, not an audio file. Use a direct link to an audio file or radio stream (for example one ending in `.mp3`, `.ogg` or `.m3u`).',
      );
    }

    const isAudioType = contentType.startsWith('audio/') || contentType === 'application/ogg'
      || contentType === 'video/webm' || contentType === 'video/mp4' || contentType === 'video/ogg';

    if (!isAudioType) {
      // Unknown / octet-stream: sniff the first bytes.
      const head = await readBodyPrefix(response, 512);
      const kind = sniff(head);
      if (kind === 'playlist') {
        // We only have a prefix; refetch the full (small) playlist.
        const again = await safeFetch(finalUrl, { timeoutMs: this.timeoutMs, allowPrivate: this.allowPrivate, fetchImpl: this.fetchImpl, lookup: this.lookup });
        const text = (await readBodyPrefix(again, 65536)).toString('utf8');
        return this.handlePlaylist(text, finalUrl, depth);
      }
      if (kind !== 'audio' && !AUDIO_EXTENSIONS.test(pathName)) {
        throw new UnsupportedSourceError('That link does not point to a supported audio format.');
      }
    } else {
      await discardBody(response);
    }

    const contentLength = Number(response.headers.get('content-length'));
    let isLive = hasIcy || !(contentLength > 0);
    const probed = await this.probe(finalUrl, { ffprobePath: this.ffprobePath, timeoutMs: this.timeoutMs });
    if (probed && probed.ok && !probed.hasAudio) {
      throw new UnsupportedSourceError('That file has no audio track.');
    }
    if (probed && probed.ok === false && !isAudioType) {
      throw new UnsupportedSourceError(describeFfmpegError(probed.error));
    }
    if (probed && probed.ok && probed.durationMs) isLive = false;

    return {
      streamUrl: finalUrl,
      contentType: contentType || null,
      hls: false,
      isLive,
      durationMs: probed && probed.ok ? probed.durationMs : null,
      title: cleanTitle(icyName) || (probed && probed.title) || titleFromUrl(finalUrl),
      artist: (probed && probed.artist) || null,
    };
  }

  async handlePlaylist(text, baseUrl, depth) {
    if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/i.test(text)) {
      // HLS: FFmpeg plays it directly.
      const isLive = !/#EXT-X-ENDLIST/i.test(text);
      const probed = await this.probe(baseUrl, { ffprobePath: this.ffprobePath, timeoutMs: this.timeoutMs });
      if (probed && probed.ok === false) throw new UnsupportedSourceError(describeFfmpegError(probed.error));
      return {
        streamUrl: baseUrl,
        contentType: 'application/vnd.apple.mpegurl',
        hls: true,
        isLive,
        durationMs: !isLive && probed && probed.ok ? probed.durationMs : null,
        title: (probed && probed.title) || titleFromUrl(baseUrl),
        artist: null,
      };
    }
    if (depth >= MAX_PLAYLIST_DEPTH) throw new UnsupportedSourceError('That playlist links to too many nested playlists.');

    const entries = parsePlaylist(text, baseUrl);
    if (!entries.length) throw new UnsupportedSourceError('That playlist does not contain any playable links.');

    let lastError = null;
    for (const entry of entries.slice(0, 3)) {
      try {
        const info = await this.inspect(entry.url, depth + 1);
        if (entry.title && (!info.title || info.title === titleFromUrl(info.streamUrl))) info.title = entry.title;
        return info;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new UnsupportedSourceError('No stream in that playlist could be opened.');
  }

  async inspectWithProbe(url) {
    const checked = await assertPublicUrl(url, { allowPrivate: this.allowPrivate, lookup: this.lookup });
    const probed = await this.probe(checked.toString(), { ffprobePath: this.ffprobePath, timeoutMs: this.timeoutMs });
    if (!probed) throw new ProviderError('Could not read that stream (no response from the server).');
    if (!probed.ok || !probed.hasAudio) throw new UnsupportedSourceError(describeFfmpegError(probed.error));
    return {
      streamUrl: checked.toString(),
      contentType: null,
      hls: false,
      isLive: !probed.durationMs,
      durationMs: probed.durationMs,
      title: probed.title || titleFromUrl(checked.toString()),
      artist: probed.artist || null,
    };
  }
}

/** Parses M3U and PLS playlists into [{ url, title }]. Only http(s) entries. */
function parsePlaylist(text, baseUrl) {
  const entries = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (/^\[playlist\]/i.test(lines[0] || '')) {
    const files = {};
    const titles = {};
    for (const line of lines) {
      const file = line.match(/^File(\d+)\s*=\s*(.+)$/i);
      if (file) files[file[1]] = file[2].trim();
      const title = line.match(/^Title(\d+)\s*=\s*(.+)$/i);
      if (title) titles[title[1]] = title[2].trim();
    }
    for (const key of Object.keys(files).sort((a, b) => Number(a) - Number(b))) {
      const url = toHttpUrl(files[key], baseUrl);
      if (url) entries.push({ url, title: titles[key] || null });
    }
    return entries;
  }

  let pendingTitle = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      pendingTitle = comma >= 0 ? line.slice(comma + 1).trim() || null : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = toHttpUrl(line, baseUrl);
    if (url) entries.push({ url, title: pendingTitle });
    pendingTitle = null;
  }
  return entries;
}

function toHttpUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Identifies common audio containers / playlists from their first bytes. */
function sniff(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  const ascii = buf.subarray(0, 16).toString('latin1');
  if (ascii.startsWith('ID3') || ascii.startsWith('OggS') || ascii.startsWith('fLaC') || ascii.startsWith('RIFF')
    || ascii.startsWith('FORM') || ascii.startsWith('#!AMR')) return 'audio';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio'; // EBML (webm/mka)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio'; // MPEG / ADTS frame sync
  const text = buf.toString('utf8').replace(/^﻿/, '').trimStart();
  if (text.startsWith('#EXTM3U') || /^\[playlist\]/i.test(text)) return 'playlist';
  if (/^<(!doctype|html)/i.test(text)) return 'html';
  return 'unknown';
}

function isHttpParseError(err) {
  if (!err) return false;
  const text = `${err.code || ''} ${err.message || ''} ${err.cause ? `${err.cause.code || ''} ${err.cause.message || ''}` : ''}`;
  return /HPE_|Parse Error|invalid (http|status)|UND_ERR_SOCKET/i.test(text);
}

function safePath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function cleanTitle(value) {
  if (!value) return null;
  const v = String(value).trim();
  return v && v.toLowerCase() !== 'unspecified' && v.toLowerCase() !== 'no name' ? v : null;
}

module.exports = { DirectUrlProvider, parsePlaylist, sniff };
