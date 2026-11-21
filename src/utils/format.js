'use strict';

/** Formats milliseconds as m:ss or h:mm:ss. Returns "LIVE" for live, "--:--" for unknown. */
function formatDuration(ms, { live = false } = {}) {
  if (live) return 'LIVE';
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Parses "123", "123.4", "2:03", "1:02:03" into milliseconds (or null). */
function parseDurationToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null;
  const str = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number(str) * 1000);
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(str)) {
    const parts = str.split(':').map(Number);
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    return Math.round(seconds * 1000);
  }
  return null;
}

/** Truncates text to `max` characters with an ellipsis. */
function truncate(text, max) {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** A text progress bar, e.g. ▰▰▰▰▱▱▱▱▱▱ */
function progressBar(positionMs, durationMs, size = 16) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '▰'.repeat(size);
  const ratio = Math.min(Math.max(positionMs / durationMs, 0), 1);
  const filled = Math.round(ratio * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

/** Converts a filename / URL path segment into a readable title. */
function titleFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    const cleaned = last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+]+/g, ' ').trim();
    return cleaned || url.hostname;
  } catch {
    return 'Unknown track';
  }
}

module.exports = { formatDuration, parseDurationToMs, truncate, progressBar, titleFromUrl };
