'use strict';
// ZIP source reproductible sans dépendance externe ni copie de données privées.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/package.js [--output /chemin/absolu/fivemai-source.zip]');
  process.exit(0);
}
let output = path.join(root, 'work', 'packages', 'fivemai-source.zip');
if (args.length) {
  if (args.length !== 2 || args[0] !== '--output' || !path.isAbsolute(args[1]) || !args[1].endsWith('.zip')) throw new Error('Utiliser --output avec un chemin absolu terminé par .zip');
  output = path.resolve(args[1]);
}
const allowedRoots = new Set(['server', 'client', 'web', 'tests', 'scripts', 'docs', '.github']);
const allowedFiles = new Set(['README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md', 'fxmanifest.lua', 'config.json', 'package.json', 'package-lock.json', '.gitignore']);
const excluded = /(?:^|\/)(?:data|node_modules|work|logs|\.git|\.env(?:\.[^/]*)?|[^/]*\.(?:cfg|pem|key|p12|pfx)|[^/]*(?:secret|credential)[^/]*)(?:\/|$)/i;
const entries = [];
function collect(absolute, relative) {
  if (excluded.test(relative)) return;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Lien symbolique refusé dans l'archive: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) collect(path.join(absolute, name), relative ? `${relative}/${name}` : name);
  } else if (stat.isFile() && path.resolve(absolute) !== output) {
    entries.push({name: `fivemai/${relative}`, data: fs.readFileSync(absolute)});
  }
}
for (const name of fs.readdirSync(root).sort()) {
  if (allowedRoots.has(name) || allowedFiles.has(name)) collect(path.join(root, name), name);
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
function noSecret(value) {
  if (!value || typeof value !== 'object') return;
  for (const [name, item] of Object.entries(value)) {
    if (/(?:api.?key|openai.?key|password|private.?key|access.?token|client.?secret)$/i.test(name) && item) throw new Error(`Valeur privée détectée dans config.json: ${name}`);
    noSecret(item);
  }
}
noSecret(config);
for (const entry of entries) {
  const matches = entry.data.toString('utf8').match(/sk-[A-Za-z0-9_-]{20,}/g) || [];
  const fixture = ['sk', 'private', 'never', 'client'].join('-');
  if (matches.some(value => !(entry.name === 'fivemai/tests/security.test.js' && value === fixture))) throw new Error(`Une clé potentielle apparaît dans ${entry.name}; archive refusée.`);
}
const crcTable = Array.from({length: 256}, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name), data = zlib.deflateRawSync(entry.data, {level: 9}), crc = crc32(entry.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0x21, 12); // 1980-01-01: archive stable, pas l'heure locale de construction.
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26);
  local.push(header, name, data);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
  directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(entry.data.length, 24);
  directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
  central.push(directory, name);
  offset += header.length + name.length + data.length;
}
const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
if (entries.length > 65535 || offset > 0xffffffff) throw new Error('Archive trop grande pour ce format ZIP');
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, centralBytes, end]);
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, archive, {flag: 'wx'});
console.log(JSON.stringify({output, files: entries.length, bytes: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex')}, null, 2));
