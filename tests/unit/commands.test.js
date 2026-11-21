'use strict';

/**
 * Validates the slash command payload against Discord's registration rules
 * (offline). A payload that passes here is accepted by PUT /applications/.../commands.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');
const { loadCommands, commandPayload } = require('../../src/commands');

const NAME = /^[-_\p{Ll}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
const REQUIRED = ['play', 'pause', 'resume', 'skip', 'stop', 'leave', 'queue', 'remove', 'clear', 'shuffle', 'loop', 'nowplaying', 'volume', 'help'];

function checkOptions(options, path, problems) {
  let seenOptional = false;
  if (options.length > 25) problems.push(`${path}: more than 25 options`);
  const names = new Set();
  for (const o of options) {
    if (!NAME.test(o.name)) problems.push(`${path}.${o.name}: invalid name`);
    if (names.has(o.name)) problems.push(`${path}.${o.name}: duplicate option`);
    names.add(o.name);
    if (!o.description || o.description.length > 100) problems.push(`${path}.${o.name}: description must be 1-100 chars`);
    if (o.type === ApplicationCommandOptionType.Subcommand) {
      checkOptions(o.options || [], `${path}.${o.name}`, problems);
      continue;
    }
    if (o.required && seenOptional) problems.push(`${path}.${o.name}: required option after optional`);
    if (!o.required) seenOptional = true;
    if (o.choices) {
      if (o.choices.length > 25) problems.push(`${path}.${o.name}: more than 25 choices`);
      for (const c of o.choices) if (!c.name || c.name.length > 100) problems.push(`${path}.${o.name}: choice name length`);
    }
  }
}

test('all spec commands exist (plus search and settings)', () => {
  const names = [...loadCommands().keys()];
  for (const n of REQUIRED) assert.ok(names.includes(n), `missing /${n}`);
  assert.ok(names.includes('search'));
  assert.ok(names.includes('settings'));
});

test('payload follows Discord command registration limits', () => {
  const payload = commandPayload();
  const problems = [];
  assert.ok(payload.length <= 100, 'max 100 global chat commands');
  for (const cmd of payload) {
    if (!NAME.test(cmd.name)) problems.push(`${cmd.name}: invalid name`);
    if (!cmd.description || cmd.description.length > 100) problems.push(`${cmd.name}: description must be 1-100 chars`);
    checkOptions(cmd.options || [], cmd.name, problems);
    const size = cmd.name.length + cmd.description.length + JSON.stringify(cmd.options || []).length;
    if (size > 8000) problems.push(`${cmd.name}: command too large`);
    // Guild-only: no DMs
    assert.deepEqual(cmd.contexts, [0], `${cmd.name} must be guild-only`);
  }
  assert.deepEqual(problems, []);
});

test('every command module has execute() and a help category', () => {
  for (const [name, mod] of loadCommands()) {
    assert.equal(typeof mod.execute, 'function', name);
    assert.ok(['Playback', 'Queue', 'Information', 'Admin'].includes(mod.category), name);
  }
});

test('/settings is hidden from members without Manage Server', () => {
  const settings = commandPayload().find((c) => c.name === 'settings');
  assert.equal(settings.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('/volume and /remove enforce numeric ranges at the Discord level', () => {
  const payload = commandPayload();
  const volume = payload.find((c) => c.name === 'volume').options[0];
  assert.equal(volume.min_value, 1);
  assert.equal(volume.max_value, 100);
  const remove = payload.find((c) => c.name === 'remove').options[0];
  assert.equal(remove.min_value, 1);
  assert.equal(remove.required, true);
  const loop = payload.find((c) => c.name === 'loop').options[0];
  assert.deepEqual(loop.choices.map((c) => c.value), ['off', 'track', 'queue']);
});
