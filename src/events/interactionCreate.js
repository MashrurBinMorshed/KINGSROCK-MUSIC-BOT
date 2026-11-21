'use strict';

const { Events } = require('discord.js');
const embeds = require('../utils/embeds');
const { KingsrockError, userMessageOf } = require('../utils/errors');
const { respond, EPHEMERAL } = require('../commands/_shared');
const search = require('../commands/search');

/**
 * Routes slash commands and components. Every error ends up here:
 *   - KingsrockError -> its user-friendly message (ephemeral)
 *   - anything else  -> logged with stack trace, generic message to the user
 */
function register(client, ctx) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.inGuild()) return;

      if (interaction.isChatInputCommand()) {
        const command = ctx.commands.get(interaction.commandName);
        if (!command) {
          await respond(interaction, { embeds: [embeds.errorEmbed('Unknown command. It may have been removed, try again in a minute.')], flags: EPHEMERAL });
          return;
        }
        ctx.logger.debug(`/${interaction.commandName} by ${interaction.user.id} in guild ${interaction.guildId}`);
        await command.execute(interaction, ctx);
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith(search.CUSTOM_ID_PREFIX)) {
        await search.handleComponent(interaction, ctx);
      }
    } catch (error) {
      await handleError(interaction, error, ctx);
    }
  });
}

async function handleError(interaction, error, ctx) {
  if (!(error instanceof KingsrockError)) {
    ctx.logger.error(`Interaction failed (${interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.customId || 'component'}):`, error);
  } else {
    ctx.logger.debug(`User-facing error: ${error.message}`);
  }
  const message = userMessageOf(error, 'Something went wrong on my side. Please try again.');
  try {
    if (interaction.isRepliable()) {
      if (interaction.isMessageComponent() && (interaction.deferred || interaction.replied)) {
        await interaction.editReply({ embeds: [embeds.errorEmbed(message)], components: [] });
      } else {
        await respond(interaction, { embeds: [embeds.errorEmbed(message)], flags: EPHEMERAL });
      }
    }
  } catch (replyError) {
    // Interaction expired (>15 min) or was deleted. Nothing more to do.
    ctx.logger.debug(`Could not send error reply: ${replyError.message}`);
  }
}

module.exports = { register, handleError };
