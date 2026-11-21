'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { BaseProvider } = require('./BaseProvider');
const { Track } = require('../Track');
const { ProviderError, TrackUnavailableError, UnsupportedSourceError } = require('../../utils/errors');

const VIDEO_ID = /^[\w-]{11}$/;
const LIST_ID = /^[\w-]{10,64}$/;
const YT_HOSTS = /^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$|^(www\.)?youtube-nocookie\.com$/i;
const MAX_PLAYLIST = 50;
const MAX_STDOUT = 32 * 1024 * 1024;
const AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio/best';

/**
 * YouTube via yt-dlp (https://github.com/yt-dlp/yt-dlp). OPT-IN: YOUTUBE_ENABLED=true.
 *
 * Read before enabling:
 *  - YouTube's Terms of Service do not permit this kind of access. The server
 *    owner is responsible for what is played.
 *  - YouTube often blocks cloud / datacenter IPs ("Sign in to confirm you're
 *    not a bot"). It may work at home and fail on a cloud VM.
 *  - yt-dlp breaks when YouTube changes; keep it updated (`yt-dlp -U`).
 *
 * yt-dlp is run as a separate program (never a shell), with canonical URLs
 * rebuilt from validated IDs, so user input can't inject options.
 */
class YouTubeProvider extends BaseProvider {
  constructor({
    enabled = false,
    ytdlpPath = 'yt-dlp',
    cookiesFile = null,
    cacheDir = null,
    jsRuntime = process.execPath,
    timeoutMs = 30000,
    run = null,
    lookup,
    logger = null,
  } = {}) {
    super({ name: 'youtube', displayName: 'YouTube', searchable: true });
    this.enabled = enabled;
    this.ytdlpPath = ytdlpPath;
    this.cookiesFile = cookiesFile;
    this.cacheDir = cacheDir;
    this.jsRuntime = jsRuntime;
    this.timeoutMs = timeoutMs;
    this.run = run || ((args) => runYtDlp(this.ytdlpPath, args, this.timeoutMs));
    this.lookup = lookup;
    this.logger = logger;
    this.version = null;
  }

  get isAvailable() {
    return this.enabled;
  }

  /** Checks yt-dlp is installed. Returns its version or null. */
  checkInstalled() {
    const r = spawnSync(this.ytdlpPath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    this.version = r.status === 0 ? r.stdout.trim() : null;
    return this.version;
  }

  baseArgs() {
    const args = ['--ignore-config', '--no-warnings', '--no-progress', '--no-playlist'];
    if (this.jsRuntime) args.push('--js-runtimes', `node:${this.jsRuntime}`);
    if (this.cacheDir) args.push('--cache-dir', this.cacheDir);
    if (this.cookiesFile) args.push('--cookies', this.cookiesFile);
    return args;
  }

  canResolve(url) {
    try {
      return YT_HOSTS.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  async search(query, { limit = 5, requestedBy = null } = {}) {
    const clean = String(query).replace(/[\r\n]/g, ' ').trim().slice(0, 200);
    if (!clean) return [];
    const json = await this.exec(['--flat-playlist', '-J', `ytsearch${Math.min(Math.max(limit, 1), 10)}:${clean}`]);
    return (json.entries || [])
      .filter((e) => e && VIDEO_ID.test(e.id || ''))
      .map((e) => this.toTrack(e, requestedBy));
  }

  async resolve(url, { requestedBy = null } = {}) {
    const target = parseYouTubeUrl(url);
    if (!target) throw new UnsupportedSourceError('That YouTube link is not a video or playlist link.');

    if (target.videoId) {
      const json = await this.exec(['--flat-playlist', '-J', watchUrl(target.videoId)]);
      return [this.toTrack({ ...json, id: target.videoId }, requestedBy)];
    }
    const json = await this.exec(['--flat-playlist', '-J', '--yes-playlist', '--playlist-end', String(MAX_PLAYLIST),
      `https://www.youtube.com/playlist?list=${target.listId}`]);
    const tracks = (json.entries || [])
      .filter((e) => e && VIDEO_ID.test(e.id || '') && !/^\[(Private|Deleted) video\]$/i.test(e.title || ''))
      .slice(0, MAX_PLAYLIST)
      .map((e) => this.toTrack(e, requestedBy));
    if (!tracks.length) throw new TrackUnavailableError('That YouTube playlist has no playable videos.');
    return tracks;
  }

  toTrack(e, requestedBy) {
    const live = e.live_status === 'is_live' || e.is_live === true;
    return new Track({
      source: this.name,
      sourceId: e.id,
      title: e.title || 'YouTube video',
      artist: e.channel || e.uploader || null,
      durationMs: !live && Number(e.duration) > 0 ? Number(e.duration) * 1000 : null,
      thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      url: watchUrl(e.id),
      isLive: live,
      requestedBy,
    });
  }

  /**
   * YouTube's media URLs only work with yt-dlp's own downloader (chunked range
   * requests + client tokens); FFmpeg fetching them directly gets HTTP 403.
   * So yt-dlp downloads the audio to stdout and FFmpeg reads it from a pipe.
   * yt-dlp runs only while the track plays and is stopped with it.
   */
  async getStream(track) {
    if (!this.enabled) throw new ProviderError('YouTube is not enabled on this bot.');
    if (!VIDEO_ID.test(track.sourceId || '')) throw new TrackUnavailableError('Invalid YouTube video.');
    const url = watchUrl(track.sourceId);
    return {
      url,
      isLive: track.isLive,
      input: {
        command: this.ytdlpPath,
        args: [...this.baseArgs(), '--quiet', '-f', AUDIO_FORMAT, '-o', '-', url],
        describeError: (stderr) => mapYtDlpError({ stderr }),
      },
    };
  }

  async exec(args) {
    if (!this.enabled) throw new ProviderError('YouTube is not enabled on this bot.');
    let stdout;
    try {
      stdout = await this.run([...this.baseArgs(), ...args]);
    } catch (err) {
      throw mapYtDlpError(err);
    }
    try {
      return JSON.parse(stdout);
    } catch (err) {
      throw new ProviderError('YouTube returned an unexpected response. yt-dlp may need an update (`yt-dlp -U`).', { cause: err });
    }
  }
}

/** Extracts a video or playlist ID from any common YouTube URL form. */
function parseYouTubeUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!YT_HOSTS.test(url.hostname)) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let videoId = null;
  if (host === 'youtu.be') videoId = parts[0];
  else if (url.pathname === '/watch') videoId = url.searchParams.get('v');
  else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) videoId = parts[1];
  if (videoId && VIDEO_ID.test(videoId)) return { videoId };

  const list = url.searchParams.get('list');
  if (list && LIST_ID.test(list) && !/^RD/.test(list)) return { listId: list }; // RD = endless auto mixes
  return null;
}

function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Converts yt-dlp failures into user-facing errors. */
function mapYtDlpError(err) {
  const text = `${err.stderr || ''} ${err.message || ''}`;
  if (err.code === 'ENOENT') return new ProviderError('YouTube support needs yt-dlp, which is not installed on the server.');
  if (err.timedOut) return new ProviderError('YouTube took too long to respond. Try again.');
  if (/confirm you.?re not a bot|Sign in to confirm(?! your age)/i.test(text)) {
    return new ProviderError("YouTube is blocking this server (\"Sign in to confirm you're not a bot\"). This often happens on cloud servers. See SETUP.md, YouTube section.");
  }
  if (/confirm your age|age.restricted|inappropriate for some users/i.test(text)) return new TrackUnavailableError('This YouTube video is age-restricted and cannot be played.');
  if (/Private video|members.only|Join this channel/i.test(text)) return new TrackUnavailableError('This YouTube video is private or members-only.');
  if (/Requested format is not available/i.test(text)) return new TrackUnavailableError('No audio format is available for this video.');
  if (/unavailable|not available|has been removed|does not exist|This video has been|Incomplete YouTube ID/i.test(text)) return new TrackUnavailableError('This YouTube video is unavailable.');
  if (/HTTP Error 429|Too Many Requests/i.test(text)) return new ProviderError('YouTube is rate limiting this server. Try again later.');
  return new ProviderError('YouTube playback failed. yt-dlp may need an update (`yt-dlp -U`).', { cause: err });
}

/** Runs yt-dlp without a shell and resolves with stdout. */
function runYtDlp(path, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let errText = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
      if (out.length > MAX_STDOUT) child.kill('SIGKILL');
    });
    child.stderr.on('data', (c) => {
      if (errText.length < 8192) errText += c;
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stderr: errText }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(out);
      else reject(Object.assign(new Error(`yt-dlp exited with code ${code}`), { stderr: errText, timedOut, exitCode: code }));
    });
  });
}

module.exports = { YouTubeProvider, parseYouTubeUrl, mapYtDlpError };
