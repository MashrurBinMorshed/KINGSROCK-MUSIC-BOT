'use strict';

/**
 * Minimal levelled logger.
 *
 * - Writes single lines to stdout/stderr so systemd's journal (or PM2, or a
 *   terminal) captures them without extra dependencies.
 * - Redacts registered secrets (the bot token) from every line, so a token can
 *   never leak into logs even if a library includes it in an error message.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const secrets = new Set();
let currentLevel = LEVELS.info;
let useTimestamps = true;

function setLevel(level) {
  if (!(level in LEVELS)) throw new Error(`Unknown log level "${level}"`);
  currentLevel = LEVELS[level];
}

function setTimestamps(enabled) {
  useTimestamps = Boolean(enabled);
}

function addSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

function redact(text) {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function formatArg(arg) {
  if (arg instanceof Error) {
    const cause = arg.cause instanceof Error ? `\n  caused by: ${arg.cause.stack || arg.cause.message}` : '';
    return `${arg.stack || `${arg.name}: ${arg.message}`}${cause}`;
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function write(level, scope, args) {
  if (LEVELS[level] < currentLevel) return;
  const prefix = `${useTimestamps ? `${new Date().toISOString()} ` : ''}${level.toUpperCase().padEnd(5)} [${scope}]`;
  const line = redact(`${prefix} ${args.map(formatArg).join(' ')}`);
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function createLogger(scope = 'kingsrock') {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

/** A logger that discards everything (used by tests). */
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

module.exports = { createLogger, setLevel, setTimestamps, addSecret, redact, silentLogger, LEVELS };
