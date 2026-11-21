'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { controlGuard, respond } = require('./_shared');

module.exports = {
  category: 'Queue',
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear all upcoming tracks (the current track keeps playing)')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, ctx) {
    const player = controlGuard(interaction, ctx);
    const count = player.queue.clear();
    if (!count) throw new UserError('The queue is already empty.');
    await respond(interaction, { embeds: [embeds.successEmbed(`🧹 Cleared **${count}** track${count === 1 ? '' : 's'} from the queue.`, 'Queue Cleared')] });
  },
};
