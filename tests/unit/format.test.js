'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration, parseDurationToMs, truncate, progressBar, titleFromUrl } = require('../../src/utils/format');

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_723_000), '1:02:03');
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(5000, { live: true }), 'LIVE');
});

test('parseDurationToMs handles seconds and clock formats', () => {
  assert.equal(parseDurationToMs('123'), 123000);
  assert.equal(parseDurationToMs('123.5'), 123500);
  assert.equal(parseDurationToMs('2:03'), 123000);
  assert.equal(parseDurationToMs('1:02:03'), 3723000);
  assert.equal(parseDurationToMs(10), 10000);
  assert.equal(parseDurationToMs(''), null);
  assert.equal(parseDurationToMs('abc'), null);
});

test('truncate and progressBar', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 6), 'hello…');
  assert.equal(progressBar(50, 100, 10), '▰▰▰▰▰▱▱▱▱▱');
  assert.equal(progressBar(500, 100, 4), '▰▰▰▰');
});

test('titleFromUrl', () => {
  assert.equal(titleFromUrl('https://x.test/music/My_Song%20Name.mp3'), 'My Song Name');
  assert.equal(titleFromUrl('https://radio.test/'), 'radio.test');
});
