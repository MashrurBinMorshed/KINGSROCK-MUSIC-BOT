# KINGSROCK Setup Guide

This guide takes you from nothing to KINGSROCK running 24/7 in the cloud, with
your PC switched off. Follow the sections in order. Commands shown as `PS>` run
in **Windows PowerShell** on your PC. Commands shown as `$` run on the **cloud server**.

1. [What you need](#1-what-you-need)
2. [Install Node.js](#2-install-nodejs-windows)
3. [Install FFmpeg and add it to PATH](#3-install-ffmpeg-on-windows-and-add-it-to-path)
4. [Create the Discord application and bot](#4-create-the-discord-application-and-bot)
5. [Configure the environment](#5-configure-the-environment)
6. [Run KINGSROCK locally](#6-run-kingsrock-locally)
7. [Using every command](#7-using-every-command)
8. [Configuring music providers](#8-configuring-music-providers)
9. [Free hosting options (evaluated)](#9-free-hosting-options-evaluated)
10. [Deploy to Oracle Cloud Always Free](#10-deploy-to-oracle-cloud-always-free)
11. [Production operations](#11-production-operations)
12. [Live acceptance test](#12-live-acceptance-test)
13. [Troubleshooting and common errors](#13-troubleshooting-and-common-errors)
14. [Sharing one bot with friends (run it on any PC)](#14-sharing-one-bot-with-friends-run-it-on-any-pc)

---

## 1. What you need

| Item | Local development (Windows) | Production (cloud) |
|---|---|---|
| Node.js | **24 LTS** (22.12+ works) | installed by `deploy/install-ubuntu.sh` |
| FFmpeg with libopus | yes | installed by the script |
| Discord account | yes | – |
| Cloud account | – | Oracle Cloud (free; card needed for verification) |
| Python | **not needed** | not needed |

## 2. Install Node.js (Windows)

`@discordjs/voice` 0.19 (the version with Discord's mandatory DAVE voice
encryption) needs **Node.js 22.12 or newer**. Node 20 reached end-of-life in April 2026.

**If you use nvm-windows** (it is installed on the development PC, and Node
24.22.3 was installed through it during the build):

```powershell
PS> nvm list                 # shows installed versions
PS> nvm install 24.22.3      # if it is not installed yet
PS> nvm use 24.22.3          # run PowerShell "as Administrator" for this one
PS> node -v                  # must print v24.x
```

`nvm use` changes the default Node for your whole PC. If another project still
needs Node 20, switch back with `nvm use 20.19.6` when you work on it.

**Without nvm:** `PS> winget install OpenJS.NodeJS.LTS`, then open a new terminal and run `node -v`.

## 3. Install FFmpeg on Windows and add it to PATH

The easiest way is winget, which also sets PATH:

```powershell
PS> winget install Gyan.FFmpeg
# close and reopen PowerShell, then:
PS> ffmpeg -version
```

If `ffmpeg` is "not recognized", add it to PATH manually:

1. Download the "release full" build from <https://www.gyan.dev/ffmpeg/builds/> and extract it to `C:\ffmpeg`.
   You should now have `C:\ffmpeg\bin\ffmpeg.exe`.
2. Press **Win**, type **environment variables**, and open **Edit the system environment variables**.
3. Click **Environment Variables…**, select **Path** under *User variables*, click **Edit**, then **New**, and enter `C:\ffmpeg\bin`.
4. Click **OK** on every dialog, **close all terminals and VS Code**, and reopen them.
5. `PS> ffmpeg -version` should now work.

Alternatively, set the full path in `.env`: `FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe` and `FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe`.

KINGSROCK checks at startup that FFmpeg exists **and** includes the `libopus` encoder. Both the gyan.dev build and Ubuntu's package include it.

## 4. Create the Discord application and bot

> **Tip:** create **two** applications: `KINGSROCK` (production, runs in the
> cloud) and `KINGSROCK Dev` (for `npm run dev` on your PC). A token must only
> be used by one running bot at a time. Two apps mean testing on your PC never
> fights with the cloud bot.

### 4.1 Create the application

1. Open <https://discord.com/developers/applications> and log in.
2. Click **New Application**, name it **KINGSROCK**, accept the terms, and click **Create**.
3. On **General Information**, optionally upload an avatar (dark or gold esports logo) and a description.
4. **Copy the Application ID**. This is your `DISCORD_CLIENT_ID`.

### 4.2 Create the bot and get the token

1. Open the **Bot** tab.
2. Click **Reset Token**, confirm, and **copy the token**. This is your `DISCORD_TOKEN`.
   - Treat it like a password. Anyone with it controls your bot.
   - Never paste it into Discord, screenshots, GitHub or chat.
   - If it leaks, click **Reset Token** again. The old token stops working immediately.
3. **Privileged Gateway Intents**: leave **all three OFF**. KINGSROCK doesn't need Presence, Server Members or Message Content.
4. **Public Bot**: turn it **OFF** if you want to be the only person who can add KINGSROCK to servers (recommended for a private esports bot).

### 4.3 Bot permissions

KINGSROCK needs only these permissions:

| Permission | Why |
|---|---|
| View Channels | See the voice and text channels |
| Send Messages | Post Now Playing / error messages |
| Embed Links | Branded embeds |
| Read Message History | Check whether its Now Playing message is still the latest (to edit instead of re-posting) |
| Connect | Join voice channels |
| Speak | Play audio |

Permission integer: **`3230720`**. It doesn't need Administrator, so don't give it that.

### 4.4 Generate the invite URL

Run `npm run doctor` (after section 5) and it prints the URL, or build it yourself:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=3230720&scope=bot%20applications.commands
```

Open it in a browser, pick your esports server, and click **Authorize**. You
need the *Manage Server* permission on that server. Both scopes are required:
`bot` adds the bot user and `applications.commands` enables slash commands.

### 4.5 Get your test server ID (for development)

Discord → **User Settings** → **Advanced** → enable **Developer Mode**. Then
right-click your test server's icon → **Copy Server ID**. This is `DISCORD_GUILD_ID`.

## 5. Configure the environment

In the project folder:

```powershell
PS> cd H:\pp\KINGSROCK\kingsrock
PS> Copy-Item .env.example .env
PS> notepad .env
```

Fill in:

```ini
DISCORD_TOKEN=paste-the-DEV-bot-token
DISCORD_CLIENT_ID=paste-the-DEV-application-id
DISCORD_GUILD_ID=your-test-server-id      # development only
```

Everything else has sensible defaults (each line is explained in `.env.example`).

**Development vs production are kept separate:**

| | Development (your PC) | Production (cloud) |
|---|---|---|
| Secrets file | `kingsrock\.env` | `/etc/kingsrock/kingsrock.env` (outside the code folder) |
| Bot application | `KINGSROCK Dev` | `KINGSROCK` |
| `DISCORD_GUILD_ID` | your test server (instant command updates) | **empty** (global commands) |
| Start | `npm run dev` | systemd runs `node src/index.js` |

`.env` is listed in `.gitignore`, so it never goes to GitHub. You can point to any
other file with `KINGSROCK_ENV_FILE=path\to\file.env`.

## 6. Run KINGSROCK locally

```powershell
PS> cd H:\pp\KINGSROCK\kingsrock
PS> npm install            # once
PS> npm run doctor         # checks Node, FFmpeg, .env, voice libraries; prints the invite URL
PS> npm test               # optional: 119 automated tests
PS> npm run dev            # starts the bot; restarts automatically when you edit src/
```

In development mode with `DISCORD_GUILD_ID` set, KINGSROCK registers its slash
commands in your test server on every start. They appear instantly.

You should see:

```
INFO  [kingsrock] FFmpeg OK: ffmpeg version …
INFO  [kingsrock] Music providers: direct, audius, radio, archive
INFO  [kingsrock] Logged in as KINGSROCK Dev#1234 (…) · 1 server(s) · mode: development
INFO  [kingsrock] Registered 16 development commands in guild …
```

Join a voice channel in your test server and type `/play query: lofi`. Press **Ctrl+C** to stop (KINGSROCK leaves voice and stops FFmpeg cleanly).

Manual registration (without starting the bot):

```powershell
PS> npm run register:guild     # instant, test server only
PS> npm run register:global    # all servers (production); can take a few minutes
PS> npm run unregister:guild   # remove test-server copies if you see duplicates
```

## 7. Using every command

Join a voice channel first. KINGSROCK joins **your** channel.

| Example | Result |
|---|---|
| `/play query: lofi chill` | Searches Audius (falling back to Internet Archive and Jamendo) and plays the first result |
| `/play query: radio: jazz` | Searches internet radio stations and plays the most popular match |
| `/play query: moonlight sonata source: Internet Archive` | Searches only CC/public-domain recordings |
| `/play query: https://example.com/music/track.mp3` | Plays a direct audio file |
| `/play query: https://stream.example.com/live.pls` | Plays a radio stream playlist |
| `/play query: https://audius.co/artist/track` | Plays an Audius track (or a whole playlist) |
| `/play query: https://youtu.be/…` · `/play query: yt: daft punk` | YouTube link or search (only when YouTube is enabled, see 8.1) |
| `/play query: https://archive.org/details/<item>` | Queues every audio file of a CC/PD Archive item (max 50) |
| `/search query: synthwave` | Shows 5 results in a menu; pick one to queue it |
| `/pause`, `/resume` | Pause or continue (radio restarts at the live point) |
| `/skip` | Next track |
| `/stop` | Stops and clears the queue (KINGSROCK leaves after the inactivity timeout) |
| `/leave` | Disconnects immediately |
| `/queue` · `/queue page: 2` | Now playing + upcoming tracks with positions and requesters |
| `/remove position: 3` | Removes track #3 |
| `/clear` | Removes all upcoming tracks |
| `/shuffle` | Shuffles upcoming tracks |
| `/loop mode: Track` / `Queue` / `Off` | Repeat one track / the whole queue / nothing |
| `/nowplaying` | Current track with a progress bar |
| `/volume` · `/volume level: 70` | Shows or sets the volume (1–100; 100 = original loudness) |
| `/help` | Command overview |
| `/settings view` | Server settings (admins only) |
| `/settings dj-role role: @DJ` | Only @DJ and admins can control playback (anyone can still queue) |
| `/settings dj-role` (empty) | Everyone in the channel can control playback again |
| `/settings announce enabled: False` | Turns off automatic Now Playing messages |
| `/settings default-volume level: 40` | Volume used when KINGSROCK joins |

Automatic behavior:

- When the queue ends, KINGSROCK edits the Now Playing message to "Queue finished".
- If **everyone leaves** the voice channel, it pauses and leaves after `ALONE_TIMEOUT_SECONDS` (60 s). If someone comes back before then, playback resumes.
- After `INACTIVITY_TIMEOUT_SECONDS` (300 s) of nothing playing, or of being paused, it leaves.
- If a track fails (expired link, server error, bad file), KINGSROCK posts the reason and plays the next track. After 5 failures in a row, it stops and clears the queue.

## 8. Configuring music providers

All provider settings are in `.env` / `kingsrock.env`:

| Variable | Default | Meaning |
|---|---|---|
| `ENABLED_PROVIDERS` | `direct,audius,radio,archive,jamendo` | Remove names to disable sources |
| `DEFAULT_SEARCH_PROVIDER` | `audius` | Tried first for plain-text `/play` |
| `AUDIUS_APP_NAME` | `KINGSROCK` | Identifies your app to the Audius API (no key needed) |
| `JAMENDO_CLIENT_ID` | empty | Free key from <https://devportal.jamendo.com> (create an app, then copy the Client ID). Jamendo is skipped when this is empty |
| `PROVIDER_TIMEOUT_SECONDS` | `10` | API timeout |
| `ALLOW_PRIVATE_NETWORK_URLS` | `false` | Keep `false`. `true` lets users play LAN or localhost URLs (only for local testing) |

Audio settings: `AUDIO_BITRATE` (default 96 kbps; lower it to save bandwidth),
`DEFAULT_VOLUME`, `STREAM_START_TIMEOUT_SECONDS`, `MAX_QUEUE_SIZE`.

### 8.1 YouTube (opt-in)

> **Read first.** YouTube support uses [yt-dlp](https://github.com/yt-dlp/yt-dlp). This goes against
> YouTube's Terms of Service, and you (the bot owner) are responsible for what is played. It is
> **off by default**.

**On Windows (your PC):**

```powershell
PS> winget install yt-dlp.yt-dlp      # then reopen the terminal
PS> yt-dlp --version
```

Then set these in `.env`:

```ini
YOUTUBE_ENABLED=true
YTDLP_PATH=yt-dlp                     # or the full path to yt-dlp.exe
DEFAULT_SEARCH_PROVIDER=youtube       # plain-text /play searches YouTube first
```

Run `npm run doctor` (it shows a `yt-dlp …` line), then `npm run dev`.

**On the Ubuntu server:** run the installer with the flag:

```bash
$ sudo bash deploy/install-ubuntu.sh --with-youtube
```

This installs the official standalone yt-dlp to `/usr/local/bin/yt-dlp` (x86_64 or arm64) and a
weekly `yt-dlp -U` self-update. Then set `YOUTUBE_ENABLED=true` in `/etc/kingsrock/kingsrock.env`
and run `sudo systemctl restart kingsrock`.

**What works:** `/play query: <song>` (searches YouTube first), `/play query: yt: <song>`,
`/search source: YouTube`, and links to videos, `youtu.be`, Shorts, live streams, `music.youtube.com`,
and playlists (first 50 videos). Endless "Mix" playlists (`list=RD…`) are refused.

**How it works:** yt-dlp downloads the audio and pipes it into FFmpeg, which encodes Opus for Discord.
YouTube's media URLs return HTTP 403 when FFmpeg fetches them directly, so the pipe is necessary.
yt-dlp uses the bot's own Node.js for YouTube's JavaScript challenge, so there's nothing extra to install.
Both processes run only while a track plays and are stopped together.

**Known problems:**

| Problem | What to do |
|---|---|
| `YouTube is blocking this server ("Sign in to confirm you're not a bot")` | YouTube flags many **cloud / datacenter IPs**, including Oracle's. It usually works from home internet. The workaround is a cookies file: export YouTube cookies from a browser where you're logged in, using a "cookies.txt" export extension, **with a throwaway Google account**, because YouTube can restrict accounts used this way. Upload it to the server as `/opt/kingsrock/data/youtube-cookies.txt` (`sudo chown kingsrock:kingsrock` and `sudo chmod 600` it; it must be in `data/` because yt-dlp writes refreshed cookies back), then set `YOUTUBE_COOKIES_FILE=/opt/kingsrock/data/youtube-cookies.txt`. |
| Tracks suddenly fail with "yt-dlp may need an update" | YouTube changed something. Run `yt-dlp -U` (Windows: `winget upgrade yt-dlp.yt-dlp`), or `sudo /usr/local/bin/yt-dlp -U` on the server. |
| A track takes 5–10 s to start | Normal: yt-dlp has to resolve the video first. |
| Volume change causes a few seconds of silence | A volume change restarts yt-dlp at the current position. |
| `This YouTube video is age-restricted` / `private or members-only` | These can't be played without an account (cookies). |

Spotify links stay unsupported: Spotify's API gives metadata only, not audio.

## 9. Free hosting options (evaluated)

A Discord music bot needs a **process that runs 24/7** with **outbound WebSocket
(Gateway) and outbound UDP (voice)**, plus **FFmpeg**. Many "free Node.js
hosting" platforms fail at least one of these, so I checked each requirement.
Facts were checked on **21 Nov 2026** from the providers' pages listed below.
Free tiers change, so re-check before you sign up.

| Option | Persistent 24/7 process | Voice UDP | FFmpeg | Free limits that matter | Verdict |
|---|---|---|---|---|---|
| **Oracle Cloud Always Free: Ampere A1** (arm64) | ✅ full VM | ✅ (egress open by default) | ✅ `apt install ffmpeg` | Since mid-2026: **2 OCPU + 12 GB RAM total** (1,500 OCPU-h / 9,000 GB-h per month). **10 TB/month outbound**. 200 GB block storage. Must be in your home region. A1 capacity is often "out of capacity" in busy regions | ✅ **Recommended** (1 OCPU / 6 GB is plenty) |
| **Oracle Cloud Always Free: E2.1.Micro** (x86) | ✅ full VM | ✅ | ✅ | 2 VMs, each 1/8 OCPU (burstable) + **1 GB RAM**, 50 Mbps. Same 10 TB outbound | ✅ Good fallback if A1 is unavailable |
| **Google Cloud Free Tier: e2-micro** | ✅ full VM | ✅ | ✅ | 1 VM in us-west1/us-central1/us-east1 only, 30 GB disk. Only **1 GB/month outbound** from North America (excluding China and Australia), which is **~24 hours of playback at 96 kbps**. After that, egress is billed (third-party sources cite about $0.12/GB) | ⚠️ Free only for light use; card required |
| **AWS Free Tier** (accounts created after 15 Jul 2025) | ✅ | ✅ | ✅ | Credit-based "Free plan": ends after **6 months** or when the credits ($100, up to $200 with activities) run out | ❌ Not free long-term |
| **Render** | ❌ free tier is only for web services, which spin down when idle. Background workers have no free tier | – | – | – | ❌ Unsuitable |
| **Railway** | ❌ Free plan ($1/month of usage) runs services that sleep when idle | – | – | – | ❌ Unsuitable for 24/7 |
| **Koyeb** | ❌ free instance scales to zero after 1 h without traffic and can't be a worker. New signups restricted in 2026 | – | – | – | ❌ Unsuitable |
| "Free Discord bot hosts" (Pterodactyl panels etc.) | varies | often not verified | varies | Unknown uptime and terms, and you hand your token to a third party | ❌ Not recommended |
| Fly.io, Heroku, Glitch, Replit | Not re-verified in this session. These ended or restricted their free always-on hosting in earlier years | | | | ❌ Don't plan on them |

**Why Oracle wins:** it's the only option checked that is a real VM, free with
no time limit, with enough outbound data for music (10 TB vs 1 GB on Google).
KINGSROCK needs about 42 MB per hour of playback per server.

**Oracle caveats (read before you sign up):**

- **Credit or debit card required** for identity verification. Always Free
  resources are not charged. Some prepaid or virtual cards are rejected.
- **Home region is permanent**, and Always Free instances must be created there. Pick
  a region close to your members (lower jitter to Discord voice servers) and
  ideally one known to have Ampere capacity.
- **Idle reclamation:** Oracle's docs say Always Free instances *may be reclaimed*
  if, over 7 days, 95th-percentile CPU is under 20 %, network is under 20 % and (A1 only) memory is
  under 20 %. A music bot is idle most of the time, so **this can apply to KINGSROCK**.
  Oracle emails a warning first. Options:
  1. Upgrade the account to **Pay As You Go**. Oracle states it does not charge
     for Always Free resources after an upgrade, only for usage *above* the
     limits. Oracle's page does **not** say whether PAYG accounts are exempt from
     idle reclamation. Many users report they are, but I could not confirm it in
     official docs. Set a budget alert (for example $1) if you upgrade.
  2. Stay on Free Tier and act on reclamation emails. Recreating the VM takes about 15 minutes with `deploy/install-ubuntu.sh`.
  - Do **not** run artificial CPU load to dodge the rule. That is the kind of
    trick this project avoids.
- **A1 limits were halved in June 2026** (reported by InfoQ, and the Oracle docs
  now show 1,500 OCPU-h / 9,000 GB-h). Use **1 OCPU / 6 GB** to stay well inside the limits.

Sources: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm) ·
[InfoQ: Oracle halves A1 free limits (Jul 2026)](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/) ·
[Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features) ·
[AWS Free Tier update (Jul 2025)](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan) ·
[Render free tier](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026) ·
[Railway free plan](https://docs.railway.com/pricing/free-plan) ·
[Koyeb scale-to-zero](https://www.koyeb.com/docs/run-and-scale/scale-to-zero) ·
[Discord DAVE for all calls](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted)

## 10. Deploy to Oracle Cloud Always Free

### 10.1 Create the account

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Enter your email, country and name, then verify your email.
3. Choose your **home region** carefully (see the caveats above).
4. Add your card for verification and finish signup. Provisioning can take a few minutes.

### 10.2 Create the VM

1. In the console, open the menu ☰ → **Compute** → **Instances** → **Create instance**.
2. **Name:** `kingsrock`.
3. **Image:** click *Change image* → **Canonical Ubuntu 24.04**.
4. **Shape:** click *Change shape*:
   - **Ampere** → `VM.Standard.A1.Flex`, **1 OCPU, 6 GB** memory (look for the *Always Free-eligible* label), **or**
   - **Specialty and previous generation** → `VM.Standard.E2.1.Micro` (if A1 says *Out of capacity*; you can also retry A1 later or in another availability domain).
5. **Networking:** keep *Create new virtual cloud network* and *public subnet*, and make sure **Assign a public IPv4 address** is on.
6. **SSH keys:** choose *Generate a key pair for me*, click **Save private key**, and store it as
   `C:\Users\<you>\.ssh\kingsrock.key`.
7. Keep the default boot volume and click **Create**. Wait until the state is **Running**, then copy the **Public IP address**.

No firewall or ingress changes are needed. KINGSROCK only makes **outbound**
connections (HTTPS/WSS to Discord, UDP to voice servers, HTTPS to music APIs), and
Oracle's default security list allows all outbound traffic. The only inbound port is
SSH (22), which Oracle opens by default.

### 10.3 Connect from Windows

```powershell
PS> icacls $HOME\.ssh\kingsrock.key /inheritance:r /grant:r "$($env:USERNAME):(R)"   # fixes "unprotected key" errors
PS> ssh -i $HOME\.ssh\kingsrock.key ubuntu@YOUR_PUBLIC_IP
```

Type `yes` the first time. Your prompt now shows `ubuntu@kingsrock`.

### 10.4 Upload KINGSROCK

From a **second** PowerShell window on your PC:

```powershell
PS> cd H:\pp\KINGSROCK
PS> tar --exclude=kingsrock/node_modules --exclude=kingsrock/.env --exclude=kingsrock/data -czf kingsrock.tgz kingsrock
PS> scp -i $HOME\.ssh\kingsrock.key kingsrock.tgz ubuntu@YOUR_PUBLIC_IP:~/
```

`.env` is excluded on purpose. Your development secrets stay on your PC.
(Alternatively, push the project to a **private** GitHub repository and run `git clone` on the server.)

### 10.5 Install

On the server:

```bash
$ tar -xzf kingsrock.tgz
$ cd ~/kingsrock
$ sudo bash deploy/install-ubuntu.sh
```

The script installs FFmpeg, Node.js 24 and a swap file (on 1 GB machines), creates the
unprivileged `kingsrock` user, copies the app to `/opt/kingsrock`, runs
`npm ci --omit=dev`, creates `/etc/kingsrock/kingsrock.env` and installs the systemd service.

### 10.6 Add the production secrets

```bash
$ sudo nano /etc/kingsrock/kingsrock.env
```

Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` from the **production** `KINGSROCK` app, and leave
`DISCORD_GUILD_ID=` **empty**. Save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

### 10.7 Check, register commands, start

```bash
$ sudo -u kingsrock env KINGSROCK_ENV_FILE=/etc/kingsrock/kingsrock.env node /opt/kingsrock/src/doctor.js
$ sudo -u kingsrock env KINGSROCK_ENV_FILE=/etc/kingsrock/kingsrock.env node /opt/kingsrock/src/deploy-commands.js --global
$ sudo systemctl start kingsrock
$ journalctl -u kingsrock -f        # Ctrl+C to stop watching (the bot keeps running)
```

Look for `Logged in as KINGSROCK#…`. Invite the **production** app to your
esports server with the invite URL that `doctor.js` printed. Global commands can take a few
minutes to show up. Press **Ctrl+R** in Discord to refresh.

## 11. Production operations

| Task | Command |
|---|---|
| Status | `sudo systemctl status kingsrock` |
| Live logs | `journalctl -u kingsrock -f` |
| Logs since boot / errors only | `journalctl -u kingsrock -b` · `journalctl -u kingsrock -p warning` |
| Restart | `sudo systemctl restart kingsrock` |
| Stop / start | `sudo systemctl stop kingsrock` · `sudo systemctl start kingsrock` |
| Start on boot | already enabled by the installer (`systemctl is-enabled kingsrock`) |
| Update code | upload the new files as in 10.4, extract, then `cd ~/kingsrock && sudo bash deploy/update.sh` (add `--register` if commands changed) |
| Measure CPU/RAM | `cd /opt/kingsrock && sudo -u kingsrock node scripts/measure.js "" 30 1` |
| OS updates | `sudo apt update && sudo apt upgrade -y` (then `sudo reboot`; KINGSROCK starts by itself) |

**Restart strategy:** systemd restarts KINGSROCK 5 s after any exit (`Restart=always`), up to
10 times in 5 minutes. If it keeps crashing (for example an invalid token), it stops trying so it
doesn't hammer Discord. Fix the cause and run `sudo systemctl restart kingsrock`.
Temporary network outages don't need a restart: discord.js reconnects the gateway, and
voice connections rejoin with backoff (5 attempts).

**Graceful shutdown:** on `systemctl stop` / reboot (SIGTERM), KINGSROCK leaves all voice
channels, stops every FFmpeg process, saves settings and disconnects within a few seconds.

**Only one instance per token:** systemd runs exactly one process, and a lock file in
`/opt/kingsrock/data` refuses a second copy on the same machine. Across machines, use separate bot
applications for development and production (section 4). If you ever run the production token on
your PC, stop the server first: `sudo systemctl stop kingsrock`.

**Health monitoring (optional):** set `HEALTH_PORT=8080` in `kingsrock.env` and restart. Then:

```bash
$ curl -s http://127.0.0.1:8080/health
{"status":"ok","gateway":"Ready","pingMs":42,"guilds":1,"activePlayers":0,"uptimeSeconds":3600,"memoryMb":{"rss":80.1,"heapUsed":25.3}}
```

It listens on localhost only and does no work unless you call it. HTTP 200 means connected to Discord, 503 means not.

**Backups:** the only state is `/opt/kingsrock/data/guild-settings.json` (server settings). Secrets are in `/etc/kingsrock/kingsrock.env`.

## 12. Live acceptance test

These are the checks that **automated tests cannot do**. Run them yourself after deploying:

- [ ] `journalctl -u kingsrock` shows `Logged in as …` and no errors
- [ ] `/help` responds in your server
- [ ] Join a voice channel, then `/play query: radio: lofi`: KINGSROCK joins, and **you hear audio**
- [ ] `/play query: https://…/some-file.mp3` (a direct audio file you are allowed to share) adds it to the queue
- [ ] `/queue` shows both, `/skip` moves to the next one, `/pause` / `/resume` work
- [ ] `/volume level: 80`: louder after a ~1 s gap
- [ ] `/loop mode: Queue`, `/shuffle`, `/remove position: 1`, `/clear` behave as expected
- [ ] A second member in the same channel hears the same audio
- [ ] A member in **another** voice channel gets "You need to be in #… to control playback" when using `/skip`
- [ ] Everyone leaves the channel: KINGSROCK pauses, then leaves after 60 s
- [ ] **Shut down your Windows PC.** From your phone, join the voice channel and `/play` again: KINGSROCK still works
- [ ] `sudo reboot` the server: KINGSROCK comes back online by itself within a minute or two

## 13. Troubleshooting and common errors

| Symptom / message | Cause and fix |
|---|---|
| `Invalid KINGSROCK configuration: DISCORD_TOKEN is missing` | `.env` not found or empty. Run it from the `kingsrock` folder, copy `.env.example` to `.env`, and fill it in. On the server, edit `/etc/kingsrock/kingsrock.env`. |
| `DISCORD_TOKEN does not look like a Discord bot token` | Extra quotes or spaces, or you pasted the *client secret* or *public key* instead of the **Bot** token. |
| `Discord rejected the bot token` | Token was reset or is wrong. Developer Portal → Bot → **Reset Token**, then update the env file. |
| `FFmpeg check failed` | FFmpeg isn't on PATH (section 3) or has no libopus. On Ubuntu: `sudo apt install ffmpeg`. Or set `FFMPEG_PATH`. |
| `npm warn EBADENGINE … node: '>=22.12.0'` or voice errors on start | Node is too old. `node -v` must be 22.12+ (section 2). |
| `Another KINGSROCK instance is already running (PID …)` | Stop the other copy (Ctrl+C in its terminal / `systemctl stop`). If no copy is running, delete `data/kingsrock.lock`. |
| Slash commands don't appear | Run `npm run register` (or `register:global`) and wait a few minutes for global commands. Press **Ctrl+R** in Discord. Make sure the invite URL included `applications.commands`. |
| Every command appears **twice** | You have both guild (dev) and global copies. Run `npm run unregister:guild`. |
| "The application did not respond" | The bot is offline or crashed. Check `journalctl -u kingsrock -n 50` / your terminal. |
| `Could not connect to the voice channel` | KINGSROCK lacks **Connect/Speak** in that channel, or outbound **UDP is blocked** (corporate network, VPN, strict firewall). Cloud VMs: keep the default allow-all egress rule. |
| Bot joins but there is **no sound** | Check that KINGSROCK isn't server-muted, that it has **Speak** permission, and that `/volume` is not very low. Run `npm run doctor` and confirm `@snazzah/davey` is listed (DAVE is required by Discord). Look for warnings in the logs. |
| `… links can't be played` (Spotify, SoundCloud…) | By design: no authorized streaming access. Search by name, or use radio and direct links. |
| `YouTube playback is turned off on this bot` | Set `YOUTUBE_ENABLED=true` and install yt-dlp (section 8.1). |
| `YOUTUBE_ENABLED=true but yt-dlp was not found` | Install yt-dlp, reopen the terminal, or set `YTDLP_PATH` to the full path. |
| YouTube errors (`not a bot`, `may need an update`) | See section 8.1. |
| `That link is a web page, not an audio file` | Use the direct stream or file URL (often ends in `.mp3`, `.m3u` or `.pls`, or the radio's "listen" link), not the website. |
| `Links to local or private network addresses are not allowed` | SSRF protection. For local testing only, set `ALLOW_PRIVATE_NETWORK_URLS=true`. |
| `The server refused access (HTTP 403)` / `expired (410)` | The source blocks bots or the link expired. Try another link. Audius and Jamendo links are refreshed automatically. |
| `The stream ended before any audio was received` | The file is damaged or not audio. |
| Internet Archive tracks take several seconds to start | archive.org download servers are slow to send the first byte (5–10 s was measured). Raise `STREAM_START_TIMEOUT_SECONDS` if they time out. |
| `Stage channels are not supported` | Use a normal voice channel. |
| Music pauses when everyone leaves | By design (`ALONE_TIMEOUT_SECONDS`). Rejoin within the timeout to resume. |
| Oracle: *Out of capacity for shape VM.Standard.A1.Flex* | Try another availability domain, try again later, or use `VM.Standard.E2.1.Micro`. |
| Oracle: email about idle instance reclamation | See section 9 (PAYG upgrade or recreate). Don't fake load. |
| `npm ci` killed on a 1 GB VM | The installer adds 1 GB of swap. Re-run `sudo bash deploy/install-ubuntu.sh`. |
| `ssh: UNPROTECTED PRIVATE KEY FILE` on Windows | Run the `icacls` command from section 10.3. |
| Warning `NODE_TLS_REJECT_UNAUTHORIZED=0 is set` | Your PC has an environment variable that disables HTTPS certificate checks for all Node programs. Remove it (System Properties → Environment Variables) unless a corporate proxy needs it. Never set it on the server. |

## 14. Sharing one bot with friends (run it on any PC)

Use this when you want **one bot** (one name in your server) that any trusted friend can start from
their own PC when yours is off. The cloud setup (sections 9–11) is better if you can get it, because
the bot then stays online by itself.

**The rule: only one person runs the bot at a time.** Discord lets two computers log in with the
same token, and then both answer every command (duplicate messages, "interaction failed" errors).
Agree in your friend group who runs it, for example by posting "I'm running KINGSROCK now" in a channel.

**The bot token is the key to the bot.** Share it only with people you trust, and only privately
(never in a public channel). If someone stops being trusted, reset the token in the Developer Portal
(Bot > Reset Token) and give the new one to the others.

### Owner: share the code (once)

Pick one way to get the code to your friends. **None of these include your token.**

- **Private GitHub repo** (best for updates): friends use **Code, then Download ZIP** (no Git needed), or `git clone`.
- **A file:** run this and send `kingsrock.tgz` (Google Drive, a DM, a USB stick):
  ```powershell
  PS> cd H:ppKINGSROCK
  PS> tar --exclude=kingsrock/node_modules --exclude=kingsrock/.env --exclude=kingsrock/data -czf kingsrock.tgz kingsrock
  ```

Then **privately** send each friend the bot token (Developer Portal, Bot, Reset Token). That is the only
secret they need. Slash commands are already registered with Discord, so friends register nothing.

### Friend: what to do (about 3 minutes, no technical knowledge needed)

1. Get the code and extract it (ZIP: right-click, Extract All).
2. Open the `kingsrock` folder and **double-click `start.bat`**.

That's all. On the first run, `start.bat` does everything by itself and shows what it's doing:

| Step | What happens |
|---|---|
| Node.js | Installed automatically if missing (Windows may ask "Do you want to allow this app to make changes?": click **Yes**) |
| FFmpeg | Installed automatically if missing |
| yt-dlp | Installed automatically if YouTube is turned on |
| Bot packages | Downloaded automatically (about 1 minute) |
| Settings | It asks you to **paste the bot token** (right-click pastes in the window), then asks whether to turn on YouTube |
| Start | The bot starts. **Leave the window open.** |

The next times: double-click `start.bat` and it starts right away.

**Requirements:** Windows 10 or 11 with an internet connection. The automatic installs use `winget`,
which comes with current Windows. If an install fails, `start.bat` says which program to install by hand.

**Wrong token?** Delete the file named `.env` in the `kingsrock` folder and double-click `start.bat` again.
To **stop** the bot, press Ctrl+C or close the window.

### Rules for sharing

- **Only one person runs the bot at a time**, because two copies answer every command twice.
- Share the token only with people you trust, and only in private messages.
- **Updating:** send or download the new code and extract it over the old folder. The `.env` file (their token) and `node_modules` stay.

## Every time after that

Double-click `start.bat` and leave the window open. Press **Ctrl+C** to stop the bot, or just close the
window. The bot is only online while that window is open and the PC is on.

If `start.bat` stops with a message, read it: it says what is missing. It never fails silently.
