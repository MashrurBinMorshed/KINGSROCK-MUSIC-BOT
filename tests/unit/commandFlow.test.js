'use strict';

/**
 * Command-layer tests: fake Discord interactions go through the real
 * interactionCreate router, real commands, real permission guards and a real
 * MusicManager/MusicPlayer (with fake voice + FFmpeg).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { ChannelType, PermissionFlagsBits, Collection } = require('discord.js');
const { loadCommands } = require('../../src/commands');
const { Cooldowns } = require('../../src/commands/_shared');
const interactionEvents = require('../../src/events/interactionCreate');
const { MusicManager } = require('../../src/music/MusicManager');
const { MusicPlayer } = require('../../src/music/MusicPlayer');
const { Announcer } = require('../../src/music/Announcer');
const { GuildSettingsStore } = require('../../src/config/GuildSettingsStore');
const { startHealthServer } = require('../../src/utils/healthServer');
const { silentLogger } = require('../../src/utils/logger');
const {
  createFakeVoice, createFakeFfmpeg, fakeSources, makeTrack, testConfig, tick,
} = require('../helpers/fakes');

const GUILD = '300000000000000001';
const VC1 = '400000000000000001';
const VC2 = '400000000000000002';

function voiceChannel(id) {
  return {
    id,
    type: ChannelType.GuildVoice,
    full: false,
    guild: { id: GUILD, voiceAdapterCreator: () => ({}) },
    permissionsFor: () => ({ has: () => true }),
  };
}

function member({ id = 'u1', channel = null, admin = false } = {}) {
  return {
    id,
    voice: { channel, channelId: channel ? channel.id : null },
    roles: { cache: new Map() },
    permissions: { has: (p) => admin && (p === PermissionFlagsBits.ManageGuild || p === PermissionFlagsBits.Administrator) },
  };
}

function interaction(name, { options = {}, sub = null, m = member() } = {}) {
  const calls = [];
  return {
    calls,
    commandName: name,
    id: `i-${Math.random()}`,
    guildId: GUILD,
    channelId: 'text-1',
    user: { id: m.id, tag: `${m.id}#0001` },
    member: m,
    guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
    deferred: false,
    replied: false,
    options: {
      getString: (n) => options[n] ?? null,
      getInteger: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null,
      getRole: (n) => options[n] ?? null,
      getSubcommand: () => sub,
    },
    inGuild: () => true,
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isMessageComponent: () => false,
    isRepliable: () => true,
    async deferReply(o) { this.deferred = true; calls.push(['defer', o]); },
    async reply(p) { this.replied = true; calls.push(['reply', p]); return { id: 'reply-msg' }; },
    async editReply(p) { calls.push(['edit', p]); return { id: 'reply-msg', channelId: 'text-1' }; },
    async followUp(p) { calls.push(['followUp', p]); return {}; },
  };
}

function setup() {
  const voice = createFakeVoice();
  const ff = createFakeFfmpeg();
  const config = testConfig();
  const sources = fakeSources();
  sources.resolve = async (query, { requestedBy }) => [makeTrack(query, { requestedBy })];
  sources.searchProviders = () => [{ displayName: 'Audius' }];
  const settings = new GuildSettingsStore({});
  const music = new MusicManager({
    config, sources, settings, logger: silentLogger,
    playerFactory: (opts) => new MusicPlayer({ ...opts, voice, spawnFfmpeg: ff.spawnFfmpeg }),
  });
  const client = new EventEmitter();
  const ctx = { client, config, logger: silentLogger, sources, music, settings, commands: loadCommands(), cooldowns: new Cooldowns() };
  interactionEvents.register(client, ctx);
  const run = async (i) => {
    client.emit('interactionCreate', i);
    for (let n = 0; n < 20; n += 1) await tick();
    return i;
  };
  return { ctx, run, music, voice, ff };
}

const embedText = (call) => JSON.stringify(call[1].embeds.map((e) => (e.toJSON ? e.toJSON() : e)));
const lastCall = (i) => i.calls[i.calls.length - 1];

test('/play outside a voice channel gives an ephemeral error', async () => {
  const { run } = setup();
  const i = await run(interaction('play', { options: { query: 'song' } }));
  const call = lastCall(i);
  assert.equal(call[0], 'reply');
  assert.equal(call[1].flags, 64);
  assert.match(embedText(call), /Join a voice channel/);
});

test('/play joins, starts playback and replies with the Now Playing embed', async () => {
  const { run, music, voice } = setup();
  const i = await run(interaction('play', { options: { query: 'Anthem' }, m: member({ channel: voiceChannel(VC1) }) }));
  assert.equal(i.calls[0][0], 'defer');
  const call = lastCall(i);
  assert.equal(call[0], 'edit');
  assert.match(embedText(call), /Now Playing/);
  assert.match(embedText(call), /Anthem/);
  const player = music.get(GUILD);
  assert.equal(player.status, 'playing');
  assert.equal(player.voiceChannelId, VC1);
  assert.equal(player.nowPlayingMessage.id, 'reply-msg');
  assert.equal(voice.connections.length, 1);

  // a second /play queues instead
  const i2 = await run(interaction('play', { options: { query: 'Second' }, m: member({ id: 'u2', channel: voiceChannel(VC1) }) }));
  assert.match(embedText(lastCall(i2)), /Added to Queue/);
  assert.equal(player.queue.size, 1);
});

test('controls are refused from another voice channel, and while not connected', async () => {
  const { run } = setup();
  const none = await run(interaction('skip', { m: member({ channel: voiceChannel(VC1) }) }));
  assert.match(embedText(lastCall(none)), /not connected/);

  await run(interaction('play', { options: { query: 'A' }, m: member({ channel: voiceChannel(VC1) }) }));
  const other = await run(interaction('skip', { m: member({ id: 'u9', channel: voiceChannel(VC2) }) }));
  assert.match(embedText(lastCall(other)), /You need to be in <#400000000000000001>/);
  const play = await run(interaction('play', { options: { query: 'B' }, m: member({ id: 'u9', channel: voiceChannel(VC2) }) }));
  assert.match(embedText(lastCall(play)), /already playing in/);
});

test('pause, resume, skip, loop, shuffle, queue and stop work through the router', async () => {
  const { run, music } = setup();
  const m = member({ channel: voiceChannel(VC1) });
  await run(interaction('play', { options: { query: 'A' }, m }));
  // per-user /play cooldown: the same user can't fire 3 requests in a row
  const spam = await run(interaction('play', { options: { query: 'spam' }, m }));
  assert.match(embedText(lastCall(spam)), /Slow down/);
  await run(interaction('play', { options: { query: 'B' }, m: member({ id: 'u2', channel: voiceChannel(VC1) }) }));
  await run(interaction('play', { options: { query: 'C' }, m: member({ id: 'u3', channel: voiceChannel(VC1) }) }));
  const player = music.get(GUILD);

  assert.match(embedText(lastCall(await run(interaction('pause', { m })))), /Paused/);
  assert.equal(player.status, 'paused');
  assert.match(embedText(lastCall(await run(interaction('resume', { m })))), /Resumed/);
  assert.match(embedText(lastCall(await run(interaction('loop', { m, options: { mode: 'queue' } })))), /whole queue/);
  assert.match(embedText(lastCall(await run(interaction('shuffle', { m })))), /Shuffled/);
  const q = await run(interaction('queue', { m }));
  assert.equal(lastCall(q)[1].flags, 64);
  assert.match(embedText(lastCall(q)), /Up next/);
  assert.match(embedText(lastCall(await run(interaction('skip', { m })))), /Skipped/);
  assert.match(embedText(lastCall(await run(interaction('remove', { m, options: { position: 1 } })))), /Removed/);
  assert.match(embedText(lastCall(await run(interaction('volume', { m, options: { level: 70 } })))), /70%/);
  assert.equal(player.volume, 70);
  assert.match(embedText(lastCall(await run(interaction('stop', { m })))), /Stopped/);
  assert.equal(player.queue.total, 0);
  assert.match(embedText(lastCall(await run(interaction('leave', { m })))), /Disconnected/);
  assert.equal(music.get(GUILD), null);
});

test('/settings requires Manage Server; admins can set a DJ role that then restricts controls', async () => {
  const { run } = setup();
  const denied = await run(interaction('settings', { sub: 'view' }));
  assert.match(embedText(lastCall(denied)), /Manage Server/);

  const admin = member({ id: 'admin', admin: true });
  const set = await run(interaction('settings', { sub: 'dj-role', options: { role: { id: '500000000000000001' } }, m: admin }));
  assert.match(embedText(lastCall(set)), /500000000000000001/);

  const m = member({ id: 'dj-less', channel: voiceChannel(VC1) });
  await run(interaction('play', { options: { query: 'A' }, m: member({ id: 'other', channel: voiceChannel(VC1) }) }));
  const pause = await run(interaction('pause', { m }));
  assert.match(embedText(lastCall(pause)), /Only members with the/);
  // ...but anyone can still queue
  const play = await run(interaction('play', { options: { query: 'B' }, m }));
  assert.match(embedText(lastCall(play)), /Added to Queue/);
});

test('unexpected internal errors are logged and users get a generic message', async () => {
  const { run, ctx } = setup();
  ctx.sources.resolve = async () => { throw new Error('internal stack details'); };
  const i = await run(interaction('play', { options: { query: 'x' }, m: member({ channel: voiceChannel(VC1) }) }));
  const text = embedText(lastCall(i));
  assert.match(text, /Something went wrong/);
  assert.doesNotMatch(text, /internal stack details/);
});

test('/help lists commands and sources', async () => {
  const { run } = setup();
  const i = await run(interaction('help'));
  const text = embedText(lastCall(i));
  for (const c of ['/play', '/queue', '/loop', '/settings']) assert.match(text, new RegExp(c));
  assert.match(text, /Audius/);
});

// ---------------------------------------------------------------- announcer

function fakeTextChannel({ latestId = null } = {}) {
  const sent = [];
  const channel = {
    id: 'text-1',
    guild: {},
    sent,
    latestId,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection(channel.latestId ? [[channel.latestId, {}]] : []) },
    async send(p) {
      const msg = {
        id: `m${sent.length + 1}`, channelId: 'text-1', edits: [], deleted: false,
        async edit(x) { this.edits.push(x); return this; },
        async delete() { this.deleted = true; },
      };
      sent.push({ payload: p, msg });
      channel.latestId = msg.id;
      return msg;
    },
  };
  return channel;
}

test('announcer edits the Now Playing message when it is the latest, otherwise replaces it', async () => {
  const channel = fakeTextChannel();
  const client = { channels: { cache: new Map([['text-1', channel]]) }, user: { id: 'bot' } };
  const settings = new GuildSettingsStore({});
  const announcer = new Announcer({ client, settings, config: testConfig() });
  const player = Object.assign(new EventEmitter(), {
    guildId: GUILD, textChannelId: 'text-1', nowPlayingMessage: null,
    queue: { upcoming: [], size: 0, loopMode: 'off' }, status: 'playing', volume: 50, positionMs: 0,
  });

  await announcer.nowPlaying(player, makeTrack('One'));
  assert.equal(channel.sent.length, 1);
  const first = player.nowPlayingMessage;

  await announcer.nowPlaying(player, makeTrack('Two')); // still latest: edit in place
  assert.equal(channel.sent.length, 1);
  assert.equal(first.edits.length, 1);

  channel.latestId = 'someone-else';
  await announcer.nowPlaying(player, makeTrack('Three')); // buried: delete + new message
  assert.equal(channel.sent.length, 2);
  assert.equal(first.deleted, true);

  settings.update(GUILD, { announce: false });
  await announcer.nowPlaying(player, makeTrack('Four'));
  assert.equal(channel.sent.length, 2, 'announcements disabled');
});

test('health endpoint reports gateway state', async () => {
  const client = { isReady: () => true, ws: { status: 0, ping: 42 }, guilds: { cache: { size: 3 } } };
  const server = startHealthServer({ port: 0, host: '127.0.0.1', client, music: { size: 1 }, logger: silentLogger });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
  server.close();
  assert.equal(body.status, 200);
  assert.equal(body.json.status, 'ok');
  assert.equal(body.json.guilds, 3);
  assert.equal(body.json.activePlayers, 1);
});
