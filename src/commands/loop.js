'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { controlGuard, respond } = require('./_shared');

const TEXT = {
  off: '➡ Loop is **off**.',
  track: '🔂 Looping the **current track**.',
  queue: '🔁 Looping the **whole queue**.',
};

module.exports = {
  category: 'Queue',
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set repeat mode')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o
      .setName('mode')
      .setDescription('Repeat mode')
      .setRequired(true)
      .addChoices(
        { name: 'Off', value: 'off' },
        { name: 'Track: repeat the current track', value: 'track' },
        { name: 'Queue: repeat the whole queue', value: 'queue' },
      )),

  async execute(interaction, ctx) {
    const player = controlGuard(interaction, ctx);
    const mode = player.queue.setLoop(interaction.options.getString('mode', true));
    await respond(interaction, { embeds: [embeds.successEmbed(TEXT[mode], 'Loop')] });
  },
};
