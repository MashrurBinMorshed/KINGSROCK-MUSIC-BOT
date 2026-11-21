'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const { GuildSettingsStore } = require('../../src/config/GuildSettingsStore');
const { assertSameChannel, assertCanControl, requireVoiceChannel, inviteUrl, INVITE_PERMISSIONS } = require('../../src/utils/permissions');
const embeds = require('../../src/utils/embeds');
const { acquireLock } = require('../../src/utils/instanceLock');
const { redact, addSecret } = require('../../src/utils/logger');
const { buildFfmpegArgs, describeFfmpegError } = require('../../src/music/FFmpeg');
const { UserError, userMessageOf, StreamError } = require('../../src/utils/errors');
const { QueueManager } = require('../../src/music/QueueManager');
const { makeTrack } = require('../helpers/fakes');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kingsrock-test-'));

test('settings store persists atomically and sanitizes input', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  const a = new GuildSettingsStore({ file });
  a.update('123456789012345678', { announce: false, djRoleId: '223456789012345678', defaultVolume: 70 });
  a.update('123456789012345679', { defaultVolume: 500, djRoleId: 'not-a-role' });
  a.flush();
  const b = new GuildSettingsStore({ file }).load();
  assert.deepEqual(b.get('123456789012345678'), { announce: false, djRoleId: '223456789012345678', defaultVolume: 70 });
  assert.deepEqual(b.get('123456789012345679'), { announce: true, djRoleId: null, defaultVolume: null });
  assert.deepEqual(b.get('999999999999999999'), { announce: true, djRoleId: null, defaultVolume: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings store survives a corrupted file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{not json');
  const s = new GuildSettingsStore({ file }).load();
  assert.equal(s.get('123456789012345678').announce, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

const member = ({ channelId = null, roles = [], admin = false, id = 'u1' } = {}) => ({
  id,
  voice: { channelId, channel: channelId ? { id: channelId } : null },
  roles: { cache: new Map(roles.map((r) => [r, true])) },
  permissions: { has: (p) => admin && (p === PermissionFlagsBits.ManageGuild || p === PermissionFlagsBits.Administrator) },
});

test('voice permission rules', () => {
  assert.throws(() => requireVoiceChannel(member()), /Join a voice channel/);
  assert.equal(requireVoiceChannel(member({ channelId: 'vc1' })).id, 'vc1');
  const player = { voiceChannelId: 'vc1' };
  assert.doesNotThrow(() => assertSameChannel(member({ channelId: 'vc1' }), player));
  assert.throws(() => assertSameChannel(member({ channelId: 'vc2' }), player), /need to be in <#vc1>/);
  assert.throws(() => assertSameChannel(member(), player), UserError);
});

test('DJ role rules: DJs, admins and the track requester are allowed', () => {
  const settings = { djRoleId: 'dj' };
  assert.doesNotThrow(() => assertCanControl(member(), { djRoleId: null }));
  assert.throws(() => assertCanControl(member(), settings), /Only members with/);
  assert.doesNotThrow(() => assertCanControl(member({ roles: ['dj'] }), settings));
  assert.doesNotThrow(() => assertCanControl(member({ admin: true }), settings));
  const track = { requestedBy: { id: 'u1' } };
  assert.doesNotThrow(() => assertCanControl(member({ id: 'u1' }), settings, { allowRequesterOf: track }));
  assert.throws(() => assertCanControl(member({ id: 'u2' }), settings, { allowRequesterOf: track }));
});

test('invite URL requests only the minimum permissions', () => {
  // View Channel + Send Messages + Embed Links + Read Message History + Connect + Speak
  assert.equal(INVITE_PERMISSIONS, 3230720n);
  assert.match(inviteUrl('123456789012345678'), /client_id=123456789012345678&permissions=3230720&scope=bot%20applications\.commands/);
});

test('embeds escape markdown, never ping, and render player state', () => {
  const q = new QueueManager();
  const t = makeTrack('Evil *bold* [link](http://x) @everyone', { url: 'https://example.com/a(b)', artist: '_DJ_' });
  q.add([t, makeTrack('next one')]);
  q.next();
  const player = { queue: q, currentTrack: t, status: 'playing', volume: 70, positionMs: 60000, pausedBy: null };
  const np = embeds.nowPlayingEmbed(player, t, { showProgress: true }).toJSON();
  assert.equal(np.color, embeds.COLORS.brand);
  assert.match(np.footer.text, /KINGSROCK/);
  assert.equal(np.url, 'https://example.com/a%28b%29');
  assert.ok(np.fields.some((f) => f.name === 'Requested by' && f.value === '<@1>'));
  assert.ok(np.fields.some((f) => f.name.startsWith('Up next') && f.value.includes('next one')));
  assert.match(np.description, /\\_DJ\\_/);
  const queue = embeds.queueEmbed(player, 1).toJSON();
  assert.match(queue.description, /Now playing/);
  assert.match(queue.description, /next one/);
  assert.equal(embeds.errorEmbed('x').toJSON().color, embeds.COLORS.error);
});

test('instance lock blocks a second live instance and releases cleanly', () => {
  const dir = tmpDir();
  const release = acquireLock(dir);
  const lockFile = path.join(dir, 'kingsrock.lock');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), String(process.pid));
  // simulate another live process holding the lock (our parent is alive)
  fs.writeFileSync(lockFile, String(process.ppid));
  assert.throws(() => acquireLock(dir), /already running/);
  // a stale lock from a dead PID is taken over
  fs.writeFileSync(lockFile, '999999');
  const release2 = acquireLock(dir);
  release2();
  assert.equal(fs.existsSync(lockFile), false);
  release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('logger redacts registered secrets', () => {
  addSecret('super-secret-token-value');
  assert.equal(redact('token=super-secret-token-value!'), 'token=[REDACTED]!');
});

test('FFmpeg arguments: Ogg/Opus output, safe protocols, volume only when needed', () => {
  const args = buildFfmpegArgs({ url: 'https://a.example/x.mp3', volume: 100, bitrateKbps: 96 });
  const joined = args.join(' ');
  assert.match(joined, /-protocol_whitelist http,https,tcp,tls,crypto/);
  assert.match(joined, /-c:a libopus -b:a 96k/);
  assert.match(joined, /-f ogg pipe:1$/);
  assert.doesNotMatch(joined, /-af/);
  assert.doesNotMatch(joined, /-ss/);
  const seeked = buildFfmpegArgs({ url: 'u', volume: 40, seekSeconds: 12.5 }).join(' ');
  assert.match(seeked, /-ss 12\.50 -i u/);
  assert.match(seeked, /-af volume=0\.40/);
  assert.doesNotMatch(buildFfmpegArgs({ url: 'u', seekSeconds: 10, isLive: true }).join(' '), /-ss/);
});

test('FFmpeg errors become readable messages', () => {
  assert.match(describeFfmpegError('Server returned 403 Forbidden (access denied)'), /403/);
  assert.match(describeFfmpegError('HTTP error 404 Not Found'), /not found/);
  assert.match(describeFfmpegError('Invalid data found when processing input'), /not supported/);
  assert.equal(describeFfmpegError('weird'), 'The audio stream failed.');
});

test('only KingsrockErrors expose their message to users', () => {
  assert.equal(userMessageOf(new StreamError('Stream broke')), 'Stream broke');
  assert.equal(userMessageOf(new Error('ECONNRESET at internal.js:12')), 'Something went wrong. Please try again.');
});
