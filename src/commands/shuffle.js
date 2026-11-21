'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { controlGuard, respond } = require('./_shared');

module.exports = {
  category: 'Queue',
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the upcoming tracks')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const player = controlGuard(interaction, ctx);
    const count = player.queue.shuffle();
    await respond(interaction, { embeds: [embeds.successEmbed(`🔀 Shuffled **${count}** upcoming tracks.`, 'Shuffled')] });
  },
};
