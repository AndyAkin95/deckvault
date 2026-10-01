'use strict';
const API='https://api.tcgdex.net/v2/en';
const SUPABASE_URL='https://lretqhaattgtwpfwsxbc.supabase.co';
const SUPABASE_KEY='sb_publishable_6ntpA39F6O2fbB8wavLzoA_acDIJfrm';
const STAY_SIGNED_IN_KEY='deckvault-stay-signed-in';
const authStorage={
  getItem(key){
    const stay=localStorage.getItem(STAY_SIGNED_IN_KEY)==='true';
    return (stay?localStorage:sessionStorage).getItem(key);
  },
  setItem(key,value){
    const stay=localStorage.getItem(STAY_SIGNED_IN_KEY)==='true';
    const target=stay?localStorage:sessionStorage;
    const other=stay?sessionStorage:localStorage;
    target.setItem(key,value);
    other.removeItem(key);
  },
  removeItem(key){
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
};
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
  auth:{
    persistSession:true,
    autoRefreshToken:true,
    detectSessionInUrl:true,
    storage:authStorage
  }
});
let currentUser=null, currentCard=null, stream=null, installPrompt=null, items=[];
let offlineMode=false,offlineSnapshotAt=null;
const OFFLINE_CACHE_VERSION=1;
const OFFLINE_QUEUE_VERSION=1;
const OFFLINE_QUEUE_PREFIX='deckvault-offline-queue-v1:';
const OFFLINE_CONFLICT_PREFIX='deckvault-offline-conflicts-v1:';
let currentCopyItem=null,currentWatchState=null;
let analyticsSetCache=null;
const APP_BUILD='v24';
const ERROR_BACKLOG_KEY='deckvault-error-backlog-v1';
const LAST_USER_KEY='deckvault-last-user-id';
let errorLogSyncing=false,errorLogInternal=false,errorBreadcrumbs=[];
let activeScanWorker=null,activeScanRunning=false,activeScanBusy=false,activeScanTimer=null,activeScanMatch=null,activeScanRejected=null,pokemonSetCache=null;
let folders=[], folderMembership=new Map(), copyFolderCounts=new Map(), activeFolderId=null, folderAssignItemId=null;
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const money=(n,c='USD')=>n==null||Number.isNaN(Number(n))?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:c}).format(Number(n));
const imageUrl=(base,q='low')=>{
  if(!base)return '';
  if(/^https?:\/\//i.test(base)&&!base.includes('tcgdex.net'))return base;
  return base+'/'+q+'.webp';
};
function toast(m){const e=$('#toast');e.textContent=m;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),1800);}
function redactDiagnostic(value){
  let s=String(value??'');
  s=s.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,'Bearer [REDACTED]');
  s=s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,'[REDACTED_JWT]');
  s=s.replace(/((?:access|refresh)[_-]?token|apikey|api[_-]?key|password|passwd|secret)(["'=:\s]+)([^\s,;}]+)/gi,'$1$2[REDACTED]');
  s=s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[REDACTED_EMAIL]');
  return s.slice(0,12000);
}
function diagnosticId(){
  if(globalThis.crypto?.randomUUID)return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const r=Math.random()*16|0,v=c==='x'?r:(r&3|8);return v.toString(16);
  });
}
function readErrorBacklog(){
  try{
    const rows=JSON.parse(localStorage.getItem(ERROR_BACKLOG_KEY)||'[]');
    return Array.isArray(rows)?rows:[];
  }catch{return [];}
}
function writeErrorBacklog(rows){
  try{localStorage.setItem(ERROR_BACKLOG_KEY,JSON.stringify((rows||[]).slice(-120)));}catch{}
}
function currentAppView(){return document.querySelector('.view.active')?.id||'startup';}
function addBreadcrumb(label){
  const text=redactDiagnostic(label).slice(0,160);
  if(!text)return;
  errorBreadcrumbs.push({at:new Date().toISOString(),action:text});
  if(errorBreadcrumbs.length>12)errorBreadcrumbs=errorBreadcrumbs.slice(-12);
}
function describeTarget(el){
  if(!el)return '';
  const target=el.closest?.('button,a,[data-go],summary,input,select,textarea')||el;
  const tag=String(target.tagName||'').toLowerCase();
  const id=target.id?'#'+target.id:'';
  const go=target.dataset?.go?' go:'+target.dataset.go:'';
  const type=target.getAttribute?.('type')?' type:'+target.getAttribute('type'):'';
  const safeText=['button','a','summary'].includes(tag)?String(target.textContent||'').trim().replace(/\s+/g,' ').slice(0,70):'';
  return [tag+id,go,type,safeText].filter(Boolean).join(' ');
}
function captureAppError(error,{severity='error',source='runtime',context={}}={}){
  try{
    if(errorLogInternal)return;
    const message=redactDiagnostic(error?.message||error||'Unknown error');
    const stack=redactDiagnostic(error?.stack||'');
    const userId=currentUser?.id||localStorage.getItem(LAST_USER_KEY)||null;
    const now=new Date().toISOString();
    const rows=readErrorBacklog();
    const fingerprint=[source,message,currentAppView(),APP_BUILD].join('|').slice(0,2000);
    const recent=rows[rows.length-1];
    if(recent&&recent.fingerprint===fingerprint&&(Date.now()-new Date(recent.client_created_at).getTime())<5000){
      recent.occurrence_count=Number(recent.occurrence_count||1)+1;
      recent.client_created_at=now;
      recent.breadcrumbs=[...errorBreadcrumbs];
      writeErrorBacklog(rows);
    }else{
      rows.push({
        client_event_id:diagnosticId(),
        user_id:userId,
        severity,
        source:redactDiagnostic(source).slice(0,80),
        message,
        stack,
        build_version:APP_BUILD,
        app_view:currentAppView(),
        online:navigator.onLine,
        user_agent:redactDiagnostic(navigator.userAgent).slice(0,500),
        breadcrumbs:[...errorBreadcrumbs],
        context:{
          offline_mode:!!offlineMode,
          standalone:window.matchMedia?.('(display-mode: standalone)')?.matches||false,
          ...Object.fromEntries(Object.entries(context||{}).map(([k,v])=>[k,redactDiagnostic(typeof v==='string'?v:JSON.stringify(v)).slice(0,1000)]))
        },
        occurrence_count:1,
        client_created_at:now,
        fingerprint
      });
      writeErrorBacklog(rows);
    }
    if(navigator.onLine&&currentUser)setTimeout(()=>syncErrorBacklog(),0);
  }catch{}
}
async function syncErrorBacklog(){
  if(errorLogSyncing||!navigator.onLine)return;
  const user=currentUser;
  if(!user)return;
  const pending=readErrorBacklog().filter(r=>!r.user_id||r.user_id===user.id);
  if(!pending.length)return;
  errorLogSyncing=true;
  errorLogInternal=true;
  try{
    const payload=pending.map(r=>({
      client_event_id:r.client_event_id,
      user_id:user.id,
      severity:r.severity||'error',
      source:r.source||'runtime',
      message:redactDiagnostic(r.message),
      stack:redactDiagnostic(r.stack||'')||null,
      build_version:r.build_version||APP_BUILD,
      app_view:r.app_view||null,
      online:typeof r.online==='boolean'?r.online:null,
      user_agent:redactDiagnostic(r.user_agent||'').slice(0,500)||null,
      breadcrumbs:r.breadcrumbs||[],
      context:r.context||{},
      occurrence_count:Number(r.occurrence_count||1),
      client_created_at:r.client_created_at||new Date().toISOString()
    }));
    const {error}=await sb.from('app_error_logs').upsert(payload,{onConflict:'client_event_id',ignoreDuplicates:true});
    if(error)throw error;
    const sent=new Set(pending.map(r=>r.client_event_id));
    writeErrorBacklog(readErrorBacklog().filter(r=>!sent.has(r.client_event_id)));
  }catch(e){
    // Do not recursively log failures of the logger itself.
    originalConsoleError('Error backlog sync failed',e);
  }finally{
    errorLogInternal=false;
    errorLogSyncing=false;
  }
}
async function diagnosticBundle(){
  let server=[];
  if(currentUser&&navigator.onLine){
    try{
      errorLogInternal=true;
      const {data,error}=await sb.from('app_error_logs')
        .select('client_event_id,severity,source,message,stack,build_version,app_view,online,user_agent,breadcrumbs,context,occurrence_count,client_created_at,received_at')
        .eq('user_id',currentUser.id)
        .order('client_created_at',{ascending:false})
        .limit(100);
      if(!error)server=data||[];
    }finally{errorLogInternal=false;}
  }
  const local=readErrorBacklog().filter(r=>!currentUser||!r.user_id||r.user_id===currentUser.id);
  return {
    generated_at:new Date().toISOString(),
    build:APP_BUILD,
    current_view:currentAppView(),
    online:navigator.onLine,
    offline_mode:offlineMode,
    user_agent:redactDiagnostic(navigator.userAgent),
    local_pending:local,
    synced_errors:server
  };
}
async function loadErrorBacklog(){
  if(!$('#errorLogList'))return;
  if(currentUser&&navigator.onLine)await syncErrorBacklog();
  const bundle=await diagnosticBundle();
  const rows=[
    ...bundle.local_pending.map(r=>({...r,_location:'Pending local'})),
    ...bundle.synced_errors.map(r=>({...r,_location:'Synced'}))
  ].sort((a,b)=>new Date(b.client_created_at)-new Date(a.client_created_at)).slice(0,50);
  $('#errorLogStatus').textContent=bundle.local_pending.length+' pending locally • '+bundle.synced_errors.length+' synced error'+(bundle.synced_errors.length===1?'':'s');
  const box=$('#errorLogList');box.innerHTML='';
  if(!rows.length){box.innerHTML='<div class="empty">No recorded errors.</div>';return;}
  rows.forEach(r=>{
    const e=document.createElement('details');e.className='errorlogrow';
    e.innerHTML='<summary><span class="errorseverity '+esc(r.severity||'error')+'">'+esc((r.severity||'error').toUpperCase())+'</span><strong>'+esc(r.message||'Unknown error')+'</strong><small>'+esc(r._location)+' • '+new Date(r.client_created_at).toLocaleString()+'</small></summary><div class="errorlogdetail"><div><b>Source</b> '+esc(r.source||'runtime')+'</div><div><b>Build</b> '+esc(r.build_version||'unknown')+' • <b>View</b> '+esc(r.app_view||'unknown')+' • <b>Online</b> '+String(r.online)+'</div>'+(Number(r.occurrence_count||1)>1?'<div><b>Occurrences</b> '+Number(r.occurrence_count)+'</div>':'')+(r.stack?'<pre>'+esc(r.stack)+'</pre>':'')+(r.breadcrumbs?.length?'<div class="errorbreadcrumbs"><b>Recent actions</b>'+r.breadcrumbs.map(x=>'<span>'+esc(new Date(x.at).toLocaleTimeString())+' — '+esc(x.action)+'</span>').join('')+'</div>':'')+'</div>';
    box.appendChild(e);
  });
}
async function copyDiagnostics(){
  const bundle=await diagnosticBundle();
  const text=JSON.stringify(bundle,null,2);
  try{await navigator.clipboard.writeText(text);toast('Diagnostics copied');}
  catch{toast('Could not copy diagnostics');}
}
async function exportDiagnostics(){
  const bundle=await diagnosticBundle();
  download('deckvault-diagnostics-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(bundle,null,2),'application/json');
}
const originalConsoleError=console.error.bind(console);
console.error=(...args)=>{
  originalConsoleError(...args);
  if(errorLogInternal)return;
  try{
    const first=args.find(x=>x instanceof Error);
    const message=args.map(x=>x instanceof Error?x.message:(typeof x==='string'?x:JSON.stringify(x))).join(' ');
    captureAppError(first||new Error(message),{source:'console.error'});
  }catch{}
};
document.addEventListener('click',e=>{const d=describeTarget(e.target);if(d)addBreadcrumb('click '+d);},true);


function setAuthMessage(m,bad=false){const e=$('#authMessage');e.textContent=m||'';e.classList.toggle('error',bad);}
function showPane(id){['signinPane','signupPane','applicationPane','resetPane'].forEach(x=>{const e=$('#'+x);if(e)e.classList.toggle('hidden',x!==id);});setAuthMessage('');}
function hideAccessGates(){
  ['bannedGate','termsGate','onboardingGate','appShell'].forEach(id=>{const e=$('#'+id);if(e)e.classList.add('hidden');});
}
function showAuth(){
  currentUser=null;
  hideAccessGates();
  $('#authGate').classList.remove('hidden');
}

function offlineCacheKey(userId){return 'deckvault-offline-v'+OFFLINE_CACHE_VERSION+':'+userId;}
function serializeFolderMembership(){
  return [...folderMembership.entries()].map(([folderId,set])=>[folderId,[...set]]);
}
function warmOfflineLibraryImages(){
  if(!('serviceWorker' in navigator)||!items.length)return;
  const urls=[...new Set(items.filter(x=>x.image).map(x=>imageUrl(x.image,'low')).filter(Boolean))].slice(0,300);
  if(!urls.length)return;
  navigator.serviceWorker.ready.then(reg=>reg.active?.postMessage({type:'CACHE_URLS',urls})).catch(()=>{});
}
function saveOfflineSnapshot(){
  if(!currentUser)return;
  try{
    const prior=readOfflineSnapshot(currentUser.id);
    const syncedAt=offlineMode?(prior?.syncedAt||offlineSnapshotAt):new Date().toISOString();
    const snapshot={
      version:OFFLINE_CACHE_VERSION,userId:currentUser.id,email:currentUser.email||'',
      savedAt:new Date().toISOString(),syncedAt,items,folders,folderMembership:serializeFolderMembership(),copyFolderCounts:[...copyFolderCounts.entries()].map(([folderId,map])=>[folderId,[...map.entries()]])
    };
    localStorage.setItem(offlineCacheKey(currentUser.id),JSON.stringify(snapshot));
    offlineSnapshotAt=syncedAt;updateLastSyncChip(syncedAt);
  }catch(e){console.warn('Offline snapshot could not be saved',e);}
}
function readOfflineSnapshot(userId){
  try{
    const raw=localStorage.getItem(offlineCacheKey(userId));
    if(!raw)return null;
    const data=JSON.parse(raw);
    if(!data||data.userId!==userId||!Array.isArray(data.items))return null;
    return data;
  }catch(e){console.warn('Offline snapshot could not be read',e);return null;}
}
function restoreOfflineSnapshot(snapshot){
  items=Array.isArray(snapshot?.items)?snapshot.items:[];
  folders=Array.isArray(snapshot?.folders)?snapshot.folders:[];
  folderMembership=new Map((snapshot?.folderMembership||[]).map(([id,ids])=>[id,new Set(ids||[])]));
  copyFolderCounts=new Map((snapshot?.copyFolderCounts||[]).map(([folderId,entries])=>[folderId,new Map(entries||[])]));
  offlineSnapshotAt=snapshot?.syncedAt||snapshot?.savedAt||null;updateLastSyncChip(offlineSnapshotAt);
  if(activeFolderId&&!folders.some(f=>f.id===activeFolderId))activeFolderId=null;
  renderFolderChips();
  populateManualFolderSelect();
}
function setOfflineMode(enabled,savedAt=null){
  offlineMode=!!enabled;
  document.body.classList.toggle('offline-mode',offlineMode);
  const banner=$('#offlineBanner');
  if(banner){
    banner.classList.toggle('hidden',!offlineMode);
    $('#offlineSavedAt').textContent=offlineMode&&savedAt?'Last synced '+new Date(savedAt).toLocaleString():'';updateLastSyncChip(savedAt||offlineSnapshotAt);
  }
  ['lookup','scanner','marketplace','community'].forEach(view=>{
    $$('[data-go="'+view+'"]').forEach(b=>b.disabled=offlineMode);
  });
  if($('#accountChip')&&currentUser)$('#accountChip').textContent=(currentUser.email||'Signed in')+(offlineMode?' • Offline':'');
}
function requireOnline(message='This action needs an internet connection.'){
  if(offlineMode||!navigator.onLine){toast(message);return false;}
  return true;
}
function isConnectivityError(error){
  const m=String(error?.message||error||'').toLowerCase();
  return !navigator.onLine||m.includes('failed to fetch')||m.includes('network')||m.includes('load failed')||m.includes('fetch');
}
async function showOfflineApp(user){
  const snapshot=readOfflineSnapshot(user.id);
  if(!snapshot)return false;
  currentUser=user;
  hideAccessGates();
  restoreOfflineSnapshot(snapshot);
  $('#authGate').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  $('#accountEmail').textContent=user.email||snapshot.email||'';
  setOfflineMode(true,snapshot.savedAt);
  renderDashboard();renderLibrary();
  if(!document.querySelector('.view.active')||['lookup','scanner','marketplace','community'].includes(document.querySelector('.view.active')?.id))go('library');
  return true;
}


function haptic(ms=24){try{navigator.vibrate?.(ms);}catch{}}
function updateLastSyncChip(value=offlineSnapshotAt){
  const chip=$('#lastSyncChip');if(!chip)return;
  if(!value){chip.textContent='Not synced';return;}
  chip.textContent=(offlineMode?'Offline • ':'Synced • ')+new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
}
function offlineQueueKey(){return OFFLINE_QUEUE_PREFIX+(currentUser?.id||localStorage.getItem(LAST_USER_KEY)||'anonymous');}
function offlineConflictKey(){return OFFLINE_CONFLICT_PREFIX+(currentUser?.id||localStorage.getItem(LAST_USER_KEY)||'anonymous');}
function readOfflineQueue(){try{const v=JSON.parse(localStorage.getItem(offlineQueueKey())||'[]');return Array.isArray(v)?v:[];}catch{return [];}}
function writeOfflineQueue(rows){localStorage.setItem(offlineQueueKey(),JSON.stringify(rows||[]));updateOfflineQueueStatus();}
function queueOfflineMutation(type,payload,baseUpdatedAt=null){
  const q=readOfflineQueue();q.push({id:crypto.randomUUID(),type,payload,baseUpdatedAt,createdAt:new Date().toISOString()});writeOfflineQueue(q);saveOfflineSnapshot();toast('Saved offline — will sync when connected');
}
function readOfflineConflicts(){try{const v=JSON.parse(localStorage.getItem(offlineConflictKey())||'[]');return Array.isArray(v)?v:[];}catch{return [];}}
function addOfflineConflict(op,serverRow,reason){
  const rows=readOfflineConflicts();rows.unshift({id:crypto.randomUUID(),op,serverRow,reason,createdAt:new Date().toISOString()});localStorage.setItem(offlineConflictKey(),JSON.stringify(rows.slice(0,100)));updateOfflineQueueStatus();
}
function updateOfflineQueueStatus(){
  const el=$('#offlineQueueStatus');if(!el)return;
  const q=readOfflineQueue().length,c=readOfflineConflicts().length;
  el.textContent=q+' queued change'+(q===1?'':'s')+(c?' • '+c+' conflict'+(c===1?'':'s'):'');
}
function renderOfflineConflicts(){
  const box=$('#offlineConflictsList');if(!box)return;
  const rows=readOfflineConflicts();box.innerHTML='';
  if(!rows.length){box.innerHTML='<div class="empty">No sync conflicts.</div>';return;}
  rows.forEach(r=>{
    const e=document.createElement('article');e.className='panel';
    e.innerHTML='<strong>'+esc(r.op?.type||'Offline change')+'</strong><p>'+esc(r.reason||'A newer server change was found.')+'</p><small>'+new Date(r.createdAt).toLocaleString()+'</small>';
    box.appendChild(e);
  });
}
async function syncOfflineQueue(){
  if(!currentUser||!navigator.onLine)return false;
  const queue=readOfflineQueue();if(!queue.length){updateOfflineQueueStatus();return true;}
  const remaining=[];
  for(const op of queue){
    try{
      if(op.type==='collection_insert'){
        const {error}=await sb.from('collection_items').insert(op.payload);
        if(error&&error.code!=='23505')throw error;
      }else if(op.type==='quantity_update'){
        const {data:server,error:getErr}=await sb.from('collection_items').select('id,updated_at,quantity').eq('id',op.payload.id).maybeSingle();
        if(getErr)throw getErr;
        if(server&&op.baseUpdatedAt&&new Date(server.updated_at)>new Date(op.baseUpdatedAt)){
          addOfflineConflict(op,server,'Quantity was changed on the server after this device went offline.');continue;
        }
        const {error}=await sb.from('collection_items').update({quantity:op.payload.quantity,updated_at:op.payload.updated_at}).eq('id',op.payload.id);
        if(error)throw error;
      }else if(op.type==='collection_update'){
        const {data:server,error:getErr}=await sb.from('collection_items').select('id,updated_at').eq('id',op.payload.id).maybeSingle();
        if(getErr)throw getErr;
        if(server&&op.baseUpdatedAt&&new Date(server.updated_at)>new Date(op.baseUpdatedAt)){
          addOfflineConflict(op,server,'Card details changed on the server after this device went offline.');continue;
        }
        const payload={...op.payload};delete payload.id;
        const {error}=await sb.from('collection_items').update(payload).eq('id',op.payload.id);
        if(error)throw error;
      }else if(op.type==='collection_delete'){
        const {data:server,error:getErr}=await sb.from('collection_items').select('id,updated_at').eq('id',op.payload.id).maybeSingle();
        if(getErr)throw getErr;
        if(server&&op.baseUpdatedAt&&new Date(server.updated_at)>new Date(op.baseUpdatedAt)){
          addOfflineConflict(op,server,'Card changed on the server after this device went offline.');continue;
        }
        const {error}=await sb.from('collection_items').delete().eq('id',op.payload.id);if(error)throw error;
      }else if(op.type==='folder_create'){
        const {error}=await sb.from('collection_folders').insert(op.payload);if(error&&error.code!=='23505')throw error;
      }else if(op.type==='folder_assignments'){
        const {itemId,folderIds}=op.payload;
        const {error:dErr}=await sb.from('collection_folder_items').delete().eq('collection_item_id',itemId);if(dErr)throw dErr;
        if(folderIds?.length){const {error:iErr}=await sb.from('collection_folder_items').insert(folderIds.map(folder_id=>({folder_id,collection_item_id:itemId})));if(iErr)throw iErr;}
      }else{
        remaining.push(op);
      }
    }catch(e){console.error('Offline sync mutation failed',op,e);remaining.push(op);}
  }
  writeOfflineQueue(remaining);
  return remaining.length===0;
}
async function runOfflineSyncAndReload(){
  if(!navigator.onLine)return toast('Still offline');
  const ok=await syncOfflineQueue();
  await loadCollection();await loadFolders();saveOfflineSnapshot();renderDashboard();renderLibrary();updateLastSyncChip();
  toast(ok?'Offline changes synced':'Some changes still need attention');
}
function parseCsvText(text){
  const rows=[];let row=[],cell='',quote=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i],next=text[i+1];
    if(ch==='"'&&quote&&next==='"'){cell+='"';i++;continue;}
    if(ch==='"'){quote=!quote;continue;}
    if(ch===','&&!quote){row.push(cell);cell='';continue;}
    if((ch==='\n'||ch==='\r')&&!quote){
      if(ch==='\r'&&next==='\n')i++;
      row.push(cell);cell='';
      if(row.some(v=>v!==''))rows.push(row);
      row=[];
      continue;
    }
    cell+=ch;
  }
  row.push(cell);if(row.some(v=>v!==''))rows.push(row);
  return rows;
}
function mapImportedCsv(rows,format='auto'){
  if(rows.length<2)return [];
  const headers=rows[0].map(h=>String(h||'').trim().toLowerCase());
  const idx=(...names)=>{for(const n of names){const i=headers.indexOf(n);if(i>=0)return i;}return -1;};
  const at=(r,...names)=>{const i=idx(...names);return i>=0?String(r[i]??'').trim():'';};
  return rows.slice(1).map((r,n)=>{
    const name=at(r,'card name','name','product name','card');
    if(!name)return null;
    const setName=at(r,'set','set name','expansion');
    const localId=at(r,'card number','number','collector number','card #');
    const qty=Number(at(r,'quantity','qty')||1)||1;
    const condition=at(r,'condition')||'Near Mint';
    const language=at(r,'language')||'English';
    const variant=at(r,'variant','printing','finish')||'Normal';
    const providerId=at(r,'provider id','tcgplayer id','card id','id');
    const price=Number(at(r,'current price','price','market price','market')||'');
    const paid=Number(at(r,'price paid','cost','purchase price')||'');
    const override=Number(at(r,'value override','graded value','current value override')||'');
    return {
      game:'pokemon',cardId:providerId||('import:'+crypto.randomUUID()),name,localId,setId:'',setName,rarity:'',
      variant,condition,language,quantity:Math.max(1,qty),image:'',price:Number.isFinite(price)?price:null,
      valueOverride:Number.isFinite(override)?override:null,pricePaid:Number.isFinite(paid)?paid:null,priceCurrency:'USD',priceSource:'Imported CSV',priceUpdatedAt:null,
      entrySource:providerId?'provider':'manual',cardState:'raw',gradingCompany:'',grade:'',certNumber:'',purchaseDate:'',
      notes:'Imported from '+format+' row '+(n+2),addedAt:new Date().toISOString()
    };
  }).filter(Boolean);
}
async function importCollectionCsv(file,format){
  if(!navigator.onLine)return toast('CSV import needs an internet connection');
  const rows=parseCsvText(await file.text()),mapped=mapImportedCsv(rows,format);
  if(!mapped.length)return $('#importCollectionStatus').textContent='No recognizable card rows found.';
  let imported=0,updated=0;
  for(const obj of mapped){
    const old=items.find(i=>i.cardId===obj.cardId&&i.variant===obj.variant&&i.condition===obj.condition&&i.language===obj.language);
    if(old){const {error}=await sb.from('collection_items').update({...toRow({...obj,id:old.id}),quantity:old.quantity+obj.quantity}).eq('id',old.id);if(!error)updated++;}
    else{const {error}=await sb.from('collection_items').insert({...toRow(obj),added_at:obj.addedAt});if(!error)imported++;}
  }
  await loadCollection();saveOfflineSnapshot();renderDashboard();renderLibrary();
  $('#importCollectionStatus').textContent=imported+' added • '+updated+' merged';
}
async function runUniversalSearch(){
  const q=$('#universalSearchInput').value.trim().toLowerCase(),box=$('#universalSearchResults');box.innerHTML='';
  if(q.length<2){box.innerHTML='<div class="empty">Type at least 2 characters.</div>';return;}
  const local=items.filter(x=>[x.name,x.setName,x.localId].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,8);
  if(local.length){
    const h=document.createElement('h3');h.textContent='Your library';box.appendChild(h);
    local.forEach(x=>{const b=document.createElement('button');b.className='globalsearchrow';b.innerHTML='<strong>'+esc(x.name)+'</strong><span>'+esc(x.setName||'')+' • #'+esc(x.localId||'')+'</span>';b.onclick=()=>{$('#universalSearchDialog').close();go('library');openLibraryCardDetails(x);};box.appendChild(b);});
  }
  if(navigator.onLine&&window.searchSocialUniversal){
    const extra=await window.searchSocialUniversal(q);extra.forEach(node=>box.appendChild(node));
  }
  if(!box.children.length)box.innerHTML='<div class="empty">No matches.</div>';
}
function openImageZoom(src,alt='Card image'){
  if(!src)return;$('#imageZoomTarget').src=src;$('#imageZoomTarget').alt=alt;$('#imageZoomDialog').showModal();
}
function installSwipeBack(el,callback){
  if(!el)return;let sx=0,sy=0;
  el.addEventListener('touchstart',e=>{const t=e.changedTouches[0];sx=t.clientX;sy=t.clientY;},{passive:true});
  el.addEventListener('touchend',e=>{const t=e.changedTouches[0];if(sx<55&&t.clientX-sx>90&&Math.abs(t.clientY-sy)<80)callback();},{passive:true});
}

async function getCurrentTerms(){
  const {data,error}=await sb.from('legal_documents').select('version,title,body,effective_at').eq('document_key','terms').eq('is_current',true).single();
  if(error)throw error;
  return data;
}
function renderTerms(target,doc){
  target.textContent=doc.body||'';
}
async function openTermsDialog(){
  try{
    const doc=await getCurrentTerms();
    $('#termsDialogTitle').textContent=doc.title;
    $('#termsDialogVersion').textContent='Version '+doc.version+' • Effective '+new Date(doc.effective_at).toLocaleDateString();
    renderTerms($('#termsDialogBody'),doc);
    $('#termsDialog').showModal();
  }catch(e){toast('Could not load Terms');}
}
async function acceptCurrentTerms(){
  if(!currentUser||!$('#acceptTermsCheck').checked)return;
  try{
    const doc=await getCurrentTerms();
    const {error}=await sb.from('terms_acceptances').insert({user_id:currentUser.id,terms_version:doc.version});
    if(error&&error.code!=='23505')throw error;
    $('#termsGate').classList.add('hidden');
    await showApp(currentUser,true);
  }catch(e){toast('Could not save Terms acceptance');}
}
async function showApp(user,termsJustAccepted=false){
  currentUser=user;
  hideAccessGates();

  if(!navigator.onLine){
    if(await showOfflineApp(user))return true;
    showAuth();
    setAuthMessage('DeckVault is offline and this account does not have a saved offline library yet.',true);
    return false;
  }

  try{
    const {data:ban,error:banError}=await sb.from('user_bans').select('reason,banned_at,active').eq('user_id',user.id).eq('active',true).maybeSingle();
    if(banError)throw banError;
    if(ban){
      $('#authGate').classList.add('hidden');
      $('#banReason').textContent=ban.reason||'Account access has been suspended.';
      $('#banDate').textContent=ban.banned_at?'Banned '+new Date(ban.banned_at).toLocaleString():'';
      $('#bannedGate').classList.remove('hidden');
      return false;
    }

    const {data:approved,error:approvalError}=await sb.from('approved_users').select('user_id').eq('user_id',user.id).maybeSingle();
    if(approvalError)throw approvalError;
    if(!approved){
      await sb.auth.signOut();
      showAuth();
      setAuthMessage('This account has not been approved for DeckVault yet.',true);
      return false;
    }

    const doc=await getCurrentTerms();
    const {data:accepted,error:acceptedError}=await sb.from('terms_acceptances').select('terms_version').eq('user_id',user.id).eq('terms_version',doc.version).maybeSingle();
    if(acceptedError)throw acceptedError;
    if(!accepted&&!termsJustAccepted){
      $('#authGate').classList.add('hidden');
      $('#termsGateVersion').textContent='Version '+doc.version+' • Effective '+new Date(doc.effective_at).toLocaleDateString();
      renderTerms($('#termsGateBody'),doc);
      $('#acceptTermsCheck').checked=false;
      $('#acceptTermsBtn').disabled=true;
      $('#termsGate').classList.remove('hidden');
      return false;
    }

    $('#authGate').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    $('#accountChip').textContent=user.email||'Signed in';
    $('#accountEmail').textContent=user.email||'';
    localStorage.setItem(LAST_USER_KEY,user.id);
    setOfflineMode(false);
    await syncOfflineQueue();
    const collectionOK=await loadCollection();
    const foldersOK=await loadFolders();
    if(collectionOK===false||foldersOK===false)throw new Error('Network data load failed');
    saveOfflineSnapshot();
    warmOfflineLibraryImages();
    renderDashboard();renderLibrary();
    if(window.refreshSocialState)setTimeout(()=>window.refreshSocialState().catch(console.error),50);
    setTimeout(()=>syncErrorBacklog().catch(()=>{}),100);
    return true;
  }catch(e){
    console.warn('Online app load failed',e);
    if(isConnectivityError(e)&&await showOfflineApp(user))return true;
    throw e;
  }
}
async function loadCollection(){
  if(!currentUser){items=[];return true;}
  const {data,error}=await sb.from('collection_items').select('*').eq('user_id',currentUser.id).order('added_at',{ascending:false});
  if(error){console.error(error);return false;}
  items=(data||[]).map(fromRow);
  return true;
}
async function loadFolders(){
  if(!currentUser){folders=[];folderMembership=new Map();copyFolderCounts=new Map();return true;}
  const [fRes,mRes,cRes]=await Promise.all([
    sb.from('collection_folders').select('*').eq('user_id',currentUser.id).order('name'),
    sb.from('collection_folder_items').select('folder_id,collection_item_id'),
    sb.from('collection_copies').select('folder_id,collection_item_id').eq('user_id',currentUser.id).not('folder_id','is',null)
  ]);
  if(fRes.error||mRes.error||cRes.error){console.error(fRes.error||mRes.error||cRes.error);return false;}
  folders=fRes.data||[];
  folderMembership=new Map();copyFolderCounts=new Map();
  (mRes.data||[]).forEach(row=>{
    if(!folderMembership.has(row.folder_id))folderMembership.set(row.folder_id,new Set());
    folderMembership.get(row.folder_id).add(row.collection_item_id);
  });
  (cRes.data||[]).forEach(row=>{
    if(!copyFolderCounts.has(row.folder_id))copyFolderCounts.set(row.folder_id,new Map());
    const map=copyFolderCounts.get(row.folder_id);
    map.set(row.collection_item_id,(map.get(row.collection_item_id)||0)+1);
  });
  if(activeFolderId&&!folders.some(f=>f.id===activeFolderId))activeFolderId=null;
  renderFolderChips();populateManualFolderSelect();return true;
}

function folderItems(folderId){
  if(!folderId)return [...items];
  const ids=folderMembership.get(folderId)||new Set(),copyCounts=copyFolderCounts.get(folderId)||new Map();
  return items.flatMap(x=>{
    if(ids.has(x.id))return [x];
    const copies=copyCounts.get(x.id)||0;
    return copies?[{...x,quantity:copies}]:[];
  });
}
function effectivePrice(x){return x?.valueOverride!=null?Number(x.valueOverride):Number(x?.price||0);}
function collectionValue(rows){
  return rows.reduce((sum,x)=>sum+((x.priceCurrency==='USD'||!x.priceCurrency)?effectivePrice(x)*Number(x.quantity||0):0),0);
}
function renderFolderChips(){
  const box=$('#libraryFolderChips');if(!box)return;
  box.innerHTML='';
  const main=document.createElement('button');
  main.type='button';main.className='folderchip'+(!activeFolderId?' active':'');
  main.textContent='Main Library';
  main.onclick=()=>{activeFolderId=null;renderFolderChips();renderLibrary();};
  box.appendChild(main);
  folders.forEach(folder=>{
    const b=document.createElement('button');b.type='button';b.className='folderchip'+(activeFolderId===folder.id?' active':'');
    b.textContent=folder.name;
    b.onclick=()=>{activeFolderId=folder.id;renderFolderChips();renderLibrary();};
    box.appendChild(b);
  });
}
function populateManualFolderSelect(){
  const sel=$('#manualFolder');if(!sel)return;
  sel.innerHTML='<option value="">Main Library only</option>'+folders.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+'</option>').join('');
}
async function createFolder(){
  const name=prompt('Folder name');
  if(!name||!name.trim())return;
  const clean=name.trim(),id=crypto.randomUUID(),now=new Date().toISOString();
  if(offlineMode||!navigator.onLine){
    folders.push({id,user_id:currentUser.id,name:clean,created_at:now,updated_at:now});
    folders.sort((a,b)=>a.name.localeCompare(b.name));
    queueOfflineMutation('folder_create',{id,user_id:currentUser.id,name:clean,created_at:now,updated_at:now});
    renderFolderChips();populateManualFolderSelect();renderLibrary();return;
  }
  const {error}=await sb.from('collection_folders').insert({user_id:currentUser.id,name:clean});
  if(error)return toast(error.code==='23505'?'A folder with that name already exists':'Could not create folder');
  await loadFolders();saveOfflineSnapshot();renderLibrary();toast('Folder created');
}
function renderFolderManager(){
  const box=$('#folderManagerList');box.innerHTML='';
  if(!folders.length){box.innerHTML='<div class="empty">No folders yet.</div>';return;}
  folders.forEach(folder=>{
    const row=document.createElement('div');row.className='foldermanagerrow';
    row.innerHTML='<strong>'+esc(folder.name)+'</strong><div><button class="secondary" data-rename>Rename</button><button class="dangerbtn" data-delete>Delete</button></div>';
    row.querySelector('[data-rename]').onclick=async()=>{
      const name=prompt('Rename folder',folder.name);
      if(!name||!name.trim()||name.trim()===folder.name)return;
      const {error}=await sb.from('collection_folders').update({name:name.trim(),updated_at:new Date().toISOString()}).eq('id',folder.id);
      if(error)return toast('Could not rename folder');
      await loadFolders();renderFolderManager();renderLibrary();
    };
    row.querySelector('[data-delete]').onclick=async()=>{
      if(!confirm('Delete folder "'+folder.name+'"? Cards stay in your Main Library.'))return;
      const {error}=await sb.from('collection_folders').delete().eq('id',folder.id);
      if(error)return toast('Could not delete folder');
      if(activeFolderId===folder.id)activeFolderId=null;
      await loadFolders();renderFolderManager();renderLibrary();toast('Folder deleted');
    };
    box.appendChild(row);
  });
}
function openFolderAssignments(item){
  folderAssignItemId=item.id;
  $('#folderAssignTitle').textContent='Folders for '+item.name;
  const box=$('#folderAssignOptions');box.innerHTML='';
  if(!folders.length){box.innerHTML='<div class="empty">Create a folder first.</div>';}
  folders.forEach(folder=>{
    const checked=(folderMembership.get(folder.id)||new Set()).has(item.id);
    const label=document.createElement('label');label.className='foldercheck';
    label.innerHTML='<input type="checkbox" value="'+esc(folder.id)+'" '+(checked?'checked':'')+'><span>'+esc(folder.name)+'</span>';
    box.appendChild(label);
  });
  $('#folderAssignDialog').showModal();
}
async function saveFolderAssignments(){
  if(!folderAssignItemId)return;
  const selected=Array.from(document.querySelectorAll('#folderAssignOptions input:checked')).map(x=>x.value);
  if(offlineMode||!navigator.onLine){
    folders.forEach(folder=>{
      if(!folderMembership.has(folder.id))folderMembership.set(folder.id,new Set());
      const set=folderMembership.get(folder.id);
      selected.includes(folder.id)?set.add(folderAssignItemId):set.delete(folderAssignItemId);
    });
    queueOfflineMutation('folder_assignments',{itemId:folderAssignItemId,folderIds:selected});
    $('#folderAssignDialog').close();renderFolderChips();renderLibrary();return;
  }
  for(const folder of folders){
    const has=(folderMembership.get(folder.id)||new Set()).has(folderAssignItemId);
    const want=selected.includes(folder.id);
    if(want&&!has)await sb.from('collection_folder_items').insert({folder_id:folder.id,collection_item_id:folderAssignItemId});
    if(!want&&has)await sb.from('collection_folder_items').delete().eq('folder_id',folder.id).eq('collection_item_id',folderAssignItemId);
  }
  $('#folderAssignDialog').close();
  await loadFolders();saveOfflineSnapshot();renderLibrary();toast('Folders updated');
}
function openManualCard(){
  $('#manualCardMessage').textContent='';$('#manualCardMessage').classList.remove('error');
  $('#manualName').value='';$('#manualSetName').value='';$('#manualLocalId').value='';
  $('#manualVariant').value='Normal';$('#manualCondition').value='Near Mint';$('#manualLanguage').value='English';
  $('#manualQuantity').value='1';$('#manualCurrentValue').value='';$('#manualPricePaid').value='';$('#manualImageUrl').value='';
  $('#manualPurchaseDate').value='';$('#manualCardState').value='raw';$('#manualGradingCompany').value='';$('#manualGrade').value='';$('#manualCertNumber').value='';
  populateManualFolderSelect();
  $('#manualCardDialog').showModal();
}
async function saveManualCard(){
  const name=$('#manualName').value.trim();
  if(!name){$('#manualCardMessage').textContent='Card name is required.';$('#manualCardMessage').classList.add('error');return;}
  const qty=Math.max(1,parseInt($('#manualQuantity').value||'1',10));
  const now=new Date().toISOString(),id=crypto.randomUUID();
  const obj={
    id,game:$('#manualGame').value,cardId:'manual:'+crypto.randomUUID(),name,
    localId:$('#manualLocalId').value.trim(),setId:'',setName:$('#manualSetName').value.trim(),rarity:'',
    variant:$('#manualVariant').value.trim()||'Normal',condition:$('#manualCondition').value,
    language:$('#manualLanguage').value.trim()||'English',quantity:qty,image:$('#manualImageUrl').value.trim(),
    price:$('#manualCurrentValue').value===''?null:Number($('#manualCurrentValue').value),
    pricePaid:$('#manualPricePaid').value===''?null:Number($('#manualPricePaid').value),
    priceCurrency:'USD',priceSource:'Manual',priceUpdatedAt:now,entrySource:'manual',valueOverride:null,
    cardState:$('#manualCardState').value,gradingCompany:$('#manualGradingCompany').value.trim(),
    grade:$('#manualGrade').value.trim(),certNumber:$('#manualCertNumber').value.trim(),
    purchaseDate:$('#manualPurchaseDate').value||'',notes:'',addedAt:now,updatedAt:now
  };
  const folderId=$('#manualFolder').value;
  if(offlineMode||!navigator.onLine){
    items.unshift(obj);
    if(folderId){
      if(!folderMembership.has(folderId))folderMembership.set(folderId,new Set());
      folderMembership.get(folderId).add(id);
    }
    queueOfflineMutation('collection_insert',{id,...toRow(obj),added_at:now,updated_at:now});
    if(folderId)queueOfflineMutation('folder_assignments',{itemId:id,folderIds:[folderId]});
    $('#manualCardDialog').close();renderDashboard();renderLibrary();haptic();toast(name+' added offline');return;
  }
  const {data,error}=await sb.from('collection_items').insert({id,...toRow(obj),added_at:now,updated_at:now}).select().single();
  if(error){$('#manualCardMessage').textContent=error.message;$('#manualCardMessage').classList.add('error');return;}
  if(folderId)await sb.from('collection_folder_items').insert({folder_id:folderId,collection_item_id:data.id});
  $('#manualCardDialog').close();
  await loadCollection();await loadFolders();saveOfflineSnapshot();renderDashboard();renderLibrary();haptic();toast(name+' added');
}

function fromRow(r){return {id:r.id,game:r.game,cardId:r.card_id,name:r.name,localId:r.local_id,setId:r.set_id,setName:r.set_name,rarity:r.rarity,variant:r.variant,condition:r.condition,language:r.language,quantity:r.quantity,image:r.image_url,price:r.price==null?null:Number(r.price),valueOverride:r.value_override==null?null:Number(r.value_override),pricePaid:r.price_paid==null?null:Number(r.price_paid),priceCurrency:r.price_currency,priceSource:r.price_source,priceUpdatedAt:r.price_updated_at,entrySource:r.entry_source||'provider',cardState:r.card_state||'raw',gradingCompany:r.grading_company||'',grade:r.grade||'',certNumber:r.cert_number||'',purchaseDate:r.purchase_date||'',notes:r.notes||'',addedAt:r.added_at,updatedAt:r.updated_at};}
function toRow(x){return {user_id:currentUser.id,game:x.game,card_id:x.cardId,name:x.name,local_id:x.localId,set_id:x.setId,set_name:x.setName,rarity:x.rarity,variant:x.variant,condition:x.condition,language:x.language,quantity:x.quantity,image_url:x.image,price:x.price,value_override:x.valueOverride??null,price_paid:x.pricePaid,price_currency:x.priceCurrency,price_source:x.priceSource,price_updated_at:x.priceUpdatedAt,entry_source:x.entrySource||'provider',card_state:x.cardState||'raw',grading_company:x.gradingCompany||null,grade:x.grade||null,cert_number:x.certNumber||null,purchase_date:x.purchaseDate||null,notes:x.notes||'',updated_at:new Date().toISOString()};}
async function signIn(e){
  e.preventDefault();
  const stay=$('#staySignedIn')?.checked===true;
  localStorage.setItem(STAY_SIGNED_IN_KEY,stay?'true':'false');
  setAuthMessage('Signing in…');
  try{
    const {data,error}=await sb.auth.signInWithPassword({
      email:$('#signInEmail').value.trim(),
      password:$('#signInPassword').value
    });
    if(error)return setAuthMessage(error.message,true);
    setAuthMessage('Loading your DeckVault…');
    await showApp(data.user);
  }catch(err){
    console.error(err);
    setAuthMessage(err?.message||'Sign-in failed. Please try again.',true);
  }
}
async function signUp(e){e.preventDefault();showPane('applicationPane');setAuthMessage('New DeckVault accounts require administrator approval.');}
async function resetPassword(e){e.preventDefault();setAuthMessage('Sending recovery email…');const {error}=await sb.auth.resetPasswordForEmail($('#resetEmail').value.trim(),{redirectTo:location.origin+location.pathname});if(error)return setAuthMessage(error.message,true);setAuthMessage('Recovery email sent.');}
async function signOut(){await sb.auth.signOut();items=[];hideAccessGates();showAuth();}

function go(view){if(view!=='scanner'&&activeScanRunning)stopActiveScan(false);$$('.view').forEach(v=>v.classList.toggle('active',v.id===view));$$('.bottomnav button').forEach(b=>b.classList.toggle('active',b.dataset.go===view));window.scrollTo({top:0,behavior:'smooth'});if(view==='dashboard')renderDashboard();if(view==='library')renderLibrary();}
async function pokemonSearch(name,number){const p=new URLSearchParams();if(name)p.set('name',name.trim());if(number)p.set('localId',number.trim());const r=await fetch(API+'/cards?'+p);if(!r.ok)throw new Error('TCGdex search failed ('+r.status+')');return r.json();}
async function pokemonCard(id){const r=await fetch(API+'/cards/'+encodeURIComponent(id));if(!r.ok)throw new Error('Could not load card');return r.json();}
async function pokemonSets(){if(pokemonSetCache)return pokemonSetCache;const r=await fetch(API+'/sets');if(!r.ok)throw new Error('Could not load Pokémon sets');pokemonSetCache=await r.json();return pokemonSetCache;}
async function pokemonSetCard(setId,localId){const r=await fetch(API+'/sets/'+encodeURIComponent(setId)+'/'+encodeURIComponent(localId));if(!r.ok)return null;return r.json();}

function pokemonVariants(c){const v=c.variants||{},o=[];if(v.normal)o.push('Normal');if(v.holo)o.push('Holofoil');if(v.reverse)o.push('Reverse Holofoil');if(v.firstEdition)o.push('1st Edition');if(v.firstEdition&&v.holo)o.push('1st Edition Holofoil');return o.length?[...new Set(o)]:['Normal'];}
function variantPriceObject(tcg,v){if(!tcg)return null;const m={'Normal':['normal','unlimited'],'Holofoil':['holofoil','holo','unlimited-holofoil'],'Reverse Holofoil':['reverse-holofoil','reverse'],'1st Edition':['1st-edition','first-edition','firstEdition'],'1st Edition Holofoil':['1st-edition-holofoil','first-edition-holofoil']};for(const k of (m[v]||['normal']))if(tcg[k])return tcg[k];return null;}
function pricePref(){return localStorage.getItem('deckvault-price-source')||'tcgplayer-market';}
function pokemonPrice(c,v,s=pricePref()){const p=c.pricing||{};if(s.startsWith('tcgplayer')){const o=variantPriceObject(p.tcgplayer,v);return {value:s==='tcgplayer-mid'?(o&&o.midPrice):(o&&o.marketPrice),currency:(p.tcgplayer&&p.tcgplayer.unit)||'USD',label:s==='tcgplayer-mid'?'TCGplayer Mid':'TCGplayer Market'};}const cm=p.cardmarket||{},foil=v.toLowerCase().includes('holo'),k=s==='cardmarket-7'?(foil?'avg7-holo':'avg7'):(foil?'avg30-holo':'avg30');return {value:cm[k],currency:cm.unit||'EUR',label:s==='cardmarket-7'?'Cardmarket 7-day':'Cardmarket 30-day'};}
async function search(){const n=$('#searchName').value.trim(),no=$('#searchNumber').value.trim();if(!n&&!no)return toast('Enter a name or collector number');$('#searchStatus').textContent='Searching TCGdex…';try{const cards=await pokemonSearch(n,no);$('#searchStatus').textContent=cards.length+' match'+(cards.length===1?'':'es')+' found';renderResults(cards);}catch(e){$('#searchStatus').textContent=e.message;}}
function renderResults(cards){const b=$('#results');b.innerHTML='';if(!cards.length){b.innerHTML='<div class="empty">No matching cards found.</div>';return;}cards.slice(0,60).forEach(c=>{const e=document.createElement('article');e.className='result';e.innerHTML='<img loading="lazy" src="'+esc(imageUrl(c.image))+'" alt="'+esc(c.name)+'"><div class="info"><strong>'+esc(c.name)+'</strong><div class="meta">#'+esc(c.localId)+' • '+esc(c.id)+'</div><button>View / Add</button></div>';e.querySelector('button').onclick=()=>openCard(c.id);b.appendChild(e);});}

async function openCard(id){
  $('#dialogBody').innerHTML='<div class="skeletoncard"></div><div class="skeletonline"></div><div class="skeletonline short"></div>';$('#cardDialog').showModal();
  try{
    currentCard=await pokemonCard(id);
    const variants=pokemonVariants(currentCard),p=pokemonPrice(currentCard,variants[0]);
    const folderOptions='<option value="">Main Library only</option>'+folders.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+'</option>').join('');
    $('#dialogBody').innerHTML='<div class="dialogtop"><img id="lookupCardImage" src="'+esc(imageUrl(currentCard.image,'high'))+'" alt="'+esc(currentCard.name)+'"><div><div class="eyebrow">'+esc(currentCard.set?.name||'Pokémon TCG')+'</div><h2>'+esc(currentCard.name)+'</h2><div class="muted">#'+esc(currentCard.localId)+(currentCard.rarity?' • '+esc(currentCard.rarity):'')+'</div><div class="pricebox"><div id="dialogPriceLabel" class="muted">'+esc(p.label)+'</div><div id="dialogPrice" class="pricebig">'+money(p.value,p.currency)+'</div></div></div></div>'+
      '<div class="fields">'+
      '<label>Variant<select id="variant">'+variants.map(v=>'<option>'+esc(v)+'</option>').join('')+'</select></label>'+
      '<label>Condition<select id="condition"><option>Near Mint</option><option>Lightly Played</option><option>Moderately Played</option><option>Heavily Played</option><option>Damaged</option></select></label>'+
      '<label>Language<select id="language"><option>English</option><option>Japanese</option><option>French</option><option>German</option><option>Italian</option><option>Spanish</option></select></label>'+
      '<label>Quantity<input id="qty" type="number" min="1" value="1"></label>'+
      '<label>Price paid each <span class="muted">optional</span><input id="pricePaid" type="number" min="0" step="0.01" placeholder="0.00"></label>'+
      '<label>Purchase date<input id="purchaseDate" type="date"></label>'+
      '<label>Card state<select id="cardState"><option value="raw">Raw</option><option value="graded">Graded</option></select></label>'+
      '<label>Grading company<select id="gradingCompany"><option value="">—</option><option>PSA</option><option>CGC</option><option>BGS</option><option>TAG</option><option>SGC</option><option>Other</option></select></label>'+
      '<label>Grade<input id="grade" maxlength="20" placeholder="e.g. 10"></label>'+
      '<label>Certification #<input id="certNumber" maxlength="80" placeholder="Optional"></label>'+
      '<label>Value override <span class="muted">optional for graded cards</span><input id="valueOverride" type="number" min="0" step="0.01" placeholder="0.00"></label>'+
      '<label>Add to folder<select id="addFolder">'+folderOptions+'</select></label>'+
      '</div><div class="dialogactions"><button id="addCard" type="button" class="primary">Add to collection</button><button class="secondary" value="cancel">Cancel</button></div>';
    $('#lookupCardImage').onclick=()=>openImageZoom($('#lookupCardImage').src,currentCard.name);
    $('#variant').onchange=()=>{const q=pokemonPrice(currentCard,$('#variant').value);$('#dialogPrice').textContent=money(q.value,q.currency);$('#dialogPriceLabel').textContent=q.label;};
    $('#addCard').onclick=addCurrent;
  }catch(e){$('#dialogBody').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
async function addCurrent(){
  const variant=$('#variant').value,condition=$('#condition').value,language=$('#language').value;
  const qty=Math.max(1,parseInt($('#qty').value||'1',10)),p=pokemonPrice(currentCard,variant);
  const old=items.find(x=>x.game==='pokemon'&&x.cardId===currentCard.id&&x.variant===variant&&x.condition===condition&&x.language===language&&x.cardState===$('#cardState').value);
  const now=new Date().toISOString();
  const paid=$('#pricePaid').value===''?(old?.pricePaid??null):Number($('#pricePaid').value);
  const id=old?.id||crypto.randomUUID();
  const x={
    id,game:'pokemon',cardId:currentCard.id,name:currentCard.name,localId:String(currentCard.localId),
    setId:currentCard.set?.id||'',setName:currentCard.set?.name||'',rarity:currentCard.rarity||'',
    variant,condition,language,quantity:(old?old.quantity:0)+qty,image:currentCard.image||'',
    price:p.value==null?null:Number(p.value),pricePaid:paid,priceCurrency:p.currency,priceSource:p.label,
    priceUpdatedAt:now,entrySource:'provider',cardState:$('#cardState').value,
    gradingCompany:$('#gradingCompany').value.trim(),grade:$('#grade').value.trim(),
    certNumber:$('#certNumber').value.trim(),purchaseDate:$('#purchaseDate').value||'',
    valueOverride:$('#valueOverride').value===''?(old?.valueOverride??null):Number($('#valueOverride').value),
    notes:old?.notes||'',addedAt:old?.addedAt||now,updatedAt:now
  };
  const folderId=$('#addFolder').value;
  if(offlineMode||!navigator.onLine){
    if(old)Object.assign(old,x);else items.unshift(x);
    queueOfflineMutation(old?'collection_update':'collection_insert',
      old?{id,...toRow(x),updated_at:now}:{id,...toRow(x),added_at:now,updated_at:now},
      old?.updatedAt||null);
    if(folderId){
      if(!folderMembership.has(folderId))folderMembership.set(folderId,new Set());
      folderMembership.get(folderId).add(id);
      queueOfflineMutation('folder_assignments',{itemId:id,folderIds:[folderId]});
    }
    $('#cardDialog').close();renderDashboard();renderLibrary();haptic();toast(currentCard.name+' saved offline');return;
  }
  let q;
  if(old)q=await sb.from('collection_items').update(toRow(x)).eq('id',old.id).select().single();
  else q=await sb.from('collection_items').insert({id,...toRow(x),added_at:now,updated_at:now}).select().single();
  if(q.error)return toast('Could not save card');
  if(currentCard?.set?.id&&currentCard?.id){
    sb.from('master_set_cards').upsert({user_id:currentUser.id,game:'pokemon',set_id:currentCard.set.id,card_id:currentCard.id},{onConflict:'user_id,game,set_id,card_id'}).then(()=>{});
  }
  if(folderId)await sb.from('collection_folder_items').upsert({folder_id:folderId,collection_item_id:q.data.id},{onConflict:'folder_id,collection_item_id'});
  $('#cardDialog').close();
  await loadCollection();await loadFolders();saveOfflineSnapshot();renderDashboard();renderLibrary();haptic();toast(currentCard.name+' saved');
}
function rowFor(x,compact){
  const e=document.createElement('div');e.className='cardrow';const total=effectivePrice(x)*Number(x.quantity||0);
  const grade=x.cardState==='graded'&&x.gradingCompany?(' • '+x.gradingCompany+' '+(x.grade||'')):'';
  e.innerHTML='<img loading="lazy" src="'+esc(imageUrl(x.image))+'"><div class="cardmain"><div class="cardtitle">'+esc(x.name)+'</div><div class="cardmeta">'+esc(x.setName)+' • #'+esc(x.localId)+' • '+esc(x.variant)+' • '+esc(x.condition)+esc(grade)+'</div>'+(compact?'':'<div class="qty"><button data-a="dec">−</button><span>'+x.quantity+'</span><button data-a="inc">+</button><button data-a="del">×</button></div>')+'</div><div class="cardprice">'+money(total,x.priceCurrency||'USD')+'<div class="cardmeta">×'+x.quantity+'</div></div>';
  if(!compact){e.querySelector('[data-a="inc"]').onclick=()=>adjust(x,1);e.querySelector('[data-a="dec"]').onclick=()=>adjust(x,-1);e.querySelector('[data-a="del"]').onclick=()=>removeEntry(x);}
  return e;
}
async function adjust(x,d){
  const q=x.quantity+d;if(q<=0)return removeEntry(x);
  const now=new Date().toISOString(),base=x.updatedAt;
  if(offlineMode||!navigator.onLine){
    x.quantity=q;x.updatedAt=now;
    queueOfflineMutation('quantity_update',{id:x.id,quantity:q,updated_at:now},base);
    renderLibrary();renderDashboard();return;
  }
  const {error}=await sb.from('collection_items').update({quantity:q,updated_at:now}).eq('id',x.id);
  if(error)return toast('Could not update quantity');
  await loadCollection();saveOfflineSnapshot();renderLibrary();renderDashboard();
}
async function removeEntry(x){
  if(!confirm('Remove '+x.name+' from this collection?'))return;
  if(offlineMode||!navigator.onLine){
    const base=x.updatedAt;items=items.filter(i=>i.id!==x.id);
    folderMembership.forEach(set=>set.delete(x.id));
    queueOfflineMutation('collection_delete',{id:x.id},base);
    renderLibrary();renderDashboard();return;
  }
  const {error}=await sb.from('collection_items').delete().eq('id',x.id);
  if(error)return toast('Could not remove card');
  await loadCollection();await loadFolders();saveOfflineSnapshot();renderLibrary();renderDashboard();
}
async function renderDashboardExtras(){
  if(!currentUser)return;
  const folderBox=$('#analyticsFolders');
  if(folderBox){
    folderBox.innerHTML='';
    const rows=[{name:'Main Library',value:collectionValue(items)},...folders.map(f=>({name:f.name,value:collectionValue(folderItems(f.id))}))].sort((a,b)=>b.value-a.value).slice(0,6);
    rows.forEach(r=>{const e=document.createElement('div');e.className='analyticsrow';e.innerHTML='<span>'+esc(r.name)+'</span><strong>'+money(r.value)+'</strong>';folderBox.appendChild(e);});
  }
  if(!navigator.onLine||offlineMode)return;
  try{
    const [{data:watch},{data:owned},{data:movers,error:moverError}]=await Promise.all([
      sb.from('card_watchlist').select('card_id').eq('user_id',currentUser.id),
      sb.from('master_set_cards').select('set_id,card_id').eq('user_id',currentUser.id).eq('game','pokemon'),
      sb.rpc('collection_price_movers',{p_days:30,p_limit:8})
    ]);
    $('#analyticsWatchCount').textContent=String(watch?.length||0);
    const setBox=$('#analyticsSets');if(setBox){
      setBox.innerHTML='<div class="skeletonline"></div><div class="skeletonline short"></div>';
      const sets=await pokemonSets();
      const counts={};(owned||[]).forEach(r=>counts[r.set_id]=(counts[r.set_id]||0)+1);
      const top=(sets||[]).filter(x=>counts[x.id]).map(set=>({name:set.name,owned:counts[set.id]||0,total:Number(set.cardCount?.total||0)}))
        .sort((a,b)=>(b.total?b.owned/b.total:0)-(a.total?a.owned/a.total:0)).slice(0,6);
      setBox.innerHTML='';
      if(!top.length)setBox.innerHTML='<div class="empty compact">No Master Set progress yet.</div>';
      top.forEach(r=>{const pct=r.total?Math.min(100,r.owned/r.total*100):0;const e=document.createElement('div');e.className='analyticsprogress';e.innerHTML='<div><span>'+esc(r.name)+'</span><strong>'+r.owned+' / '+r.total+'</strong></div><i><b style="width:'+pct+'%"></b></i>';setBox.appendChild(e);});
    }
    const moverBox=$('#analyticsMovers');if(moverBox){
      moverBox.innerHTML='';
      if(moverError){moverBox.innerHTML='<div class="empty compact">Could not load price movers.</div>';}
      else if(!movers?.length){moverBox.innerHTML='<div class="empty compact">Price movers will appear after DeckVault has enough 30-day snapshot history.</div>';}
      else movers.forEach(m=>{const pct=Number(m.percent_change||0),e=document.createElement('button');e.type='button';e.className='moverrow '+(pct>=0?'up':'down');e.innerHTML='<div><strong>'+esc(m.card_name)+'</strong><span>'+esc(m.set_name||'')+' • '+esc(m.variant||'')+'</span></div><div><b>'+(pct>=0?'+':'')+pct.toFixed(1)+'%</b><small>'+money(m.previous_value,m.currency||'USD')+' → '+money(m.current_value,m.currency||'USD')+'</small></div>';e.onclick=()=>{const card=items.find(x=>x.cardId===m.card_id&&x.variant===m.variant);if(card){go('library');openLibraryCardDetails(card);}};moverBox.appendChild(e);});
    }
  }catch(e){console.warn('Dashboard extras',e);}
}
function renderDashboard(){
  const count=items.reduce((sum,x)=>sum+Number(x.quantity||0),0);
  const total=items.reduce((sum,x)=>sum+((x.priceCurrency==='USD'||!x.priceCurrency)?effectivePrice(x)*Number(x.quantity||0):0),0);
  const spent=items.reduce((sum,x)=>sum+(x.pricePaid==null?0:Number(x.pricePaid)*Number(x.quantity||0)),0);
  const gain=total-spent,pct=spent?gain/spent*100:0;
  const top=[...items].sort((a,b)=>effectivePrice(b)*b.quantity-effectivePrice(a)*a.quantity)[0];
  $('#collectionValue').textContent=money(total);$('#totalCards').textContent=count.toLocaleString();$('#uniqueCards').textContent=items.length.toLocaleString();
  $('#duplicates').textContent=Math.max(0,count-items.length).toLocaleString();
  $('#setCount').textContent=new Set(items.map(x=>x.game+':'+x.setId).filter(Boolean)).size.toLocaleString();
  $('#analyticsSpend').textContent=money(spent);$('#analyticsGain').textContent=(gain>=0?'+':'')+money(gain);$('#analyticsGainPct').textContent=(pct>=0?'+':'')+pct.toFixed(1)+'%';
  $('#analyticsGain').classList.toggle('negative',gain<0);
  $('#analyticsTopCard').textContent=top?.name||'—';$('#analyticsTopCardValue').textContent=top?money(effectivePrice(top)*top.quantity,top.priceCurrency||'USD'):'$0.00';
  const r=[...items].sort((a,b)=>new Date(b.addedAt)-new Date(a.addedAt)).slice(0,5),b=$('#recent');b.innerHTML='';
  if(!r.length){b.className='panel empty';b.textContent='No cards yet.';}else{b.className='panel';r.forEach(x=>b.appendChild(rowFor(x,true)));}
  renderDashboardExtras();
}

const HISTORY_RANGES={
  '1d':1,'7d':7,'14d':14,'21d':21,'1m':30,'3m':90,'6m':180,'1y':365,'5y':1825,'max':null
};
let activeHistoryRange='1m';

function liveProviderValues(x,card,ebayRows=[]){
  const values=[];
  if(x.valueOverride!=null)values.push({provider:'DeckVault',label:'Value override',value:Number(x.valueOverride),currency:x.priceCurrency||'USD',kind:'selected'});
  else if(x.price!=null)values.push({provider:'DeckVault',label:x.priceSource||'Stored value',value:Number(x.price),currency:x.priceCurrency||'USD',kind:'selected'});
  if(card?.pricing?.tcgplayer){
    const tcg=variantPriceObject(card.pricing.tcgplayer,x.variant);
    if(tcg){
      [['marketPrice','Market'],['lowPrice','Low'],['midPrice','Mid'],['highPrice','High'],['directLowPrice','Direct low']].forEach(([field,label])=>{
        const v=Number(tcg[field]);
        if(Number.isFinite(v))values.push({provider:'TCGplayer',label,value:v,currency:card.pricing.tcgplayer.unit||'USD'});
      });
    }
  }
  if(card?.pricing?.cardmarket){
    const cm=card.pricing.cardmarket;
    const foil=String(x.variant||'').toLowerCase().includes('holo');
    const fields=foil
      ? [['trend-holo','Trend'],['low-holo','Low'],['avg1-holo','1-day avg'],['avg7-holo','7-day avg'],['avg30-holo','30-day avg']]
      : [['trend','Trend'],['low','Low'],['avg1','1-day avg'],['avg7','7-day avg'],['avg30','30-day avg']];
    fields.forEach(([field,label])=>{
      const v=Number(cm[field]);
      if(Number.isFinite(v))values.push({provider:'Cardmarket',label,value:v,currency:cm.unit||'EUR'});
    });
  }
  const verified=(ebayRows||[]).filter(r=>r.sale_status==='verified_completed'&&r.sold_price!=null).map(r=>Number(r.sold_price)+Number(r.shipping_price||0)).filter(Number.isFinite).sort((a,b)=>a-b);
  if(verified.length){
    const mid=Math.floor(verified.length/2);
    const med=verified.length%2?verified[mid]:(verified[mid-1]+verified[mid])/2;
    values.push({provider:'eBay',label:'Verified median',value:med,currency:ebayRows[0]?.currency||'USD'});
  }
  values.push({provider:'PriceCharting',label:'API subscription required',value:null,currency:'USD',kind:'unavailable'});
  return values;
}
function renderProviderValues(values){
  const box=$('#providerValueGrid');if(!box)return;
  box.innerHTML='';
  values.forEach(v=>{
    const e=document.createElement('div');e.className='providervalue'+(v.kind?' '+v.kind:'');
    e.innerHTML='<span>'+esc(v.provider)+'</span><strong>'+(v.value==null?'Not connected':money(v.value,v.currency||'USD'))+'</strong><small>'+esc(v.label)+'</small>';
    box.appendChild(e);
  });
}
function historyMetricLabel(provider,metric){
  const map={
    'tcgplayer|market':'TCGplayer Market',
    'tcgplayer|low':'TCGplayer Low',
    'tcgplayer|mid':'TCGplayer Mid',
    'tcgplayer|high':'TCGplayer High',
    'tcgplayer|direct-low':'TCGplayer Direct Low',
    'cardmarket|trend':'Cardmarket Trend',
    'cardmarket|low':'Cardmarket Low',
    'cardmarket|average':'Cardmarket Average',
    'cardmarket|avg-1d':'Cardmarket 1-day Avg',
    'cardmarket|avg-7d':'Cardmarket 7-day Avg',
    'cardmarket|avg-30d':'Cardmarket 30-day Avg'
  };
  return map[provider+'|'+metric]||provider+' '+metric;
}
function rangeStart(range){
  const days=HISTORY_RANGES[range];
  return days==null?null:new Date(Date.now()-days*86400000);
}
function renderHistoryChart(rows,range='1m'){
  const box=$('#priceHistoryChart'),summary=$('#priceHistorySummary');
  if(!box)return;
  const start=rangeStart(range);
  let pts=(rows||[]).filter(r=>!start||new Date(r.observed_at)>=start).map(r=>({t:new Date(r.observed_at).getTime(),v:Number(r.value),currency:r.currency})).filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.v)).sort((a,b)=>a.t-b.t);
  if(!pts.length){
    box.innerHTML='<div class="historyempty">No recorded history in this range yet.</div>';
    if(summary)summary.textContent='DeckVault begins recording price history from the first snapshot forward.';
    return;
  }
  const vals=pts.map(p=>p.v),min=Math.min(...vals),max=Math.max(...vals),first=pts[0],last=pts[pts.length-1];
  const spread=Math.max(max-min,Math.max(max,1)*0.04);
  const yMin=Math.max(0,min-spread*.25),yMax=max+spread*.25;
  const tMin=pts[0].t,tMax=pts.length===1?tMin+86400000:pts[pts.length-1].t;
  const W=760,H=300,L=55,R=16,T=18,B=38;
  const x=t=>L+(t-tMin)/(tMax-tMin)*(W-L-R);
  const y=v=>T+(yMax-v)/(yMax-yMin)*(H-T-B);
  const path=pts.map((p,i)=>(i?'L':'M')+x(p.t).toFixed(1)+' '+y(p.v).toFixed(1)).join(' ');
  const grid=[0,.25,.5,.75,1].map(frac=>{
    const yy=T+frac*(H-T-B),val=yMax-frac*(yMax-yMin);
    return '<line x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'" class="chartgrid"/><text x="'+(L-7)+'" y="'+(yy+4)+'" text-anchor="end" class="chartlabel">'+esc(money(val,pts[0].currency||'USD'))+'</text>';
  }).join('');
  const dots=pts.length<=45?pts.map(p=>'<circle cx="'+x(p.t)+'" cy="'+y(p.v)+'" r="3" class="chartdot"><title>'+new Date(p.t).toLocaleDateString()+': '+money(p.v,p.currency||'USD')+'</title></circle>').join(''):'';
  box.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Card price history chart">'+grid+'<path d="'+path+'" class="chartline" fill="none"/>'+dots+'<text x="'+L+'" y="'+(H-10)+'" class="chartlabel">'+new Date(first.t).toLocaleDateString()+'</text><text x="'+(W-R)+'" y="'+(H-10)+'" text-anchor="end" class="chartlabel">'+new Date(last.t).toLocaleDateString()+'</text></svg>';
  const diff=last.v-first.v,pct=first.v?diff/first.v*100:null;
  if(summary)summary.textContent=money(last.v,last.currency||'USD')+' latest • '+(diff>=0?'+':'')+money(diff,last.currency||'USD')+(pct==null?'':' ('+(pct>=0?'+':'')+pct.toFixed(1)+'%)')+' across '+pts.length+' recorded snapshot'+(pts.length===1?'':'s');
}
async function loadPriceHistory(x){
  const selector=$('#priceHistoryMetric');
  const {data,error}=await sb.from('card_price_snapshots')
    .select('provider,metric,value,currency,observed_at')
    .eq('game',x.game)
    .eq('card_id',x.cardId)
    .eq('variant',x.variant)
    .order('observed_at',{ascending:true})
    .limit(5000);
  if(error){console.error(error);$('#priceHistoryChart').innerHTML='<div class="historyempty">Could not load price history.</div>';return;}
  const rows=data||[];
  const keys=[...new Set(rows.map(r=>r.provider+'|'+r.metric))];
  const preferred=['tcgplayer|market','tcgplayer|mid','tcgplayer|low','tcgplayer|high','cardmarket|trend','cardmarket|avg-7d','cardmarket|avg-30d'];
  keys.sort((a,b)=>(preferred.indexOf(a)<0?999:preferred.indexOf(a))-(preferred.indexOf(b)<0?999:preferred.indexOf(b)));
  selector.innerHTML=keys.length?keys.map(k=>{const [p,m]=k.split('|');return '<option value="'+esc(k)+'">'+esc(historyMetricLabel(p,m))+'</option>';}).join(''):'<option value="">No history yet</option>';
  const choose=keys.includes('tcgplayer|market')?'tcgplayer|market':keys[0]||'';
  selector.value=choose;
  const draw=()=>{
    const key=selector.value,[p,m]=key.split('|');
    renderHistoryChart(rows.filter(r=>r.provider===p&&r.metric===m),activeHistoryRange);
  };
  selector.onchange=draw;
  document.querySelectorAll('.historyrange').forEach(b=>b.onclick=()=>{
    activeHistoryRange=b.dataset.range;
    document.querySelectorAll('.historyrange').forEach(x=>x.classList.toggle('active',x===b));
    draw();
  });
  draw();
}
async function refreshCardValuation(x){
  let card=null;
  if(x.game==='pokemon'&&x.entrySource!=='manual'&&!String(x.cardId).startsWith('manual:')){
    try{card=await pokemonCard(x.cardId);}catch(e){console.warn(e);}
    try{await sb.functions.invoke('snapshot-card-prices',{body:{card_id:x.cardId}});}catch(e){console.warn(e);}
  }
  const {data:ebayRows}=await sb.from('sales_comps_cache')
    .select('sold_price,shipping_price,currency,sale_status')
    .eq('game',x.game).eq('card_id',x.cardId)
    .order('sold_at',{ascending:false}).limit(30);
  renderProviderValues(liveProviderValues(x,card,ebayRows||[]));
  await loadPriceHistory(x);
}
function ebaySoldSearchUrl(x){
  const terms=[x.name,x.setName,x.localId].filter(Boolean).join(' ');
  const u=new URL('https://www.ebay.com/sch/i.html');
  u.searchParams.set('_nkw',terms);
  u.searchParams.set('LH_Sold','1');
  u.searchParams.set('LH_Complete','1');
  return u.toString();
}

async function loadWatchState(x){
  currentWatchState=null;
  if(!currentUser||!navigator.onLine||offlineMode)return null;
  const {data,error}=await sb.from('card_watchlist').select('*')
    .eq('user_id',currentUser.id).eq('game',x.game).eq('card_id',x.cardId).eq('variant',x.variant).maybeSingle();
  if(error){console.error(error);return null;}
  currentWatchState=data||null;return currentWatchState;
}
async function saveWatchState(x){
  if(!navigator.onLine||offlineMode)return toast('Watchlist changes need an internet connection');
  const target=$('#watchTargetPrice').value===''?null:Number($('#watchTargetPrice').value);
  const pct=Math.max(0,Number($('#watchChangePct').value||10));
  const payload={user_id:currentUser.id,game:x.game,card_id:x.cardId,variant:x.variant,card_name:x.name,set_name:x.setName,image_url:x.image,target_price:target,currency:x.priceCurrency||'USD',notify_change_pct:pct};
  const {error}=await sb.from('card_watchlist').upsert(payload,{onConflict:'user_id,game,card_id,variant'});
  if(error)return toast('Could not save watchlist');
  currentWatchState=payload;$('#watchCardBtn').textContent='★ Watching';$('#watchRemoveBtn').classList.remove('hidden');haptic();renderDashboard();toast('Watchlist saved');
}
async function removeWatchState(x){
  const {error}=await sb.from('card_watchlist').delete().eq('user_id',currentUser.id).eq('game',x.game).eq('card_id',x.cardId).eq('variant',x.variant);
  if(error)return toast('Could not remove watch');
  currentWatchState=null;$('#watchCardBtn').textContent='☆ Add to Watchlist';$('#watchRemoveBtn').classList.add('hidden');renderDashboard();toast('Removed from Watchlist');
}
async function populateWatchControls(x){
  const state=await loadWatchState(x);
  if(!$('#watchCardBtn'))return;
  $('#watchCardBtn').textContent=state?'★ Watching':'☆ Add to Watchlist';
  $('#watchTargetPrice').value=state?.target_price??'';
  $('#watchChangePct').value=state?.notify_change_pct??10;
  $('#watchRemoveBtn').classList.toggle('hidden',!state);
}

async function ensureCopyRows(x){
  if(!navigator.onLine||offlineMode)return [];
  const {data,error}=await sb.from('collection_copies').select('*').eq('collection_item_id',x.id).order('created_at');
  if(error)throw error;
  let rows=data||[];
  const missing=Math.max(0,Number(x.quantity||0)-rows.length);
  if(missing){
    const inserts=Array.from({length:missing},()=>({
      user_id:currentUser.id,collection_item_id:x.id,condition:x.condition,price_paid:x.pricePaid,current_value:x.valueOverride??null,
      purchase_date:x.purchaseDate||null,card_state:x.cardState||'raw',grading_company:x.gradingCompany||null,
      grade:x.grade||null,cert_number:x.certNumber||null
    }));
    const {data:created,error:createErr}=await sb.from('collection_copies').insert(inserts).select();
    if(createErr)throw createErr;rows=[...rows,...(created||[])];
  }
  return rows;
}
function copyFolderOptions(selected=''){
  return '<option value="">No specific folder</option>'+folders.map(f=>'<option value="'+esc(f.id)+'" '+(selected===f.id?'selected':'')+'>'+esc(f.name)+'</option>').join('');
}
function renderCopyRows(rows){
  const box=$('#copiesList');box.innerHTML='';
  if(!rows.length){box.innerHTML='<div class="empty">No individual copies yet.</div>';return;}
  rows.forEach((copy,index)=>{
    const e=document.createElement('article');e.className='copyrow';e.dataset.copyId=copy.id;
    e.innerHTML='<div class="copyrowhead"><strong>Copy '+(index+1)+'</strong><button class="dangerbtn" data-copy-delete type="button">Remove</button></div>'+
      '<div class="fields">'+
      '<label>Condition<select data-copy-condition>'+['Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged'].map(v=>'<option '+(copy.condition===v?'selected':'')+'>'+v+'</option>').join('')+'</select></label>'+
      '<label>Price paid<input data-copy-paid type="number" min="0" step="0.01" value="'+esc(copy.price_paid??'')+'"></label>'+
      '<label>Current value<input data-copy-value type="number" min="0" step="0.01" value="'+esc(copy.current_value??'')+'"></label>'+
      '<label>Purchase date<input data-copy-date type="date" value="'+esc(copy.purchase_date||'')+'"></label>'+
      '<label>Folder<select data-copy-folder>'+copyFolderOptions(copy.folder_id||'')+'</select></label>'+
      '<label>State<select data-copy-state><option value="raw" '+(copy.card_state==='raw'?'selected':'')+'>Raw</option><option value="graded" '+(copy.card_state==='graded'?'selected':'')+'>Graded</option></select></label>'+
      '<label>Company<input data-copy-company value="'+esc(copy.grading_company||'')+'" placeholder="PSA, CGC, BGS…"></label>'+
      '<label>Grade<input data-copy-grade value="'+esc(copy.grade||'')+'" placeholder="10"></label>'+
      '<label>Certification #<input data-copy-cert value="'+esc(copy.cert_number||'')+'"></label>'+
      '<label class="fullfield">Notes<input data-copy-notes value="'+esc(copy.notes||'')+'"></label>'+
      '</div><button class="secondary wide" data-copy-save type="button">Save copy</button>';
    e.querySelector('[data-copy-save]').onclick=()=>saveCopyRow(copy.id,e);
    e.querySelector('[data-copy-delete]').onclick=()=>deleteCopyRow(copy.id);
    box.appendChild(e);
  });
}
async function openCopiesManager(x){
  if(!navigator.onLine||offlineMode)return toast('Individual copy management needs an internet connection');
  currentCopyItem=x;$('#copiesDialogTitle').textContent='Copies of '+x.name;$('#copiesList').innerHTML='<div class="skeletonline"></div><div class="skeletonline short"></div>';$('#copiesDialog').showModal();
  try{renderCopyRows(await ensureCopyRows(x));}catch(e){console.error(e);$('#copiesList').innerHTML='<div class="empty">Could not load copies.</div>';}
}
async function reloadCopies(){if(currentCopyItem)renderCopyRows(await ensureCopyRows(currentCopyItem));}
async function saveCopyRow(id,node){
  const payload={
    condition:node.querySelector('[data-copy-condition]').value,
    price_paid:node.querySelector('[data-copy-paid]').value===''?null:Number(node.querySelector('[data-copy-paid]').value),
    current_value:node.querySelector('[data-copy-value]').value===''?null:Number(node.querySelector('[data-copy-value]').value),
    purchase_date:node.querySelector('[data-copy-date]').value||null,
    folder_id:node.querySelector('[data-copy-folder]').value||null,
    card_state:node.querySelector('[data-copy-state]').value,
    grading_company:node.querySelector('[data-copy-company]').value.trim()||null,
    grade:node.querySelector('[data-copy-grade]').value.trim()||null,
    cert_number:node.querySelector('[data-copy-cert]').value.trim()||null,
    notes:node.querySelector('[data-copy-notes]').value.trim()||null,
    updated_at:new Date().toISOString()
  };
  const {error}=await sb.from('collection_copies').update(payload).eq('id',id);
  if(error)return toast('Could not save copy');await loadFolders();renderLibrary();renderDashboard();haptic();toast('Copy saved');
}
async function addCopyRow(){
  if(!currentCopyItem)return;
  const x=currentCopyItem;
  const {error}=await sb.from('collection_copies').insert({
    user_id:currentUser.id,collection_item_id:x.id,condition:x.condition,price_paid:x.pricePaid,current_value:x.valueOverride??null,
    purchase_date:x.purchaseDate||null,card_state:x.cardState||'raw',grading_company:x.gradingCompany||null,
    grade:x.grade||null,cert_number:x.certNumber||null
  });
  if(error)return toast('Could not add copy');
  const quantity=x.quantity+1,now=new Date().toISOString();
  await sb.from('collection_items').update({quantity,updated_at:now}).eq('id',x.id);
  x.quantity=quantity;x.updatedAt=now;await loadFolders();await reloadCopies();renderLibrary();renderDashboard();
}
async function deleteCopyRow(id){
  if(!currentCopyItem||!confirm('Remove this individual copy?'))return;
  const {error}=await sb.from('collection_copies').delete().eq('id',id);if(error)return toast('Could not remove copy');
  const quantity=Math.max(0,currentCopyItem.quantity-1);
  if(quantity===0){await sb.from('collection_items').delete().eq('id',currentCopyItem.id);$('#copiesDialog').close();await loadCollection();renderLibrary();renderDashboard();return;}
  await sb.from('collection_items').update({quantity,updated_at:new Date().toISOString()}).eq('id',currentCopyItem.id);
  currentCopyItem.quantity=quantity;await loadFolders();await reloadCopies();renderLibrary();renderDashboard();
}

async function openLibraryCardDetails(x){
  const box=$('#libraryCardDetails');
  const total=effectivePrice(x)*Number(x.quantity||0);
  const gradeLabel=x.cardState==='graded'?((x.gradingCompany||'Graded')+(x.grade?' '+x.grade:'')+(x.certNumber?' • Cert '+x.certNumber:'')):'Raw';
  const img=x.image?'<img id="libraryDetailImage" src="'+esc(imageUrl(x.image,'high'))+'" alt="'+esc(x.name)+'">':'<div class="librarydetailplaceholder">DV</div>';
  box.innerHTML='<div class="librarydetailtop">'+img+'<div><div class="eyebrow">'+esc(x.setName||'Collection card')+'</div><h2>'+esc(x.name)+'</h2><div class="muted">'+(x.localId?'#'+esc(x.localId)+' • ':'')+esc(x.variant)+' • '+esc(x.condition)+'</div><div class="gradebadge">'+esc(gradeLabel)+'</div>'+
    '<div class="detailmetrics"><div><span>Current value</span><strong>'+money(total,x.priceCurrency||'USD')+'</strong></div><div><span>Price paid each</span><strong>'+money(x.pricePaid,'USD')+'</strong></div><div><span>Quantity</span><strong>'+Number(x.quantity||0)+'</strong></div></div>'+
    '<div class="detailactions"><button id="manageCopiesBtn" class="secondary" type="button">Manage individual copies</button></div></div></div>'+
    '<div class="valuationsection watchsection"><div class="pagehead"><div><div class="eyebrow">WATCHLIST</div><h3>Price alerts</h3></div><button id="watchCardBtn" class="secondary" type="button">☆ Add to Watchlist</button></div>'+
    '<div class="watchcontrols"><label>Target price<input id="watchTargetPrice" type="number" min="0" step="0.01" placeholder="Optional"></label><label>Notify on change %<input id="watchChangePct" type="number" min="0" step="1" value="10"></label><button id="watchSaveBtn" class="secondary" type="button">Save alerts</button><button id="watchRemoveBtn" class="ghost hidden" type="button">Remove</button></div></div>'+
    '<div class="valuationsection"><div class="eyebrow">CURRENT VALUES</div><h3>Price sources</h3><div id="providerValueGrid" class="providervaluegrid"><div class="skeletonline"></div></div><p class="valuesnote">Provider prices are shown in their native currency and may represent different market methodologies. PriceCharting requires a paid API subscription before DeckVault can retrieve its current values. Historical charts only use recorded source data; DeckVault does not invent older prices.</p></div>'+
    '<div class="valuationsection"><div class="pricehistoryhead"><div><div class="eyebrow">PRICE HISTORY</div><h3>Value over time</h3></div><select id="priceHistoryMetric"><option>Loading…</option></select></div><div class="historyranges"><button type="button" class="historyrange" data-range="1d">1D</button><button type="button" class="historyrange" data-range="7d">7D</button><button type="button" class="historyrange" data-range="14d">14D</button><button type="button" class="historyrange" data-range="21d">21D</button><button type="button" class="historyrange active" data-range="1m">1M</button><button type="button" class="historyrange" data-range="3m">3M</button><button type="button" class="historyrange" data-range="6m">6M</button><button type="button" class="historyrange" data-range="1y">1Y</button><button type="button" class="historyrange" data-range="5y">5Y</button><button type="button" class="historyrange" data-range="max">Max</button></div><div id="priceHistoryChart" class="pricehistorychart"><div class="historyempty">Loading price history…</div></div><div id="priceHistorySummary" class="historysummary"></div></div>'+
    '<div class="salescomphead"><div><div class="eyebrow">MARKET COMPS</div><h3>Recent eBay Sales</h3></div><span id="ebayCompStatus" class="pill">Checking…</span></div><div id="ebayCompList" class="salescomplist"><div class="skeletonline"></div><div class="skeletonline short"></div></div><a id="openEbaySold" class="secondary ebaylink" target="_blank" rel="noopener noreferrer">View reported sold listings on eBay ↗</a><p class="salesdisclaimer">DeckVault only treats a comp as verified when the data source can confirm it remained a completed sale. eBay does not expose refund/cancellation outcomes for arbitrary third-party public sales, so ordinary public “sold” results may include transactions later reversed.</p>';
  $('#openEbaySold').href=ebaySoldSearchUrl(x);$('#libraryCardDialog').showModal();
  $('#libraryDetailImage')?.addEventListener('click',()=>openImageZoom($('#libraryDetailImage').src,x.name));
  $('#manageCopiesBtn').onclick=()=>openCopiesManager(x);
  $('#watchCardBtn').onclick=()=>saveWatchState(x);$('#watchSaveBtn').onclick=()=>saveWatchState(x);$('#watchRemoveBtn').onclick=()=>removeWatchState(x);
  activeHistoryRange='1m';
  if(offlineMode||!navigator.onLine){
    $('#providerValueGrid').innerHTML='<div class="providervalue selected"><span>DeckVault</span><strong>'+money(effectivePrice(x),x.priceCurrency||'USD')+'</strong><small>'+esc(x.valueOverride!=null?'Value override':(x.priceSource||'Last saved price'))+'</small></div>';
    $('#priceHistoryMetric').innerHTML='<option>Offline</option>';$('#priceHistoryChart').innerHTML='<div class="historyempty">Price-history data needs a connection. Your last saved card value is shown above.</div>';
    $('#priceHistorySummary').textContent=offlineSnapshotAt?'Library synced '+new Date(offlineSnapshotAt).toLocaleString():'Using your saved offline library.';
    $('#ebayCompStatus').textContent='Offline';$('#ebayCompList').innerHTML='<div class="empty">Recent sales require an internet connection.</div>';$('#openEbaySold').classList.add('hidden');
    $('.watchsection').classList.add('offline-disabled');return;
  }
  populateWatchControls(x).catch(console.error);refreshCardValuation(x).catch(console.error);
  const {data,error}=await sb.from('sales_comps_cache').select('provider,listing_id,title,sold_price,shipping_price,currency,sold_at,listing_url,image_url,condition_text,sale_status')
    .eq('game',x.game).eq('card_id',x.cardId).eq('sale_status','verified_completed').order('sold_at',{ascending:false}).limit(20);
  const list=$('#ebayCompList'),status=$('#ebayCompStatus');list.innerHTML='';
  if(error){console.error(error);status.textContent='Unavailable';list.innerHTML='<div class="empty">Could not load sold comps.</div>';return;}
  if(!data?.length){status.textContent='No verified feed yet';list.innerHTML='<div class="empty">No verified eBay transactions are available for this card yet. DeckVault will not label ordinary public sold results as final transactions when refund/cancellation status cannot be verified.</div>';return;}
  status.textContent=data.length+' verified';
  data.forEach(c=>{const row=document.createElement(c.listing_url?'a':'div');row.className='salescomprow';if(c.listing_url){row.href=c.listing_url;row.target='_blank';row.rel='noopener noreferrer';}const landed=Number(c.sold_price||0)+Number(c.shipping_price||0);row.innerHTML=(c.image_url?'<img src="'+esc(c.image_url)+'" alt="">':'<div class="salescompimg">eBay</div>')+'<div class="salescompmain"><strong>'+esc(c.title)+'</strong><span>'+esc(c.condition_text||'Condition not provided')+'</span><small>'+(c.sold_at?new Date(c.sold_at).toLocaleDateString():'Date unavailable')+' • Verified completed</small></div><div class="salescompprice">'+money(c.sold_price,c.currency||'USD')+(Number(c.shipping_price||0)>0?'<small>+'+money(c.shipping_price,c.currency||'USD')+' ship</small>':'')+'<small>'+money(landed,c.currency||'USD')+' total</small></div>';list.appendChild(row);});
}
function libraryCardFor(x){
  const e=document.createElement('article');e.className='librarycard';
  const total=effectivePrice(x)*Number(x.quantity||0);
  const img=x.image?'<img loading="lazy" src="'+esc(imageUrl(x.image))+'" alt="'+esc(x.name)+'">':'<div class="librarycardplaceholder">DV</div>';
  const gradeLine=x.cardState==='graded'?'<span class="librarygrade">'+esc((x.gradingCompany||'Graded')+(x.grade?' '+x.grade:''))+'</span>':'';
  e.innerHTML='<div class="librarycardimage">'+img+'<span class="qtybadge">×'+x.quantity+'</span></div><div class="librarycardbody"><strong>'+esc(x.name)+'</strong><span>'+esc(x.setName||'No set')+(x.localId?' • #'+esc(x.localId):'')+'</span><span>'+esc(x.variant)+' • '+esc(x.condition)+'</span>'+gradeLine+'<div class="libraryprices"><div><small>Value</small><b>'+money(total,x.priceCurrency||'USD')+'</b></div><div><small>Paid ea.</small><b>'+money(x.pricePaid,'USD')+'</b></div></div><div class="librarycardactions"><button class="secondary" data-folders>Folders</button><button data-dec>−</button><button data-inc>＋</button><button class="librarydelete" data-delete>×</button></div></div>';
  e.querySelector('.librarycardimage').onclick=()=>openLibraryCardDetails(x);
  e.querySelector('.librarycardbody>strong').onclick=()=>openLibraryCardDetails(x);
  e.querySelector('[data-folders]').onclick=()=>openFolderAssignments(x);
  e.querySelector('[data-inc]').onclick=()=>adjust(x,1);
  e.querySelector('[data-dec]').onclick=()=>adjust(x,-1);
  e.querySelector('[data-delete]').onclick=()=>removeEntry(x);
  return e;
}
function renderLibrary(){
  let a=folderItems(activeFolderId);
  const q=$('#librarySearch').value.trim().toLowerCase(),sort=$('#librarySort').value;
  if(q)a=a.filter(x=>[x.name,x.setName,x.localId,x.variant,x.condition].some(v=>String(v||'').toLowerCase().includes(q)));
  a.sort((x,y)=>{
    if(sort==='name_asc')return x.name.localeCompare(y.name);
    if(sort==='name_desc')return y.name.localeCompare(x.name);
    if(sort==='value_desc')return effectivePrice(y)*y.quantity-effectivePrice(x)*x.quantity;
    if(sort==='value_asc')return effectivePrice(x)*x.quantity-effectivePrice(y)*y.quantity;
    if(sort==='paid_desc')return Number(y.pricePaid??-1)-Number(x.pricePaid??-1);
    if(sort==='paid_asc')return Number(x.pricePaid??Number.MAX_SAFE_INTEGER)-Number(y.pricePaid??Number.MAX_SAFE_INTEGER);
    return new Date(y.addedAt)-new Date(x.addedAt);
  });
  const fullRows=folderItems(activeFolderId);
  const folder=folders.find(f=>f.id===activeFolderId);
  $('#libraryTitle').textContent=folder?folder.name:'Main Library';
  $('#libraryValue').textContent=money(collectionValue(fullRows));
  $('#libraryValueLabel').textContent=(folder?folder.name:'Entire collection')+' • '+fullRows.reduce((n,x)=>n+Number(x.quantity||0),0)+' cards';
  const box=$('#libraryList');box.innerHTML='';
  if(!a.length)box.innerHTML='<div class="empty">No cards match this view.</div>';
  else a.forEach(x=>box.appendChild(libraryCardFor(x)));
}
async function refreshPrices(){if(!requireOnline('Refreshing prices needs an internet connection.'))return;if(!items.length)return toast('No cards to refresh');const btn=$('#refreshPrices');btn.disabled=true;btn.textContent='Refreshing…';for(const id of [...new Set(items.filter(x=>x.game==='pokemon'&&x.entrySource!=='manual'&&!String(x.cardId).startsWith('manual:')).map(x=>x.cardId))].slice(0,50)){try{const c=await pokemonCard(id);for(const x of items.filter(i=>i.cardId===id)){const p=pokemonPrice(c,x.variant);await sb.from('collection_items').update({price:p.value==null?null:Number(p.value),price_currency:p.currency,price_source:p.label,price_updated_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',x.id);}}catch(e){console.warn(e);}}await loadCollection();saveOfflineSnapshot();btn.disabled=false;btn.textContent='Refresh prices';renderLibrary();renderDashboard();toast('Prices refreshed');}
async function startCamera(){try{if(stream)stream.getTracks().forEach(t=>t.stop());stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});$('#video').srcObject=stream;$('#cameraPlaceholder').classList.add('hidden');$('#video').classList.remove('hidden');$('#capturePreview').classList.add('hidden');$('#captureCard').disabled=false;$('#cameraStatus').textContent='Camera ready';return true;}catch(e){$('#cameraStatus').textContent='Camera blocked';alert('Camera access failed. '+e.message);return false;}}
function capture(){const v=$('#video');if(!v.videoWidth)return;const c=$('#canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0,c.width,c.height);$('#capturePreview').src=c.toDataURL('image/jpeg',.9);$('#capturePreview').classList.remove('hidden');v.classList.add('hidden');$('#captureCard').classList.add('hidden');$('#retake').classList.remove('hidden');$('#cameraStatus').textContent='Captured';stopActiveScan(false);}
function retake(){$('#capturePreview').classList.add('hidden');$('#video').classList.remove('hidden');$('#captureCard').classList.remove('hidden');$('#retake').classList.add('hidden');$('#cameraStatus').textContent='Camera ready';}

async function loadTesseract(){
  if(window.Tesseract)return window.Tesseract;
  if(window.__deckvaultTesseractPromise)return window.__deckvaultTesseractPromise;
  window.__deckvaultTesseractPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
    script.async=true;
    script.onload=()=>window.Tesseract?resolve(window.Tesseract):reject(new Error('OCR engine did not initialize'));
    script.onerror=()=>reject(new Error('OCR engine could not be downloaded'));
    document.head.appendChild(script);
  });
  return window.__deckvaultTesseractPromise;
}
async function ensureActiveScanWorker(){
  if(activeScanWorker)return activeScanWorker;
  const T=await loadTesseract();
  $('#activeScanStatus').textContent='Loading OCR engine for the first scan…';
  activeScanWorker=await T.createWorker('eng',1,{
    logger:m=>{
      if(m.status==='recognizing text'&&activeScanRunning)$('#activeScanStatus').textContent='Reading card number… '+Math.round((m.progress||0)*100)+'%';
    }
  });
  await activeScanWorker.setParameters({
    tessedit_char_whitelist:'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/- ',
    preserve_interword_spaces:'1'
  });
  return activeScanWorker;
}
function normalizeScanText(text){
  return String(text||'').replace(/[｜∕⁄]/g,'/').replace(/\s+/g,' ').trim();
}
function normalizeCollectorId(value){
  const raw=String(value||'').toUpperCase().replace(/[\s.-]/g,'');
  const m=raw.match(/^([A-Z]*)(\d+)$/);
  return m?m[1]+String(Number(m[2])):raw;
}
function parseCardFractions(text){
  const clean=normalizeScanText(text),fractions=[];
  // Handles numeric cards (161/197), secret rares, and subset numbers
  // like TG05/TG30. O, I and L are common numeric OCR substitutions.
  for(const m of clean.matchAll(/(?:^|[^A-Z0-9])([A-Z]{0,4}\s*[0-9OIl]{1,4})\s*[/\\|]\s*([A-Z]{0,4}\s*[0-9OIl]{2,4})(?![0-9])/gi)){
    const lhs=m[1].replace(/\s+/g,'').toUpperCase();
    const rhs=m[2].replace(/\s+/g,'').toUpperCase();
    const asNumber=v=>v.replace(/[OQ]/g,'0').replace(/[IL]/g,'1');
    // Keep a known subset prefix (TG, GG, RC), but don't misread a
    // leading O or I in an otherwise numeric collector number as a prefix.
    let left=lhs.match(/^([A-Z]{0,4})([0-9OIL]{1,4})$/);
    const right=rhs.match(/^([A-Z]{0,4})([0-9OIL]{2,4})$/);
    if(!left||!right)continue;
    if(/^[OIL]/.test(left[1])&&!/[A-HJ-NP-Z]/.test(left[1]))left=['', '',left[1]+left[2]];
    const number=Number(asNumber(left[2]));
    const denominator=Number(asNumber(right[2]));
    const local=normalizeCollectorId(left[1]+asNumber(left[2]));
    if(!denominator||denominator<10||denominator>999||!number||number>9999)continue;
    if(right[1]&&left[1]&&right[1]!==left[1])continue;
    fractions.push({localId:local,denominator,raw:m[0].trim()});
  }
  return [...new Map(fractions.map(f=>[f.localId+'/'+f.denominator,f])).values()].reverse();
}
function parseCardFraction(text){return parseCardFractions(text)[0]||null;}
function levenshtein(a,b){
  a=String(a||'').toLowerCase();b=String(b||'').toLowerCase();
  const dp=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){let prev=dp[0];dp[0]=i;for(let j=1;j<=b.length;j++){const cur=dp[j];dp[j]=Math.min(dp[j]+1,dp[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));prev=cur;}}
  return dp[b.length];
}
async function ocrRegion(yFrac,heightFrac,whitelist){
  const v=$('#video');if(!v.videoWidth||!v.videoHeight)return '';
  const c=document.createElement('canvas');
  const sx=0,sy=Math.floor(v.videoHeight*yFrac),sw=v.videoWidth,sh=Math.max(1,Math.floor(v.videoHeight*heightFrac));
  const scale=Math.min(2,1600/sw);
  c.width=Math.max(1,Math.floor(sw*scale));c.height=Math.max(1,Math.floor(sh*scale));
  const ctx=c.getContext('2d');
  ctx.filter='grayscale(1) contrast(1.8)';
  ctx.drawImage(v,sx,sy,sw,sh,0,0,c.width,c.height);
  const worker=await ensureActiveScanWorker();
  if(whitelist)await worker.setParameters({tessedit_char_whitelist:whitelist});
  const result=await worker.recognize(c);
  return normalizeScanText(result?.data?.text||'');
}
function scanEligibleSets(fraction,sets){
  if(!fraction?.denominator)return sets||[];
  return (sets||[]).filter(s=>[s.cardCount?.official,s.cardCount?.total]
    .some(n=>Number(n)===fraction.denominator));
}
function scanCandidateRank(c,hint=''){
  const q=String(hint||'').trim().toLowerCase();
  if(!q)return 0;
  const name=String(c.name||'').toLowerCase(),set=String(c.set?.name||'').toLowerCase();
  if(name===q||set===q)return -100;
  if(name.includes(q)||set.includes(q))return -75;
  const words=q.split(/\s+/).filter(x=>x.length>2);
  return words.length?-Math.max(...words.map(w=>
    name.includes(w)||set.includes(w)?45:Math.max(0,20-levenshtein(w,name))
  )):0;
}
async function lookupScanCandidates(fraction,nameHint=''){
  const localId=fraction?.localId||null;
  const [setsResult,cardsResult]=await Promise.allSettled([
    pokemonSets(),pokemonSearch(localId?'':nameHint,localId||'')
  ]);
  const sets=setsResult.status==='fulfilled'&&Array.isArray(setsResult.value)?setsResult.value:[];
  const eligible=scanEligibleSets(fraction,sets);
  const eligibleMap=new Map(eligible.map(s=>[s.id,s]));
  const allSets=new Map(sets.map(s=>[s.id,s]));
  const briefs=cardsResult.status==='fulfilled'&&Array.isArray(cardsResult.value)?cardsResult.value:[];
  const exact=briefs.filter(c=>!localId||normalizeCollectorId(c.localId)===normalizeCollectorId(localId));
  const enriched=exact.map(c=>{
    const setId=allSets.has(c.id.slice(0,c.id.lastIndexOf('-')))
      ?c.id.slice(0,c.id.lastIndexOf('-')):(c.id.slice(0,c.id.lastIndexOf('-')));
    const set=allSets.get(setId)||{id:setId,name:setId};
    return {...c,set,verifiedSetTotal:!fraction?.denominator||eligibleMap.has(setId)};
  });
  // Include all valid official/total matches, not only the first 18 sets.
  let candidates=fraction?.denominator
    ?enriched.filter(c=>c.verifiedSetTotal)
    :enriched;
  // When the number read is good but the denominator was misread, display
  // unverified cards as alternatives; never silently auto-confirm them.
  if(!candidates.length&&enriched.length)candidates=enriched.map(c=>({...c,verifiedSetTotal:false}));
  if(!candidates.length&&localId&&eligible.length){
    // Fall back to per-set lookups only if the indexed card search failed.
    const direct=[];
    for(let i=0;i<eligible.length&&direct.length<12;i+=5){
      const batch=await Promise.allSettled(eligible.slice(i,i+5)
        .map(set=>pokemonSetCard(set.id,localId)));
      batch.forEach((r,j)=>{
        if(r.status==='fulfilled'&&r.value)
          direct.push({...r.value,set:r.value.set||eligible[i+j],verifiedSetTotal:true});
      });
    }
    candidates=direct;
  }
  if(!candidates.length&&cardsResult.status==='rejected'&&setsResult.status==='rejected')
    throw new Error('Card database is unreachable. Check your connection and try again.');
  const deduped=[...new Map(candidates.map(c=>[c.id,c])).values()];
  return deduped.sort((a,b)=>
    Number(b.verifiedSetTotal)-Number(a.verifiedSetTotal) ||
    scanCandidateRank(a,nameHint)-scanCandidateRank(b,nameHint) ||
    String(a.name||'').localeCompare(String(b.name||'')) ||
    String(a.set?.name||'').localeCompare(String(b.set?.name||'')));
}
function hideScanChoices(){
  $('#scanChoices')?.classList.add('hidden');
  if($('#scanChoicesGrid'))$('#scanChoicesGrid').innerHTML='';
}
function showScanChoices(cards,fraction){
  activeScanRunning=false;
  clearTimeout(activeScanTimer);
  $('#scanChoices').classList.remove('hidden');
  $('#activeScanCandidate').classList.add('hidden');
  $('#activeScanGuide').classList.add('hidden');
  $('#activeScanBtn').textContent='Resume Active Scan';
  $('#activeScanStatus').textContent=cards.length+' possible matches. Select the right card image.';
  const grid=$('#scanChoicesGrid');grid.innerHTML='';
  cards.slice(0,24).forEach(card=>{
    const button=document.createElement('button');button.type='button';button.className='scanchoice';
    const img=card.image?'<img loading="lazy" src="'+esc(imageUrl(card.image,'low'))+'" alt="'+esc(card.name)+'">':'<div class="librarycardplaceholder">DV</div>';
    button.innerHTML=img+'<strong>'+esc(card.name)+'</strong><span>'+esc(card.set?.name||'Unknown set')+
      ' • #'+esc(card.localId||'')+'</span>'+
      (!card.verifiedSetTotal?'<small class="muted">Set total unverified</small>':'');
    button.onclick=()=>{hideScanChoices();showActiveScanCandidate(card,fraction);};
    grid.appendChild(button);
  });
  if(cards.length>24){
    const p=document.createElement('p');p.className='muted';
    p.textContent='Showing 24 of '+cards.length+'. Enter the card name or set below to narrow the list.';
    grid.appendChild(p);
  }
}
function showActiveScanCandidate(card,fraction){
  if(!card)return;
  activeScanMatch=card;activeScanRunning=false;
  clearTimeout(activeScanTimer);
  hideScanChoices();
  $('#activeScanCandidateImage').src=imageUrl(card.image,'high');
  $('#activeScanCandidateName').textContent=card.name;
  $('#activeScanCandidateMeta').textContent=(card.set?.name||'Pokémon TCG')+
    ' • #'+card.localId+
    (fraction?.raw?' • read '+fraction.raw:'')+
    (card.verifiedSetTotal===false?' • verify printed total':'');
  $('#activeScanCandidate').classList.remove('hidden');
  $('#activeScanGuide').classList.add('hidden');
  $('#activeScanStatus').textContent='Does this match your card?';
  $('#activeScanBtn').textContent='Resume Active Scan';
}
async function showScannedMatches(fraction,nameHint=''){
  const candidates=await lookupScanCandidates(fraction,nameHint);
  const available=candidates.filter(c=>!activeScanRejected||
    c.id!==activeScanRejected.id||Date.now()>activeScanRejected.until);
  if(!available.length)return false;
  if(available.length===1&&available[0].verifiedSetTotal!==false)
    showActiveScanCandidate(available[0],fraction);
  else showScanChoices(available,fraction);
  return true;
}
async function manualScanSearch(){
  stopActiveScan(false);
  const raw=$('#scanManualNumber').value.trim(),hint=$('#scanManualName').value.trim();
  if(!raw&&!hint){$('#activeScanStatus').textContent='Enter a printed number or card name.';return;}
  let fraction=parseCardFraction(raw);
  if(!fraction&&raw){
    const id=normalizeCollectorId(raw.replace(/[^A-Za-z0-9]/g,''));
    fraction={localId:id,denominator:null,raw};
  }
  $('#activeScanStatus').textContent='Searching for possible matches…';
  try{
    const found=await showScannedMatches(fraction,hint);
    if(!found)$('#activeScanStatus').textContent='No matches yet. Check the printed number, or try the Lookup tab.';
  }catch(e){
    console.error('Manual scan search',e);
    $('#activeScanStatus').textContent='Card search failed: '+e.message;
  }
}
async function activeScanStep(){
  if(!activeScanRunning||activeScanBusy||!stream)return;
  activeScanBusy=true;
  try{
    $('#activeScanStatus').textContent='Reading the printed card number…';
    const primary=await ocrRegion(.70,.28,'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/- ');
    let fractions=parseCardFractions(primary),readout=primary;
    if(!fractions.length){
      const wider=await ocrRegion(.55,.42,'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/- ');
      fractions=parseCardFractions(wider);readout=wider||primary;
    }
    $('#scanReadout').textContent=readout?'Detected text: '+readout.slice(0,100):'No printed number detected yet.';
    if(!fractions.length){
      $('#activeScanStatus').textContent='No clear number yet. Hold the card steady, or enter its number below.';
    }else{
      let found=false;
      for(const fraction of fractions){
        $('#activeScanStatus').textContent='Found '+fraction.raw+' — checking matching cards…';
        const candidates=await lookupScanCandidates(fraction);
        const available=candidates.filter(c=>!activeScanRejected||
          c.id!==activeScanRejected.id||Date.now()>activeScanRejected.until);
        if(!available.length)continue;
        let hint='';
        if(available.length>1){
          try{hint=await ocrRegion(.06,.38,'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -');}catch{}
        }
        if(hint)available.sort((a,b)=>scanCandidateRank(a,hint)-scanCandidateRank(b,hint));
        if(available.length===1&&available[0].verifiedSetTotal!==false)
          showActiveScanCandidate(available[0],fraction);
        else showScanChoices(available,fraction);
        found=true;break;
      }
      if(found)return;
      $('#activeScanStatus').textContent='Number detected, but no clear match. Check the readout or enter the number manually below.';
      $('#scanManualDetails').open=true;
      if(!$('#scanManualNumber').value)$('#scanManualNumber').value=fractions[0].raw;
    }
  }catch(e){
    console.warn('Active scan',e);
    $('#activeScanStatus').textContent='Scanning had trouble: '+(e?.message||'try holding the card steady');
    $('#scanManualDetails').open=true;
  }finally{
    activeScanBusy=false;
    if(activeScanRunning)activeScanTimer=setTimeout(activeScanStep,850);
  }
}
async function startActiveScan(){
  hideScanChoices();
  if(activeScanMatch){activeScanMatch=null;$('#activeScanCandidate').classList.add('hidden');}
  if(!stream){const ok=await startCamera();if(!ok)return;}
  activeScanRunning=true;
  $('#activeScanGuide').classList.remove('hidden');
  $('#activeScanBtn').textContent='Stop Active Scan';
  $('#cameraStatus').textContent='Active scanning';
  try{await ensureActiveScanWorker();activeScanStep();}catch(e){activeScanRunning=false;$('#activeScanStatus').textContent=e.message;$('#activeScanBtn').textContent='Start Active Scan (Beta)';}
}
function stopActiveScan(update=true){
  activeScanRunning=false;activeScanBusy=false;clearTimeout(activeScanTimer);activeScanTimer=null;
  $('#activeScanGuide')?.classList.add('hidden');
  if(update){$('#activeScanBtn').textContent='Start Active Scan (Beta)';$('#activeScanStatus').textContent='Active Scan paused.';}
}
async function toggleActiveScan(){if(activeScanRunning){stopActiveScan();return;}await startActiveScan();}
function rejectActiveScanMatch(){
  if(activeScanMatch)activeScanRejected={id:activeScanMatch.id,until:Date.now()+8000};
  activeScanMatch=null;$('#activeScanCandidate').classList.add('hidden');startActiveScan();
}
function confirmActiveScanMatch(){
  const card=activeScanMatch;if(!card)return;haptic(28);
  activeScanMatch=null;$('#activeScanCandidate').classList.add('hidden');stopActiveScan(false);
  openCard(card.id);
}
function download(content,type,name){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const csv=v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
async function exportJson(){
  let copies=[],watchlist=[];
  if(navigator.onLine&&currentUser){
    const [c,w]=await Promise.all([
      sb.from('collection_copies').select('*').eq('user_id',currentUser.id),
      sb.from('card_watchlist').select('*').eq('user_id',currentUser.id)
    ]);
    copies=c.data||[];watchlist=w.data||[];
  }
  const backup={
    format:'deckvault-backup',version:3,exportedAt:new Date().toISOString(),
    collection:items,folders,folderMembership:serializeFolderMembership(),copies,watchlist
  };
  download(JSON.stringify(backup,null,2),'application/json','deckvault-backup-'+new Date().toISOString().slice(0,10)+'.json');
}
async function exportCsv(collectr){
  const cols=collectr
    ?['Game','Card Name','Set','Card Number','Variant','Condition','Language','Quantity','Provider ID','Current Price','Value Override','Currency','Card State','Grading Company','Grade','Certification #','Price Paid','Purchase Date']
    :['Game','Name','Set','Set ID','Card Number','Variant','Condition','Language','Quantity','Rarity','Provider ID','Price','Value Override','Price Paid','Currency','Price Source','Card State','Grading Company','Grade','Certification #','Purchase Date','Added At','Updated At','Notes'];
  const rows=items.map(x=>collectr
    ?[x.game,x.name,x.setName,x.localId,x.variant,x.condition,x.language,x.quantity,x.cardId,x.price||'',x.valueOverride??'',x.priceCurrency||'',x.cardState,x.gradingCompany,x.grade,x.certNumber,x.pricePaid??'',x.purchaseDate||'']
    :[x.game,x.name,x.setName,x.setId,x.localId,x.variant,x.condition,x.language,x.quantity,x.rarity,x.cardId,x.price||'',x.valueOverride??'',x.pricePaid??'',x.priceCurrency||'',x.priceSource||'',x.cardState,x.gradingCompany,x.grade,x.certNumber,x.purchaseDate||'',x.addedAt,x.updatedAt,x.notes||'']);
  download([cols,...rows].map(r=>r.map(csv).join(',')).join('\n'),'text/csv;charset=utf-8',(collectr?'deckvault-collectr-transfer-':'deckvault-collection-')+new Date().toISOString().slice(0,10)+'.csv');
}
async function importBackup(file){
  if(!navigator.onLine)return toast('Backup restore needs an internet connection');
  const d=JSON.parse(await file.text());
  if(!d||!Array.isArray(d.collection))throw new Error('Not a valid DeckVault backup.');
  if(!confirm('Restore '+d.collection.length+' entries to this account?'))return;
  for(const x of d.collection){
    const cardId=x.cardId||x.card_id;if(!cardId)continue;
    const variant=x.variant||'Normal',condition=x.condition||'Near Mint',language=x.language||'English';
    const old=items.find(i=>i.game===(x.game||'pokemon')&&i.cardId===cardId&&i.variant===variant&&i.condition===condition&&i.language===language);
    const obj={
      game:x.game||'pokemon',cardId,name:x.name||'',localId:x.localId||x.local_id||'',setId:x.setId||x.set_id||'',setName:x.setName||x.set_name||'',rarity:x.rarity||'',
      variant,condition,language,quantity:Number(x.quantity||1),image:x.image||x.image_url||'',price:x.price==null?null:Number(x.price),
      valueOverride:(x.valueOverride??x.value_override)==null?null:Number(x.valueOverride??x.value_override),pricePaid:(x.pricePaid??x.price_paid)==null?null:Number(x.pricePaid??x.price_paid),priceCurrency:x.priceCurrency||x.price_currency||'USD',
      priceSource:x.priceSource||x.price_source||'',priceUpdatedAt:x.priceUpdatedAt||x.price_updated_at||null,entrySource:x.entrySource||x.entry_source||'provider',
      cardState:x.cardState||x.card_state||'raw',gradingCompany:x.gradingCompany||x.grading_company||'',grade:x.grade||'',certNumber:x.certNumber||x.cert_number||'',
      purchaseDate:x.purchaseDate||x.purchase_date||'',notes:x.notes||'',addedAt:x.addedAt||x.added_at||new Date().toISOString()
    };
    if(old)await sb.from('collection_items').update(toRow({...obj,id:old.id})).eq('id',old.id);
    else await sb.from('collection_items').insert({...toRow(obj),added_at:obj.addedAt});
  }
  if(Array.isArray(d.watchlist)&&d.watchlist.length){
    const rows=d.watchlist.map(w=>({...w,user_id:currentUser.id}));
    await sb.from('card_watchlist').upsert(rows,{onConflict:'user_id,game,card_id,variant'});
  }
  await loadCollection();await loadFolders();saveOfflineSnapshot();renderDashboard();renderLibrary();toast('Backup restored');
}

function showStartupError(error,alreadyCaptured=false){
  if(!alreadyCaptured)captureAppError(error,{severity:'fatal',source:'startup'});
  originalConsoleError('DeckVault startup error',error);
  const box=$('#startupError');
  if(!box)return;
  $('#startupErrorText').textContent=error?.message||String(error||'Unknown startup error');
  box.classList.remove('hidden');
}
window.addEventListener('error',e=>{
  const err=e.error||new Error(e.message||'Window error');
  captureAppError(err,{source:'window.error',context:{filename:e.filename||'',lineno:e.lineno||'',colno:e.colno||''}});
  showStartupError(err,true);
});
window.addEventListener('unhandledrejection',e=>{
  const err=e.reason instanceof Error?e.reason:new Error(String(e.reason||'Unhandled promise rejection'));
  captureAppError(err,{source:'unhandledrejection'});
  showStartupError(err,true);
});
async function init(){
  // Dialog close/cancel controls must never be blocked by required-field validation.
  $$('dialog .close, dialog button[value="cancel"]').forEach(button=>{
    button.type='button';
    button.onclick=()=>button.closest('dialog')?.close('cancel');
  });
  $('#startupReloadBtn').onclick=()=>location.reload();
  $('#refreshErrorLog').onclick=()=>loadErrorBacklog().catch(e=>console.error(e));
  $('#copyDiagnostics').onclick=copyDiagnostics;
  $('#exportDiagnostics').onclick=exportDiagnostics;
  $('#universalSearchBtn').onclick=()=>{$('#universalSearchDialog').showModal();setTimeout(()=>$('#universalSearchInput').focus(),50);};
  $('#universalSearchInput').oninput=()=>{clearTimeout(window.__dvSearchTimer);window.__dvSearchTimer=setTimeout(runUniversalSearch,180);};
  $('#syncOfflineNowBtn').onclick=runOfflineSyncAndReload;
  $('#viewOfflineConflictsBtn').onclick=()=>{renderOfflineConflicts();$('#offlineConflictsDialog').showModal();};
  $('#addCopyBtn').onclick=addCopyRow;
  $('#importCollectionCsv').onchange=async e=>{const file=e.target.files[0];if(file)try{await importCollectionCsv(file,$('#importCollectionFormat').value);}catch(err){console.error(err);$('#importCollectionStatus').textContent=err.message;}e.target.value='';};
  updateOfflineQueueStatus();
  document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
  installSwipeBack($('#libraryCardDialog'),()=>$('#libraryCardDialog').close());
  installSwipeBack($('#imageZoomDialog'),()=>$('#imageZoomDialog').close());
  $('#signInForm').onsubmit=signIn;$('#signUpForm').onsubmit=signUp;$('#resetForm').onsubmit=resetPassword;
  $('#staySignedIn').checked=localStorage.getItem(STAY_SIGNED_IN_KEY)==='true';
  $('#staySignedIn').onchange=e=>localStorage.setItem(STAY_SIGNED_IN_KEY,e.target.checked?'true':'false');
  $('#showSignUp').onclick=()=>showPane('applicationPane');$('#showSignIn').onclick=()=>showPane('signinPane');$('#showReset').onclick=()=>showPane('resetPane');$('#resetBack').onclick=()=>showPane('signinPane');
  $('#signOutBtn').onclick=signOut;$('#bannedSignOut').onclick=signOut;$('#termsSignOut').onclick=signOut;
  $('#viewTermsAuth').onclick=openTermsDialog;$('#viewTermsBtn').onclick=openTermsDialog;
  $('#acceptTermsCheck').onchange=e=>{$('#acceptTermsBtn').disabled=!e.target.checked;};
  $('#acceptTermsBtn').onclick=acceptCurrentTerms;
  $('#searchBtn').onclick=search;$('#searchName').onkeydown=e=>{if(e.key==='Enter')search();};$('#searchNumber').onkeydown=e=>{if(e.key==='Enter')search();};
  $('#librarySearch').oninput=renderLibrary;$('#librarySort').onchange=renderLibrary;$('#refreshPrices').onclick=refreshPrices;$('#manualAddCardBtn').onclick=openManualCard;$('#saveManualCardBtn').onclick=saveManualCard;$('#newFolderBtn').onclick=createFolder;$('#manageFoldersBtn').onclick=()=>{renderFolderManager();$('#manageFoldersDialog').showModal();};$('#saveFolderAssignmentsBtn').onclick=saveFolderAssignments;$('#scanManualSearch').onclick=manualScanSearch;$('#scanManualNumber').onkeydown=e=>{if(e.key==='Enter')manualScanSearch();};$('#scanManualName').onkeydown=e=>{if(e.key==='Enter')manualScanSearch();};$('#startCamera').onclick=startCamera;$('#activeScanBtn').onclick=toggleActiveScan;$('#activeScanReject').onclick=rejectActiveScanMatch;$('#activeScanConfirm').onclick=confirmActiveScanMatch;$('#captureCard').onclick=capture;$('#retake').onclick=retake;
  $('#exportJson').onclick=exportJson;$('#exportCsv').onclick=()=>exportCsv(false);$('#exportCollectr').onclick=()=>exportCsv(true);$('#importJson').onchange=async e=>{if(e.target.files[0])try{await importBackup(e.target.files[0]);}catch(err){alert(err.message);}e.target.value='';};
  $('#clearData').onclick=async()=>{if(confirm('Delete every card in your DeckVault account collection?')){const {error}=await sb.from('collection_items').delete().eq('user_id',currentUser.id);if(error)return toast('Could not clear collection');await loadCollection();renderDashboard();renderLibrary();toast('Collection cleared');}};
  $('#priceSource').value=pricePref();$('#priceSource').onchange=e=>{localStorage.setItem('deckvault-price-source',e.target.value);toast('Price source saved');};
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installBtn').classList.remove('hidden');});$('#installBtn').onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installBtn').classList.add('hidden');};
  window.addEventListener('offline',()=>{
    if(!currentUser)return;
    saveOfflineSnapshot();
    const snap=readOfflineSnapshot(currentUser.id);
    setOfflineMode(true,snap?.savedAt||offlineSnapshotAt);
    toast('Offline mode: showing your saved library and prices.');
    if(['lookup','scanner','marketplace','community'].includes(document.querySelector('.view.active')?.id))go('library');
  });
  window.addEventListener('online',()=>{
    if(currentUser){
      toast('Connection restored. Syncing DeckVault…');
      syncOfflineQueue().then(()=>showApp(currentUser)).then(()=>syncErrorBacklog()).catch(err=>console.error(err));
    }
  });
    sb.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT'){
      setTimeout(showAuth,0);
      return;
    }
    if(session?.user&&(!currentUser||currentUser.id!==session.user.id)){
      setTimeout(()=>showApp(session.user).catch(err=>{
        console.error(err);
        setAuthMessage(err?.message||'Could not finish signing in.',true);
      }),0);
    }
  });
  const {data:{session}}=await sb.auth.getSession();if(session?.user)await showApp(session.user);else showAuth();
  if('serviceWorker' in navigator){
    let swReloaded=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(swReloaded)return;
      swReloaded=true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js?build='+encodeURIComponent(APP_BUILD),{updateViaCache:'none'})
      .then(reg=>reg.update())
      .catch(console.warn);
  }
}
document.addEventListener('DOMContentLoaded',()=>init().catch(showStartupError));
window.addEventListener('pagehide',()=>{if(stream)stream.getTracks().forEach(t=>t.stop());});