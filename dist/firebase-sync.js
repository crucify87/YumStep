import {firebaseConfig} from './firebase-config.js';
import {emptyState,recordsFor,stateFor,mergeGuest,validateRecords,batchEntries} from './sync-model.mjs';

const bar=document.getElementById('cloud-bar');
let account=null,ready=false,busy=false,epoch=0,baseline=new Map(),pending=new Map(),flight=null,flightEpoch=-1;
let auth,db,sdk,status='Firebase 연결 중…';
const cacheKey=uid=>'yumstep-account-v1-'+uid;
const pendingKey=uid=>'yumstep-pending-v1-'+uid;
function paint(){
  bar.replaceChildren();
  const label=document.createElement('span');label.setAttribute('role','status');label.textContent=(account?(account.displayName||'내 계정')+' · ':'')+status;bar.append(label);
  const button=(text,action,disabled=false)=>{const b=document.createElement('button');b.className='outline';b.textContent=text;b.disabled=disabled;b.onclick=action;bar.append(b);};
  if(!auth)return;
  if(account){button('동기화',refresh,busy);button('브라우저 기록 가져오기',importGuest,busy||!ready);button('로그아웃',logout,busy);}
  else button('Google로 로그인',login,busy);
}
function lock(value){busy=value;const blocked=value||!!(account&&!ready);for(const id of ['app','nav','mobile','overlay'])document.getElementById(id).inert=blocked;document.querySelector('header').inert=blocked;paint();}
function message(error){
  if(error.code==='permission-denied')return '저장 권한이 없습니다. Firebase의 Firestore 보안 규칙을 확인해 주세요.';
  if(error.code==='auth/unauthorized-domain')return '로그인 허용 도메인에 '+location.hostname+'을 추가해 주세요.';
  if(error.code==='auth/operation-not-allowed')return 'Firebase Authentication에서 Google 로그인을 켜 주세요.';
  if(error.code==='auth/popup-blocked')return '로그인 팝업이 차단됐습니다. 브라우저에서 팝업을 허용해 주세요.';
  return error.message?.startsWith('사진이')?error.message:'연결하지 못했습니다. 브라우저 기록은 유지됩니다. 인터넷 연결을 확인하고 동기화를 눌러 주세요.';
}
function updateState(value){window.yumstepData.replace(value);}
function storePending(){if(account)localStorage.setItem(cacheKey(account.uid),JSON.stringify({state:window.yumstepData.get(),pending:[...pending]}));}

// Persist the state and retry journal atomically before starting network work.
window.yumstepCloud={
  persist(value){
    if(!account){localStorage.setItem('yumstep-v1',JSON.stringify(value));return;}
    if(!ready)throw Error('계정 기록을 먼저 불러와 주세요.');
      const next=new Map(pending);
      for(const [key,payload] of recordsFor(value)){
        if((flight&&flightEpoch===epoch)||payload!==baseline.get(key))next.set(key,payload);else next.delete(key);
      }
      localStorage.setItem(cacheKey(account.uid),JSON.stringify({state:value,pending:[...next]}));pending=next;
      status=pending.size?'브라우저에 저장됨 · 클라우드 저장 대기':'클라우드에 저장됨';paint();
      void flush().catch(error=>{status=message(error);paint();});
  }
};
async function flush(){
  if(flight&&flightEpoch===epoch){await flight;if(pending.size&&ready)return flush();return;}
  if(!account||!ready||!pending.size)return;
  const uid=account.uid,generation=epoch;
  const task=(async()=>{
    while(pending.size&&account?.uid===uid&&ready&&epoch===generation){
      validateRecords(pending);
      const items=batchEntries(pending),batch=sdk.writeBatch(db);
      for(const [key,payload] of items)batch.set(sdk.doc(db,'users',uid,'records',key),{payload,updatedAt:sdk.serverTimestamp()});
      status='클라우드에 저장 중…';paint();await batch.commit();
      if(account?.uid!==uid||epoch!==generation)return;
      for(const [key,payload] of items){baseline.set(key,payload);if(pending.get(key)===payload)pending.delete(key);}
      storePending();
    }
    if(epoch===generation){status='클라우드에 저장됨';paint();}
  })();
  flight=task;flightEpoch=generation;
  try{await task;}finally{if(flight===task){flight=null;flightEpoch=-1;}}
}
async function loadAccount(user){
  const ticket=++epoch;ready=false;account=user;baseline=new Map();pending=new Map();
  lock(true);window.yumstepData.close();
  if(!user){updateState(JSON.parse(localStorage.getItem('yumstep-v1')||JSON.stringify(emptyState())));status='브라우저에 저장 중 · 로그인하면 계정 저장 가능';lock(false);return;}
  status='계정 기록을 불러오는 중…';paint();
  try{
    const cached=JSON.parse(localStorage.getItem(cacheKey(user.uid))||'null');updateState(cached?.state||cached||emptyState());
    const journal=cached?.pending||JSON.parse(localStorage.getItem(pendingKey(user.uid))||'[]');pending=new Map(journal);
    const result=await sdk.getDocs(sdk.collection(db,'users',user.uid,'records'));
    if(ticket!==epoch)return;
    baseline=new Map(result.docs.map(d=>[d.id,d.data().payload]));
    const combined=new Map([...baseline,...pending]);
    const value=stateFor(combined);localStorage.setItem(cacheKey(user.uid),JSON.stringify({state:value,pending:[...pending]}));updateState(value);
    ready=true;status=pending.size?'저장하지 못한 기록을 재시도합니다.':'클라우드 연결됨 · 본인만 볼 수 있어요';
    await flush();
  }catch(error){if(ticket===epoch)status=message(error);}
  finally{if(ticket===epoch)lock(false);}
}
async function login(){
  lock(true);
  try{await sdk.signInWithPopup(auth,new sdk.GoogleAuthProvider());}
  catch(error){if(!['auth/popup-closed-by-user','auth/cancelled-popup-request'].includes(error.code))status=message(error);lock(false);}
}
async function logout(){
  lock(true);
  try{await Promise.race([flush(),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),10000))]);}catch{/* Pending changes remain in this account's local journal. */}
  try{await sdk.signOut(auth);}catch(error){status=message(error);lock(false);}
}
async function refresh(){
  if(!account)return;
  lock(true);
  try{if(ready)await flush();await loadAccount(account);}catch(error){status=message(error);lock(false);}
}
function importGuest(){
  if(!account||!ready)return;
  if(!confirm('이 브라우저에서 로그인 전에 작성한 레시피·후기·저장 목록을 현재 Google 계정으로 가져올까요? 기존 계정 기록은 유지됩니다.'))return;
  try{
    const guest=JSON.parse(localStorage.getItem('yumstep-v1')||JSON.stringify(emptyState()));
    const value=mergeGuest(window.yumstepData.get(),guest);validateRecords(recordsFor(value));
    // Cache and journal before changing the visible state.
    window.yumstepCloud.persist(value);updateState(value);
  }catch(error){status=message(error);paint();}
}
window.addEventListener('online',()=>{if(account)void refresh();});
window.addEventListener('beforeunload',event=>{if(pending.size){event.preventDefault();event.returnValue='';}});
lock(true);
try{
  const [appSdk,authSdk,firestoreSdk]=await Promise.all([
    import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js')
  ]);
  sdk={...authSdk,...firestoreSdk};const app=appSdk.initializeApp(firebaseConfig);auth=sdk.getAuth(app);db=sdk.getFirestore(app);
  auth.languageCode='ko';sdk.onAuthStateChanged(auth,user=>void loadAccount(user));
}catch(error){status='Firebase를 불러오지 못했습니다. 현재 기록은 브라우저에 저장됩니다. 새로고침해 주세요.';lock(false);}
