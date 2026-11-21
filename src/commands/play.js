'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const { preflightPlay, queueTracks, playResultEmbeds, requesterOf, respond } = require('./_shared');

const SOURCE_CHOICES = [
  { name: 'Auto (default source first, then the others)', value: 'auto' },
  { name: 'YouTube (if enabled on this bot)', value: 'youtube' },
  { name: 'Audius', value: 'audius' },
  { name: 'Internet Archive (CC / public domain)', value: 'archive' },
  { name: 'Jamendo (Creative Commons)', value: 'jamendo' },
  { name: 'Internet radio stations', value: 'radio' },
];

module.exports = {
  category: 'Playback',
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song, radio station or direct audio link in your voice channel')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o
      .setName('query')
      .setDescription('Song / artist name, "radio: <station>", or a link (YouTube, audio file, stream)')
      .setRequired(true)
      .setMaxLength(500))
    .addStringOption((o) => o
      .setName('source')
      .setDescription('Where to search (default: auto)')
      .addChoices(...SOURCE_CHOICES)),

  async execute(interaction, ctx) {
    preflightPlay(interaction, ctx);
    ctx.cooldowns.hit(interaction.user.id, 'play', 2000);
    await interaction.deferReply();

    const query = interaction.options.getString('query', true);
    const source = interaction.options.getString('source') || 'auto';
    const tracks = await ctx.sources.resolve(query, { source, requestedBy: requesterOf(interaction) });

    const { player, result } = await queueTracks(interaction, ctx, tracks, { announceStart: false });
    const message = await respond(interaction, { embeds: playResultEmbeds(player, tracks, result, interaction.user.id) });

    // The reply doubles as the Now Playing message, so the next track edits it
    // instead of posting another message.
    if (result.startedNow && result.started && message) player.nowPlayingMessage = message;
  },
};

module.exports.SOURCE_CHOICES = SOURCE_CHOICES;
