'use strict';

const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { formatDuration, truncate, progressBar } = require('./format');

/** KINGSROCK brand palette: royal gold on Discord's dark theme. */
const COLORS = Object.freeze({
  brand: 0xd4af37, // gold
  success: 0x2fbf71,
  warning: 0xf0a020,
  error: 0xe0383e,
  neutral: 0x2b2d31, // blends with Discord dark mode
});

const BRAND = 'KINGSROCK';
const FOOTER = 'KINGSROCK • Esports Audio';
const SOURCE_LABELS = {
  direct: 'Direct link',
  audius: 'Audius',
  radio: 'Internet radio',
  archive: 'Internet Archive',
  jamendo: 'Jamendo',
  youtube: 'YouTube',
};
const LOOP_LABELS = { off: 'Off', track: '🔂 Track', queue: '🔁 Queue' };

let brandIconUrl = null;
/** Set once the bot is logged in, so embeds can show the bot avatar. */
function setBrandIcon(url) {
  brandIconUrl = url || null;
}

function base(color = COLORS.brand) {
  const embed = new EmbedBuilder().setColor(color).setFooter({ text: FOOTER });
  return embed;
}

function author(embed, text) {
  return embed.setAuthor(brandIconUrl ? { name: text, iconURL: brandIconUrl } : { name: text });
}

/** Escapes markdown and strips characters that would break [text](url) links. */
function safeText(text, max = 256) {
  return escapeMarkdown(truncate(String(text ?? '').replace(/[[\]]/g, ''), max));
}

function safeUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return url.replace(/\)/g, '%29').replace(/\(/g, '%28').replace(/\s/g, '%20');
}

function trackLink(track, max = 80) {
  const title = safeText(track.title, max);
  const url = safeUrl(track.url);
  return url ? `[${title}](${url})` : `**${title}**`;
}

function requesterText(track) {
  return track.requestedBy && track.requestedBy.id ? `<@${track.requestedBy.id}>` : 'Unknown';
}

function durationText(track) {
  return formatDuration(track.durationMs, { live: track.isLive });
}

function statusLabel(player) {
  switch (player.status) {
    case 'playing': return '▶ Playing';
    case 'paused': return player.pausedBy === 'alone' ? '⏸ Paused (channel empty)' : '⏸ Paused';
    case 'starting': return '⏳ Starting';
    default: return '⏹ Stopped';
  }
}

// ---------------------------------------------------------------- music

function nowPlayingEmbed(player, track = player.currentTrack, { showProgress = false } = {}) {
  const embed = author(base(), `${BRAND} • Now Playing`);
  if (!track) return embed.setColor(COLORS.neutral).setDescription('Nothing is playing. Use `/play` to start the session.');

  embed.setTitle(truncate(track.title, 250));
  const url = safeUrl(track.url);
  if (url) embed.setURL(url);
  if (track.thumbnail && /^https:\/\//i.test(track.thumbnail)) embed.setThumbnail(track.thumbnail);

  const lines = [];
  if (track.artist) lines.push(`**${safeText(track.artist, 120)}**`);
  if (showProgress && !track.isLive && track.durationMs) {
    const pos = Math.min(player.positionMs, track.durationMs);
    lines.push(`\`${formatDuration(pos)}\` ${progressBar(pos, track.durationMs)} \`${formatDuration(track.durationMs)}\``);
  } else if (showProgress && track.isLive) {
    lines.push(`🔴 **LIVE** · listening for \`${formatDuration(player.positionMs)}\``);
  }
  if (lines.length) embed.setDescription(lines.join('\n'));

  const next = player.queue.upcoming[0];
  embed.addFields(
    { name: 'Duration', value: durationText(track), inline: true },
    { name: 'Requested by', value: requesterText(track), inline: true },
    { name: 'Status', value: statusLabel(player), inline: true },
    { name: 'Source', value: SOURCE_LABELS[track.source] || track.source, inline: true },
    { name: 'Volume', value: `${player.volume}%`, inline: true },
    { name: 'Loop', value: LOOP_LABELS[player.queue.loopMode] || 'Off', inline: true },
    {
      name: `Up next${player.queue.size ? ` (${player.queue.size} in queue)` : ''}`,
      value: next ? `${trackLink(next, 70)} · \`${durationText(next)}\`` : 'Nothing queued, use `/play` to add more.',
    },
  );
  return embed;
}

function addedEmbed(tracks, { position, requester }) {
  const embed = author(base(COLORS.success), `${BRAND} • Added to Queue`);
  if (tracks.length === 1) {
    const t = tracks[0];
    embed.setDescription(`${trackLink(t)}${t.artist ? `\n${safeText(t.artist, 100)}` : ''}`);
    embed.addFields(
      { name: 'Position', value: `#${position}`, inline: true },
      { name: 'Duration', value: durationText(t), inline: true },
      { name: 'Requested by', value: requester ? `<@${requester}>` : requesterText(t), inline: true },
    );
    if (t.thumbnail && /^https:\/\//i.test(t.thumbnail)) embed.setThumbnail(t.thumbnail);
  } else {
    const preview = tracks.slice(0, 5).map((t, i) => `\`${position + i}.\` ${trackLink(t, 60)}`).join('\n');
    embed.setDescription(`Added **${tracks.length}** tracks.\n${preview}${tracks.length > 5 ? `\n… and ${tracks.length - 5} more` : ''}`);
  }
  return embed;
}

const QUEUE_PAGE_SIZE = 10;

function queueEmbed(player, page = 1) {
  const embed = author(base(), `${BRAND} • Queue`);
  const { queue } = player;
  const totalPages = Math.max(1, Math.ceil(queue.size / QUEUE_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);

  const current = queue.current;
  const parts = [];
  parts.push(current
    ? `**Now playing** · ${statusLabel(player)}\n${trackLink(current)} · \`${durationText(current)}\` · ${requesterText(current)}`
    : '**Now playing**\nNothing');

  if (queue.size) {
    const start = (p - 1) * QUEUE_PAGE_SIZE;
    const rows = queue.upcoming.slice(start, start + QUEUE_PAGE_SIZE)
      .map((t, i) => `\`${String(start + i + 1).padStart(2, ' ')}.\` ${trackLink(t, 55)} · \`${durationText(t)}\` · ${requesterText(t)}`);
    parts.push(`**Up next**\n${rows.join('\n')}`);
  } else {
    parts.push('**Up next**\nThe queue is empty. Use `/play` to add tracks.');
  }
  embed.setDescription(truncate(parts.join('\n\n'), 4000));

  const { totalMs, unknown } = queue.upcomingDuration();
  embed.addFields(
    { name: 'Tracks', value: String(queue.size), inline: true },
    { name: 'Total length', value: `${formatDuration(totalMs)}${unknown ? ` + ${unknown} live/unknown` : ''}`, inline: true },
    { name: 'Loop · Volume', value: `${LOOP_LABELS[queue.loopMode]} · ${player.volume}%`, inline: true },
  );
  embed.setFooter({ text: `${FOOTER} • Page ${p}/${totalPages}` });
  return embed;
}

function searchResultsEmbed(results, query) {
  const embed = author(base(), `${BRAND} • Search Results`);
  embed.setDescription(
    `Results for **${safeText(query, 100)}**: pick one from the menu below.\n\n${results
      .map((t, i) => `\`${i + 1}.\` ${trackLink(t, 60)}${t.artist ? ` · ${safeText(t.artist, 40)}` : ''} · \`${durationText(t)}\` · ${SOURCE_LABELS[t.source] || t.source}`)
      .join('\n')}`,
  );
  return embed;
}

// ---------------------------------------------------------------- generic

function successEmbed(text, title) {
  const embed = base(COLORS.success).setDescription(text);
  if (title) author(embed, `${BRAND} • ${title}`);
  return embed;
}

function infoEmbed(text, title) {
  const embed = base(COLORS.brand).setDescription(text);
  if (title) author(embed, `${BRAND} • ${title}`);
  return embed;
}

function warningEmbed(text, title) {
  const embed = base(COLORS.warning).setDescription(text);
  if (title) author(embed, `${BRAND} • ${title}`);
  return embed;
}

function errorEmbed(text, title = 'Error') {
  return author(base(COLORS.error), `${BRAND} • ${title}`).setDescription(`✖ ${text}`);
}

module.exports = {
  COLORS,
  BRAND,
  SOURCE_LABELS,
  setBrandIcon,
  safeText,
  safeUrl,
  trackLink,
  nowPlayingEmbed,
  addedEmbed,
  queueEmbed,
  searchResultsEmbed,
  successEmbed,
  infoEmbed,
  warningEmbed,
  errorEmbed,
  QUEUE_PAGE_SIZE,
};
