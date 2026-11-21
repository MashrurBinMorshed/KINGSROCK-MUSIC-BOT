'use strict';

/**
 * Test doubles for @discordjs/voice, FFmpeg and providers so MusicPlayer's
 * state machine can be tested deterministically without Discord or audio.
 */
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const { Track } = require('../../src/music/Track');

class FakeAudioPlayer extends EventEmitter {
  constructor({ autoPlay = true } = {}) {
    super();
    this.autoPlay = autoPlay;
    this.state = { status: AudioPlayerStatus.Idle };
    this.played = [];
  }

  setState(next) {
    const old = this.state;
    this.state = next;
    this.emit('stateChange', old, next);
  }

  play(resource) {
    this.played.push(resource);
    this.setState({ status: AudioPlayerStatus.Buffering, resource });
    if (this.autoPlay && !resource.metadata.handle.neverStart) {
      setImmediate(() => {
        if (this.state.resource === resource && this.state.status === AudioPlayerStatus.Buffering) {
          this.setState({ status: AudioPlayerStatus.Playing, resource });
        }
      });
    }
  }

  pause() {
    if (this.state.status !== AudioPlayerStatus.Playing) return false;
    this.setState({ status: AudioPlayerStatus.Paused, resource: this.state.resource });
    return true;
  }

  unpause() {
    if (this.state.status !== AudioPlayerStatus.Paused) return false;
    this.setState({ status: AudioPlayerStatus.Playing, resource: this.state.resource });
    return true;
  }

  stop() {
    if (this.state.status === AudioPlayerStatus.Idle) return false;
    this.setState({ status: AudioPlayerStatus.Idle });
    return true;
  }

  /** Simulates the current resource reaching its natural end. */
  finishCurrent() {
    if (this.state.status === AudioPlayerStatus.Idle) return;
    this.setState({ status: AudioPlayerStatus.Idle });
  }
}

class FakeConnection extends EventEmitter {
  constructor({ channelId }) {
    super();
    this.joinConfig = { channelId };
    this.state = { status: VoiceConnectionStatus.Ready };
    this.rejoinAttempts = 0;
    this.subscribed = null;
    this.destroyed = false;
  }

  subscribe(player) {
    this.subscribed = player;
  }

  rejoin(cfg) {
    if (cfg && cfg.channelId) this.joinConfig.channelId = cfg.channelId;
    this.rejoinAttempts += 1;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const old = this.state;
    this.state = { status: VoiceConnectionStatus.Destroyed };
    this.emit('stateChange', old, this.state);
  }
}

function entersState(target, status, timeoutMs) {
  if (target.state.status === status) return Promise.resolve(target);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.off('stateChange', onChange);
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    }, Math.min(timeoutMs, 200));
    const onChange = (_old, next) => {
      if (next.status === status) {
        clearTimeout(timer);
        target.off('stateChange', onChange);
        resolve(target);
      }
    };
    target.on('stateChange', onChange);
  });
}

function createFakeVoice() {
  const voice = {
    connections: [],
    players: [],
    createAudioPlayer: () => {
      const p = new FakeAudioPlayer();
      voice.players.push(p);
      return p;
    },
    // playStream is a plain object: the "first packet" check treats it as ready.
    createAudioResource: (stream, { metadata }) => ({ stream, playStream: {}, metadata, playbackDuration: 0 }),
    joinVoiceChannel: ({ channelId }) => {
      const c = new FakeConnection({ channelId });
      voice.connections.push(c);
      return c;
    },
    entersState,
  };
  return voice;
}

/** Fake FFmpeg: control exit codes per URL via `behaviors`. */
function createFakeFfmpeg() {
  const spawned = [];
  const behaviors = new Map(); // url -> { exitCode, stderr, delayMs, neverStart }
  const spawnFfmpeg = (opts) => {
    const behavior = behaviors.get(opts.url) || {};
    let resolveExit;
    const exited = new Promise((r) => { resolveExit = r; });
    let killed = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolveExit({ code, signal: null });
    };
    const handle = {
      opts,
      stream: new PassThrough(),
      exited,
      stderr: () => behavior.stderr || '',
      killedByUs: () => killed,
      kill: () => {
        if (done) return;
        killed = true;
        finish(null);
      },
      exit: finish,
      neverStart: Boolean(behavior.neverStart),
    };
    if (behavior.exitCode !== undefined) setTimeout(() => finish(behavior.exitCode), behavior.delayMs || 0);
    spawned.push(handle);
    return handle;
  };
  return { spawnFfmpeg, spawned, behaviors };
}

function fakeSources({ failing = new Set() } = {}) {
  return {
    calls: [],
    async getStream(track) {
      this.calls.push(track.title);
      if (failing.has(track.title)) {
        const { TrackUnavailableError } = require('../../src/utils/errors');
        throw new TrackUnavailableError(`${track.title} is unavailable`);
      }
      return { url: `http://audio.test/${encodeURIComponent(track.title)}`, isLive: track.isLive };
    },
  };
}

function makeTrack(title, extra = {}) {
  return new Track({ source: 'direct', title, durationMs: 180000, streamUrl: `http://audio.test/${title}`, requestedBy: { id: '1' }, ...extra });
}

function testConfig(overrides = {}) {
  return {
    audio: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', bitrateKbps: 96, defaultVolume: 50, startTimeoutMs: 200, ...(overrides.audio || {}) },
    player: { inactivityTimeoutMs: 60000, aloneTimeoutMs: 60000, maxQueueSize: 50, maxConsecutiveFailures: 3, ...(overrides.player || {}) },
    providers: { allowPrivateNetworkUrls: false, requestTimeoutMs: 1000, ...(overrides.providers || {}) },
  };
}

function fakeChannel(id = '100000000000000001', guildId = '200000000000000001') {
  return { id, guild: { id: guildId, voiceAdapterCreator: () => ({}) } };
}

const tick = () => new Promise((r) => setImmediate(r));

module.exports = {
  FakeAudioPlayer,
  FakeConnection,
  createFakeVoice,
  createFakeFfmpeg,
  fakeSources,
  makeTrack,
  testConfig,
  fakeChannel,
  tick,
};
