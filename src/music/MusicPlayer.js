'use strict';

const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const voiceLib = require('@discordjs/voice');
const { QueueManager } = require('./QueueManager');
const { spawnFfmpeg: defaultSpawnFfmpeg, describeFfmpegError } = require('./FFmpeg');
const { KingsrockError, StreamError, UserError, VoiceConnectionError } = require('../utils/errors');
const { silentLogger } = require('../utils/logger');

const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  NoSubscriberBehavior,
  StreamType,
} = voiceLib;

const READY_TIMEOUT_MS = 20_000;
const MAX_REJOIN_ATTEMPTS = 5;

/**
 * Resolves when `stream` has at least one buffered audio packet; rejects if
 * the stream ends/errors first, or after `timeoutMs`. Does not consume data.
 */
function waitForFirstPacket(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof stream.readableLength !== 'number') {
      resolve(); // not a Node stream (test doubles)
      return;
    }
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
    };
    const onReadable = () => {
      if (stream.readableLength > 0) {
        cleanup();
        resolve();
      } else if (stream.readableEnded || stream.destroyed) {
        onEnd();
      } else {
        stream.read(0); // at EOF this triggers 'end' without consuming anything
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new StreamError('The stream ended before any audio was received. The file may be damaged or not audio.'));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    timer = setTimeout(() => {
      cleanup();
      const err = new Error('Timed out waiting for audio');
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs);
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onError);
    onReadable();
  });
}

/**
 * One MusicPlayer per guild. Owns that guild's voice connection, audio
 * player, queue, volume, loop mode and timers. Nothing here is shared between
 * guilds.
 *
 * Events (consumed by the Announcer to post Discord messages):
 *   trackStart (track)                 a track actually started producing audio
 *   trackError (track, error)          a track failed; playback moves on
 *   queueEnd   ()                      nothing left to play
 *   giveUp     (failures)              too many consecutive failures
 *   autoLeave  (reason)                left because of inactivity / empty channel
 *   destroyed  (reason)                all resources released
 *
 * Concurrency: every start/stop/skip bumps `playToken`. Async work that
 * finishes after a newer action checks the token and discards itself, so a
 * fast /skip during a slow stream start can never play two tracks at once.
 */
class MusicPlayer extends EventEmitter {
  constructor({
    guildId,
    config,
    sources,
    logger = silentLogger,
    volume,
    voice = voiceLib,
    spawnFfmpeg = defaultSpawnFfmpeg,
    noSubscriberBehavior = NoSubscriberBehavior.Pause,
  }) {
    super();
    this.guildId = guildId;
    this.config = config;
    this.sources = sources;
    this.logger = logger;
    this.voice = voice;
    this.spawnFfmpeg = spawnFfmpeg;

    this.queue = new QueueManager({ maxSize: config.player.maxQueueSize });
    this.volume = volume || config.audio.defaultVolume;

    this.connection = null;
    this.voiceChannelId = null;
    this.textChannelId = null;
    this.nowPlayingMessage = null;

    this.status = 'idle'; // idle | starting | playing | paused
    this.pausedBy = null; // user | alone
    this.needsRestart = false; // volume changed while paused
    this.playToken = 0;
    this.ffmpeg = null;
    this.resource = null;
    this.seekOffsetMs = 0;
    this.consecutiveFailures = 0;
    this.idleTimer = null;
    this.aloneTimer = null;
    this.readyLock = false;
    this.destroyed = false;

    this.audioPlayer = voice.createAudioPlayer({
      behaviors: {
        noSubscriber: noSubscriberBehavior,
        // Tolerate ~5 s of voice reconnection before the player gives up on a track.
        maxMissedFrames: 250,
      },
    });
    this.audioPlayer.on('stateChange', (oldState, newState) => this.onPlayerStateChange(oldState, newState));
    this.audioPlayer.on('error', (error) => {
      const meta = error.resource && error.resource.metadata;
      if (meta) meta.error = error;
      this.logger.warn(`Audio player error in guild ${this.guildId}: ${error.message}`);
    });
  }

  // ---------------------------------------------------------------- state

  get currentTrack() {
    return this.queue.current;
  }

  get isActive() {
    return this.status !== 'idle' || this.queue.size > 0;
  }

  /** Current playback position in ms (seek offset + time played since start). */
  get positionMs() {
    if (!this.resource || !this.queue.current) return 0;
    return this.seekOffsetMs + this.resource.playbackDuration;
  }

  // ---------------------------------------------------------------- voice

  /** Joins (or moves to) a voice channel and waits until the connection is ready. */
  async connect(channel) {
    if (this.destroyed) throw new VoiceConnectionError('This player was shut down. Try again.');
    const current = this.connection;
    if (current && current.state.status !== VoiceConnectionStatus.Destroyed) {
      if (this.voiceChannelId === channel.id && current.state.status === VoiceConnectionStatus.Ready) return;
      if (this.voiceChannelId !== channel.id) {
        current.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
        this.voiceChannelId = channel.id;
      }
      await this.waitReady(current);
      return;
    }

    const connection = this.voice.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection = connection;
    this.voiceChannelId = channel.id;
    this.attachConnectionHandlers(connection);
    await this.waitReady(connection);
    connection.subscribe(this.audioPlayer);
  }

  async waitReady(connection) {
    try {
      await this.voice.entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (err) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw new VoiceConnectionError(
        'Could not connect to the voice channel. Check that I have the **Connect** and **Speak** permissions there, then try again.',
        { cause: err },
      );
    }
  }

  attachConnectionHandlers(connection) {
    connection.on('error', (error) => {
      this.logger.warn(`Voice connection error in guild ${this.guildId}: ${error.message}`);
    });
    connection.on('stateChange', async (oldState, newState) => {
      if (this.destroyed || connection !== this.connection) return;
      try {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
          if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
            // 4014 = kicked from the channel, or moved. A move reconnects by itself.
            try {
              await this.voice.entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
            } catch {
              if (!this.destroyed) this.destroy('disconnected');
            }
          } else if (connection.rejoinAttempts < MAX_REJOIN_ATTEMPTS) {
            // Recoverable network interruption: back off and rejoin.
            await delay((connection.rejoinAttempts + 1) * 5_000);
            if (!this.destroyed && connection.state.status === VoiceConnectionStatus.Disconnected) {
              this.logger.info(`Rejoining voice in guild ${this.guildId} (attempt ${connection.rejoinAttempts + 1})`);
              connection.rejoin();
            }
          } else {
            this.logger.warn(`Voice connection lost in guild ${this.guildId}; giving up after ${MAX_REJOIN_ATTEMPTS} attempts.`);
            this.destroy('connection lost');
          }
        } else if (newState.status === VoiceConnectionStatus.Destroyed) {
          this.destroy('connection destroyed');
        } else if (!this.readyLock && (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling)) {
          // Don't let a connection hang in Connecting/Signalling forever.
          this.readyLock = true;
          try {
            await this.voice.entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
          } catch {
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
          } finally {
            this.readyLock = false;
          }
        }
      } catch (err) {
        this.logger.error(`Voice state handling failed in guild ${this.guildId}:`, err);
      }
    });
  }

  /** Called when the bot itself was moved to another channel. */
  onBotMoved(channelId) {
    if (channelId) this.voiceChannelId = channelId;
  }

  /**
   * Reacts to listeners joining/leaving. `humanCount` = non-bot members in
   * the bot's channel.
   */
  onListenersChanged(humanCount) {
    if (this.destroyed) return;
    if (humanCount === 0) {
      if (this.aloneTimer) return;
      if (this.status === 'playing') this.pause('alone');
      const t = setTimeout(() => {
        this.aloneTimer = null;
        if (!this.destroyed) {
          this.emit('autoLeave', 'alone');
          this.destroy('alone');
        }
      }, this.config.player.aloneTimeoutMs);
      t.unref();
      this.aloneTimer = t;
    } else {
      if (this.aloneTimer) {
        clearTimeout(this.aloneTimer);
        this.aloneTimer = null;
      }
      if (this.status === 'paused' && this.pausedBy === 'alone') {
        this.resume().catch((err) => this.logger.warn(`Auto-resume failed in guild ${this.guildId}: ${err.message}`));
      }
    }
  }

  // ---------------------------------------------------------------- queue / playback

  /**
   * Adds tracks. Starts playback if nothing is playing.
   * @returns {Promise<{added:number, dropped:number, position:number, startedNow:boolean, started?:object, failures?:Array}>}
   */
  async enqueue(tracks, { announce = false } = {}) {
    if (this.destroyed) throw new UserError('The player was shut down. Try again.');
    const { added, dropped, firstPosition } = this.queue.add(tracks);
    if (this.status === 'idle' && !this.queue.current) {
      const result = await this.playFromQueue({ announce });
      return { added, dropped, position: 0, startedNow: true, ...result };
    }
    return { added, dropped, position: firstPosition, startedNow: false };
  }

  /**
   * Advances the queue until a track starts or the queue is empty.
   * Failed tracks are reported and skipped.
   */
  async playFromQueue({ skipped = false, failed = false, announce = true } = {}) {
    const failures = [];
    let flags = { skipped, failed };
    for (;;) {
      if (this.destroyed) return { started: null, failures };
      if (this.consecutiveFailures >= this.config.player.maxConsecutiveFailures) {
        this.queue.reset();
        this.toIdle();
        this.consecutiveFailures = 0;
        this.emit('giveUp', failures);
        return { started: null, failures, gaveUp: true };
      }
      const next = this.queue.next(flags);
      if (!next) {
        this.toIdle();
        this.emit('queueEnd');
        return { started: null, failures };
      }
      const result = await this.startTrack(next, { announce });
      if (result.superseded) return { started: null, failures, superseded: true };
      if (result.started) return { started: next, failures };
      failures.push({ track: next, error: result.error });
      if (announce) this.emit('trackError', next, result.error);
      flags = { failed: true };
    }
  }

  /**
   * Starts streaming `track`. Resolves once audio is actually flowing (the
   * audio player reached Playing), or with an error. Never throws.
   */
  async startTrack(track, { announce = true, seekMs = 0 } = {}) {
    const token = ++this.playToken;
    this.clearIdleTimer();
    this.killStream();
    this.status = 'starting';
    this.pausedBy = null;
    this.needsRestart = false;
    this.seekOffsetMs = seekMs;

    let handle = null;
    try {
      const stream = await this.sources.getStream(track);
      if (token !== this.playToken || this.destroyed) return { superseded: true };

      handle = this.spawnFfmpeg(
        {
          url: stream.url,
          seekSeconds: seekMs / 1000,
          volume: this.volume,
          bitrateKbps: this.config.audio.bitrateKbps,
          isLive: stream.isLive ?? track.isLive,
          headers: stream.headers || null,
          input: stream.input || null,
        },
        { ffmpegPath: this.config.audio.ffmpegPath },
      );
      this.ffmpeg = handle;

      const resource = this.voice.createAudioResource(handle.stream, {
        inputType: StreamType.OggOpus,
        metadata: { track, token, handle },
      });
      this.resource = resource;

      const earlyExit = handle.exited.then((exit) => {
        if (exit && exit.code !== 0 && !handle.killedByUs()) {
          throw new StreamError(describeFfmpegError(handle.stderr()));
        }
        return new Promise(() => {}); // clean exit: let the packet check decide
      });
      // Never announce a track before real audio exists: wait for the first
      // Opus packet. (The audio player alone would report "Playing" even for
      // a stream that ends without producing any audio.)
      await Promise.race([waitForFirstPacket(resource.playStream, this.config.audio.startTimeoutMs), earlyExit]);
      if (token !== this.playToken || this.destroyed) {
        handle.kill();
        return { superseded: true };
      }
      this.audioPlayer.play(resource);
      await Promise.race([this.voice.entersState(this.audioPlayer, AudioPlayerStatus.Playing, 5_000), earlyExit]);
    } catch (err) {
      if (token !== this.playToken || this.destroyed) return { superseded: true };
      // If an input program (yt-dlp) failed, its reason is more useful than FFmpeg's.
      let inputError = null;
      if (handle && handle.inputExited) {
        await handle.inputExited();
        inputError = handle.inputError();
      }
      if (token !== this.playToken || this.destroyed) return { superseded: true };
      if (handle) handle.kill();
      this.ffmpeg = null;
      this.resource = null;
      this.consecutiveFailures += 1;
      const error = inputError || this.normalizeStartError(err, handle);
      this.logger.warn(`Track failed in guild ${this.guildId}: "${track.title}" (${track.source}): ${error.message}`);
      return { error };
    }

    if (token !== this.playToken || this.destroyed) return { superseded: true };
    this.status = 'playing';
    this.consecutiveFailures = 0;
    this.logger.info(`Playing in guild ${this.guildId}: "${track.title}" (${track.source})`);
    if (announce) this.emit('trackStart', track);
    return { started: track };
  }

  normalizeStartError(err, handle) {
    if (err instanceof KingsrockError) return err;
    const stderr = handle ? handle.stderr() : '';
    if (err && err.name === 'AbortError') {
      return new StreamError(stderr ? describeFfmpegError(stderr) : 'The audio stream did not start in time.', { cause: err });
    }
    return new StreamError(stderr ? describeFfmpegError(stderr) : 'The audio stream failed to start.', { cause: err });
  }

  onPlayerStateChange(oldState, newState) {
    if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle && oldState.resource) {
      this.onResourceEnd(oldState.resource.metadata).catch((err) => {
        this.logger.error(`Error advancing queue in guild ${this.guildId}:`, err);
      });
    }
  }

  /** A resource finished on its own (track ended or stream died). */
  async onResourceEnd(meta) {
    if (!meta || this.destroyed || meta.token !== this.playToken) return; // stale or intentional
    const exit = await Promise.race([meta.handle.exited, delay(1500).then(() => null)]);
    if (this.destroyed || meta.token !== this.playToken) return;

    let error = null;
    const inputError = meta.handle.inputError ? meta.handle.inputError() : null;
    if (inputError) error = inputError;
    else if (meta.error) error = new StreamError('The audio stream failed during playback.', { cause: meta.error });
    else if (exit && exit.code !== 0 && exit.code !== null && !meta.handle.killedByUs()) {
      error = new StreamError(describeFfmpegError(meta.handle.stderr()));
    }

    this.ffmpeg = null;
    this.resource = null;
    if (error) {
      this.consecutiveFailures += 1;
      this.logger.warn(`Playback error in guild ${this.guildId}: "${meta.track.title}": ${error.message}`);
      this.emit('trackError', meta.track, error);
    }
    await this.playFromQueue({ failed: Boolean(error), announce: true });
  }

  pause(by = 'user') {
    if (this.status === 'paused') throw new UserError('Playback is already paused.');
    if (this.status !== 'playing') throw new UserError('Nothing is playing right now.');
    this.audioPlayer.pause(true);
    this.status = 'paused';
    this.pausedBy = by;
    this.startIdleTimer();
    return this.queue.current;
  }

  async resume() {
    if (this.status !== 'paused') throw new UserError(this.status === 'playing' ? 'Playback is not paused.' : 'Nothing is paused right now.');
    this.clearIdleTimer();
    const track = this.queue.current;
    // Live radio would resume with stale audio, and a pending volume change
    // needs a new FFmpeg process: restart the stream in both cases.
    if (track && (track.isLive || this.needsRestart)) {
      return this.restartCurrent();
    }
    this.audioPlayer.unpause();
    this.status = 'playing';
    this.pausedBy = null;
    return track;
  }

  /** Restarts the current track at the current position (volume change, live resume). */
  async restartCurrent() {
    const track = this.queue.current;
    if (!track) return null;
    const seekMs = track.isLive ? 0 : Math.max(0, this.positionMs - 250);
    const result = await this.startTrack(track, { announce: false, seekMs });
    if (result.error) {
      this.emit('trackError', track, result.error);
      await this.playFromQueue({ failed: true, announce: true });
      return null;
    }
    return track;
  }

  async skip() {
    const skipped = this.queue.current;
    if (!skipped) throw new UserError('Nothing is playing right now.');
    this.playToken += 1; // invalidate the running track / start attempt
    this.killStream();
    this.audioPlayer.stop(true);
    const result = await this.playFromQueue({ skipped: true, announce: true });
    return { skipped, next: result.started || null };
  }

  stop() {
    if (!this.queue.current && this.queue.size === 0 && this.status === 'idle') {
      throw new UserError('Nothing is playing right now.');
    }
    this.playToken += 1;
    this.killStream();
    this.audioPlayer.stop(true);
    this.queue.reset();
    this.toIdle();
  }

  /** @returns {Promise<{ volume: number, restarted: boolean }>} */
  async setVolume(volume) {
    if (!Number.isInteger(volume) || volume < 1 || volume > 100) throw new UserError('Volume must be a whole number from 1 to 100.');
    const changed = volume !== this.volume;
    this.volume = volume;
    if (!changed || !this.queue.current) return { volume, restarted: false };
    if (this.status === 'paused') {
      this.needsRestart = true;
      return { volume, restarted: false };
    }
    if (this.status === 'playing') {
      await this.restartCurrent();
      return { volume, restarted: true };
    }
    return { volume, restarted: false };
  }

  // ---------------------------------------------------------------- lifecycle

  toIdle() {
    this.status = 'idle';
    this.pausedBy = null;
    this.ffmpeg = null;
    this.resource = null;
    this.startIdleTimer();
  }

  startIdleTimer() {
    this.clearIdleTimer();
    const t = setTimeout(() => {
      this.idleTimer = null;
      if (!this.destroyed && (this.status === 'idle' || this.status === 'paused')) {
        this.emit('autoLeave', 'inactivity');
        this.destroy('inactivity');
      }
    }, this.config.player.inactivityTimeoutMs);
    t.unref();
    this.idleTimer = t;
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  killStream() {
    if (this.ffmpeg) {
      this.ffmpeg.kill();
      this.ffmpeg = null;
    }
    this.resource = null;
  }

  /** Releases everything: FFmpeg, audio player, voice connection, timers. Idempotent. */
  destroy(reason = 'destroyed') {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playToken += 1;
    this.clearIdleTimer();
    if (this.aloneTimer) clearTimeout(this.aloneTimer);
    this.aloneTimer = null;
    this.killStream();
    try {
      this.audioPlayer.stop(true);
    } catch {
      /* ignore */
    }
    this.audioPlayer.removeAllListeners();
    // A late stream error must never become an unhandled 'error' event.
    this.audioPlayer.on('error', () => {});
    const connection = this.connection;
    this.connection = null;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy();
      } catch {
        /* ignore */
      }
    }
    this.queue.reset();
    this.status = 'idle';
    this.logger.info(`Player for guild ${this.guildId} destroyed (${reason})`);
    this.emit('destroyed', reason);
    this.removeAllListeners();
  }
}

module.exports = { MusicPlayer };
