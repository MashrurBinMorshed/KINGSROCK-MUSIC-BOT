'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { controlGuard, respond, EPHEMERAL } = require('./_shared');

module.exports = {
  category: 'Information',
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or change the playback volume')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('level').setDescription('Volume from 1 to 100').setMinValue(1).setMaxValue(100)),

  async execute(interaction, ctx) {
    const level = interaction.options.getInteger('level');
    if (level === null) {
      const player = ctx.music.get(interaction.guildId);
      const current = player ? player.volume : (ctx.settings.get(interaction.guildId).defaultVolume || ctx.config.audio.defaultVolume);
      await respond(interaction, { embeds: [embeds.infoEmbed(`🔊 Volume is **${current}%**.`, 'Volume')], flags: EPHEMERAL });
      return;
    }
    const player = controlGuard(interaction, ctx);
    await interaction.deferReply();
    await player.setVolume(level);
    const note = player.status === 'paused' ? '\nIt will apply when playback resumes.' : '';
    const icon = level < 34 ? '🔈' : level < 67 ? '🔉' : '🔊';
    await respond(interaction, {
      embeds: [embeds.successEmbed(`${icon} Volume set to **${level}%**.${note}`, 'Volume')],
    });
  },
};
