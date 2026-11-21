'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { ConfigError } = require('../utils/errors');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SNOWFLAKE = /^\d{17,20}$/;
// Discord bot tokens are three dot-separated base64url segments. This is a
// sanity check only, it never prints the token.
const TOKEN_SHAPE = /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/;

const SEARCH_PROVIDERS = ['audius', 'archive', 'jamendo', 'radio', 'youtube'];
const ALL_PROVIDERS = ['direct', ...SEARCH_PROVIDERS];

/**
 * Loads the environment file (if present) into process.env.
 *
 * Order of precedence (highest first):
 *   1. Real environment variables (e.g. systemd EnvironmentFile=, PM2 env)
 *   2. The file named by KINGSROCK_ENV_FILE
 *   3. <project>/.env
 *
 * dotenv never overrides variables that are already set, so production
 * secrets injected by the service manager always win.
 */
function loadEnvFile(env = process.env) {
  const file = env.KINGSROCK_ENV_FILE
    ? path.resolve(env.KINGSROCK_ENV_FILE)
    : path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, quiet: true, processEnv: env });
    return file;
  }
  return null;
}

function readString(env, key, fallback = '') {
  const raw = env[key];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === '' ? fallback : value;
}

function readInt(env, key, fallback, { min, max }, problems) {
  const raw = readString(env, key, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${key} must be a whole number between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return value;
}

function readBool(env, key, fallback, problems) {
  const raw = readString(env, key, '').toLowerCase();
  if (raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  problems.push(`${key} must be true or false (got "${raw}")`);
  return fallback;
}

/**
 * Builds and validates the configuration.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]   environment to read (default process.env)
 * @param {string[]} [options.argv]           process arguments (for --dev)
 * @param {boolean} [options.requireToken]    require DISCORD_TOKEN (bot + register)
 * @param {boolean} [options.requireClientId] require DISCORD_CLIENT_ID (register)
 * @param {boolean} [options.loadFile]        load the .env file first
 */
function loadConfig({
  env = process.env,
  argv = process.argv,
  requireToken = true,
  requireClientId = false,
  loadFile = true,
} = {}) {
  const envFile = loadFile ? loadEnvFile(env) : null;
  const problems = [];

  const devFlag = argv.includes('--dev');
  const nodeEnv = devFlag ? 'development' : readString(env, 'NODE_ENV', 'production');
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    problems.push(`NODE_ENV must be development, production or test (got "${nodeEnv}")`);
  }
  const isDevelopment = nodeEnv === 'development';

  const token = readString(env, 'DISCORD_TOKEN');
  if (requireToken) {
    if (!token) problems.push('DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token.');
    else if (!TOKEN_SHAPE.test(token)) problems.push('DISCORD_TOKEN does not look like a Discord bot token (check for extra quotes or spaces).');
  }

  const clientId = readString(env, 'DISCORD_CLIENT_ID');
  if (clientId && !SNOWFLAKE.test(clientId)) problems.push('DISCORD_CLIENT_ID must be the numeric Application ID from the Developer Portal.');
  if (requireClientId && !clientId) problems.push('DISCORD_CLIENT_ID is missing (Developer Portal > your app > General Information > Application ID).');

  const guildId = readString(env, 'DISCORD_GUILD_ID');
  if (guildId && !SNOWFLAKE.test(guildId)) problems.push('DISCORD_GUILD_ID must be a numeric server ID, or left empty.');

  const logLevel = readString(env, 'LOG_LEVEL', isDevelopment ? 'debug' : 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be debug, info, warn, error or silent (got "${logLevel}")`);
  }

  const youtubeEnabled = readBool(env, 'YOUTUBE_ENABLED', false, problems);
  const youtubeCookies = readString(env, 'YOUTUBE_COOKIES_FILE');
  if (youtubeCookies && !fs.existsSync(youtubeCookies)) problems.push(`YOUTUBE_COOKIES_FILE does not exist: ${youtubeCookies}`);

  // YouTube is switched on only by YOUTUBE_ENABLED, not by ENABLED_PROVIDERS.
  const enabledRaw = readString(env, 'ENABLED_PROVIDERS', ALL_PROVIDERS.filter((p) => p !== 'youtube').join(','));
  const enabledProviders = enabledRaw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const p of enabledProviders) {
    if (!ALL_PROVIDERS.includes(p)) problems.push(`ENABLED_PROVIDERS contains unknown provider "${p}" (valid: ${ALL_PROVIDERS.join(', ')})`);
  }

  const defaultSearchProvider = readString(env, 'DEFAULT_SEARCH_PROVIDER', youtubeEnabled ? 'youtube' : 'audius').toLowerCase();
  if (!SEARCH_PROVIDERS.includes(defaultSearchProvider)) {
    problems.push(`DEFAULT_SEARCH_PROVIDER must be one of ${SEARCH_PROVIDERS.join(', ')} (got "${defaultSearchProvider}")`);
  } else if (defaultSearchProvider === 'youtube' && !youtubeEnabled) {
    problems.push('DEFAULT_SEARCH_PROVIDER is youtube but YOUTUBE_ENABLED is not true.');
  }

  const jamendoClientId = readString(env, 'JAMENDO_CLIENT_ID');
  if (jamendoClientId && !/^[a-zA-Z0-9]{4,64}$/.test(jamendoClientId)) {
    problems.push('JAMENDO_CLIENT_ID looks invalid (letters and digits only).');
  }

  const audiusAppName = readString(env, 'AUDIUS_APP_NAME', 'KINGSROCK');
  if (!/^[\w.-]{1,64}$/.test(audiusAppName)) problems.push('AUDIUS_APP_NAME may only contain letters, digits, ".", "_" and "-".');

  const config = {
    nodeEnv,
    isDevelopment,
    envFile,
    projectRoot: PROJECT_ROOT,

    discord: {
      token,
      clientId,
      guildId: guildId || null,
    },

    logLevel,

    audio: {
      ffmpegPath: readString(env, 'FFMPEG_PATH', 'ffmpeg'),
      ffprobePath: readString(env, 'FFPROBE_PATH', 'ffprobe'),
      bitrateKbps: readInt(env, 'AUDIO_BITRATE', 96, { min: 32, max: 256 }, problems),
      defaultVolume: readInt(env, 'DEFAULT_VOLUME', 50, { min: 1, max: 100 }, problems),
      startTimeoutMs: readInt(env, 'STREAM_START_TIMEOUT_SECONDS', 20, { min: 5, max: 120 }, problems) * 1000,
    },

    player: {
      inactivityTimeoutMs: readInt(env, 'INACTIVITY_TIMEOUT_SECONDS', 300, { min: 10, max: 86400 }, problems) * 1000,
      aloneTimeoutMs: readInt(env, 'ALONE_TIMEOUT_SECONDS', 60, { min: 5, max: 86400 }, problems) * 1000,
      maxQueueSize: readInt(env, 'MAX_QUEUE_SIZE', 200, { min: 1, max: 5000 }, problems),
      maxConsecutiveFailures: 5,
    },

    providers: {
      enabled: enabledProviders,
      defaultSearch: defaultSearchProvider,
      jamendoClientId: jamendoClientId || null,
      audiusAppName,
      youtube: {
        enabled: youtubeEnabled,
        ytdlpPath: readString(env, 'YTDLP_PATH', 'yt-dlp'),
        cookiesFile: youtubeCookies || null,
      },
      allowPrivateNetworkUrls: readBool(env, 'ALLOW_PRIVATE_NETWORK_URLS', false, problems),
      requestTimeoutMs: readInt(env, 'PROVIDER_TIMEOUT_SECONDS', 10, { min: 2, max: 60 }, problems) * 1000,
    },

    dataDir: path.resolve(PROJECT_ROOT, readString(env, 'DATA_DIR', 'data')),

    health: {
      port: readInt(env, 'HEALTH_PORT', 0, { min: 0, max: 65535 }, problems),
      host: readString(env, 'HEALTH_HOST', '127.0.0.1'),
    },
  };

  if (problems.length) throw new ConfigError(problems);
  return deepFreeze(config);
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

module.exports = { loadConfig, loadEnvFile, PROJECT_ROOT, SEARCH_PROVIDERS, ALL_PROVIDERS };
