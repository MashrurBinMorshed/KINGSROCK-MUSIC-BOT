'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { controlGuard, respond } = require('./_shared');

module.exports = {
  category: 'Playback',
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const player = controlGuard(interaction, ctx);
    player.stop();
    await respond(interaction, {
      embeds: [embeds.infoEmbed('⏹ Stopped playback and cleared the queue. I will leave the channel if nothing else is played.', 'Stopped')],
    });
  },
};
