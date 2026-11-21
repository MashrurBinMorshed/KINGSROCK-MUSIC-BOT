'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { YouTubeProvider, parseYouTubeUrl, mapYtDlpError } = require('../../src/music/providers/YouTubeProvider');
const { AudioSourceManager } = require('../../src/music/AudioSourceManager');
const { DirectUrlProvider } = require('../../src/music/providers/DirectUrlProvider');
const { buildFfmpegArgs } = require('../../src/music/FFmpeg');
const { loadConfig } = require('../../src/config');
const { ProviderError, TrackUnavailableError, UnsupportedSourceError } = require('../../src/utils/errors');

const TOKEN = `${'A'.repeat(26)}.${'B'.repeat(6)}.${'C'.repeat(38)}`;

/** Fake yt-dlp: records args, returns JSON by matching the last argument. */
function fakeRun(responses) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const target = args[args.length - 1];
    const key = Object.keys(responses).find((k) => target.includes(k));
    const value = responses[key];
    if (value instanceof Error) throw value;
    return JSON.stringify(value);
  };
  run.calls = calls;
  return run;
}

test('parseYouTubeUrl handles every common link form and rejects others', () => {
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeUrl('https://m.youtube.com/live/dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'), { listId: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI' });
  // watch + list -> the video, not the playlist
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'), { videoId: 'dQw4w9WgXcQ' });
  assert.equal(parseYouTubeUrl('https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ'), null, 'endless mixes are refused');
  assert.equal(parseYouTubeUrl('https://www.youtube.com/@channel'), null);
  assert.equal(parseYouTubeUrl('https://evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=--option-x'), null);
});

test('search maps results; queries cannot inject yt-dlp options', async () => {
  const run = fakeRun({ ytsearch: { entries: [
    { id: 'dQw4w9WgXcQ', title: 'Song', duration: 213, channel: 'Artist' },
    { id: 'rFZHOHl-L8A', title: 'Live radio', live_status: 'is_live', channel: 'Lofi' },
    { id: 'bad', title: 'skip me' },
  ] } });
  const yt = new YouTubeProvider({ enabled: true, run, jsRuntime: '/usr/bin/node' });
  const results = await yt.search('--exec rm -rf / song', { limit: 5 });
  assert.equal(results.length, 2);
  assert.equal(results[0].durationMs, 213000);
  assert.equal(results[0].artist, 'Artist');
  assert.equal(results[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(results[1].isLive, true);
  assert.equal(results[1].durationMs, null);
  const args = run.calls[0];
  assert.equal(args[args.length - 1], 'ytsearch5:--exec rm -rf / song', 'query stays inside one ytsearch argument');
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('node:/usr/bin/node'));
});

test('resolve: single videos and playlists (capped, private entries skipped)', async () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ id: `vid${String(i).padStart(8, '0')}`, title: `T${i}`, duration: 100 }));
  entries[1] = { id: 'privatevid1', title: '[Private video]' };
  const run = fakeRun({
    'watch?v=dQw4w9WgXcQ': { id: 'dQw4w9WgXcQ', title: 'Video', duration: 10, uploader: 'Up' },
    'playlist?list=': { entries },
  });
  const yt = new YouTubeProvider({ enabled: true, run });
  const [video] = await yt.resolve('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(video.title, 'Video');
  const list = await yt.resolve('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');
  assert.equal(list.length, 50);
  assert.ok(!list.some((t) => t.title === '[Private video]'));
  await assert.rejects(yt.resolve('https://www.youtube.com/@someone'), UnsupportedSourceError);
});

test('getStream returns a yt-dlp input process with a canonical URL (no shell)', async () => {
  const yt = new YouTubeProvider({ enabled: true, ytdlpPath: '/usr/local/bin/yt-dlp', cookiesFile: '/etc/kingsrock/cookies.txt', cacheDir: '/data/cache' });
  const s = await yt.getStream({ sourceId: 'dQw4w9WgXcQ', isLive: false });
  assert.equal(s.input.command, '/usr/local/bin/yt-dlp');
  assert.deepEqual(s.input.args.slice(-5), ['-f', 'bestaudio[acodec=opus]/bestaudio/best', '-o', '-', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  assert.ok(s.input.args.includes('--cookies'));
  assert.ok(s.input.args.includes('--cache-dir'));
  assert.ok(s.input.describeError('ERROR: [youtube] x: This video is unavailable') instanceof TrackUnavailableError);
  await assert.rejects(yt.getStream({ sourceId: '../../etc/passwd' }), TrackUnavailableError);
  await assert.rejects(new YouTubeProvider({ enabled: false }).getStream({ sourceId: 'dQw4w9WgXcQ' }), ProviderError);
});

test('yt-dlp errors become clear messages', () => {
  const m = (stderr, extra = {}) => mapYtDlpError({ stderr, ...extra });
  assert.match(m("ERROR: [youtube] x: Sign in to confirm you're not a bot").userMessage, /blocking this server/);
  assert.match(m('ERROR: Sign in to confirm your age').userMessage, /age-restricted/);
  assert.match(m('ERROR: Private video').userMessage, /private/);
  assert.match(m('ERROR: [youtube] x: This video is unavailable').userMessage, /unavailable/);
  assert.match(m('HTTP Error 429: Too Many Requests').userMessage, /rate limiting/);
  assert.match(m('ERROR: Requested format is not available').userMessage, /No audio format/);
  assert.match(mapYtDlpError(Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' })).userMessage, /not installed/);
  assert.match(m('something new and weird').userMessage, /yt-dlp -U/);
});

test('YouTube links: played when enabled, explained when disabled', async () => {
  const run = fakeRun({
    'watch?v=dQw4w9WgXcQ': { id: 'dQw4w9WgXcQ', title: 'Video', duration: 10 },
    ytsearch: { entries: [{ id: 'dQw4w9WgXcQ', title: 'Searched', duration: 10 }] },
  });
  const on = new AudioSourceManager({ providers: [new DirectUrlProvider({}), new YouTubeProvider({ enabled: true, run })] });
  const [t] = await on.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(t.source, 'youtube');
  const [s] = await on.resolve('yt: never gonna give you up', {});
  assert.equal(s.source, 'youtube');

  const off = new AudioSourceManager({ providers: [new DirectUrlProvider({}), new YouTubeProvider({ enabled: false })] });
  await assert.rejects(off.resolve('https://youtu.be/dQw4w9WgXcQ'), /turned off on this bot/);
  // Spotify stays blocked either way
  await assert.rejects(on.resolve('https://open.spotify.com/track/abc'), /Spotify links can't be played/);
});

test('config: YouTube is off by default; enabling it makes it the default search', () => {
  const base = { DISCORD_TOKEN: TOKEN };
  const opts = { argv: [], loadFile: false };
  const off = loadConfig({ env: { ...base }, ...opts });
  assert.equal(off.providers.youtube.enabled, false);
  assert.equal(off.providers.defaultSearch, 'audius');
  const on = loadConfig({ env: { ...base, YOUTUBE_ENABLED: 'true' }, ...opts });
  assert.equal(on.providers.youtube.enabled, true);
  assert.equal(on.providers.defaultSearch, 'youtube');
  assert.throws(() => loadConfig({ env: { ...base, DEFAULT_SEARCH_PROVIDER: 'youtube' }, ...opts }), /YOUTUBE_ENABLED/);
  assert.throws(() => loadConfig({ env: { ...base, YOUTUBE_ENABLED: 'true', YOUTUBE_COOKIES_FILE: '/nope/cookies.txt' }, ...opts }), /does not exist/);
});

test('FFmpeg piped mode reads only stdin (no network protocols)', () => {
  const args = buildFfmpegArgs({ url: 'ignored', piped: true, volume: 50, seekSeconds: 30 });
  const joined = args.join(' ');
  assert.match(joined, /-protocol_whitelist pipe /);
  assert.match(joined, /-ss 30\.00 -i pipe:0/);
  assert.doesNotMatch(joined, /-reconnect|-user_agent|-nostdin|ignored/);
  const http = buildFfmpegArgs({ url: 'https://x.example/a', headers: { 'User-Agent': 'UA', Referer: 'https://y', Bad: 'x\r\ninjected: 1' } }).join(' ');
  assert.match(http, /-user_agent UA/);
  assert.match(http, /-headers Referer: https:\/\/y/);
  assert.doesNotMatch(http, /injected/);
});
