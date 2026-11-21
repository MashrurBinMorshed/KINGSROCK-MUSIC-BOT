'use strict';

/**
 * KINGSROCK entry point.
 *
 *   npm start      production (reads .env or real environment variables)
 *   npm run dev    development (auto-restart on file changes, debug logs,
 *                  instant command registration in DISCORD_GUILD_ID)
 */
const path = require('node:path');
const { Client, GatewayIntentBits, Options } = require('discord.js');
const { loadConfig } = require('./config');
const { GuildSettingsStore } = require('./config/GuildSettingsStore');
const logging = require('./utils/logger');
const { checkFfmpeg } = require('./music/FFmpeg');
const { createProviders } = require('./music/providers');
const { AudioSourceManager } = require('./music/AudioSourceManager');
const { MusicManager } = require('./music/MusicManager');
const { Announcer } = require('./music/Announcer');
const { loadCommands } = require('./commands');
const { Cooldowns } = require('./commands/_shared');
const { acquireLock } = require('./utils/instanceLock');
const { startHealthServer } = require('./utils/healthServer');
const interactionEvents = require('./events/interactionCreate');
const clientEvents = require('./events/client');

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  // ------------------------------------------------------------ config
  let config;
  try {
    config = loadConfig({ requireToken: true });
  } catch (err) {
    process.stderr.write(`\n${err.message}\n\nSee SETUP.md, section "Configure the environment".\n\n`);
    process.exit(1);
  }
  logging.setLevel(config.logLevel);
  // systemd's journal adds its own timestamps.
  logging.setTimestamps(!process.env.INVOCATION_ID);
  logging.addSecret(config.discord.token);
  const logger = logging.createLogger('kingsrock');
  logger.info(`Starting KINGSROCK (${config.nodeEnv}) on Node ${process.version}, ${process.platform}/${process.arch}`);
  if (config.envFile) logger.info(`Loaded environment from ${path.relative(process.cwd(), config.envFile) || config.envFile}`);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    logger.warn('NODE_TLS_REJECT_UNAUTHORIZED=0 is set: HTTPS certificate checks are DISABLED for this process. Remove it unless you know why it is there.');
  }

  // ------------------------------------------------------------ prerequisites
  const ffmpeg = checkFfmpeg(config.audio.ffmpegPath);
  if (!ffmpeg.ok) {
    logger.error(`FFmpeg check failed: ${ffmpeg.error}`);
    logger.error('Install FFmpeg with libopus (Windows: "winget install Gyan.FFmpeg", Ubuntu: "sudo apt install ffmpeg") or set FFMPEG_PATH.');
    process.exit(1);
  }
  logger.info(`FFmpeg OK: ${ffmpeg.version}`);

  let releaseLock;
  try {
    releaseLock = acquireLock(config.dataDir);
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  // ------------------------------------------------------------ services
  const settings = new GuildSettingsStore({ file: path.join(config.dataDir, 'guild-settings.json'), logger: logger.child('settings') }).load();
  const providers = createProviders(config, { logger: logger.child('providers') });
  const sources = new AudioSourceManager({ providers, defaultSearch: config.providers.defaultSearch, logger: logger.child('sources') });
  logger.info(`Music providers: ${providers.map((p) => p.name).join(', ') || 'none'}`);

  const client = new Client({
    // Only what a music bot needs: guilds (commands/channels) and voice states.
    // No privileged intents (no message content, no member list, no presences).
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    allowedMentions: { parse: [] },
    // Keep RAM low: don't cache things KINGSROCK never reads.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
      GuildEmojiManager: 0,
      GuildStickerManager: 0,
      GuildBanManager: 0,
      GuildInviteManager: 0,
      GuildScheduledEventManager: 0,
      StageInstanceManager: 0,
      ThreadMemberManager: 0,
      AutoModerationRuleManager: 0,
      ApplicationCommandManager: 0,
    }),
  });

  const announcer = new Announcer({ client, settings, logger: logger.child('announcer'), config });
  const music = new MusicManager({ config, sources, settings, logger: logger.child('music'), announcer });
  const commands = loadCommands();

  // ------------------------------------------------------------ shutdown
  let shuttingDown = false;
  let healthServer = null;
  const shutdown = async (code = 0, reason = 'shutdown') => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})…`);
    const force = setTimeout(() => {
      logger.error('Shutdown took too long, forcing exit.');
      process.exit(code || 1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      music.destroyAll('shutdown'); // stops FFmpeg, leaves voice channels
      settings.flush();
      if (healthServer) healthServer.close();
      await client.destroy();
    } catch (err) {
      logger.error('Error during shutdown:', err);
    } finally {
      releaseLock();
      process.exit(code);
    }
  };

  process.on('SIGINT', () => shutdown(0, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal: a single failed promise (e.g. a Discord API call)
    // must not take music down for every server.
    logger.error('Unhandled promise rejection:', reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', (err) => {
    // State may be corrupted: exit and let systemd/PM2 restart cleanly.
    logger.error('Uncaught exception, restarting:', err);
    shutdown(1, 'uncaught exception');
  });
  process.on('exit', () => releaseLock());

  // ------------------------------------------------------------ wire up
  const ctx = { client, config, logger, sources, music, settings, commands, cooldowns: new Cooldowns(), shutdown };
  interactionEvents.register(client, ctx);
  clientEvents.register(client, ctx);

  if (config.health.port) {
    healthServer = startHealthServer({ port: config.health.port, host: config.health.host, client, music, logger: logger.child('health') });
  }

  try {
    await client.login(config.discord.token);
  } catch (err) {
    const invalid = /TokenInvalid|invalid token|401/i.test(`${err.code} ${err.message}`);
    logger.error(invalid
      ? 'Discord rejected the bot token. Reset it in the Developer Portal (Bot > Reset Token) and update DISCORD_TOKEN.'
      : `Could not log in to Discord: ${err.message}`);
    if (/disallowed intents/i.test(err.message)) logger.error('KINGSROCK only uses non-privileged intents; check that you are using the right token.');
    await shutdown(1, 'login failed');
  }
}

main();
