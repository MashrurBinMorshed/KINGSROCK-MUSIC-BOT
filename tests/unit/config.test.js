'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');
const { ConfigError } = require('../../src/utils/errors');

// A syntactically valid but fake token.
const TOKEN = `${'A'.repeat(26)}.${'B'.repeat(6)}.${'C'.repeat(38)}`;
const load = (env, opts = {}) => loadConfig({ env: { ...env }, argv: [], loadFile: false, ...opts });

test('valid minimal config uses safe defaults', () => {
  const c = load({ DISCORD_TOKEN: TOKEN });
  assert.equal(c.nodeEnv, 'production');
  assert.equal(c.discord.guildId, null);
  assert.equal(c.audio.defaultVolume, 50);
  assert.equal(c.audio.bitrateKbps, 96);
  assert.equal(c.player.inactivityTimeoutMs, 300_000);
  assert.equal(c.providers.allowPrivateNetworkUrls, false);
  assert.deepEqual(c.providers.enabled, ['direct', 'audius', 'archive', 'jamendo', 'radio']);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.audio));
});

test('missing or malformed token is reported', () => {
  assert.throws(() => load({}), (e) => e instanceof ConfigError && /DISCORD_TOKEN is missing/.test(e.message));
  assert.throws(() => load({ DISCORD_TOKEN: '"abc"' }), /does not look like/);
  // commands like `npm run doctor` can skip the token requirement
  assert.ok(load({}, { requireToken: false }));
});

test('all problems are reported together', () => {
  try {
    load({ DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_ID: 'abc', DISCORD_GUILD_ID: '12', DEFAULT_VOLUME: '150', AUDIO_BITRATE: 'loud', ENABLED_PROVIDERS: 'direct,napster', LOG_LEVEL: 'chatty' });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.problems.length, 6);
  }
});

test('--dev switches to development with debug logs; DISCORD_GUILD_ID is optional', () => {
  const c = load({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '123456789012345678' }, { argv: ['node', 'index.js', '--dev'] });
  assert.equal(c.isDevelopment, true);
  assert.equal(c.logLevel, 'debug');
  assert.equal(c.discord.guildId, '123456789012345678');
});

test('register script requires DISCORD_CLIENT_ID', () => {
  assert.throws(() => load({ DISCORD_TOKEN: TOKEN }, { requireClientId: true }), /DISCORD_CLIENT_ID is missing/);
});
