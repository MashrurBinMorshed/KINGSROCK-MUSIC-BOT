'use strict';

/**
 * `npm run doctor`: checks the environment without connecting to Discord.
 * Safe to run any time. Never prints the token.
 */
const os = require('node:os');
const { generateDependencyReport } = require('@discordjs/voice');
const { loadConfig } = require('./config');
const { checkFfmpeg } = require('./music/FFmpeg');
const { inviteUrl } = require('./utils/permissions');

const ok = (msg) => console.log(`  [ OK ] ${msg}`);
const bad = (msg) => console.log(`  [FAIL] ${msg}`);
const warn = (msg) => console.log(`  [WARN] ${msg}`);

let failures = 0;
console.log('\nKINGSROCK doctor\n');

console.log('System');
ok(`${os.type()} ${os.release()} (${process.platform}/${process.arch}), ${(os.totalmem() / 1073741824).toFixed(1)} GB RAM, ${os.cpus().length} CPU(s)`);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 12)) ok(`Node.js ${process.version}`);
else {
  bad(`Node.js ${process.version}: KINGSROCK needs Node 22.12 or newer (Node 24 LTS recommended).`);
  failures += 1;
}
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') warn('NODE_TLS_REJECT_UNAUTHORIZED=0 is set: HTTPS certificate verification is disabled for Node. Remove it.');

console.log('\nConfiguration');
let config = null;
try {
  config = loadConfig({ requireToken: true, requireClientId: false });
  ok(`Environment loaded${config.envFile ? ` from ${config.envFile}` : ' from process environment'} (${config.nodeEnv})`);
  ok('DISCORD_TOKEN is set (not shown)');
  if (config.discord.clientId) ok(`DISCORD_CLIENT_ID ${config.discord.clientId}`);
  else warn('DISCORD_CLIENT_ID is empty (needed for "npm run register")');
  ok(`DISCORD_GUILD_ID ${config.discord.guildId || '(empty: global commands)'}`);
  ok(`Providers: ${config.providers.enabled.join(', ')} · default search: ${config.providers.defaultSearch}`);
  if (config.providers.enabled.includes('jamendo') && !config.providers.jamendoClientId) warn('Jamendo enabled but JAMENDO_CLIENT_ID is empty: Jamendo will be skipped.');
} catch (err) {
  bad(err.message.replace(/\n/g, '\n         '));
  failures += 1;
}

console.log('\nFFmpeg');
const ff = checkFfmpeg(config ? config.audio.ffmpegPath : 'ffmpeg');
if (ff.ok) ok(`${ff.version} (libopus: yes)`);
else {
  bad(ff.error || 'FFmpeg not found');
  failures += 1;
}

if (config && config.providers.youtube.enabled) {
  console.log('\nYouTube (yt-dlp)');
  const { YouTubeProvider } = require('./music/providers/YouTubeProvider');
  const yt = new YouTubeProvider({ enabled: true, ytdlpPath: config.providers.youtube.ytdlpPath });
  if (yt.checkInstalled()) {
    ok(`yt-dlp ${yt.version} (JS runtime: this Node.js)`);
    warn('YouTube is enabled: this is against YouTube\'s Terms of Service, and cloud IPs are often blocked. Keep yt-dlp updated (yt-dlp -U).');
  } else {
    bad(`YOUTUBE_ENABLED=true but yt-dlp was not found ("${config.providers.youtube.ytdlpPath}"). Install it (Windows: winget install yt-dlp.yt-dlp) or set YTDLP_PATH.`);
    failures += 1;
  }
  if (config.providers.youtube.cookiesFile) warn('YOUTUBE_COOKIES_FILE is set: the Google account in that file can be restricted by YouTube. Use a throwaway account.');
}

console.log('\n@discordjs/voice dependency report');
console.log(generateDependencyReport().split('\n').map((l) => `  ${l}`).join('\n'));
console.log('  Note: no Opus library is needed. FFmpeg encodes Opus directly (Ogg/Opus input).');

if (config && config.discord.clientId) console.log(`\nInvite URL:\n  ${inviteUrl(config.discord.clientId)}`);
console.log(failures ? `\n${failures} problem(s) found.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
