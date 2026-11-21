'use strict';

/**
 * All slash commands. Add a new command by creating a file in this folder
 * and listing it here; `npm run register` publishes the change to Discord.
 */
const COMMAND_MODULES = [
  require('./play'),
  require('./search'),
  require('./pause'),
  require('./resume'),
  require('./skip'),
  require('./stop'),
  require('./leave'),
  require('./queue'),
  require('./remove'),
  require('./clear'),
  require('./shuffle'),
  require('./loop'),
  require('./nowplaying'),
  require('./volume'),
  require('./help'),
  require('./settings'),
];

/** @returns {Map<string, object>} command name -> module */
function loadCommands() {
  const map = new Map();
  for (const mod of COMMAND_MODULES) {
    const name = mod.data.name;
    if (map.has(name)) throw new Error(`Duplicate command name: ${name}`);
    map.set(name, mod);
  }
  return map;
}

/** JSON payload for the Discord API. */
function commandPayload(commands = loadCommands()) {
  return [...commands.values()].map((c) => c.data.toJSON());
}

module.exports = { loadCommands, commandPayload };
