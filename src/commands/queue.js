'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { respond, EPHEMERAL } = require('./_shared');

module.exports = {
  category: 'Queue',
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current track and upcoming queue')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(500)),

  async execute(interaction, ctx) {
    const player = ctx.music.get(interaction.guildId);
    if (!player || (!player.currentTrack && player.queue.size === 0)) {
      throw new UserError('The queue is empty. Use `/play` to add music.');
    }
    const page = interaction.options.getInteger('page') || 1;
    await respond(interaction, { embeds: [embeds.queueEmbed(player, page)], flags: EPHEMERAL });
  },
};
