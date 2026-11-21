'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { UserError } = require('./errors');

/**
 * Minimum permissions KINGSROCK needs. Used for the invite URL and checks.
 *   View Channel, Send Messages, Embed Links, Read Message History (to tidy
 *   up its own Now Playing message), Connect, Speak.
 */
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];
const INVITE_PERMISSIONS = REQUIRED_PERMISSIONS.reduce((acc, p) => acc | p, 0n);

function inviteUrl(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`;
}

/** The member's voice channel, or a friendly error. */
function requireVoiceChannel(member) {
  const channel = member && member.voice && member.voice.channel;
  if (!channel) throw new UserError('Join a voice channel first, then use this command.');
  return channel;
}

/** Checks that the bot can join and speak in `channel`. */
function assertCanJoin(channel, botMember) {
  if (channel.type === ChannelType.GuildStageVoice) {
    throw new UserError('Stage channels are not supported. Please use a regular voice channel.');
  }
  const perms = channel.permissionsFor(botMember);
  const missing = [];
  if (!perms || !perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
  if (!perms || !perms.has(PermissionFlagsBits.Connect)) missing.push('Connect');
  if (!perms || !perms.has(PermissionFlagsBits.Speak)) missing.push('Speak');
  if (missing.length) {
    throw new UserError(`I need the **${missing.join('**, **')}** permission${missing.length > 1 ? 's' : ''} in <#${channel.id}>.`);
  }
  const alreadyThere = botMember.voice && botMember.voice.channelId === channel.id;
  if (!alreadyThere && channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) {
    throw new UserError(`<#${channel.id}> is full.`);
  }
}

/** Users can only control playback from the bot's own voice channel. */
function assertSameChannel(member, player) {
  if (!player || !player.voiceChannelId) return;
  if (!member.voice || member.voice.channelId !== player.voiceChannelId) {
    throw new UserError(`You need to be in <#${player.voiceChannelId}> to control playback.`);
  }
}

function isAdmin(member) {
  return Boolean(member && member.permissions && (member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator)));
}

/**
 * If the server set a DJ role, only DJs, admins, or (for skip) the person who
 * requested the current track may use controls.
 */
function assertCanControl(member, settings, { allowRequesterOf = null } = {}) {
  if (!settings || !settings.djRoleId) return;
  if (isAdmin(member)) return;
  if (member.roles && member.roles.cache && member.roles.cache.has(settings.djRoleId)) return;
  if (allowRequesterOf && allowRequesterOf.requestedBy && allowRequesterOf.requestedBy.id === member.id) return;
  throw new UserError(`Only members with the <@&${settings.djRoleId}> role can do that.`);
}

module.exports = {
  REQUIRED_PERMISSIONS,
  INVITE_PERMISSIONS,
  inviteUrl,
  requireVoiceChannel,
  assertCanJoin,
  assertSameChannel,
  assertCanControl,
  isAdmin,
};
