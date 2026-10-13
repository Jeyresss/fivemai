'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? files(target) : entry.isFile() ? [target] : [];
  });
}
const javascript = ['server', 'web', 'tests', 'scripts'].flatMap(dir => files(path.join(root, dir))).filter(file => /\.(?:js|cjs|mjs)$/.test(file));
let failures = 0;
for (const file of javascript) {
  const result = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  if (result.status !== 0) {
    failures++;
    console.error(result.stderr || result.error?.message || `Vérification impossible: ${file}`);
  }
}
let luaCount = 0;
try {
  const {lua, lauxlib, to_luastring, to_jsstring} = require('fengari');
  const luaFiles = [...files(path.join(root, 'client')), ...files(path.join(root, 'server')), path.join(root, 'fxmanifest.lua')].filter(file => file.endsWith('.lua') && fs.existsSync(file));
  for (const file of luaFiles) {
    const state = lauxlib.luaL_newstate();
    try {
      const result = lauxlib.luaL_loadbuffer(state, to_luastring(fs.readFileSync(file, 'utf8')), null, to_luastring(file));
      if (result !== lua.LUA_OK) {
        failures++;
        console.error(`${path.relative(root, file)}: ${to_jsstring(lua.lua_tostring(state, -1))}`);
      }
      luaCount++;
    } finally { lua.lua_close(state); }
  }
} catch (error) {
  if (error.code === 'MODULE_NOT_FOUND' && /fengari/.test(error.message)) {
    console.warn('Analyse Lua non exécutée: installer les dépendances de développement avec npm ci --ignore-scripts.');
  } else {
    failures++;
    console.error(error.message);
  }
}
try { JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); }
catch (error) { failures++; console.error(`config.json: ${error.message}`); }
console.log(`Syntaxe: ${javascript.length} fichiers JavaScript, ${luaCount} fichiers Lua, configuration JSON; ${failures} erreur(s).`);
process.exitCode = failures ? 1 : 0;
