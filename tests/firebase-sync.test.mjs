import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {emptyState,recordsFor,stateFor,mergeGuest,validateRecords,batchEntries} from '../dist/sync-model.mjs';

test('nested ingredients, photos, independent reviews and profile round trip',()=>{
 const value={...emptyState(),recipes:[{id:'r1',ingredients:[['감자',2,'개']],photo:'data:image/jpeg;base64,abc'}],reviews:{r1:[{rating:5,photo:'photo1'},{rating:4,photo:'photo2'}]},saved:['r1'],likes:['pasta'],profile:'내 키친',brandImage:'data:image/webp;base64,x'};
 assert.deepEqual(stateFor(recordsFor(value)),value);
 assert.equal([...recordsFor(value).keys()].filter(k=>k.startsWith('review-')).length,2);
});
test('guest import is idempotent and preserves existing account recipes',()=>{
 const account={...emptyState(),recipes:[{id:'same',title:'account'}],saved:['pasta']};
 const guest={...emptyState(),recipes:[{id:'same',title:'guest'},{id:'new'}],saved:['toast'],reviews:{pasta:[{rating:5,text:'맛있어요'}]}};
 const merged=mergeGuest(account,guest);assert.deepEqual(mergeGuest(merged,guest),merged);
 assert.equal(merged.recipes[0].title,'account');assert.equal(account.recipes.length,1);
});
test('UTF-8 size checks and byte-aware batch limits keep writes below document/request limits',()=>{
 assert.throws(()=>validateRecords(new Map([['big','한'.repeat(270000)]])));
 const records=new Map(Array.from({length:20},(_,i)=>['r'+i,'x'.repeat(700000)]));
 assert.equal(batchEntries(records).length,8);
 assert.equal(batchEntries(new Map(Array.from({length:500},(_,i)=>['r'+i,'x']))).length,400);
});
function harness(){
 const storage=new Map(),nodes=new Map();let value=emptyState(),writes=[],failWrite=false,delayWrite=null,readHook=null;
 const node=()=>({inert:false,children:[],replaceChildren(){this.children=[]},append(v){this.children.push(v)},setAttribute(){}});
 const getNode=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
 const remote=new Map();const sdk={
  getDocs:async ref=>{if(readHook)return readHook(ref);return{docs:[...(remote.get(ref.uid)||new Map())].map(([id,payload])=>({id,data:()=>({payload})}))}},
  collection:(_db,_users,uid)=>({uid}),doc:(_db,_users,uid,_records,key)=>({uid,key}),serverTimestamp:()=>0,
  writeBatch:()=>{const items=[];return{set:(ref,v)=>items.push([ref,v]),commit:async()=>{if(failWrite)throw Object.assign(Error('denied'),{code:'permission-denied'});if(delayWrite)await delayWrite();for(const [ref,v]of items){if(!remote.has(ref.uid))remote.set(ref.uid,new Map());remote.get(ref.uid).set(ref.key,v.payload);writes.push([ref.uid,ref.key,v.payload]);}}}},
  onAuthStateChanged:()=>{},getAuth:()=>({}),signOut:async()=>{},GoogleAuthProvider:class{}
 };
 const context=vm.createContext({Map,Set,JSON,TextEncoder,structuredClone,console,setTimeout,clearTimeout,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},document:{getElementById:getNode,querySelector:()=>getNode('header'),createElement:node},location:{hostname:'example.test'},confirm:()=>true,window:{yumstepData:{get:()=>structuredClone(value),replace:v=>{value=v},close:()=>{}},addEventListener:()=>{}},...{emptyState,recordsFor,stateFor,mergeGuest,validateRecords,batchEntries},testSdk:sdk});
 let source=fs.readFileSync(new URL('../dist/firebase-sync.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 const startup=source.lastIndexOf('lock(true);\ntry{');assert.ok(startup>0);
 source=source.slice(0,startup)+'sdk=testSdk;auth={};db={};';vm.runInContext(source,context);
 return{storage,remote,writes,nodes,get value(){return value},setFail:v=>{failWrite=v},setDelay:fn=>{delayWrite=fn},setRead:fn=>{readHook=fn},run:code=>vm.runInContext(code,context),save:v=>{value=v;context.window.yumstepCloud.persist(v)},flush:()=>vm.runInContext('flush()',context),login:uid=>vm.runInContext('loadAccount({uid:'+JSON.stringify(uid)+',displayName:"User"})',context)};
}
test('account isolation and logout restore the untouched guest workspace',async()=>{
 const h=harness();h.storage.set('yumstep-v1',JSON.stringify({...emptyState(),profile:'guest'}));
 await h.login('alice');h.save({...emptyState(),profile:'Alice',saved:['pasta']});await h.flush();
 assert.ok(h.writes.every(w=>w[0]==='alice'));assert.equal(JSON.parse(h.remote.get('alice').get('settings')).profile,'Alice');
 await h.login('bob');assert.equal(h.value.profile,'나의 키친');assert.equal(h.value.saved.length,0);
 await h.run('loadAccount(null)');assert.equal(h.value.profile,'guest');
});
test('failed writes survive reload and retry without overwriting guest data',async()=>{
 const h=harness();await h.login('alice');h.setFail(true);
 h.save({...emptyState(),profile:'Pending'});await assert.rejects(h.flush());
 assert.ok(h.storage.get('yumstep-account-v1-alice').includes('Pending'));
 h.setFail(false);await h.login('alice');assert.equal(h.value.profile,'Pending');assert.equal(h.run('pending.size'),0);
});
test('edits reverted while a write is in flight are sent after acknowledgement',async()=>{
 const h=harness();h.remote.set('alice',recordsFor(emptyState()));await h.login('alice');
 let release;h.setDelay(()=>new Promise(resolve=>{release=resolve}));
 h.save({...emptyState(),profile:'Changed'});h.save(emptyState());
 h.setDelay(null);release();await h.flush();assert.equal(JSON.parse(h.remote.get('alice').get('settings')).profile,'나의 키친');
});
test('late account reads cannot replace a newer account workspace',async()=>{
 const h=harness();let resolveAlice;h.setRead(ref=>ref.uid==='alice'?new Promise(resolve=>{resolveAlice=resolve}):Promise.resolve({docs:[]}));
 const alice=h.login('alice');await h.login('bob');resolveAlice({docs:[{id:'settings',data:()=>({payload:JSON.stringify({profile:'Alice'})})}]});await alice;
 assert.equal(h.value.profile,'나의 키친');assert.equal(h.run('account.uid'),'bob');
});
test('permission failure blocks editing until retry or logout',async()=>{
 const h=harness();h.setRead(async()=>{throw Object.assign(Error('denied'),{code:'permission-denied'})});await h.login('alice');
 assert.equal(h.nodes.get('app').inert,true);assert.equal(h.run('ready'),false);assert.equal(h.writes.length,0);
 await h.run('loadAccount(null)');assert.equal(h.nodes.get('app').inert,false);
});
test('a pending write from another login does not block the current account',async()=>{
 const h=harness();await h.login('alice');let release;
 h.setDelay(()=>new Promise(resolve=>{release=resolve}));h.save({...emptyState(),profile:'Alice pending'});
 h.setDelay(null);await h.login('bob');h.save({...emptyState(),profile:'Bob'});await h.flush();
 assert.equal(JSON.parse(h.remote.get('bob').get('settings')).profile,'Bob');
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.value.profile,'Bob');assert.equal(h.run('account.uid'),'bob');
});
