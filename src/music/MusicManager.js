'use strict';

const { MusicPlayer } = require('./MusicPlayer');
const { silentLogger } = require('../utils/logger');

/**
 * Keeps one independent MusicPlayer per guild. Players are created on the
 * first /play and removed as soon as they are destroyed (leave, inactivity,
 * kick, shutdown), so idle servers cost nothing.
 */
class MusicManager {
  constructor({ config, sources, settings = null, logger = silentLogger, announcer = null, playerFactory = null }) {
    this.config = config;
    this.sources = sources;
    this.settings = settings;
    this.logger = logger;
    this.announcer = announcer;
    this.playerFactory = playerFactory || ((opts) => new MusicPlayer(opts));
    this.players = new Map();
  }

  get size() {
    return this.players.size;
  }

  get(guildId) {
    return this.players.get(guildId) || null;
  }

  /** Returns the guild's player, creating it if needed. */
  getOrCreate(guildId) {
    const existing = this.players.get(guildId);
    if (existing && !existing.destroyed) return existing;

    const guildSettings = this.settings ? this.settings.get(guildId) : {};
    const player = this.playerFactory({
      guildId,
      config: this.config,
      sources: this.sources,
      logger: this.logger.child ? this.logger.child(`guild:${guildId}`) : this.logger,
      volume: guildSettings.defaultVolume || this.config.audio.defaultVolume,
    });
    player.once('destroyed', () => {
      if (this.players.get(guildId) === player) this.players.delete(guildId);
    });
    if (this.announcer) this.announcer.bind(player);
    this.players.set(guildId, player);
    return player;
  }

  destroy(guildId, reason = 'removed') {
    const player = this.players.get(guildId);
    if (player) player.destroy(reason);
    this.players.delete(guildId);
  }

  destroyAll(reason = 'shutdown') {
    for (const player of [...this.players.values()]) {
      try {
        player.destroy(reason);
      } catch (err) {
        this.logger.error('Error destroying player:', err);
      }
    }
    this.players.clear();
  }

  /** discord.js voiceStateUpdate handler. */
  handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild ? newState.guild.id : oldState.guild.id;
    const player = this.players.get(guildId);
    if (!player || player.destroyed) return;

    const botId = newState.client && newState.client.user ? newState.client.user.id : null;
    if (newState.id === botId) {
      if (newState.channelId && newState.channelId !== player.voiceChannelId) player.onBotMoved(newState.channelId);
      // A full disconnect is handled by the voice connection state machine.
    }

    const channelId = player.voiceChannelId;
    if (!channelId) return;
    if (oldState.channelId !== channelId && newState.channelId !== channelId && newState.id !== botId) return;

    const channel = newState.guild.channels.cache.get(channelId);
    if (!channel || !channel.members) return;
    const humans = channel.members.filter((m) => !m.user.bot).size;
    player.onListenersChanged(humans);
  }
}

module.exports = { MusicManager };
