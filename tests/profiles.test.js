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
