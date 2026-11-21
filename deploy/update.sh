#!/usr/bin/env bash
# Updates KINGSROCK on the server after you upload / pull new code.
#   cd ~/kingsrock && git pull        # or upload the new files
#   sudo bash deploy/update.sh        # add --register if commands changed
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/kingsrock
ENV_FILE=/etc/kingsrock/kingsrock.env

if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  tar -C "$SRC_DIR" --exclude=node_modules --exclude=.env --exclude='.env.*' --exclude=data --exclude=.git -cf - . | tar -C "$APP_DIR" -xf -
  cp "$SRC_DIR/.env.example" "$APP_DIR/.env.example"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R kingsrock:kingsrock "$APP_DIR"
cp "$APP_DIR/deploy/kingsrock.service" /etc/systemd/system/kingsrock.service
systemctl daemon-reload

if [[ "${1:-}" == "--register" ]]; then
  sudo -u kingsrock env KINGSROCK_ENV_FILE="$ENV_FILE" node "$APP_DIR/src/deploy-commands.js" --global
fi
systemctl restart kingsrock
sleep 3
systemctl --no-pager --lines=15 status kingsrock || true
