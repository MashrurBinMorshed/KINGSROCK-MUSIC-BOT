'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Prevents two KINGSROCK processes from running from the same directory at
 * the same time (two processes with one token = duplicate replies and voice
 * fights). This guards one machine only. Across machines, use a separate bot
 * application (token) for development, see SETUP.md.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by another user
  }
}

function acquireLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'kingsrock.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
      throw new Error(`Another KINGSROCK instance is already running (PID ${pid}). Stop it first, or delete ${file} if that process is not KINGSROCK.`);
    }
  }
  fs.writeFileSync(file, String(process.pid));
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
}

module.exports = { acquireLock, isAlive };
