#!/usr/bin/env bash
# =====================================================================
#  KINGSROCK one-time server setup for Ubuntu 22.04 / 24.04
#  (Oracle Cloud Always Free: Ampere A1 arm64 or E2.1.Micro x86_64)
#
#  Run from the uploaded project folder:
#     cd ~/kingsrock && sudo bash deploy/install-ubuntu.sh
#     add --with-youtube to also install yt-dlp (see SETUP.md, YouTube)
#
#  What it does (idempotent, safe to re-run):
#    1. installs FFmpeg, git, curl and Node.js 24 LTS
#    2. adds a 1 GB swap file on machines with < 2 GB RAM
#    3. creates a locked-down "kingsrock" system user
#    4. copies the app to /opt/kingsrock and installs dependencies
#    5. creates /etc/kingsrock/kingsrock.env (chmod 600) for your secrets
#    6. installs and enables the systemd service
# =====================================================================
set -euo pipefail

APP_DIR=/opt/kingsrock
ENV_DIR=/etc/kingsrock
ENV_FILE=$ENV_DIR/kingsrock.env
NODE_MAJOR=24
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo bash deploy/install-ubuntu.sh"; exit 1; fi
echo "==> KINGSROCK setup from $SRC_DIR"

echo "==> Installing system packages (ffmpeg, git, curl)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ffmpeg git curl ca-certificates gnupg

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  echo "==> Installing Node.js $NODE_MAJOR LTS (NodeSource)…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi
echo "    node $(node -v), npm $(npm -v)"
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libopus || { echo "FFmpeg has no libopus encoder!"; exit 1; }
echo "    $(ffmpeg -hide_banner -version | head -n1) (libopus OK)"

if [[ " $* " == *" --with-youtube "* ]]; then
  # Official standalone build (bundles Python). KINGSROCK passes its own Node.js
  # to yt-dlp as the JavaScript runtime YouTube now requires.
  case "$(uname -m)" in
    x86_64) YTDLP_ASSET=yt-dlp_linux ;;
    aarch64|arm64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;;
    *) echo "Unsupported CPU for yt-dlp standalone: $(uname -m)"; exit 1 ;;
  esac
  echo "==> Installing yt-dlp ($YTDLP_ASSET) to /usr/local/bin/yt-dlp…"
  curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP_ASSET" -o /usr/local/bin/yt-dlp
  chmod 755 /usr/local/bin/yt-dlp
  echo "    yt-dlp $(/usr/local/bin/yt-dlp --version)"
  # YouTube changes often; yt-dlp must stay current. Weekly self-update.
  cat > /etc/cron.weekly/kingsrock-yt-dlp <<'CRON'
#!/bin/sh
/usr/local/bin/yt-dlp -U >/var/log/kingsrock-yt-dlp-update.log 2>&1
CRON
  chmod 755 /etc/cron.weekly/kingsrock-yt-dlp
fi

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ $MEM_MB -lt 2000 ]] && ! swapon --show | grep -q '/swapfile'; then
  echo "==> ${MEM_MB} MB RAM: adding 1 GB swap so npm installs don't run out of memory…"
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! id kingsrock >/dev/null 2>&1; then
  echo "==> Creating system user 'kingsrock'…"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin kingsrock
fi

echo "==> Copying application to $APP_DIR…"
mkdir -p "$APP_DIR/data"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  # Copy code only: never copy a local .env, node_modules or runtime data.
  tar -C "$SRC_DIR" --exclude=node_modules --exclude=.env --exclude='.env.*' --exclude=data --exclude=.git -cf - . | tar -C "$APP_DIR" -xf -
  cp "$SRC_DIR/.env.example" "$APP_DIR/.env.example"
fi
cd "$APP_DIR"
echo "==> Installing production dependencies…"
npm ci --omit=dev --no-audit --no-fund
chown -R kingsrock:kingsrock "$APP_DIR"
chmod 750 "$APP_DIR" "$APP_DIR/data"

mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE from .env.example…"
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' "$ENV_FILE"
  CREATED_ENV=1
fi
chown root:kingsrock "$ENV_FILE"
chmod 640 "$ENV_FILE"

echo "==> Installing systemd service…"
cp "$APP_DIR/deploy/kingsrock.service" /etc/systemd/system/kingsrock.service
if [[ $MEM_MB -lt 1500 ]]; then
  # Tiny VM (e.g. 1 GB E2.1.Micro): lower the memory ceiling.
  sed -i 's/^MemoryHigh=.*/MemoryHigh=300M/; s/^MemoryMax=.*/MemoryMax=450M/' /etc/systemd/system/kingsrock.service
fi
systemctl daemon-reload
systemctl enable kingsrock >/dev/null

echo
echo "================================================================="
if [[ "${CREATED_ENV:-0}" == "1" ]] || ! grep -q '^DISCORD_TOKEN=.\+' "$ENV_FILE"; then
  echo " NEXT STEPS"
  echo "  1. Add your secrets:      sudo nano $ENV_FILE"
  echo "     (DISCORD_TOKEN and DISCORD_CLIENT_ID; leave DISCORD_GUILD_ID empty)"
  echo "  2. Check the setup:       sudo -u kingsrock env KINGSROCK_ENV_FILE=$ENV_FILE node $APP_DIR/src/doctor.js"
  echo "  3. Register commands:     sudo -u kingsrock env KINGSROCK_ENV_FILE=$ENV_FILE node $APP_DIR/src/deploy-commands.js --global"
  echo "  4. Start KINGSROCK:       sudo systemctl start kingsrock"
  echo "  5. Watch the logs:        journalctl -u kingsrock -f"
else
  systemctl restart kingsrock
  echo " KINGSROCK (re)started. Logs: journalctl -u kingsrock -f"
fi
echo "================================================================="
