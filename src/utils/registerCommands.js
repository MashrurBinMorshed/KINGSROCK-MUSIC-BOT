'use strict';

const { REST, Routes } = require('discord.js');

/**
 * Bulk-overwrites slash commands. With guildId: instant, one server (dev).
 * Without: global, all servers (production; can take a few minutes to show).
 * @returns {Promise<number>} number of registered commands
 */
async function registerCommands({ token, clientId, guildId = null, body }) {
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  const result = await rest.put(route, { body });
  return Array.isArray(result) ? result.length : 0;
}

module.exports = { registerCommands };
