'use strict';

/**
 * Live provider tests against the real public APIs (internet required).
 * Opt-in, because external services change and can be down:
 *
 *   Windows PowerShell:  $env:KINGSROCK_LIVE_TESTS=1; npm run test:integration
 *   Linux:               KINGSROCK_LIVE_TESTS=1 npm run test:integration
 *
 * Each test resolves a real track and confirms FFmpeg can decode its stream
 * into Opus packets. Discord itself is still not involved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { AudiusProvider } = require('../../src/music/providers/AudiusProvider');
const { RadioBrowserProvider } = require('../../src/music/providers/RadioBrowserProvider');
const { InternetArchiveProvider } = require('../../src/music/providers/InternetArchiveProvider');
const { DirectUrlProvider } = require('../../src/music/providers/DirectUrlProvider');
const { AudioSourceManager } = require('../../src/music/AudioSourceManager');
const { spawnFfmpeg, checkFfmpeg } = require('../../src/music/FFmpeg');

const skip = process.env.KINGSROCK_LIVE_TESTS === '1'
  ? (checkFfmpeg('ffmpeg').ok ? false : 'FFmpeg missing')
  : 'set KINGSROCK_LIVE_TESTS=1 to run live provider tests';

/** Streams ~2 s of audio through FFmpeg and counts Opus packets. */
async function decodeSome(url, isLive) {
  const handle = spawnFfmpeg({ url, isLive, volume: 50, bitrateKbps: 96 });
  const resource = createAudioResource(handle.stream, { inputType: StreamType.OggOpus });
  let packets = 0;
  // archive.org download servers can take 5-10 s before sending the first byte.
  const timer = setTimeout(() => handle.kill(), 40000);
  try {
    for await (const _ of resource.playStream) { // eslint-disable-line no-unused-vars
      packets += 1;
      if (packets >= 100) break; // 100 x 20 ms = 2 s
    }
  } finally {
    clearTimeout(timer);
    handle.kill();
  }
  return { packets, stderr: handle.stderr() };
}

test('Audius: search -> fresh stream URL -> decodable audio', { skip, timeout: 60000 }, async () => {
  const p = new AudiusProvider({ appName: 'KINGSROCK' });
  const results = await p.search('lofi', { limit: 3 });
  assert.ok(results.length > 0, 'Audius returned no streamable results');
  const t = results[0];
  assert.ok(t.title && t.durationMs > 0);
  const stream = await p.getStream(t);
  assert.match(stream.url, /^https:\/\//);
  const { packets, stderr } = await decodeSome(stream.url, false);
  assert.ok(packets >= 100, `only ${packets} packets. ${stderr}`);
});

test('Radio Browser: station search -> live stream -> decodable audio', { skip, timeout: 60000 }, async () => {
  const direct = new DirectUrlProvider({});
  const p = new RadioBrowserProvider({ directProvider: direct });
  const stations = await p.search('jazz', { limit: 5 });
  assert.ok(stations.length > 0);
  let lastErr = null;
  for (const st of stations) {
    try {
      const stream = await p.getStream(st);
      const { packets, stderr } = await decodeSome(stream.url, true);
      if (packets >= 100) return;
      lastErr = new Error(`${st.title}: ${packets} packets ${stderr}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no station played');
});

test('Internet Archive: CC/public-domain search -> hydrate -> decodable audio', { skip, timeout: 60000 }, async () => {
  const p = new InternetArchiveProvider({});
  const results = await p.search('beethoven sonata', { limit: 5 });
  assert.ok(results.length > 0, 'no CC/PD results');
  const track = await p.hydrate(results[0]);
  assert.match(track.extra.license, /creativecommons|publicdomain/i);
  const stream = await p.getStream(track);
  const { packets, stderr } = await decodeSome(stream.url, false);
  assert.ok(packets >= 100, `only ${packets} packets. ${stderr}`);
});

test('YouTube (yt-dlp): search -> yt-dlp pipe -> decodable audio', { skip, timeout: 120000 }, async (t) => {
  const { YouTubeProvider } = require('../../src/music/providers/YouTubeProvider');
  const yt = new YouTubeProvider({ enabled: true, ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp' });
  if (!yt.checkInstalled()) {
    t.skip('yt-dlp not installed (set YTDLP_PATH)');
    return;
  }
  const [track] = await yt.search('lofi hip hop', { limit: 1 });
  assert.ok(track && track.title);
  const stream = await yt.getStream(track);
  const handle = spawnFfmpeg({ url: stream.url, isLive: stream.isLive, input: stream.input });
  const resource = createAudioResource(handle.stream, { inputType: StreamType.OggOpus });
  let packets = 0;
  const timer = setTimeout(() => handle.kill(), 60000);
  for await (const _ of resource.playStream) { // eslint-disable-line no-unused-vars
    packets += 1;
    if (packets >= 100) break;
  }
  clearTimeout(timer);
  handle.kill();
  assert.ok(packets >= 100, `only ${packets} packets: ${handle.stderr()} ${handle.inputError() ? handle.inputError().userMessage : ''}`);
});

test('AudioSourceManager auto search returns a playable track', { skip, timeout: 60000 }, async () => {
  const m = new AudioSourceManager({
    providers: [new DirectUrlProvider({}), new AudiusProvider({}), new InternetArchiveProvider({})],
    defaultSearch: 'audius',
  });
  const [t] = await m.resolve('chill beats');
  const stream = await m.getStream(t);
  assert.match(stream.url, /^https:\/\//);
  // YouTube provider not registered here: the link is explained, not played.
  await assert.rejects(m.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /turned off on this bot/);
  await assert.rejects(m.resolve('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'), /can't be played/);
});
