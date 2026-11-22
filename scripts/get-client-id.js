'use strict';
// Prints the bot's Application ID for start.bat. Uses DISCORD_CLIENT_ID from .env when present,
// otherwise derives it from the token (the first part of a bot token is the base64 bot ID) and
// saves it to .env so slash-command registration works without asking anyone.
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '..', '.env');
let text = '';
try { text = fs.readFileSync(envPath, 'utf8'); } catch { process.exit(1); }

const read = (key) => {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
};

let id = read('DISCORD_CLIENT_ID');
if (!/^\d{17,20}$/.test(id)) {
  const token = read('DISCORD_TOKEN');
  const derived = Buffer.from(token.split('.')[0] || '', 'base64').toString();
  if (!/^\d{17,20}$/.test(derived)) process.exit(1);
  id = derived;
  fs.appendFileSync(envPath, `${text.endsWith('\n') || !text ? '' : '\n'}DISCORD_CLIENT_ID=${id}\n`);
}
process.stdout.write(id);
