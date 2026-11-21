'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { controlGuard, respond } = require('./_shared');

module.exports = {
  category: 'Playback',
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume paused playback')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const player = controlGuard(interaction, ctx, { requireTrack: true });
    if (player.status !== 'paused') throw new UserError('Playback is not paused.');
    await interaction.deferReply();
    const track = await player.resume();
    if (!track) throw new UserError('The stream could not be resumed, moving on.');
    await respond(interaction, {
      embeds: [embeds.successEmbed(`▶ Resumed **${embeds.safeText(track.title, 100)}**.`, 'Resumed')],
    });
  },
};
