'use strict';

const { PermissionFlagsBits } = require('discord.js');
const embeds = require('../utils/embeds');
const { userMessageOf } = require('../utils/errors');
const { silentLogger } = require('../utils/logger');
const { formatDuration } = require('../utils/format');

/**
 * Turns player events into Discord messages in the channel where music was
 * requested. Keeps channel noise low:
 *   - one "Now Playing" message per guild, edited in place when it is still
 *     the latest message, otherwise replaced (old one deleted);
 *   - "queue finished" / "left" states reuse that same message.
 */
class Announcer {
  constructor({ client, settings = null, logger = silentLogger, config }) {
    this.client = client;
    this.settings = settings;
    this.logger = logger;
    this.config = config;
  }

  bind(player) {
    player.on('trackStart', (track) => this.safe(() => this.nowPlaying(player, track)));
    player.on('trackError', (track, error) => this.safe(() => this.trackError(player, track, error)));
    player.on('queueEnd', () => this.safe(() => this.replaceNowPlaying(player, embeds.infoEmbed('The queue has finished. Use `/play` to keep the session going.', 'Queue Finished'))));
    player.on('giveUp', () => this.safe(() => this.send(player, embeds.errorEmbed('Several tracks in a row failed to play, so I stopped and cleared the queue.', 'Playback Stopped'))));
    player.on('autoLeave', (reason) => this.safe(() => this.autoLeave(player, reason)));
  }

  async safe(fn) {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Announcement failed: ${err.message}`);
    }
  }

  announcementsEnabled(player) {
    return !this.settings || this.settings.get(player.guildId).announce !== false;
  }

  /** The text channel to talk in, if the bot may send embeds there. */
  channel(player) {
    if (!player.textChannelId) return null;
    const channel = this.client.channels.cache.get(player.textChannelId);
    if (!channel || !channel.isTextBased() || !channel.guild) return null;
    const perms = channel.permissionsFor(this.client.user);
    if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return null;
    }
    return channel;
  }

  async send(player, embed) {
    const channel = this.channel(player);
    if (!channel) return null;
    return channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  async nowPlaying(player, track) {
    if (!this.announcementsEnabled(player)) return;
    await this.replaceNowPlaying(player, embeds.nowPlayingEmbed(player, track));
  }

  /** Edits the existing Now Playing message if it is the newest one, else posts a new one. */
  async replaceNowPlaying(player, embed) {
    const channel = this.channel(player);
    if (!channel) return;
    const old = player.nowPlayingMessage;

    if (old && old.channelId === channel.id) {
      let isLatest = false;
      if (channel.permissionsFor(this.client.user).has(PermissionFlagsBits.ReadMessageHistory)) {
        try {
          const latest = await channel.messages.fetch({ limit: 1, cache: false });
          isLatest = latest.firstKey() === old.id;
        } catch {
          isLatest = false;
        }
      }
      if (isLatest) {
        try {
          await old.edit({ embeds: [embed], allowedMentions: { parse: [] } });
          return;
        } catch {
          /* fall through and post a new one */
        }
      }
      old.delete().catch(() => {});
    } else if (old) {
      old.delete().catch(() => {});
    }
    player.nowPlayingMessage = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  async trackError(player, track, error) {
    const reason = userMessageOf(error, 'The audio stream failed.');
    const next = player.queue.upcoming[0];
    await this.send(
      player,
      embeds.errorEmbed(
        `Couldn't play **${embeds.safeText(track.title, 100)}**\n${reason}${next ? '\nMoving on to the next track.' : ''}`,
        'Playback Failed',
      ),
    );
  }

  async autoLeave(player, reason) {
    const text = reason === 'alone'
      ? `Everyone left the voice channel, so I disconnected after ${formatDuration(this.config.player.aloneTimeoutMs)}.`
      : `Disconnected after ${formatDuration(this.config.player.inactivityTimeoutMs)} of inactivity. Use \`/play\` to bring me back.`;
    await this.replaceNowPlaying(player, embeds.infoEmbed(text, 'Disconnected'));
  }
}

module.exports = { Announcer };
