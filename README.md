# KINGSROCK

**A lightweight, cloud-hosted Discord music bot for esports communities.**

KINGSROCK runs once on a cloud server and plays music in your Discord voice
channels for everyone at the same time. Members just type `/play`: they don't
install anything, run any code or host anything. Your own PC can be switched
off.

> Setup, Discord configuration and cloud deployment are covered step by step in
> **[SETUP.md](SETUP.md)**.

---

## Contents

1. [What KINGSROCK does](#1-what-kingsrock-does)
2. [How the architecture works](#2-how-the-architecture-works)
3. [Technology stack](#3-technology-stack)
4. [Commands](#4-commands)
5. [Music sources and their limits](#5-music-sources-and-their-limits)
6. [Resource usage (measured)](#6-resource-usage-measured)
7. [Hosting summary](#7-hosting-summary)
8. [Security](#8-security)
9. [Testing: what is and isn't verified](#9-testing-what-is-and-isnt-verified)
10. [Project structure](#10-project-structure)
11. [Adding a new music provider](#11-adding-a-new-music-provider)
12. [npm scripts](#12-npm-scripts)

---

## 1. What KINGSROCK does

- Joins your voice channel and streams music that everyone in the channel hears together.
- Keeps a **queue per server**, so anyone in the channel can add tracks and the next one starts automatically.
- Handles **many servers at once**, each with its own player, queue, volume, loop mode and voice connection. One server never affects another.
- Searches **Audius**, **Internet Archive** (Creative Commons and public domain only), **Jamendo** (Creative Commons; optional free key) and thousands of **internet radio stations**.
- Plays **direct audio links** and **radio streams** (`.mp3`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.flac`, `.wav`, `.webm`, Icecast/Shoutcast, `.m3u`, `.pls`, HLS `.m3u8`).
- Posts dark, premium **KINGSROCK-branded embeds**. A single Now Playing message is edited in place instead of spamming the channel.
- Cleans up after itself: it pauses when everyone leaves, disconnects after inactivity, and never leaves FFmpeg processes or voice connections running.

## 2. How the architecture works

```
 YOUR WINDOWS PC ── development & testing only (npm run dev)
        │  upload code once
        ▼
 CLOUD SERVER (Oracle Cloud Always Free VM, Ubuntu, systemd)
 ┌────────────────────────────────────────────────────────────────────────┐
 │  node src/index.js  (one process, supervised and auto-restarted)       │
 │                                                                        │
 │  discord.js ── Gateway (WSS) ── slash commands, voice state events     │
 │      │                                                                 │
 │  MusicManager ── one MusicPlayer per guild ─────────────────────────┐  │
 │      │             ├─ QueueManager  (queue, loop, shuffle)          │  │
 │      │             ├─ AudioPlayer + VoiceConnection (@discordjs/voice)│ │
 │      │             └─ FFmpeg process (only while a track plays)     │  │
 │  AudioSourceManager                                                 │  │
 │      ├─ search / resolve  -> Track metadata                         │  │
 │      └─ getStream(track)  -> fresh stream URL right before playback │  │
 │           providers: direct · audius · radio · archive · jamendo    │  │
 └────────────────────────────────────────────────────────────────────────┘
        │ Opus audio over encrypted UDP (DAVE end-to-end encryption)
        ▼
 DISCORD VOICE CHANNEL ── every member hears the same music
```

**The audio path** (one per guild that is playing):

```
source URL ──HTTP──▶ FFmpeg (decode → volume → libopus 48 kHz stereo → Ogg)
           ──pipe──▶ @discordjs/voice (Ogg demux → Opus packets, no re-encoding)
           ──UDP───▶ Discord voice server
```

Design choices that keep it light:

- **FFmpeg encodes Opus directly.** Node.js never decodes or re-encodes audio,
  so no JavaScript Opus encoder and no per-sample volume processing in JS are needed.
- **Streaming only.** Audio is never loaded fully into RAM or written to disk. FFmpeg is throttled by backpressure and keeps only a few seconds buffered ahead.
- **No polling.** Everything is event driven: gateway events, voice state changes, stream events and timers.
- **Metadata is separate from streams.** Tracks store metadata. Each provider fetches a fresh playable URL right before playback, so expiring signed URLs (Audius, Jamendo) still work after waiting in the queue.
- **Minimal Discord intents:** only `Guilds` and `GuildVoiceStates`. There are no privileged intents and no message-content access, and caches KINGSROCK doesn't need are disabled.

## 3. Technology stack

| Part | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24 LTS** (≥ 22.12 required) | Required by `@discordjs/voice` 0.19 |
| Language | JavaScript, CommonJS | No build step |
| Discord | **discord.js 14.28** | Maintained, full slash command support |
| Voice | **@discordjs/voice 0.19.2** + `@snazzah/davey` (DAVE) | Discord requires DAVE end-to-end voice encryption since March 2026 |
| Audio | **FFmpeg** with libopus | Decodes any format, outputs Opus |
| Config | **dotenv** | `.env` for development, systemd `EnvironmentFile` for production |
| Tests | **node:test** (built in) | No test framework dependency |
| Process manager | **systemd** (PM2 config included as an option) | Restart on failure, logs in journald |

There are only **3 direct dependencies** (30 packages installed in total). No database, no Redis, no Lavalink, no GPU, no paid APIs.

## 4. Commands

All commands are slash commands and work only inside servers.

| Command | What it does | Who can use it |
|---|---|---|
| `/play <query> [source]` | Search and play, or play a link. Starts now if idle, otherwise adds to the queue. `query` can be a song, artist, `radio: lofi`, or a URL. | Anyone in a voice channel |
| `/search <query> [source]` | Shows up to 5 results with a menu to choose from | Anyone |
| `/pause` · `/resume` | Pause or resume | Listeners in the bot's channel ¹ |
| `/skip` | Skip the current track | Listeners ¹ (the requester can always skip their own track) |
| `/stop` | Stop and clear the queue | Listeners ¹ |
| `/leave` | Disconnect from voice | Listeners ¹ |
| `/queue [page]` | Current track and upcoming tracks, with requesters and positions | Anyone |
| `/remove <position>` | Remove a queued track | Listeners ¹ (anyone can remove their own requests) |
| `/clear` | Clear upcoming tracks | Listeners ¹ |
| `/shuffle` | Shuffle upcoming tracks | Listeners ¹ |
| `/loop <off\|track\|queue>` | Repeat mode | Listeners ¹ |
| `/nowplaying` | Current track with a progress bar | Anyone |
| `/volume [1-100]` | Show or set the volume | Listeners ¹ to change |
| `/help` | All commands and sources | Anyone |
| `/settings view\|dj-role\|announce\|default-volume` | Per-server configuration | **Manage Server** permission |

¹ "Listeners" means members **in the same voice channel as KINGSROCK**. Members in
other channels can't control its playback. If an admin sets a **DJ role**
(`/settings dj-role`), controls are limited to that role plus admins, while
anyone can still queue music.

Volume changes restart FFmpeg at the current position, which causes a short
(~1 s) gap. This is how volume stays nearly free in CPU terms.

## 5. Music sources and their limits

| Source | Search | Needs key | What it plays |
|---|---|---|---|
| **Direct link / radio stream** | – | no | Any publicly accessible audio file or stream URL |
| **Audius** | ✅ title / artist | no | Tracks artists uploaded to Audius that are public and streamable. Gated or premium tracks are filtered out. |
| **Internet Archive** | ✅ | no | **Only** items licensed Creative Commons or public domain. Other items are refused. |
| **Jamendo** | ✅ | free client ID ([devportal.jamendo.com](https://devportal.jamendo.com)) | Independent Creative Commons music (non-commercial API terms) |
| **Radio Browser** | ✅ stations | no | Public internet radio stations from the community directory |
| **YouTube** (opt-in, `YOUTUBE_ENABLED=true`) | ✅ | no, needs [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Videos, Shorts, live streams and playlists (up to 50). See the warning below. |

**YouTube is off by default.** When you enable it, KINGSROCK uses yt-dlp to
download the audio and pipes it into FFmpeg (`yt-dlp → FFmpeg → Discord`).
Before turning it on, know that:

- this goes against **YouTube's Terms of Service**, and the server owner is responsible for what is played;
- YouTube often **blocks cloud / datacenter IPs** ("Sign in to confirm you're not a bot"), so it can work on your PC and fail on the cloud server (see [SETUP.md § 8.1](SETUP.md#81-youtube-opt-in));
- yt-dlp must be **kept up to date**, because YouTube changes break older versions;
- a YouTube track takes **~5–10 s to start** and uses an extra yt-dlp process (~70 MB RAM) while it plays.
  A volume change restarts yt-dlp, causing a gap of a few seconds.

**What KINGSROCK never plays:** Spotify, SoundCloud, Apple Music, Deezer, TIDAL,
Amazon Music, Bandcamp and Twitch links, plus YouTube links while YouTube is
disabled. KINGSROCK replies with a clear explanation and suggests searching by name instead.

Honest limitations:

- Without YouTube, the free, legal catalogs are **independent / Creative Commons /
  public-domain music and radio**, not the mainstream charts. Many famous songs can only
  be heard on radio stations that broadcast them.
- Spotify's API provides metadata only, not playable audio, so it is not used.
- Provider APIs are third-party services. If one is down, `auto` search falls back to the others.
- Internet Archive download servers can take 5–10 s before they start sending audio.
- Radio stream content is the responsibility of each station.

## 6. Resource usage (measured)

Measured with `npm run measure` on the development PC (AMD Ryzen 5 5600,
Windows 10, Node 24.22.3). That runs the real production pipeline (FFmpeg →
Ogg/Opus → `@discordjs/voice` AudioPlayer at real time) for 30 seconds, but
**without** a Discord connection:

| Scenario | Node.js CPU | Node.js RAM (RSS) | FFmpeg CPU (each) | FFmpeg RAM (each) |
|---|---|---|---|---|
| 1 stream | ~0.05 % of one core | 65 MB | ~1.1 % of one core | ~20 MB |
| 3 simultaneous streams | 0.5 % of one core | 68 MB | ~0.8 % of one core | ~20 MB |

Notes:

- A cloud vCPU is slower than a desktop Ryzen core, so expect higher
  percentages on the server. Run `npm run measure` there to get real numbers.
- With a live Discord connection, RAM grows with the number of servers and
  channels cached. Check it on the server with `systemctl status kingsrock` or
  the optional `/health` endpoint.
- **Network:** about 96 kbps out per playing server, which is roughly **42 MB per hour of playback**.
- While idle (nothing playing) there is no FFmpeg process and no audio traffic.

**Minimum practical server:** 1 vCPU (even a shared or burstable one), **1 GB RAM** (plus swap for
`npm ci`), about 1 GB of disk for the app, outbound internet with UDP allowed, and Ubuntu 22.04/24.04
on x86_64 or arm64.

## 7. Hosting summary

**Recommended: Oracle Cloud Always Free.** Use an Ampere A1 VM (arm64, 1 OCPU / 6 GB)
or an E2.1.Micro VM (x86, 1 GB). It is a real VM with a persistent process,
unrestricted outbound UDP for Discord voice, and 10 TB/month of outbound data,
at no monthly cost. Important caveats include a credit card for identity
verification, idle-instance reclamation and limited A1 capacity. The full
comparison of free options, and why other platforms are unsuitable, is in
[SETUP.md § Free hosting options](SETUP.md#9-free-hosting-options-evaluated).

## 8. Security

- Secrets come only from `.env` (development) or `/etc/kingsrock/kingsrock.env`
  (production, `chmod 640`, owned by root:kingsrock). `.gitignore` excludes every `.env` file.
- The bot token is **redacted from all log output**, even if a library error contains it.
- The bot requests only the minimum permissions: View Channel, Send Messages, Embed Links, Read Message History, Connect, Speak (invite permission integer `3230720`).
- **SSRF protection:** user links that resolve to private, loopback or link-local addresses
  (including the cloud metadata service `169.254.169.254`) are refused. Every
  redirect hop is re-checked. FFmpeg may only use network protocols
  (`http,https,tcp,tls,crypto`), so a malicious playlist can't make it read local files.
- No mentions are ever parsed in bot messages (`allowedMentions: none`), so track titles can't ping `@everyone`.
- systemd runs KINGSROCK as an unprivileged user with a read-only filesystem except `data/`.
- A lock file prevents two instances running from the same folder. Use a separate bot application for development (see SETUP.md).

## 9. Testing: what is and isn't verified

`npm test` runs **119 automated tests** with Node's built-in test runner. The 5 live provider tests
run only when `KINGSROCK_LIVE_TESTS=1` is set; otherwise they are reported as skipped.

| Level | Count | What it covers | Status |
|---|---|---|---|
| **Unit** (`tests/unit`) | 104 | YouTube provider (URL parsing, no option injection, error mapping, enable/disable routing), Slash commands end-to-end through the real router (fake Discord interactions), Now Playing edit-vs-replace, health endpoint, Queue add/remove/clear/shuffle, loop modes, playback state transitions, failure → next track, give-up after repeated failures, skip/stop/volume restarts, inactivity and alone timers, cleanup, independent guild players, all providers with mocked HTTP, SSRF rules, config validation, slash command registration rules, permissions, embeds, settings store, instance lock | ✅ all pass |
| **Integration** (`tests/integration/audioPipeline`) | 10 | **Real FFmpeg + real `@discordjs/voice` AudioPlayer** with a local HTTP server: probing, playlists, redirects, Opus packet output, player state machine, broken files reported (never "playing"), FFmpeg cleanup, two guilds streaming at once | ✅ all pass |
| **Live provider** (`tests/integration/liveProviders`, opt-in `KINGSROCK_LIVE_TESTS=1`) | 5 | Real Audius, Radio Browser, Internet Archive and YouTube (yt-dlp) → real streams decoded to Opus | ✅ passed on the development PC (Internet Archive is slow and failed once with a timeout before the timeout was raised) |
| **Discord login** | – | Startup with an invalid token reached Discord's API and was rejected cleanly | ✅ error path only |
| **Live Discord voice playback** | – | Hearing audio in a real voice channel | ❌ **not yet tested**: needs your bot token and server ([SETUP.md § 12](SETUP.md#12-live-acceptance-test)) |
| **Cloud deployment / PC-off test** | – | | ❌ **not yet performed**: needs your cloud account |

## 10. Project structure

```
kingsrock/
├── src/
│   ├── index.js                 entry point: startup checks, client, shutdown
│   ├── deploy-commands.js       slash command registration CLI
│   ├── doctor.js                environment checker
│   ├── commands/                one file per slash command (+ _shared.js helpers)
│   ├── events/                  interaction routing, gateway / voice events
│   ├── music/
│   │   ├── MusicManager.js      guildId -> MusicPlayer
│   │   ├── MusicPlayer.js       per-guild voice + audio + queue state machine
│   │   ├── QueueManager.js      pure queue logic
│   │   ├── AudioSourceManager.js routing, blocked platforms, fallbacks
│   │   ├── Announcer.js         Now Playing / error messages
│   │   ├── FFmpeg.js            spawn, probe, error mapping
│   │   ├── Track.js             track metadata model
│   │   └── providers/           Base, DirectUrl, Audius, RadioBrowser, InternetArchive, Jamendo
│   ├── config/                  env validation, per-guild settings store
│   └── utils/                   logger, embeds, network safety, permissions, lock, health
├── tests/                       unit/, integration/, helpers/
├── scripts/measure.js           CPU / RAM measurement
├── deploy/                      systemd unit, Ubuntu installer, update script, PM2 config
├── .env.example  .gitignore  package.json  README.md  SETUP.md
```

## 11. Adding a new music provider

1. Create `src/music/providers/MyProvider.js` extending `BaseProvider`:

   ```js
   const { BaseProvider } = require('./BaseProvider');
   const { Track } = require('../Track');

   class MyProvider extends BaseProvider {
     constructor() { super({ name: 'mine', displayName: 'My Source', searchable: true }); }
     canResolve(url) { return new URL(url).hostname === 'mine.example'; }   // optional
     async resolve(url, { requestedBy }) { /* return [new Track({...})] */ }  // optional
     async search(query, { limit, requestedBy }) {
       // call the API -> return Track[] with source: this.name, sourceId, title, artist, durationMs ...
     }
     async getStream(track) {
       // called right before playback: return a FRESH playable URL
       return { url: 'https://…/audio.mp3', isLive: false };
     }
   }
   module.exports = { MyProvider };
   ```

2. Register it in `src/music/providers/index.js` (`createProviders`).
3. Add its name to `ALL_PROVIDERS` / `SEARCH_PROVIDERS` in `src/config/index.js`, and add a `source` choice in `src/commands/play.js` and `search.js` if users should pick it.
4. Throw `TrackUnavailableError`, `UnsupportedSourceError` or `ProviderError` (from `src/utils/errors.js`) with a user-friendly message. Anything else is reported as a generic error.
5. Add tests with a mocked `fetchImpl` (see `tests/unit/providers.test.js`) and run `npm run register` if you changed command options.

Only add sources whose terms permit streaming into Discord.

## 12. npm scripts

| Script | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Development: auto-restart on changes, debug logs, instant commands in `DISCORD_GUILD_ID` |
| `npm start` | Production start |
| `npm test` | All tests (unit + integration; live tests run with `KINGSROCK_LIVE_TESTS=1`) |
| `npm run test:unit` / `test:integration` | One test level |
| `npm run register` | Register slash commands (guild if `DISCORD_GUILD_ID` is set, else global) |
| `npm run register:global` / `register:guild` / `unregister:guild` | Explicit registration targets |
| `npm run doctor` | Check Node, FFmpeg, config, voice dependencies; print the invite URL |
| `npm run measure` | Measure CPU / RAM of the audio pipeline |
