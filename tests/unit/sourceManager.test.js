'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioSourceManager } = require('../../src/music/AudioSourceManager');
const { BaseProvider } = require('../../src/music/providers/BaseProvider');
const { Track } = require('../../src/music/Track');
const { UnsupportedSourceError, ProviderError, UserError, TrackUnavailableError } = require('../../src/utils/errors');

class StubProvider extends BaseProvider {
  constructor(name, { searchable = true, results = [], fail = false, owns = null, available = true } = {}) {
    super({ name, displayName: name.toUpperCase(), searchable });
    this.results = results;
    this.fail = fail;
    this.owns = owns;
    this.available = available;
    this.searched = [];
  }

  get isAvailable() { return this.available; }

  canResolve(url) { return Boolean(this.owns && url.includes(this.owns)); }

  async resolve(url) { return [new Track({ source: this.name, title: `resolved ${url}` })]; }

  async search(query) {
    this.searched.push(query);
    if (this.fail) throw new Error('kaboom');
    return this.results.map((title) => new Track({ source: this.name, title }));
  }

  async getStream() { return { url: 'https://stream.example/a' }; }
}

test('blocks YouTube, Spotify, SoundCloud links with a clear explanation', async () => {
  const m = new AudioSourceManager({ providers: [new StubProvider('direct', { searchable: false })] });
  for (const url of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://open.spotify.com/track/x', 'https://soundcloud.com/a/b', 'https://music.apple.com/x']) {
    await assert.rejects(m.resolve(url), (e) => e instanceof UnsupportedSourceError && /can't be played|turned off on this bot/.test(e.userMessage), url);
  }
});

test('routes URLs to the owning provider, otherwise to direct', async () => {
  const audius = new StubProvider('audius', { owns: 'audius.co' });
  const direct = new StubProvider('direct', { searchable: false });
  const m = new AudioSourceManager({ providers: [direct, audius] });
  assert.equal((await m.resolve('https://audius.co/a/b'))[0].source, 'audius');
  assert.equal((await m.resolve('https://cdn.example/a.mp3'))[0].source, 'direct');
});

test('auto search falls back across providers, skipping radio unless asked', async () => {
  const audius = new StubProvider('audius', { results: [] });
  const archive = new StubProvider('archive', { results: ['From Archive'] });
  const radio = new StubProvider('radio', { results: ['Radio X'] });
  const m = new AudioSourceManager({ providers: [audius, archive, radio], defaultSearch: 'audius' });
  const [t] = await m.resolve('some song');
  assert.equal(t.title, 'From Archive');
  assert.equal(radio.searched.length, 0);
  const [r] = await m.resolve('radio: chill');
  assert.equal(r.title, 'Radio X');
  assert.deepEqual(radio.searched, ['chill']);
});

test('a failing provider does not break auto search; explicit source surfaces the error', async () => {
  const broken = new StubProvider('audius', { fail: true });
  const archive = new StubProvider('archive', { results: ['ok'] });
  const m = new AudioSourceManager({ providers: [broken, archive], defaultSearch: 'audius' });
  assert.equal((await m.resolve('x'))[0].title, 'ok');
  await assert.rejects(m.search('x', { source: 'audius' }), ProviderError);
});

test('validation: empty, too long, unknown or unconfigured sources', async () => {
  const jam = new StubProvider('jamendo', { available: false });
  const m = new AudioSourceManager({ providers: [jam] });
  await assert.rejects(m.resolve('   '), UserError);
  await assert.rejects(m.resolve('x'.repeat(501)), /too long/);
  await assert.rejects(m.search('x', { source: 'nope' }), /Unknown source/);
  await assert.rejects(m.search('x', { source: 'jamendo' }), /not configured/);
});

test('no results gives a friendly TrackUnavailableError', async () => {
  const m = new AudioSourceManager({ providers: [new StubProvider('audius', { results: [] })] });
  await assert.rejects(m.resolve('zzzz'), TrackUnavailableError);
});

test('getStream errors for disabled sources', async () => {
  const m = new AudioSourceManager({ providers: [] });
  await assert.rejects(m.getStream(new Track({ source: 'audius', title: 'x' })), UnsupportedSourceError);
});
