'use strict';

/**
 * Registers KINGSROCK slash commands with Discord.
 *
 *   npm run register            global if DISCORD_GUILD_ID is empty, else that guild
 *   npm run register:guild      only DISCORD_GUILD_ID (instant, for development)
 *   npm run register:global     every server (production; may take a few minutes)
 *   npm run unregister:guild    removes the guild copies (avoids duplicates after
 *                               switching from development to global)
 */
const { loadConfig } = require('./config');
const { commandPayload } = require('./commands');
const { registerCommands } = require('./utils/registerCommands');
const { inviteUrl } = require('./utils/permissions');

async function run() {
  const args = process.argv.slice(2);
  let config;
  try {
    config = loadConfig({ requireToken: true, requireClientId: true });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const wantGuild = args.includes('--guild') || (!args.includes('--global') && config.discord.guildId);
  const clear = args.includes('--clear');
  if (wantGuild && !config.discord.guildId) {
    console.error('DISCORD_GUILD_ID is empty. Set it to your test server ID, or use "npm run register:global".');
    process.exit(1);
  }

  const body = clear ? [] : commandPayload();
  const target = wantGuild ? `guild ${config.discord.guildId}` : 'all servers (global)';
  console.log(`${clear ? 'Removing' : 'Registering'} ${clear ? 'all' : body.length} KINGSROCK commands for ${target}…`);
  try {
    const count = await registerCommands({
      token: config.discord.token,
      clientId: config.discord.clientId,
      guildId: wantGuild ? config.discord.guildId : null,
      body,
    });
    console.log(clear ? 'Done: guild commands removed.' : `Done: ${count} commands registered.`);
    if (!wantGuild && !clear) console.log('Global commands can take a few minutes to appear. Restart Discord (Ctrl+R) if they do not.');
    console.log(`\nInvite URL:\n${inviteUrl(config.discord.clientId)}\n`);
  } catch (err) {
    const status = err.status || err.code;
    if (status === 401) console.error('Discord rejected the token (401). Check DISCORD_TOKEN.');
    else if (status === 403 || err.code === 50001) console.error('Missing access (403). Is the bot in that server, and was it invited with the applications.commands scope?');
    else if (status === 404 || err.code === 10002) console.error('Unknown application (404). DISCORD_CLIENT_ID must be the Application ID of the same app as the token.');
    else console.error(`Registration failed: ${err.message}`);
    process.exit(1);
  }
}

run();
