'use strict';

const path = require('node:path');
const { YouTubeProvider } = require('./YouTubeProvider');
const { DirectUrlProvider } = require('./DirectUrlProvider');
const { AudiusProvider } = require('./AudiusProvider');
const { RadioBrowserProvider } = require('./RadioBrowserProvider');
const { InternetArchiveProvider } = require('./InternetArchiveProvider');
const { JamendoProvider } = require('./JamendoProvider');

/**
 * Creates the providers enabled in config. Add new providers here.
 * @returns {import('./BaseProvider').BaseProvider[]}
 */
function createProviders(config, { logger } = {}) {
  const { providers: p, audio } = config;
  const enabled = new Set(p.enabled);
  const list = [];

  const direct = new DirectUrlProvider({
    timeoutMs: p.requestTimeoutMs,
    allowPrivate: p.allowPrivateNetworkUrls,
    ffprobePath: audio.ffprobePath,
  });
  if (enabled.has('direct')) list.push(direct);
  if (enabled.has('audius')) list.push(new AudiusProvider({ appName: p.audiusAppName, timeoutMs: p.requestTimeoutMs }));
  if (enabled.has('radio')) list.push(new RadioBrowserProvider({ timeoutMs: p.requestTimeoutMs, directProvider: direct }));
  if (enabled.has('archive')) list.push(new InternetArchiveProvider({ timeoutMs: p.requestTimeoutMs }));
  if (p.youtube && p.youtube.enabled) {
    const youtube = new YouTubeProvider({
      enabled: true,
      ytdlpPath: p.youtube.ytdlpPath,
      cookiesFile: p.youtube.cookiesFile,
      cacheDir: config.dataDir ? path.join(config.dataDir, 'yt-dlp-cache') : null,
      timeoutMs: Math.max(p.requestTimeoutMs * 3, 30000),
    });
    if (youtube.checkInstalled()) {
      list.push(youtube);
      if (logger) logger.warn(`YouTube enabled (yt-dlp ${youtube.version}). This is against YouTube's Terms of Service; you are responsible for its use.`);
    } else if (logger) {
      logger.error(`YOUTUBE_ENABLED=true but yt-dlp was not found ("${p.youtube.ytdlpPath}"). Install it or set YTDLP_PATH. YouTube stays disabled.`);
    }
  }
  if (enabled.has('jamendo')) {
    const jamendo = new JamendoProvider({ clientId: p.jamendoClientId, timeoutMs: p.requestTimeoutMs });
    if (jamendo.isAvailable) list.push(jamendo);
    else if (logger) logger.info('Jamendo provider disabled: set JAMENDO_CLIENT_ID to enable it.');
  }
  return list;
}

module.exports = {
  createProviders,
  DirectUrlProvider,
  AudiusProvider,
  RadioBrowserProvider,
  InternetArchiveProvider,
  JamendoProvider,
  YouTubeProvider,
};
