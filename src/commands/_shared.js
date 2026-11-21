'use strict';

const { MessageFlags } = require('discord.js');
const embeds = require('../utils/embeds');
const { UserError, userMessageOf } = require('../utils/errors');
const { requireVoiceChannel, assertCanJoin, assertSameChannel, assertCanControl } = require('../utils/permissions');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_MENTIONS = { parse: [] };

/** Replies, edits a deferred reply, or follows up, whichever is valid now. */
async function respond(interaction, payload) {
  const body = { allowedMentions: NO_MENTIONS, ...payload };
  if (interaction.deferred && !interaction.replied) {
    const { flags, ...rest } = body; // flags can't change after defer
    return interaction.editReply(rest);
  }
  if (interaction.replied) return interaction.followUp(body);
  return interaction.reply(body);
}

function replyEphemeral(interaction, embed) {
  return respond(interaction, { embeds: [embed], flags: EPHEMERAL });
}

/**
 * Common checks for playback controls:
 *  - a player exists in this guild,
 *  - the user is in the bot's voice channel,
 *  - the DJ role (if configured) allows it.
 */
function controlGuard(interaction, ctx, { allowRequester = false, requireTrack = false } = {}) {
  const player = ctx.music.get(interaction.guildId);
  if (!player || player.destroyed || !player.voiceChannelId) throw new UserError("I'm not connected to a voice channel in this server.");
  assertSameChannel(interaction.member, player);
  assertCanControl(interaction.member, ctx.settings.get(interaction.guildId), {
    allowRequesterOf: allowRequester ? player.currentTrack : null,
  });
  if (requireTrack && !player.currentTrack) throw new UserError('Nothing is playing right now.');
  return player;
}

/** Validates that `member` may start/queue music, before doing slow work. */
function preflightPlay(interaction, ctx) {
  const channel = requireVoiceChannel(interaction.member);
  const player = ctx.music.get(interaction.guildId);
  if (player && !player.destroyed && player.voiceChannelId && player.voiceChannelId !== channel.id && player.isActive) {
    throw new UserError(`I'm already playing in <#${player.voiceChannelId}>. Join that channel to add music.`);
  }
  assertCanJoin(channel, interaction.guild.members.me);
  return channel;
}

/**
 * Connects (if needed) and enqueues tracks for the requesting member.
 * @returns {Promise<{player, result}>}
 */
async function queueTracks(interaction, ctx, tracks, { announceStart = false } = {}) {
  const channel = preflightPlay(interaction, ctx); // re-check: state may have changed while resolving
  const player = ctx.music.getOrCreate(interaction.guildId);
  player.textChannelId = interaction.channelId;
  await player.connect(channel);
  const result = await player.enqueue(tracks, { announce: announceStart });
  return { player, result };
}

/** Builds the reply embeds for a queueTracks() result. */
function playResultEmbeds(player, tracks, result, requesterId) {
  const list = [];
  if (result.startedNow) {
    if (result.started) list.push(embeds.nowPlayingEmbed(player, result.started));
    if (result.failures && result.failures.length) {
      const lines = result.failures.slice(0, 5)
        .map((f) => `• **${embeds.safeText(f.track.title, 80)}**: ${userMessageOf(f.error, 'stream failed')}`);
      list.push(embeds.errorEmbed(lines.join('\n'), result.started ? 'Skipped Unplayable Tracks' : 'Playback Failed'));
    }
    if (result.started && result.added > 1) {
      list.push(embeds.successEmbed(`Added **${result.added}** tracks to the queue.`));
    }
  } else {
    list.push(embeds.addedEmbed(tracks.slice(0, result.added), { position: result.position, requester: requesterId }));
  }
  if (result.dropped) list.push(embeds.warningEmbed(`${result.dropped} track(s) were not added because the queue is full.`));
  return list;
}

function requesterOf(interaction) {
  return { id: interaction.user.id, tag: interaction.user.tag };
}

/** Tiny per-user cooldown to protect provider APIs from spam. */
class Cooldowns {
  constructor() {
    this.map = new Map();
  }

  /** Throws if the user used `key` less than `ms` ago. */
  hit(userId, key, ms) {
    const id = `${key}:${userId}`;
    const now = Date.now();
    const until = this.map.get(id) || 0;
    if (until > now) throw new UserError(`Slow down a little, try again in ${Math.ceil((until - now) / 1000)}s.`);
    this.map.set(id, now + ms);
    if (this.map.size > 5000) {
      for (const [k, v] of this.map) if (v <= now) this.map.delete(k);
    }
  }
}

module.exports = {
  EPHEMERAL,
  NO_MENTIONS,
  respond,
  replyEphemeral,
  controlGuard,
  preflightPlay,
  queueTracks,
  playResultEmbeds,
  requesterOf,
  Cooldowns,
};
