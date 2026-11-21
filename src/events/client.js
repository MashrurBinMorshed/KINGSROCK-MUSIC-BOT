'use strict';

const { Events, ActivityType } = require('discord.js');
const embeds = require('../utils/embeds');
const { commandPayload } = require('../commands');
const { registerCommands } = require('../utils/registerCommands');

/** Lifecycle, voice-state and gateway logging handlers. */
function register(client, ctx) {
  const { logger, config } = ctx;

  client.once(Events.ClientReady, async (c) => {
    embeds.setBrandIcon(c.user.displayAvatarURL({ size: 128 }));
    c.user.setPresence({ activities: [{ name: '/play · KINGSROCK', type: ActivityType.Listening }], status: 'online' });
    logger.info(`Logged in as ${c.user.tag} (${c.user.id}) · ${c.guilds.cache.size} server(s) · mode: ${config.nodeEnv}`);

    // Development convenience: instant guild command registration.
    if (config.isDevelopment && config.discord.guildId) {
      try {
        const count = await registerCommands({
          token: config.discord.token,
          clientId: c.user.id,
          guildId: config.discord.guildId,
          body: commandPayload(ctx.commands),
        });
        logger.info(`Registered ${count} development commands in guild ${config.discord.guildId}.`);
      } catch (err) {
        logger.warn(`Could not register development commands: ${err.message}`);
      }
    }
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    try {
      ctx.music.handleVoiceStateUpdate(oldState, newState);
    } catch (err) {
      logger.error('voiceStateUpdate handler failed:', err);
    }
  });

  client.on(Events.GuildDelete, (guild) => {
    // Kicked from a server: release everything for it.
    ctx.music.destroy(guild.id, 'removed from server');
    logger.info(`Removed from guild ${guild.id}`);
  });

  client.on(Events.Error, (err) => logger.error('Discord client error:', err));
  client.on(Events.Warn, (msg) => logger.warn(`Discord: ${msg}`));
  client.on(Events.ShardDisconnect, (event, id) => logger.warn(`Gateway shard ${id} disconnected (code ${event.code}). discord.js will reconnect.`));
  client.on(Events.ShardReconnecting, (id) => logger.info(`Gateway shard ${id} reconnecting…`));
  client.on(Events.ShardResume, (id, replayed) => logger.info(`Gateway shard ${id} resumed (${replayed} events replayed).`));
  client.on(Events.Invalidated, () => {
    logger.error('Discord session invalidated. Exiting so the process manager restarts KINGSROCK.');
    ctx.shutdown(1);
  });
  if (config.logLevel === 'debug') client.on(Events.Debug, (msg) => {
    if (!/heartbeat|provided token/i.test(msg)) logger.debug(`discord.js: ${msg}`);
  });
}

module.exports = { register };
