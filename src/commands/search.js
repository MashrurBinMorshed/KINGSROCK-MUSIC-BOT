'use strict';

const {
  SlashCommandBuilder, InteractionContextType, ActionRowBuilder, StringSelectMenuBuilder,
} = require('discord.js');
const embeds = require('../utils/embeds');
const { truncate, formatDuration } = require('../utils/format');
const { UserError } = require('../utils/errors');
const { EPHEMERAL, respond, queueTracks, playResultEmbeds, preflightPlay } = require('./_shared');

const RESULT_TTL_MS = 2 * 60 * 1000;
const CUSTOM_ID_PREFIX = 'kr-search:';

/** Pending search menus: interaction id -> { userId, results, timer } */
const pending = new Map();

function remember(id, entry) {
  const timer = setTimeout(() => pending.delete(id), RESULT_TTL_MS);
  timer.unref();
  pending.set(id, { ...entry, timer });
}

function take(id) {
  const entry = pending.get(id);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(id);
  }
  return entry || null;
}

module.exports = {
  category: 'Playback',
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for music and pick a result from a menu')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('query').setDescription('Song, artist or station name').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o
      .setName('source')
      .setDescription('Where to search (default: auto)')
      .addChoices(
        { name: 'Auto', value: 'auto' },
        { name: 'YouTube (if enabled on this bot)', value: 'youtube' },
        { name: 'Audius', value: 'audius' },
        { name: 'Internet Archive (CC / public domain)', value: 'archive' },
        { name: 'Jamendo (Creative Commons)', value: 'jamendo' },
        { name: 'Internet radio stations', value: 'radio' },
      )),

  async execute(interaction, ctx) {
    ctx.cooldowns.hit(interaction.user.id, 'search', 3000);
    await interaction.deferReply({ flags: EPHEMERAL });
    const query = interaction.options.getString('query', true);
    const source = interaction.options.getString('source') || 'auto';
    const results = await ctx.sources.search(query, {
      source,
      limit: 5,
      requestedBy: { id: interaction.user.id, tag: interaction.user.tag },
    });
    if (!results.length) throw new UserError(`No results for **${embeds.safeText(query, 100)}**. Try other words or another source.`);

    remember(interaction.id, { userId: interaction.user.id, results });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}${interaction.id}`)
      .setPlaceholder('Choose a track to queue')
      .addOptions(results.map((t, i) => ({
        label: truncate(t.title, 100),
        description: truncate([t.artist, formatDuration(t.durationMs, { live: t.isLive }), embeds.SOURCE_LABELS[t.source]].filter(Boolean).join(' · '), 100),
        value: String(i),
      })));

    await respond(interaction, {
      embeds: [embeds.searchResultsEmbed(results, query)],
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  },

  /** Handles the select menu built above. */
  async handleComponent(interaction, ctx) {
    const id = interaction.customId.slice(CUSTOM_ID_PREFIX.length);
    const entry = pending.get(id);
    if (!entry) {
      await interaction.update({ embeds: [embeds.warningEmbed('This search has expired. Run `/search` again.')], components: [] });
      return;
    }
    if (entry.userId !== interaction.user.id) {
      await interaction.reply({ embeds: [embeds.errorEmbed('This menu belongs to someone else.')], flags: EPHEMERAL });
      return;
    }
    preflightPlay(interaction, ctx);
    take(id);
    const choice = entry.results[Number(interaction.values[0])];
    if (!choice) throw new UserError('That option is no longer available.');

    await interaction.deferUpdate();
    const track = await ctx.sources.hydrate(choice);
    // Starting now: announce publicly through the Announcer (Now Playing message).
    const { player, result } = await queueTracks(interaction, ctx, [track], { announceStart: true });

    if (result.startedNow && result.started) {
      await interaction.editReply({ embeds: [embeds.successEmbed(`Started **${embeds.safeText(track.title, 100)}**.`)], components: [] });
    } else if (result.startedNow) {
      await interaction.editReply({ embeds: playResultEmbeds(player, [track], result, interaction.user.id), components: [] });
    } else {
      await interaction.editReply({ embeds: [embeds.successEmbed(`Queued **${embeds.safeText(track.title, 100)}** at position #${result.position}.`)], components: [] });
      // Let the channel know too.
      await interaction.followUp({ embeds: playResultEmbeds(player, [track], result, interaction.user.id), allowedMentions: { parse: [] } });
    }
  },

  CUSTOM_ID_PREFIX,
  _pending: pending,
};
