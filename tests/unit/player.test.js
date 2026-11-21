'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MusicPlayer } = require('../../src/music/MusicPlayer');
const { MusicManager } = require('../../src/music/MusicManager');
const { UserError } = require('../../src/utils/errors');
const {
  createFakeVoice, createFakeFfmpeg, fakeSources, makeTrack, testConfig, fakeChannel, tick,
} = require('../helpers/fakes');

function setup({ failing = [], config = {}, behaviors = {} } = {}) {
  const voice = createFakeVoice();
  const ff = createFakeFfmpeg();
  for (const [title, b] of Object.entries(behaviors)) ff.behaviors.set(`http://audio.test/${encodeURIComponent(title)}`, b);
  const sources = fakeSources({ failing: new Set(failing) });
  const player = new MusicPlayer({ guildId: 'g1', config: testConfig(config), sources, voice, spawnFfmpeg: ff.spawnFfmpeg });
  const events = [];
  for (const e of ['trackStart', 'trackError', 'queueEnd', 'giveUp', 'autoLeave', 'destroyed']) {
    player.on(e, (arg) => events.push([e, arg && arg.title ? arg.title : arg]));
  }
  const ap = voice.players[0];
  return { voice, ff, sources, player, events, ap };
}

/**
 * Simulates a track reaching its natural end: FFmpeg exits cleanly (code 0)
 * and the audio player goes idle, then lets the queue advance.
 */
async function finishTrack(ap) {
  const resource = ap.state.resource;
  if (resource && resource.metadata.handle) resource.metadata.handle.exit(0);
  ap.finishCurrent();
  await new Promise((r) => setTimeout(r, 10));
  await tick();
}

test('enqueue on an idle player starts playback and reports the started track', async () => {
  const { player, ff } = setup();
  const res = await player.enqueue([makeTrack('a'), makeTrack('b')]);
  assert.equal(res.startedNow, true);
  assert.equal(res.started.title, 'a');
  assert.equal(player.status, 'playing');
  assert.equal(player.currentTrack.title, 'a');
  assert.equal(ff.spawned.length, 1);
  assert.equal(ff.spawned[0].opts.volume, 50);
  assert.equal(ff.spawned[0].opts.bitrateKbps, 96);
});

test('enqueue while playing only queues and returns the position', async () => {
  const { player } = setup();
  await player.enqueue(makeTrack('a'));
  const res = await player.enqueue([makeTrack('b'), makeTrack('c')]);
  assert.equal(res.startedNow, false);
  assert.equal(res.position, 1);
  assert.equal(player.queue.size, 2);
});

test('state transitions: playing -> paused -> playing -> idle at queue end', async () => {
  const { player, ap, events } = setup();
  await player.enqueue(makeTrack('a'), { announce: true });
  assert.equal(player.status, 'playing');
  player.pause();
  assert.equal(player.status, 'paused');
  assert.throws(() => player.pause(), /already paused/);
  await player.resume();
  assert.equal(player.status, 'playing');
  await assert.rejects(player.resume(), UserError);
  await finishTrack(ap);
  assert.equal(player.status, 'idle');
  assert.equal(player.currentTrack, null);
  assert.deepEqual(events.map((e) => e[0]), ['trackStart', 'queueEnd']);
});

test('automatically plays the next track when one ends', async () => {
  const { player, ap, events } = setup();
  await player.enqueue([makeTrack('a'), makeTrack('b')], { announce: true });
  await finishTrack(ap);
  assert.equal(player.currentTrack.title, 'b');
  assert.deepEqual(events.filter((e) => e[0] === 'trackStart').map((e) => e[1]), ['a', 'b']);
});

test('a track whose stream cannot be resolved is reported and skipped', async () => {
  const { player, events } = setup({ failing: ['bad'] });
  const res = await player.enqueue([makeTrack('bad'), makeTrack('good')]);
  assert.equal(res.started.title, 'good');
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0].error.userMessage, /unavailable/);
  assert.equal(player.status, 'playing');
  assert.equal(events.filter((e) => e[0] === 'trackError').length, 0, 'initial failures are returned, not announced');
});

test('FFmpeg failing before audio starts is detected and the queue continues', async () => {
  const { player, events } = setup({ behaviors: { broken: { exitCode: 1, stderr: 'HTTP error 404 Not Found', neverStart: true } } });
  await player.enqueue(makeTrack('first'), { announce: true });
  await player.enqueue([makeTrack('broken'), makeTrack('after')]);
  await player.skip();
  assert.equal(player.currentTrack.title, 'after');
  const err = events.find((e) => e[0] === 'trackError');
  assert.equal(err[1], 'broken');
});

test('a stream that dies mid-track (FFmpeg exit != 0) reports an error and moves on', async () => {
  const { player, ap, ff, events } = setup();
  await player.enqueue([makeTrack('a'), makeTrack('b')], { announce: true });
  ff.spawned[0].exit(1); // ffmpeg crashed
  await finishTrack(ap);
  assert.equal(player.currentTrack.title, 'b');
  assert.ok(events.some((e) => e[0] === 'trackError' && e[1] === 'a'));
});

test('a stream that never starts times out instead of pretending to play', async () => {
  const { player } = setup({ behaviors: { silent: { neverStart: true } } });
  const res = await player.enqueue(makeTrack('silent'));
  assert.equal(res.started, null);
  assert.match(res.failures[0].error.userMessage, /did not start/);
  assert.equal(player.status, 'idle');
});

test('gives up after too many consecutive failures', async () => {
  const { player, events } = setup({ failing: ['x1', 'x2', 'x3', 'x4'] });
  const res = await player.enqueue(['x1', 'x2', 'x3', 'x4'].map((t) => makeTrack(t)));
  assert.equal(res.gaveUp, true);
  assert.equal(player.queue.size, 0);
  assert.ok(events.some((e) => e[0] === 'giveUp'));
});

test('skip advances, stops the old FFmpeg process, and works with loop=track', async () => {
  const { player, ff } = setup();
  await player.enqueue([makeTrack('a'), makeTrack('b')]);
  player.queue.setLoop('track');
  const { skipped, next } = await player.skip();
  assert.equal(skipped.title, 'a');
  assert.equal(next.title, 'b');
  assert.equal(ff.spawned[0].killedByUs(), true);
});

test('loop=track replays the same track when it ends', async () => {
  const { player, ap } = setup();
  await player.enqueue([makeTrack('a'), makeTrack('b')]);
  player.queue.setLoop('track');
  await finishTrack(ap);
  assert.equal(player.currentTrack.title, 'a');
});

test('stop clears everything and starts the inactivity timer', async () => {
  const { player, ff } = setup();
  await player.enqueue([makeTrack('a'), makeTrack('b')]);
  player.stop();
  assert.equal(player.status, 'idle');
  assert.equal(player.queue.total, 0);
  assert.ok(ff.spawned[0].killedByUs());
  assert.ok(player.idleTimer);
  assert.throws(() => player.stop(), /Nothing is playing/);
  player.destroy();
});

test('volume change restarts FFmpeg with the new volume at the current position', async () => {
  const { player, ff } = setup();
  await player.enqueue(makeTrack('a'));
  player.resource.playbackDuration = 30_000;
  const res = await player.setVolume(80);
  assert.equal(res.restarted, true);
  assert.equal(ff.spawned.length, 2);
  assert.equal(ff.spawned[1].opts.volume, 80);
  assert.ok(ff.spawned[1].opts.seekSeconds > 29 && ff.spawned[1].opts.seekSeconds <= 30);
  assert.ok(ff.spawned[0].killedByUs());
  assert.equal(player.currentTrack.title, 'a', 'restart does not advance the queue');
  await assert.rejects(player.setVolume(0), UserError);
  await assert.rejects(player.setVolume(101), UserError);
});

test('volume change while paused applies on resume; live streams restart on resume', async () => {
  const { player, ff } = setup();
  await player.enqueue(makeTrack('radio', { isLive: true, durationMs: null }));
  player.pause();
  await player.setVolume(30);
  assert.equal(ff.spawned.length, 1);
  await player.resume();
  assert.equal(ff.spawned.length, 2);
  assert.equal(ff.spawned[1].opts.volume, 30);
  assert.equal(ff.spawned[1].opts.seekSeconds, 0);
});

test('connect joins once, subscribes, and destroy releases every resource', async () => {
  const { player, voice, ff, events } = setup();
  await player.connect(fakeChannel());
  await player.connect(fakeChannel()); // same channel: no new connection
  assert.equal(voice.connections.length, 1);
  assert.equal(voice.connections[0].subscribed, player.audioPlayer);
  await player.enqueue(makeTrack('a'));
  player.destroy('test');
  player.destroy('again'); // idempotent
  assert.ok(voice.connections[0].destroyed);
  assert.ok(ff.spawned[0].killedByUs());
  assert.equal(player.queue.total, 0);
  assert.equal(player.idleTimer, null);
  assert.deepEqual(events.filter((e) => e[0] === 'destroyed').length, 1);
});

test('voice connection being destroyed externally cleans up the player', async () => {
  const { player, voice } = setup();
  await player.connect(fakeChannel());
  voice.connections[0].destroy();
  assert.equal(player.destroyed, true);
});

test('alone in channel: pauses, auto-resumes when someone returns', async () => {
  const { player } = setup();
  await player.enqueue(makeTrack('a'));
  player.onListenersChanged(0);
  assert.equal(player.status, 'paused');
  assert.equal(player.pausedBy, 'alone');
  assert.ok(player.aloneTimer);
  player.onListenersChanged(2);
  await tick();
  assert.equal(player.status, 'playing');
  assert.equal(player.aloneTimer, null);
  player.destroy();
});

test('alone timeout leaves the channel', async () => {
  const { player, events } = setup({ config: { player: { aloneTimeoutMs: 20 } } });
  await player.enqueue(makeTrack('a'));
  player.onListenersChanged(0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(player.destroyed, true);
  assert.ok(events.some((e) => e[0] === 'autoLeave' && e[1] === 'alone'));
});

test('inactivity timeout leaves after the queue ends', async () => {
  const { player, ap, events } = setup({ config: { player: { inactivityTimeoutMs: 20 } } });
  await player.enqueue(makeTrack('a'));
  await finishTrack(ap);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(player.destroyed, true);
  assert.ok(events.some((e) => e[0] === 'autoLeave' && e[1] === 'inactivity'));
});

test('MusicManager keeps guild players fully independent', async () => {
  const voice = createFakeVoice();
  const ff = createFakeFfmpeg();
  const config = testConfig();
  const manager = new MusicManager({
    config,
    sources: fakeSources(),
    playerFactory: (opts) => new MusicPlayer({ ...opts, voice, spawnFfmpeg: ff.spawnFfmpeg }),
  });
  const p1 = manager.getOrCreate('g1');
  const p2 = manager.getOrCreate('g2');
  assert.notEqual(p1, p2);
  assert.equal(manager.getOrCreate('g1'), p1);
  await p1.enqueue([makeTrack('one-a'), makeTrack('one-b')]);
  await p2.enqueue(makeTrack('two-a'));
  await p1.setVolume(90);
  p1.queue.setLoop('queue');
  p2.pause();

  assert.equal(p1.status, 'playing');
  assert.equal(p2.status, 'paused');
  assert.equal(p2.volume, 50);
  assert.equal(p2.queue.loopMode, 'off');
  assert.equal(p1.currentTrack.title, 'one-a');
  assert.equal(p2.currentTrack.title, 'two-a');

  manager.destroy('g1');
  assert.equal(manager.get('g1'), null);
  assert.equal(manager.get('g2'), p2);
  assert.equal(p2.status, 'paused');
  // a destroyed player is replaced by a fresh one on next use
  const again = manager.getOrCreate('g1');
  assert.notEqual(again, p1);
  manager.destroyAll();
  assert.equal(manager.size, 0);
  assert.ok(p2.destroyed);
});
