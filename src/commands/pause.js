'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { controlGuard, respond } = require('./_shared');

module.exports = {
  category: 'Playback',
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause playback')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const player = controlGuard(interaction, ctx, { requireTrack: true });
    const track = player.pause('user');
    await respond(interaction, {
      embeds: [embeds.infoEmbed(`⏸ Paused **${embeds.safeText(track.title, 100)}**. Use \`/resume\` to continue.`, 'Paused')],
    });
  },
};
