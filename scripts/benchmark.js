'use strict';
// Charge synthétique des vrais moteurs Node/SQLite, sans FXServer ni appel IA.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {performance, monitorEventLoopDelay} = require('node:perf_hooks');
const {PersistentDatabase} = require('../server/database');
const {ProfileStore} = require('../server/profiles');
const {MemoryStore} = require('../server/core');
const root = path.resolve(__dirname, '..');
const options = {players: 128, activePeds: 200, profiles: 5000, ticks: 100, output: path.join(root, 'work', 'benchmark.json')};
const names = {'--players': 'players', '--active-peds': 'activePeds', '--profiles': 'profiles', '--ticks': 'ticks', '--output': 'output'};
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/benchmark.js [--players 128] [--active-peds 200] [--profiles 5000] [--ticks 100] [--output /chemin/resultat.json]');
  process.exit(0);
}
for (let index = 0; index < args.length; index += 2) {
  const name = names[args[index]], value = args[index + 1];
  if (!name || value === undefined) throw new Error(`Argument inconnu ou incomplet: ${args[index]}`);
  options[name] = name === 'output' ? path.resolve(value) : Number(value);
}
for (const name of ['players', 'activePeds', 'profiles', 'ticks']) {
  if (!Number.isSafeInteger(options[name]) || options[name] < 1 || options[name] > 100000) throw new Error(`Nombre invalide: ${name}`);
}
if (options.activePeds > options.profiles) throw new Error('Le nombre de peds actifs ne peut pas dépasser les profils persistants');
const measurements = {};
let peakRssBytes = process.memoryUsage().rss;
function sampleMemory() { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }
function measured(name, fn) {
  const begin = performance.now(), cpu = process.cpuUsage();
  const result = fn();
  const elapsed = process.cpuUsage(cpu);
  measurements[name] = {wallMs: performance.now() - begin, cpuMs: (elapsed.user + elapsed.system) / 1000};
  sampleMemory();
  return result;
}
function statistics(samples) {
  const ordered = [...samples].sort((a, b) => a - b), percentile = fraction => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] || 0;
  return {samples: ordered.length, meanMs: ordered.reduce((sum, item) => sum + item, 0) / Math.max(1, ordered.length), p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: ordered.at(-1) || 0};
}
function sample(fn, count) {
  const values = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now(); fn(index); values.push(performance.now() - start);
    if (index % 100 === 0) sampleMemory();
  }
  return statistics(values);
}
const tickPause = () => new Promise(resolve => setImmediate(resolve));
async function run() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fivemai-benchmark-'));
  const delay = monitorEventLoopDelay({resolution: 10});
  const overallCpu = process.cpuUsage(), overallBegin = performance.now();
  let db;
  delay.enable();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    db = measured('databaseOpen', () => new PersistentDatabase(path.join(temporary, 'city.sqlite'), {maxRecords: Math.max(100000, options.profiles * 4), maxBytes: 256 * 1024 * 1024}));
    measured('profileSeed', () => db.transaction(() => {
      for (let index = 0; index < options.profiles; index++) {
        const id = `bench_npc_${index}`;
        db.set('profiles', id, {id, firstName: `Prénom${index}`, lastName: 'Benchmark', age: 22 + index % 44, model: 123, sex: index % 2 ? 'female' : 'male', jobId: 'resident', job: 'Habitant', voice: index % 2 ? 'marin' : 'cedar', language: 'Français courant', personality: 'Calme, observateur et loyal.', story: `Identité synthétique ${index}, habitant de Los Santos, proche de sa famille, souhaite maintenir son activité et retrouver ses voisins. `.repeat(4), goals: ['travailler', 'rencontrer ses voisins'], habits: ['travail', 'repos'], appearanceVersion: 1});
      }
    }));
    const profiles = measured('profileLoad', () => new ProfileStore(path.join(temporary, 'profiles.json'), {db, maxProfiles: options.profiles}));
    const memory = new MemoryStore(path.join(temporary, 'memory.json'), {db});
    measurements.profileRead = sample(index => profiles.get(`bench_npc_${index % options.profiles}`), options.players * 10);
    measurements.memoryWrite = sample(index => memory.add(`license:benchmark_${index % options.players}`, `bench_npc_${index % options.activePeds}`, 'conversation', `Déclaration synthétique numéro ${index}: je reviendrai aider le quartier.`, {source: 'benchmark_player', provenance: 'player_declaration'}), options.players * 3);
    measurements.memoryRead = sample(index => memory.get(`license:benchmark_${index % options.players}`, `bench_npc_${index % options.activePeds}`), options.players * 10);
    const players = Array.from({length: options.players}, (_, index) => ({src: index + 1, player: `license:benchmark_${index}`, bucket: index % 4, position: {x: (index % 16) * 80, y: Math.floor(index / 16) * 80, z: 30}}));
    const characters = Array.from({length: options.activePeds}, (_, index) => {
      const position = players[index % players.length].position;
      return {id: `bench_npc_${index}`, coords: {...position, x: position.x + 5, y: position.y + 5}, routine: [{id: 'work', start: 0, end: 1440, destination: {...position, x: position.x + 15, y: position.y + 15}, scenario: 'WORLD_HUMAN_STAND_MOBILE'}]};
    });
    const positions = new Map(characters.map((character, index) => [character.id, {exists: true, position: {...character.coords}, bucket: players[index % players.length].bucket, health: 200, alive: true, busy: false, model: 123, entity: index + 1000, netId: index + 2000}]));
    let simulatedNow = 1770000000000, dispatches = 0;
    // The API exercised here is the production module. Entity snapshots and
    // dispatch receipts are synthetic; this does not time GTA native tasks.
    const {CitySimulation} = require('../server/simulation');
    const simulation = new CitySimulation({db, characters, npcSnapshot: id => positions.get(id), dispatch: () => {dispatches++; return true;}, config: {nearRadius: 120, maxDetailed: options.activePeds, perPlayer: options.activePeds, maxDispatchPerTick: options.activePeds}, now: () => simulatedNow, minuteOfDay: () => 600});
    const tickValues = [], cpu = process.cpuUsage();
    let lastMetrics;
    for (let index = 0; index < options.ticks; index++) {
      simulatedNow += 1000;
      const start = performance.now(); lastMetrics = simulation.tick(players); tickValues.push(performance.now() - start);
      sampleMemory(); await tickPause();
    }
    const tickCpu = process.cpuUsage(cpu);
    measurements.simulation = {...statistics(tickValues), cpuMs: (tickCpu.user + tickCpu.system) / 1000, dispatches, lastMetrics};
    // Public knowledge ingestion is exercised through the production city
    // engine. Witness selection here is synthetic and is not a line-of-sight
    // or native-entity validation benchmark.
    let observations = 0;
    measurements.perceptionPublicEventIngestion = sample(index => {
      const ok = simulation.recordPublicEvent({id: `bench_event_${index}`, source: 'server_public', visibility: 'public', description: `Service benchmark ${index}`, witnesses: [characters[index % characters.length].id]});
      if (!ok) throw new Error('Événement synthétique refusé');
      observations++;
    }, options.players);
    measurements.perceptionPublicEventIngestion.accepted = observations;
    measurements.perceptionPublicEventIngestion.scope = 'Événements publics et connaissances, témoins synthétiques; validation géométrique/GTA non mesurée';
    const {PerceptionEngine} = require('../server/perception');
    const perception = new PerceptionEngine({db, memory, identity: src => players[src - 1]?.player, snapshot: src => players[src - 1], npcSnapshot: id => positions.get(id), now: () => simulatedNow, onPublic: event => simulation.recordPublicEvent(event)});
    perception.sample(characters.map(character => character.id));
    let observed = 0;
    measurements.perceptionObservation = sample(index => {
      const targetIndex = index % characters.length, src = targetIndex % players.length + 1;
      if (!perception.observe(src, characters[targetIndex].id, {aimed: true, targetNetId: positions.get(characters[targetIndex].id).netId})) throw new Error('Observation synthétique refusée');
      observed++;
    }, options.players * 10);
    measurements.perceptionObservation.accepted = observed;
    measurements.perceptionObservation.scope = 'Filtres réels identité/distance/bucket et provenance; instantanés serveur synthétiques, aucune ligne de vue GTA mesurée';
    let published = 0;
    measurements.perceptionPublication = sample(index => {
      const targetIndex = index % characters.length, src = targetIndex % players.length + 1;
      const record = perception.publish({id: `bench_perception_${index}`, actorSource: src, npcId: characters[targetIndex].id, type: 'service', visibility: 'public', description: `Service validé benchmark ${index}`, witnesses: [characters[targetIndex].id], source: 'benchmark_server'});
      if (!record) throw new Error('Publication synthétique refusée');
      published++;
    }, options.players);
    measurements.perceptionPublication.accepted = published;
    measurements.perceptionPublication.scope = 'Publication transactionnelle, mémoire, relation et ingestion publique réelles; preuve gameplay synthétique';
    measured('backup', () => db.backup(path.join(temporary, 'backup.sqlite')));
    const storageStatistics = db.stats();
    db.close(); db = null;
    await new Promise(resolve => setTimeout(resolve, 20));
    const storageBytes = fs.statSync(path.join(temporary, 'city.sqlite')).size;
    const totalCpu = process.cpuUsage(overallCpu);
    const result = {kind: 'node-sqlite-synthetic-workload', generatedAt: new Date().toISOString(), environment: {node: process.version, platform: process.platform, architecture: process.arch, cpuModel: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, quotaUnknown: true}, workload: options, measurements, totals: {wallMs: performance.now() - overallBegin, cpuMs: (totalCpu.user + totalCpu.system) / 1000, storageBytes, storageStatistics, peakRssBytes, eventLoopDelayMaxMs: Number.isFinite(delay.max) ? delay.max / 1e6 : null}, limits: ['Aucun FXServer, native GTA, WebRTC réseau ou appel OpenAI.', 'Joueurs, positions, peds et accusés de tâches synthétiques; moteurs et SQLite réels.', 'Charge mono-processus locale; quotas hôte inconnus; aucun engagement FPS ou capacité serveur.', 'Le pic de retard de boucle inclut les écritures synchrones et le peuplement initial.']};
    fs.mkdirSync(path.dirname(options.output), {recursive: true}); fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    delay.disable(); if (db) db.close(); fs.rmSync(temporary, {recursive: true, force: true});
  }
}
run().catch(error => {console.error(error.stack); process.exitCode = 1;});
