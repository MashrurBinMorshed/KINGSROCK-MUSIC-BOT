'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { USER_AGENT } = require('../utils/net');
const { StreamError } = require('../utils/errors');

/**
 * Only network protocols are allowed. This blocks `file:`, `pipe:`, `data:`,
 * `concat:` etc., so a malicious playlist (e.g. an HLS .m3u8 pointing at
 * file:///etc/passwd) can never make FFmpeg read local files.
 */
const PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto';
const STDERR_LIMIT = 4096;

/**
 * Builds FFmpeg arguments that decode any supported input and encode straight
 * to Ogg/Opus (48 kHz stereo, what Discord expects).
 *
 * Why Ogg/Opus output: @discordjs/voice only has to *demux* Ogg pages into
 * Opus packets. No JavaScript Opus encoder, no PCM volume transform in JS,
 * one native process per playing guild. This is the lightest pipeline
 * @discordjs/voice supports for arbitrary input formats.
 */
function buildFfmpegArgs({ url, seekSeconds = 0, volume = 100, bitrateKbps = 96, isLive = false, headers = null, piped = false }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (piped) {
    // Input comes from another process (e.g. yt-dlp) on stdin: no network access at all.
    args.splice(1, 1); // stdin is the input, so drop -nostdin
    args.push('-protocol_whitelist', 'pipe');
  } else {
    // Some providers require the exact HTTP headers their URL was issued for.
    const extra = { ...(headers || {}) };
    const userAgent = extra['User-Agent'] || extra['user-agent'] || USER_AGENT;
    delete extra['User-Agent'];
    delete extra['user-agent'];
    const headerLines = Object.entries(extra)
      .filter(([k, v]) => /^[\w-]+$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v))
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    args.push('-protocol_whitelist', PROTOCOL_WHITELIST, '-user_agent', userAgent);
    if (headerLines) args.push('-headers', headerLines);
    args.push(
      // Recover from short network interruptions instead of ending the track.
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      // Fail instead of hanging forever if the server stops sending data (15 s).
      '-rw_timeout', '15000000',
    );
  }
  // On piped input FFmpeg can't seek, so -ss decodes and discards up to the position.
  if (!isLive && seekSeconds > 0) args.push('-ss', seekSeconds.toFixed(2));
  args.push(
    '-i', piped ? 'pipe:0' : url,
    '-map', '0:a:0', // first audio stream only (ignore cover art / video)
    '-vn', '-sn', '-dn',
  );
  if (volume !== 100) args.push('-af', `volume=${(volume / 100).toFixed(2)}`);
  args.push(
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', `${bitrateKbps}k`,
    '-vbr', 'on',
    '-compression_level', '5', // 0-10: 5 trades a little quality for noticeably less CPU than 10
    '-frame_duration', '20',
    '-application', 'audio',
    '-f', 'ogg',
    'pipe:1',
  );
  return args;
}

/**
 * Spawns FFmpeg for one track.
 *
 * @returns {{
 *   process: import('node:child_process').ChildProcess,
 *   stream: import('node:stream').Readable,
 *   exited: Promise<{code: number|null, signal: string|null}>,
 *   stderr: () => string,
 *   killedByUs: () => boolean,
 *   kill: () => void,
 * }}
 */
function spawnFfmpeg(options, { ffmpegPath = 'ffmpeg', spawnImpl = spawn } = {}) {
  // options.input = { command, args, describeError(stderr) } feeds FFmpeg's stdin
  // from another program (used for YouTube via yt-dlp).
  const input = options.input || null;
  const args = buildFfmpegArgs({ ...options, piped: Boolean(input) });
  let child;
  let source = null;
  try {
    child = spawnImpl(ffmpegPath, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    throw new StreamError('FFmpeg could not be started. Is it installed?', { cause: err });
  }

  let sourceStderr = '';
  let sourceExit = null;
  if (input) {
    try {
      // POSIX: own process group, so the whole tree (yt-dlp + its helpers) can be killed.
      source = spawnImpl(input.command, input.args, {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
    } catch (err) {
      child.kill('SIGKILL');
      throw new StreamError('The input program could not be started. Is it installed?', { cause: err });
    }
    source.stdout.on('error', () => {});
    source.stderr.on('error', () => {});
    child.stdin.on('error', () => {}); // EPIPE when FFmpeg exits first
    source.stdout.pipe(child.stdin);
    source.stderr.setEncoding('utf8');
    source.stderr.on('data', (c) => {
      sourceStderr = (sourceStderr + c).slice(-STDERR_LIMIT);
    });
    source.once('error', (err) => {
      sourceStderr += `\n${err.code || ''} ${err.message}`;
      sourceExit = { code: -1, spawnError: err };
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    });
    source.once('close', (code, signal) => {
      sourceExit = sourceExit || { code, signal };
    });
  }

  let stderrBuf = '';
  let killed = false;
  let exitInfo = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_LIMIT);
  });
  // A destroyed stdout pipe (e.g. after kill) must never crash the process.
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});

  const exited = new Promise((resolve) => {
    child.once('error', (err) => {
      stderrBuf += `\n${err.message}`;
      exitInfo = { code: -1, signal: null, spawnError: err };
      resolve(exitInfo);
    });
    child.once('close', (code, signal) => {
      exitInfo = exitInfo || { code, signal };
      resolve(exitInfo);
    });
  });

  let forceTimer = null;
  const killSource = () => {
    if (source && !sourceExit) {
      try {
        source.stdout.destroy();
      } catch {
        /* ignore */
      }
      killTree(source);
    }
  };
  // Never leave the input program running after FFmpeg is gone.
  exited.then(killSource);

  const kill = () => {
    if (exitInfo || killed) return;
    killed = true;
    killSource();
    try {
      child.stdout.destroy();
    } catch {
      /* ignore */
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    forceTimer = setTimeout(() => {
      if (!exitInfo) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 2000);
    forceTimer.unref();
  };
  exited.then(() => forceTimer && clearTimeout(forceTimer));

  return {
    process: child,
    stream: child.stdout,
    exited,
    stderr: () => stderrBuf.trim(),
    killedByUs: () => killed,
    kill,
    /** A user-facing error from the input program (e.g. yt-dlp), or null. */
    inputError: () => {
      if (!input || killed || !sourceExit || sourceExit.code === 0) return null;
      if (/Broken pipe|Errno 32|EPIPE/i.test(sourceStderr) && exitInfo && exitInfo.code === 0) return null;
      return input.describeError ? input.describeError(sourceStderr, sourceExit) : new StreamError('The audio source failed.');
    },
    /** Waits (briefly) for the input program to exit, so its error can be read. */
    inputExited: (ms = 1500) => new Promise((resolve) => {
      if (!source || sourceExit) {
        resolve();
        return;
      }
      const t = setTimeout(resolve, ms);
      source.once('close', () => {
        clearTimeout(t);
        setImmediate(resolve);
      });
    }),
  };
}

/**
 * Kills a process and its children. yt-dlp starts helper processes (its own
 * runtime, and FFmpeg for live streams) that a plain kill would orphan.
 */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      process.kill(-child.pid, 'SIGTERM'); // negative pid = the whole process group
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/** Turns FFmpeg stderr into a short, user friendly reason. */
function describeFfmpegError(stderr) {
  const text = String(stderr || '');
  if (/ENOENT|not recognized|No such file or directory.*ffmpeg/i.test(text)) return 'FFmpeg is not installed on the server.';
  if (/HTTP error 403|403 Forbidden/i.test(text)) return 'The server refused access to this audio (HTTP 403). The link may have expired.';
  if (/HTTP error 404|404 Not Found/i.test(text)) return 'The audio file was not found (HTTP 404).';
  if (/HTTP error 410/i.test(text)) return 'The audio link has expired (HTTP 410).';
  if (/HTTP error 5\d\d/i.test(text)) return 'The audio server had an error.';
  if (/Connection refused|Connection timed out|timed out|Network is unreachable|Failed to resolve/i.test(text)) return 'Could not connect to the audio server.';
  if (/Invalid data found|could not find codec|Unknown input format|does not contain any stream|matches no streams/i.test(text)) {
    return 'This audio format is not supported, or the link is not an audio stream.';
  }
  if (/Protocol not on whitelist|Protocol not found/i.test(text)) return 'This stream uses a protocol KINGSROCK does not allow.';
  return 'The audio stream failed.';
}

/**
 * Probes a URL with ffprobe to read duration / tags and confirm it has audio.
 * Returns null if ffprobe is unavailable or times out (probing is best effort).
 */
function probe(url, { ffprobePath = 'ffprobe', timeoutMs = 10000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(ffprobePath, [
        '-v', 'error',
        '-protocol_whitelist', PROTOCOL_WHITELIST,
        '-user_agent', USER_AGENT,
        '-rw_timeout', String(Math.max(timeoutMs - 1000, 2000) * 1000),
        '-show_entries', 'format=duration,format_name:format_tags:stream=codec_type,codec_name',
        '-of', 'json',
        url,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      if (out.length < 65536) out += c;
    });
    child.stderr.on('data', (c) => {
      if (err.length < 4096) err += c;
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, error: err.trim(), hasAudio: false });
        return;
      }
      try {
        const data = JSON.parse(out);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const tags = lowerKeys((data.format && data.format.tags) || {});
        const duration = Number(data.format && data.format.duration);
        finish({
          ok: true,
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
          codec: (streams.find((s) => s.codec_type === 'audio') || {}).codec_name || null,
          durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
          formatName: (data.format && data.format.format_name) || null,
          title: tags.title || tags['icy-name'] || null,
          artist: tags.artist || tags.album_artist || null,
        });
      } catch {
        finish(null);
      }
    });
  });
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Checks that FFmpeg runs and has the libopus encoder.
 * @returns {{ ok: boolean, version?: string, libopus?: boolean, error?: string }}
 */
function checkFfmpeg(ffmpegPath = 'ffmpeg') {
  const version = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (version.error || version.status !== 0) {
    return { ok: false, error: version.error ? version.error.message : (version.stderr || 'ffmpeg exited with an error') };
  }
  const firstLine = (version.stdout || '').split('\n')[0].trim();
  const encoders = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const libopus = /\blibopus\b/.test(encoders.stdout || '');
  return { ok: libopus, version: firstLine, libopus, error: libopus ? undefined : 'FFmpeg was found but it has no libopus encoder.' };
}

module.exports = { buildFfmpegArgs, spawnFfmpeg, describeFfmpegError, probe, checkFfmpeg, PROTOCOL_WHITELIST };
