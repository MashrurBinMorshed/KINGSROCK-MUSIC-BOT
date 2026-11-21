'use strict';

/**
 * Optional PM2 config, for hosts without systemd (systemd is recommended on
 * Linux VMs). Usage:
 *   npm install -g pm2
 *   pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup
 * Secrets still come from .env (or KINGSROCK_ENV_FILE); never put them here.
 */
module.exports = {
  apps: [
    {
      name: 'kingsrock',
      script: 'src/index.js',
      cwd: `${__dirname}/..`,
      instances: 1, // exactly one instance per bot token
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      kill_timeout: 15000, // time for graceful shutdown
      max_memory_restart: '450M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
