'use strict';

/**
 * Measures real CPU and memory use of the KINGSROCK audio pipeline.
 *
 *   npm run measure                  # 30 s, generated local audio (no network)
 *   npm run measure -- <url> [sec] [players]
 *
 * Runs the production pipeline (FFmpeg -> Ogg/Opus -> @discordjs/voice
 * AudioPlayer reading 20 ms frames in real time) without a Discord
 * connection, and reports:
 *   - Node.js process: CPU % of one core, RSS memory
 *   - each FFmpeg process: CPU % of one core, memory
 * Discord's UDP send + encryption add a little more CPU in production.
 */
const { spawnSync, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, AudioPlayerStatus, entersState } = require('@discordjs/voice');
require('discord.js'); // load it so Node RSS includes the Discord library, as in production
const { spawnFfmpeg } = require('../src/music/FFmpeg');

const [, , urlArg, secArg, playersArg] = process.argv;
const seconds = Number(secArg) || 30;
const playerCount = Number(playersArg) || 1;

function processStats(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "$($p.CPU) $($p.WorkingSet64)"`], { encoding: 'utf8', windowsHide: true }).trim();
      const [cpu, mem] = out.split(/\s+/).map(Number);
      return { cpuSeconds: cpu, rssBytes: mem };
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
    const cpuSeconds = (Number(stat[11]) + Number(stat[12])) / ticks;
    const rssPages = Number(stat[21]);
    return { cpuSeconds, rssBytes: rssPages * 4096 };
  } catch {
    return null;
  }
}

async function main() {
  let url = urlArg;
  let server = null;
  let tmp = null;
  if (!url) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kingsrock-measure-'));
    const file = path.join(tmp, 'music.mp3');
    // Pink noise + tone: harder to encode than silence, closer to real music.
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=color=pink:duration=${seconds * 2 + 60}:amplitude=0.3`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds * 2 + 60}`, '-filter_complex', 'amix=inputs=2', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', file], { windowsHide: true });
    if (r.status !== 0) throw new Error(String(r.stderr));
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}/music.mp3`;
  }

  console.log(`KINGSROCK pipeline measurement: ${playerCount} player(s), ${seconds}s, source ${urlArg ? url : 'local 192 kbps MP3 (generated)'}`);
  console.log(`Machine: ${os.cpus()[0].model.trim()} x${os.cpus().length}, ${process.platform}/${process.arch}, Node ${process.version}\n`);

  const pipelines = [];
  for (let i = 0; i < playerCount; i += 1) {
    const handle = spawnFfmpeg({ url, volume: 50, bitrateKbps: 96, isLive: Boolean(urlArg) });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.play(createAudioResource(handle.stream, { inputType: StreamType.OggOpus }));
    pipelines.push({ handle, player });
  }
  await Promise.all(pipelines.map((p) => entersState(p.player, AudioPlayerStatus.Playing, 30000)));
  await new Promise((r) => setTimeout(r, 2000)); // skip startup burst

  const startWall = process.hrtime.bigint();
  const startNode = process.cpuUsage();
  const startFf = pipelines.map((p) => processStats(p.handle.process.pid));
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const wall = Number(process.hrtime.bigint() - startWall) / 1e9;
  const nodeCpu = process.cpuUsage(startNode);
  const endFf = pipelines.map((p) => processStats(p.handle.process.pid));

  const nodePct = ((nodeCpu.user + nodeCpu.system) / 1e6 / wall) * 100;
  console.log(`Node.js (discord.js + voice + ${playerCount} AudioPlayer): CPU ${nodePct.toFixed(2)}% of one core, RSS ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`);
  pipelines.forEach((p, i) => {
    const a = startFf[i];
    const b = endFf[i];
    if (a && b) {
      console.log(`FFmpeg #${i + 1}: CPU ${(((b.cpuSeconds - a.cpuSeconds) / wall) * 100).toFixed(2)}% of one core, memory ${(b.rssBytes / 1048576).toFixed(1)} MB`);
    } else {
      console.log(`FFmpeg #${i + 1}: stats unavailable on this platform`);
    }
  });
  const totalPct = nodePct + pipelines.reduce((s, _p, i) => s + (startFf[i] && endFf[i] ? ((endFf[i].cpuSeconds - startFf[i].cpuSeconds) / wall) * 100 : 0), 0);
  console.log(`\nTotal: ${totalPct.toFixed(2)}% of one CPU core for ${playerCount} simultaneous stream(s).`);
  console.log(`Outbound audio per stream at 96 kbps ≈ ${(96 / 8 * 3600 / 1024).toFixed(0)} MB per hour of playback.`);

  for (const p of pipelines) {
    p.player.stop(true);
    p.handle.kill();
  }
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
