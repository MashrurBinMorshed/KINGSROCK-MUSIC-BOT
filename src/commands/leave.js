'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { controlGuard, respond } = require('./_shared');

module.exports = {
  category: 'Playback',
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect KINGSROCK from the voice channel')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    controlGuard(interaction, ctx);
    ctx.music.destroy(interaction.guildId, 'leave command');
    await respond(interaction, { embeds: [embeds.infoEmbed('👋 Disconnected. Thanks for listening!', 'Disconnected')] });
  },
};
