'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QueueManager } = require('../../src/music/QueueManager');
const { UserError } = require('../../src/utils/errors');
const { makeTrack } = require('../helpers/fakes');

const titles = (q) => q.upcoming.map((t) => t.title);

test('add returns positions and respects max size', () => {
  const q = new QueueManager({ maxSize: 3 });
  assert.deepEqual(q.add(makeTrack('a')), { added: 1, dropped: 0, firstPosition: 1 });
  assert.deepEqual(q.add([makeTrack('b'), makeTrack('c'), makeTrack('d')]), { added: 2, dropped: 1, firstPosition: 2 });
  assert.equal(q.size, 3);
  assert.throws(() => q.add(makeTrack('e')), UserError);
});

test('max size counts the current track', () => {
  const q = new QueueManager({ maxSize: 2 });
  q.add([makeTrack('a'), makeTrack('b')]);
  q.next();
  assert.equal(q.capacity, 0);
  assert.throws(() => q.add(makeTrack('c')), /full/);
});

test('remove uses 1-based positions and validates input', () => {
  const q = new QueueManager();
  q.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  assert.equal(q.remove(2).title, 'b');
  assert.deepEqual(titles(q), ['a', 'c']);
  assert.throws(() => q.remove(0), UserError);
  assert.throws(() => q.remove(3), /between 1 and 2/);
  assert.throws(() => q.remove(1.5), UserError);
  q.clear();
  assert.throws(() => q.remove(1), /no upcoming/);
});

test('clear keeps the current track, reset removes everything', () => {
  const q = new QueueManager();
  q.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  q.next();
  assert.equal(q.clear(), 2);
  assert.equal(q.current.title, 'a');
  q.reset();
  assert.equal(q.current, null);
  assert.ok(q.isEmpty);
});

test('shuffle is a permutation and uses the injected RNG', () => {
  const values = [0.9, 0.1, 0.5, 0.3];
  let i = 0;
  const q = new QueueManager({ random: () => values[i++ % values.length] });
  const input = ['a', 'b', 'c', 'd', 'e'];
  q.add(input.map((t) => makeTrack(t)));
  q.shuffle();
  assert.deepEqual([...titles(q)].sort(), input);
  assert.notDeepEqual(titles(q), input);
});

test('shuffle needs at least two upcoming tracks', () => {
  const q = new QueueManager();
  q.add(makeTrack('a'));
  assert.throws(() => q.shuffle(), UserError);
});

test('loop off: plays through then ends', () => {
  const q = new QueueManager();
  q.add([makeTrack('a'), makeTrack('b')]);
  assert.equal(q.next().title, 'a');
  assert.equal(q.next().title, 'b');
  assert.equal(q.next(), null);
  assert.ok(q.isEmpty);
});

test('loop track: repeats until skipped', () => {
  const q = new QueueManager();
  q.add([makeTrack('a'), makeTrack('b')]);
  q.setLoop('track');
  assert.equal(q.next().title, 'a');
  assert.equal(q.next().title, 'a');
  assert.equal(q.next().title, 'a');
  assert.equal(q.next({ skipped: true }).title, 'b');
  assert.equal(q.next().title, 'b');
});

test('loop queue: rotates finished tracks to the end', () => {
  const q = new QueueManager();
  q.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  q.setLoop('queue');
  const order = [];
  for (let n = 0; n < 7; n += 1) order.push(q.next().title);
  assert.deepEqual(order, ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  // skipping in queue loop still keeps the track in rotation
  assert.equal(q.next({ skipped: true }).title, 'b');
  assert.deepEqual(titles(q), ['c', 'a']);
});

test('failed tracks are dropped from rotation in every loop mode', () => {
  const q = new QueueManager();
  q.add([makeTrack('a'), makeTrack('b')]);
  q.setLoop('queue');
  q.next(); // a
  assert.equal(q.next({ failed: true }).title, 'b');
  assert.deepEqual(titles(q), []);
  q.setLoop('track');
  assert.equal(q.next({ failed: true }), null);
});

test('setLoop validates the mode', () => {
  const q = new QueueManager();
  assert.throws(() => q.setLoop('forever'), UserError);
  assert.equal(q.setLoop('queue'), 'queue');
});

test('upcomingDuration sums known durations and counts live/unknown tracks', () => {
  const q = new QueueManager();
  q.add([makeTrack('a', { durationMs: 1000 }), makeTrack('b', { durationMs: 2000 }), makeTrack('radio', { isLive: true, durationMs: null })]);
  assert.deepEqual(q.upcomingDuration(), { totalMs: 3000, unknown: 1 });
});
