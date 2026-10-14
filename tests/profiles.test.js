const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ProfileStore}=require('../server/profiles');
test('ambient characters have unique persisted identities and biographies',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-profiles-'));
 try{const file=path.join(dir,'profiles.json'),jobs=[{id:'mechanic',label:'Mécanicien'}];const s=new ProfileStore(file,{jobs});const a=s.create(123,'mechanic'),b=s.create(123,'mechanic');assert.notEqual(a.id,b.id);assert.notEqual(a.story,b.story);assert.equal(a.jobId,'mechanic');assert.ok(a.firstName&&a.lastName&&a.personality&&a.voice);assert.deepEqual(new ProfileStore(file).get(a.id),a);assert.equal(s.get('toString'),null);}finally{fs.rmSync(dir,{recursive:true});}
});
test('profile cap prevents unlimited creation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-profiles-'));
 try{const s=new ProfileStore(path.join(dir,'profiles.json'),{maxProfiles:1});s.create(123);assert.throws(()=>s.create(123),/Limite/);}finally{fs.rmSync(dir,{recursive:true});}
});

test('assigning a job preserves identity and persists the new role',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-profiles-'));
 try{const file=path.join(dir,'profiles.json'),s=new ProfileStore(file),p=s.create(123);s.assignJob(p.id,'mechanic','Mécanicien');const restored=new ProfileStore(file).get(p.id);assert.equal(restored.jobId,'mechanic');assert.equal(restored.firstName,p.firstName);assert.match(restored.story,/changé de métier/);}finally{fs.rmSync(dir,{recursive:true});}
});

test('voice and model language persist across repeated encounters',()=>{
 const {modelHash}=require('../server/core');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-identity-'));
 try{
  const file=path.join(dir,'profiles.json'),s=new ProfileStore(file),gang=s.create(modelHash('g_f_y_ballas_01'),undefined,'female');
  assert.equal(gang.sex,'female');assert.equal(gang.archetypeId,'gang');assert.match(gang.language,/argot/);assert.ok(['marin','coral','shimmer'].includes(gang.voice));
  const fresh=new ProfileStore(file),restored=fresh.ensureAppearance(gang.id,'male');assert.deepEqual(restored,gang);
  const mechanic=s.create(modelHash('s_m_y_xmech_01'),undefined,'male');assert.equal(mechanic.archetypeId,'mechanic');assert.ok(['cedar','ash','echo'].includes(mechanic.voice));
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('legacy profile migration preserves name, biography, profession and identifier',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-legacy-'));
 try{const file=path.join(dir,'profiles.json'),legacy={id:'npc-old',firstName:'Camille',lastName:'Morel',model:123,jobId:'mechanic',story:'Son histoire',voice:'cedar'};fs.writeFileSync(file,JSON.stringify({'npc-old':legacy}));const s=new ProfileStore(file),p=s.ensureAppearance('npc-old','female');for(const key of ['id','firstName','lastName','jobId','story'])assert.equal(p[key],legacy[key]);assert.equal(p.sex,'female');assert.equal(p.appearanceVersion,1);assert.ok(['marin','coral','shimmer'].includes(p.voice));assert.equal(new ProfileStore(file).get(p.id).voice,p.voice);}finally{fs.rmSync(dir,{recursive:true});}
});
test('custom ped archetype maps by signed hash and custom voices are used',()=>{
 const {appearance,enrichFixed}=require('../server/archetypes'),{modelHash}=require('../server/core');
 const definitions=[{id:'custom',models:['custom_ped'],register:'Langage marin',temperament:'calm'}];const p=appearance(modelHash('custom_ped')|0,'female',definitions,{female:['marin']});assert.equal(p.archetypeId,'custom');assert.deepEqual(p.voiceChoices,['marin']);
 const fixed=enrichFixed({model:'s_f_y_cop_01',voice:'coral'},{});assert.equal(fixed.sex,'female');assert.equal(fixed.archetypeId,'police');assert.equal(fixed.voice,'coral');
});

test('a custom model with unknown configured sex accepts the actual native sex hint',()=>{
 const {enrichFixed}=require('../server/archetypes');const male=enrichFixed({model:'custom_character',sex:'unknown'}, {}, 'male');assert.equal(male.sex,'male');assert.equal(male.voice,'cedar');const female=enrichFixed({model:'custom_character'}, {}, 'female');assert.equal(female.sex,'female');assert.equal(female.voice,'marin');
});

test('fixed SQLite NPC identities preserve customized biography and voice across restart',()=>{
 const {PersistentDatabase}=require('../server/database'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-fixed-sqlite-'));let db;
 try{
  const file=path.join(dir,'city.sqlite');db=new PersistentDatabase(file);let profiles=new ProfileStore(null,{db});
  const fixed={id:'marcel',model:'s_m_y_xmech_01',firstName:'Marcel',lastName:'Dubois',story:'Origine initiale',voice:'cedar',jobId:'mechanic',job:'Mécanicien'};
  profiles.upsertFixed(fixed);const customized=profiles.get('marcel');customized.firstName='Marc';customized.story='Histoire éditée par un administrateur';customized.voice='echo';db.set('profiles','marcel',customized);db.close();
  db=new PersistentDatabase(file);profiles=new ProfileStore(null,{db});const restored=profiles.upsertFixed({...fixed,firstName:'Remplacé',story:'Nouvelle configuration',voice:'ash'});assert.equal(restored.firstName,'Marc');assert.equal(restored.story,'Histoire éditée par un administrateur');assert.equal(restored.voice,'echo');assert.equal(restored.id,'marcel');assert.equal(profiles.get('marcel').fixed,true);
 }finally{db?.close();fs.rmSync(dir,{recursive:true});}
});
test('female numeric models and custom sex overrides choose coherent persisted voices',()=>{
 const {modelHash}=require('../server/core'),{sexForModel}=require('../server/archetypes');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-sex-'));
 try{
  assert.equal(sexForModel(modelHash('a_f_y_hipster_01'),'male'),'female');
  const store=new ProfileStore(path.join(dir,'profiles.json'),{sexOverrides:{custom_ped:'female'}});const custom=store.create(modelHash('custom_ped'),'resident','male');assert.equal(custom.sex,'female');assert.ok(['marin','coral','shimmer'].includes(custom.voice));assert.equal(new ProfileStore(store.file).get(custom.id).voice,custom.voice);
  const official=store.create(modelHash('s_f_y_cop_01')|0,undefined,'male');assert.equal(official.sex,'female');assert.equal(official.archetypeId,'police');
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('profile JSON keys cannot access Object prototype properties',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-prototype-'));
 try{const store=new ProfileStore(path.join(dir,'profiles.json'));assert.equal(store.get('__proto__'),null);assert.equal(store.get('constructor'),null);assert.throws(()=>store.upsertFixed({id:'bad\nkey'}),/Invalid NPC/);}finally{fs.rmSync(dir,{recursive:true});}
});

test('multiple stores share the persistent profile cap',()=>{
 const {PersistentDatabase}=require('../server/database'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-shared-cap-'));let db;
 try{db=new PersistentDatabase(path.join(dir,'city.sqlite'));const first=new ProfileStore(null,{db,maxProfiles:1}),second=new ProfileStore(null,{db,maxProfiles:1});first.create('s_m_y_xmech_01');assert.throws(()=>second.create('s_m_y_xmech_01'),/Limite/);}finally{db?.close();fs.rmSync(dir,{recursive:true});}
});
