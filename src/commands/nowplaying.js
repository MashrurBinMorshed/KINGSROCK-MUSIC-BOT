'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { respond, EPHEMERAL } = require('./_shared');

module.exports = {
  category: 'Information',
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the track that is playing right now')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const player = ctx.music.get(interaction.guildId);
    if (!player || !player.currentTrack) throw new UserError('Nothing is playing right now. Use `/play` to start.');
    await respond(interaction, { embeds: [embeds.nowPlayingEmbed(player, player.currentTrack, { showProgress: true })], flags: EPHEMERAL });
  },
};
