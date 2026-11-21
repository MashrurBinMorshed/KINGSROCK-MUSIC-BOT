'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { silentLogger } = require('../utils/logger');

const DEFAULTS = Object.freeze({
  announce: true, // post "Now Playing" messages
  djRoleId: null, // if set, only this role (and admins) can control playback
  defaultVolume: null, // null = use DEFAULT_VOLUME from config
});

/**
 * Per-guild settings managed with /settings by server admins.
 *
 * Stored in a small JSON file (no database needed). Writes are debounced and
 * atomic (write temp file, then rename), so a crash can't corrupt the file.
 */
class GuildSettingsStore {
  constructor({ file, logger = silentLogger, saveDelayMs = 1000 } = {}) {
    this.file = file || null;
    this.logger = logger;
    this.saveDelayMs = saveDelayMs;
    this.data = new Map();
    this.saveTimer = null;
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [guildId, value] of Object.entries(raw || {})) {
        if (/^\d{17,20}$/.test(guildId) && value && typeof value === 'object') {
          this.data.set(guildId, sanitize(value));
        }
      }
      this.logger.info(`Loaded settings for ${this.data.size} server(s).`);
    } catch (err) {
      this.logger.error(`Could not read ${this.file}; starting with default settings.`, err);
    }
    return this;
  }

  get(guildId) {
    return { ...DEFAULTS, ...(this.data.get(guildId) || {}) };
  }

  update(guildId, patch) {
    const next = sanitize({ ...this.get(guildId), ...patch });
    this.data.set(guildId, next);
    this.scheduleSave();
    return { ...DEFAULTS, ...next };
  }

  delete(guildId) {
    if (this.data.delete(guildId)) this.scheduleSave();
  }

  scheduleSave() {
    if (!this.file) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
    this.saveTimer.unref();
  }

  /** Writes pending changes now (called on shutdown). */
  flush() {
    if (!this.file) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger.error(`Could not save ${this.file}:`, err);
    }
  }
}

function sanitize(value) {
  const out = {};
  if (typeof value.announce === 'boolean') out.announce = value.announce;
  if (value.djRoleId === null || /^\d{17,20}$/.test(String(value.djRoleId))) out.djRoleId = value.djRoleId === null ? null : String(value.djRoleId);
  if (value.defaultVolume === null || (Number.isInteger(value.defaultVolume) && value.defaultVolume >= 1 && value.defaultVolume <= 100)) {
    out.defaultVolume = value.defaultVolume;
  }
  return out;
}

module.exports = { GuildSettingsStore, DEFAULTS };
