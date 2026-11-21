'use strict';

const { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits } = require('discord.js');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { isAdmin } = require('../utils/permissions');
const { respond, EPHEMERAL } = require('./_shared');

module.exports = {
  category: 'Admin',
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Server settings for KINGSROCK (Manage Server required)')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('view').setDescription('Show the current settings'))
    .addSubcommand((s) => s
      .setName('dj-role')
      .setDescription('Restrict playback controls to a role (leave empty to allow everyone)')
      .addRoleOption((o) => o.setName('role').setDescription('DJ role (empty = everyone can control playback)')))
    .addSubcommand((s) => s
      .setName('announce')
      .setDescription('Turn automatic "Now Playing" messages on or off')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Post Now Playing messages').setRequired(true)))
    .addSubcommand((s) => s
      .setName('default-volume')
      .setDescription('Volume used when KINGSROCK joins (leave empty to reset)')
      .addIntegerOption((o) => o.setName('level').setDescription('1 to 100').setMinValue(1).setMaxValue(100))),

  async execute(interaction, ctx) {
    // Discord already hides the command from non-admins; check again server-side.
    if (!isAdmin(interaction.member)) throw new UserError('You need the **Manage Server** permission to change KINGSROCK settings.');
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    let note = null;

    if (sub === 'dj-role') {
      const role = interaction.options.getRole('role');
      if (role && role.id === guildId) throw new UserError('Pick a specific role, not @everyone. Leave the option empty to allow everyone.');
      ctx.settings.update(guildId, { djRoleId: role ? role.id : null });
      note = role ? `Only <@&${role.id}> and admins can control playback now. Anyone can still queue music.` : 'Everyone in the voice channel can control playback now.';
    } else if (sub === 'announce') {
      const enabled = interaction.options.getBoolean('enabled', true);
      ctx.settings.update(guildId, { announce: enabled });
      note = enabled ? 'Now Playing messages are **on**.' : 'Now Playing messages are **off**.';
    } else if (sub === 'default-volume') {
      const level = interaction.options.getInteger('level');
      ctx.settings.update(guildId, { defaultVolume: level ?? null });
      note = level ? `Default volume set to **${level}%** (applies the next time KINGSROCK joins).` : 'Default volume reset.';
    }

    const s = ctx.settings.get(guildId);
    const embed = embeds.infoEmbed(note || 'Current KINGSROCK settings for this server.', 'Settings').addFields(
      { name: 'DJ role', value: s.djRoleId ? `<@&${s.djRoleId}>` : 'Not set (everyone)', inline: true },
      { name: 'Now Playing messages', value: s.announce ? 'On' : 'Off', inline: true },
      { name: 'Default volume', value: `${s.defaultVolume || ctx.config.audio.defaultVolume}%${s.defaultVolume ? '' : ' (bot default)'}`, inline: true },
    );
    await respond(interaction, { embeds: [embed], flags: EPHEMERAL });
  },
};
