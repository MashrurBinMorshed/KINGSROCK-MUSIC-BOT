'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { respond } = require('./_shared');
const { assertSameChannel, assertCanControl } = require('../utils/permissions');

module.exports = {
  category: 'Queue',
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o
      .setName('position')
      .setDescription('Queue position (see /queue)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(5000)),

  async execute(interaction, ctx) {
    const player = ctx.music.get(interaction.guildId);
    if (!player || player.destroyed || player.queue.size === 0) throw new UserError('There are no upcoming tracks to remove.');
    assertSameChannel(interaction.member, player);

    const position = interaction.options.getInteger('position', true);
    const target = player.queue.upcoming[position - 1];
    const ownTrack = Boolean(target && target.requestedBy && target.requestedBy.id === interaction.user.id);
    // Members may always remove their own requests; other tracks need DJ rights.
    if (!ownTrack) assertCanControl(interaction.member, ctx.settings.get(interaction.guildId));

    const removed = player.queue.remove(position);
    await respond(interaction, {
      embeds: [embeds.successEmbed(`🗑 Removed **${embeds.safeText(removed.title, 100)}** (was #${position}).`, 'Removed')],
    });
  },
};
