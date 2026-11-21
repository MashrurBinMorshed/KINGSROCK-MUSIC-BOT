'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { respond, EPHEMERAL } = require('./_shared');

const ORDER = ['Playback', 'Queue', 'Information', 'Admin'];

module.exports = {
  category: 'Information',
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all KINGSROCK commands')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const groups = new Map(ORDER.map((c) => [c, []]));
    for (const cmd of ctx.commands.values()) {
      const json = cmd.data.toJSON();
      const opts = (json.options || [])
        .filter((o) => o.type !== 1) // subcommands are listed in the description
        .map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`))
        .join(' ');
      const list = groups.get(cmd.category) || groups.get('Information');
      list.push(`\`/${json.name}${opts ? ` ${opts}` : ''}\` · ${json.description}`);
    }

    const providers = ctx.sources.searchProviders();
    const sources = providers.map((p) => p.displayName);
    const youtubeOn = providers.some((p) => p.name === 'youtube');
    const embed = embeds.infoEmbed(
      'Join a voice channel and use `/play` to start. Everyone in the channel hears the same music.',
      'Commands',
    );
    for (const [name, lines] of groups) {
      if (lines.length) embed.addFields({ name, value: lines.join('\n') });
    }
    embed.addFields({
      name: 'Music sources',
      value: [
        `Search: ${sources.length ? sources.join(', ') : 'none enabled'}`,
        `Links: ${youtubeOn ? 'YouTube videos / playlists, ' : ''}direct audio files (.mp3, .ogg, .m4a, .flac…), radio streams (.m3u, .pls, Icecast/Shoutcast, HLS), Audius / Internet Archive / Jamendo links`,
        `Tips: \`/play query: radio: lofi\` searches radio stations${youtubeOn ? ', `/play query: yt: song name` searches YouTube' : ''}.`,
        youtubeOn ? 'Spotify and SoundCloud links cannot be played.' : 'YouTube, Spotify and SoundCloud cannot be played on this bot.',
      ].join('\n'),
    });
    await respond(interaction, { embeds: [embed], flags: EPHEMERAL });
  },
};
