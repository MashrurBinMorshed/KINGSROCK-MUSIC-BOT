'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { controlGuard, respond } = require('./_shared');

module.exports = {
  category: 'Playback',
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    // The requester of the current track may always skip it, even with a DJ role set.
    const player = controlGuard(interaction, ctx, { allowRequester: true, requireTrack: true });
    await interaction.deferReply();
    const { skipped, next } = await player.skip();
    const text = next
      ? `⏭ Skipped **${embeds.safeText(skipped.title, 80)}**.\nUp now: **${embeds.safeText(next.title, 80)}**`
      : `⏭ Skipped **${embeds.safeText(skipped.title, 80)}**. The queue is now empty.`;
    await respond(interaction, { embeds: [embeds.successEmbed(text, 'Skipped')] });
  },
};
