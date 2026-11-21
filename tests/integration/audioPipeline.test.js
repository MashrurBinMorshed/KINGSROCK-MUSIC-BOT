'use strict';

/**
 * Integration tests: real FFmpeg + real @discordjs/voice AudioPlayer.
 *
 * A local HTTP server serves generated audio. These tests verify the complete
 * audio path up to (but not including) the Discord voice connection:
 *   URL -> provider -> FFmpeg (Ogg/Opus) -> Ogg demuxer -> Opus packets -> AudioPlayer
 *
 * They do NOT prove audio is audible in a Discord voice channel. That needs a
 * live test with a real bot token (see SETUP.md, "Live acceptance test").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const voice = require('@discordjs/voice');
const { createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType, entersState } = voice;

const { spawnFfmpeg, checkFfmpeg, probe } = require('../../src/music/FFmpeg');
const { DirectUrlProvider } = require('../../src/music/providers/DirectUrlProvider');
const { AudioSourceManager } = require('../../src/music/AudioSourceManager');
const { MusicPlayer } = require('../../src/music/MusicPlayer');
const { testConfig } = require('../helpers/fakes');

const ffmpegOk = checkFfmpeg('ffmpeg').ok;
const skip = ffmpegOk ? false : 'FFmpeg with libopus is not installed';

let server;
let base;
let dir;

function makeTone(file, seconds, freq, title) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `title=${title}`, '-metadata', 'artist=KINGSROCK QA', file], { windowsHide: true });
  if (r.status !== 0) throw new Error(`could not create fixture: ${r.stderr}`);
}

test.before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kingsrock-it-'));
  makeTone(path.join(dir, 'tone.mp3'), 3, 440, 'Test Tone A');
  makeTone(path.join(dir, 'short.mp3'), 1.5, 660, 'Test Tone B');
  fs.writeFileSync(path.join(dir, 'garbage.mp3'), Buffer.alloc(64 * 1024, 7));

  server = http.createServer((req, res) => {
    const name = req.url.split('?')[0];
    if (name === '/page') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>x</title>');
    if (name === '/radio.pls') {
      return res.writeHead(200, { 'Content-Type': 'audio/x-scpls' }).end(`[playlist]\nFile1=${base}/missing.mp3\nFile2=${base}/tone.mp3\nTitle2=Playlist Tone\n`);
    }
    if (name === '/redirect') return res.writeHead(302, { Location: '/tone.mp3' }).end();
    const file = path.join(dir, path.basename(name));
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    const stat = fs.statSync(file);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size, 'Accept-Ranges': 'none' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('ffprobe reads duration and tags of a direct file', { skip }, async () => {
  const info = await probe(`${base}/tone.mp3`, { timeoutMs: 10000 });
  assert.equal(info.ok, true);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.durationMs - 3000) < 200, `duration ${info.durationMs}`);
  assert.equal(info.title, 'Test Tone A');
});

test('direct provider resolves files, redirects and playlists against a real server', { skip }, async () => {
  const p = new DirectUrlProvider({ allowPrivate: true, timeoutMs: 10000 });
  const [file] = await p.resolve(`${base}/tone.mp3`);
  assert.equal(file.title, 'Test Tone A');
  assert.equal(file.artist, 'KINGSROCK QA');
  assert.equal(file.isLive, false);
  const [viaRedirect] = await p.resolve(`${base}/redirect`);
  assert.equal(viaRedirect.streamUrl, `${base}/tone.mp3`);
  const [fromPls] = await p.resolve(`${base}/radio.pls`);
  assert.equal(fromPls.streamUrl, `${base}/tone.mp3`);
  await assert.rejects(p.resolve(`${base}/page`), /web page/);
  await assert.rejects(p.resolve(`${base}/missing.mp3`), /Nothing was found/);
});

test('private addresses are refused unless explicitly allowed', { skip }, async () => {
  const p = new DirectUrlProvider({ allowPrivate: false });
  await assert.rejects(p.resolve(`${base}/tone.mp3`), /private network/);
});

test('FFmpeg produces a valid Ogg/Opus stream of 20 ms Opus packets', { skip }, async () => {
  const handle = spawnFfmpeg({ url: `${base}/tone.mp3`, volume: 50, bitrateKbps: 96 });
  const resource = createAudioResource(handle.stream, { inputType: StreamType.OggOpus });
  let packets = 0;
  let bytes = 0;
  for await (const packet of resource.playStream) {
    packets += 1;
    bytes += packet.length;
  }
  const exit = await handle.exited;
  assert.equal(exit.code, 0, handle.stderr());
  // 3 s of audio / 20 ms frames = 150 packets
  assert.ok(packets >= 145 && packets <= 155, `packets=${packets}`);
  const kbps = (bytes * 8) / 3 / 1000;
  assert.ok(kbps > 40 && kbps < 140, `bitrate ${kbps.toFixed(1)} kbps`);
});

test('real AudioPlayer goes Buffering -> Playing -> Idle for a real stream', { skip }, async () => {
  const handle = spawnFfmpeg({ url: `${base}/short.mp3`, volume: 100, bitrateKbps: 64 });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const states = [];
  player.on('stateChange', (_o, n) => states.push(n.status));
  const resource = createAudioResource(handle.stream, { inputType: StreamType.OggOpus });
  player.play(resource);
  await entersState(player, AudioPlayerStatus.Playing, 10000);
  await entersState(player, AudioPlayerStatus.Idle, 10000);
  assert.deepEqual(states, ['buffering', 'playing', 'idle']);
  assert.ok(resource.playbackDuration >= 1300, `played ${resource.playbackDuration} ms`);
  assert.equal((await handle.exited).code, 0);
});

test('FFmpeg failure on a broken file is detected (non-zero exit, readable error)', { skip }, async () => {
  const handle = spawnFfmpeg({ url: `${base}/garbage.mp3` });
  handle.stream.resume();
  const exit = await handle.exited;
  assert.notEqual(exit.code, 0);
  assert.ok(handle.stderr().length > 0);
});

test('a stream that yields no audio is never reported as playing (regression)', { skip, timeout: 20000 }, async () => {
  const sources = new AudioSourceManager({ providers: [new DirectUrlProvider({ allowPrivate: true, timeoutMs: 10000 })] });
  const [track] = await sources.resolve(`${base}/tone.mp3`);
  track.streamUrl = `${base}/garbage.mp3`;
  const player = new MusicPlayer({
    guildId: 'reg', config: testConfig({ audio: { startTimeoutMs: 10000 } }), sources, voice, noSubscriberBehavior: NoSubscriberBehavior.Play,
  });
  let announced = false;
  player.on('trackStart', () => { announced = true; });
  const res = await player.enqueue(track, { announce: true });
  assert.equal(res.started, null);
  assert.equal(res.failures.length, 1);
  assert.equal(announced, false);
  assert.equal(player.status, 'idle');
  player.destroy('test');
});

test('kill() stops FFmpeg promptly (no orphan processes)', { skip }, async () => {
  const handle = spawnFfmpeg({ url: `${base}/tone.mp3` });
  await once(handle.stream, 'readable');
  handle.kill();
  const started = Date.now();
  await handle.exited;
  assert.ok(Date.now() - started < 3000);
  assert.equal(handle.killedByUs(), true);
});

test('MusicPlayer end-to-end with real FFmpeg: plays, reports a broken track, continues, cleans up', { skip, timeout: 30000 }, async () => {
  const sources = new AudioSourceManager({ providers: [new DirectUrlProvider({ allowPrivate: true, timeoutMs: 10000 })] });
  // Resolve tracks the same way /play does.
  const [a] = await sources.resolve(`${base}/short.mp3`);
  const broken = (await sources.resolve(`${base}/tone.mp3`))[0];
  broken.streamUrl = `${base}/garbage.mp3`; // becomes unplayable after queueing (e.g. replaced upstream)
  broken.title = 'Broken Track';
  const [b] = await sources.resolve(`${base}/short.mp3`);
  b.title = 'Second Tone';

  const config = testConfig({ audio: { startTimeoutMs: 10000 } });
  const player = new MusicPlayer({
    guildId: 'it-guild', config, sources, voice, noSubscriberBehavior: NoSubscriberBehavior.Play,
  });
  const events = [];
  player.on('trackStart', (t) => events.push(`start:${t.title}`));
  player.on('trackError', (t) => events.push(`error:${t.title}`));
  player.on('queueEnd', () => events.push('end'));

  const res = await player.enqueue([a, broken, b], { announce: true });
  assert.equal(res.started.title, 'Test Tone B');
  assert.equal(player.status, 'playing');

  const ended = new Promise((resolve) => player.once('queueEnd', resolve));
  await ended;
  assert.deepEqual(events, ['start:Test Tone B', 'error:Broken Track', 'start:Second Tone', 'end']);
  assert.equal(player.status, 'idle');

  player.destroy('test end');
  assert.equal(player.ffmpeg, null);
  assert.equal(player.audioPlayer.state.status, 'idle');
});

test('two guild players stream independently at the same time', { skip, timeout: 30000 }, async () => {
  const sources = new AudioSourceManager({ providers: [new DirectUrlProvider({ allowPrivate: true, timeoutMs: 10000 })] });
  const config = testConfig({ audio: { startTimeoutMs: 10000 } });
  const mk = (id) => new MusicPlayer({ guildId: id, config, sources, voice, noSubscriberBehavior: NoSubscriberBehavior.Play });
  const p1 = mk('guild-1');
  const p2 = mk('guild-2');
  const [t1] = await sources.resolve(`${base}/tone.mp3`);
  const [t2] = await sources.resolve(`${base}/short.mp3`);
  await Promise.all([p1.enqueue(t1), p2.enqueue(t2)]);
  assert.equal(p1.status, 'playing');
  assert.equal(p2.status, 'playing');
  assert.notEqual(p1.ffmpeg.process.pid, p2.ffmpeg.process.pid);
  p1.pause();
  assert.equal(p2.status, 'playing');
  const ffmpeg1 = p1.ffmpeg;
  p1.destroy('test');
  await ffmpeg1.exited;
  assert.equal(p2.status, 'playing');
  await new Promise((resolve) => p2.once('queueEnd', resolve));
  p2.destroy('test');
});
