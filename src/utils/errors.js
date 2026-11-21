'use strict';

/**
 * Error hierarchy for KINGSROCK.
 *
 * Every error that extends KingsrockError carries a `userMessage` that is safe
 * to show inside Discord. Anything else is treated as an internal error: it is
 * logged with its stack trace and the user only sees a generic message.
 */
class KingsrockError extends Error {
  constructor(userMessage, { cause, code } = {}) {
    super(userMessage, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.userMessage = userMessage;
    this.code = code || 'KINGSROCK_ERROR';
  }
}

/** Invalid input or a request the user is not allowed to make. */
class UserError extends KingsrockError {
  constructor(message, opts = {}) {
    super(message, { code: 'USER_ERROR', ...opts });
  }
}

/** The link or source is not something KINGSROCK can legally / technically play. */
class UnsupportedSourceError extends KingsrockError {
  constructor(message, opts = {}) {
    super(message, { code: 'UNSUPPORTED_SOURCE', ...opts });
  }
}

/** The track exists in metadata but cannot be streamed (removed, gated, expired...). */
class TrackUnavailableError extends KingsrockError {
  constructor(message, opts = {}) {
    super(message, { code: 'TRACK_UNAVAILABLE', ...opts });
  }
}

/** A music provider API failed (network error, bad response, rate limit...). */
class ProviderError extends KingsrockError {
  constructor(message, opts = {}) {
    super(message, { code: 'PROVIDER_ERROR', ...opts });
  }
}

/** FFmpeg or the audio pipeline failed. */
class StreamError extends KingsrockError {
  constructor(message, opts = {}) {
    super(message, { code: 'STREAM_ERROR', ...opts });
  }
}

/** Joining or keeping a Discord voice connection failed. */
class VoiceConnectionError extends KingsrockError {
  constructor(message, opts = {}) {
    super(message, { code: 'VOICE_ERROR', ...opts });
  }
}

/** Invalid or missing configuration. Holds every problem found. */
class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid KINGSROCK configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function userMessageOf(error, fallback = 'Something went wrong. Please try again.') {
  if (error instanceof KingsrockError) return error.userMessage;
  return fallback;
}

module.exports = {
  KingsrockError,
  UserError,
  UnsupportedSourceError,
  TrackUnavailableError,
  ProviderError,
  StreamError,
  VoiceConnectionError,
  ConfigError,
  userMessageOf,
};
