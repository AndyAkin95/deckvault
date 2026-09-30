'use strict';

const API='https://api.tcgdex.net/v2/en';
const DB_NAME='deckvault-db';
const DB_VERSION=1;
const COLLECTION='collection';
const SETTINGS='settings';
let db=null;
let stream=null;
let currentCard=null;
let installPrompt=null;

const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));

function esc(v){
  return String(v==null?'':v).replace(/[&<>'"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c];});
}
function toast(msg){
  const el=$('#toast'); el.textContent=msg; el.classList.add('show');
  setTimeout(function(){el.classList.remove('show');},1800);
}
function money(n,currency){
  if(n==null||Number.isNaN(Number(n))) return '—';
  try{return new Intl.NumberFormat('en-US',{style:'currency',currency:currency||'USD'}).format(Number(n));}
  catch(e){return (currency||'USD')+' '+Number(n).toFixed(2);}
}
function imageUrl(base,quality){
  if(!base) return '';
  return base+'/'+(quality||'low')+'.webp';
}
function uidFor(game,cardId,variant,condition,language){
  return [game,cardId,String(variant).toLowerCase().replace(/\s+/g,'-'),condition,language].join('|');
}

function openDB(){
  return new Promise(function(resolve,reject){
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=function(e){
      const d=e.target.result;
      if(!d.objectStoreNames.contains(COLLECTION)){
        const s=d.createObjectStore(COLLECTION,{keyPath:'uid'});
        s.createIndex('game','game',{unique:false});
        s.createIndex('cardId','cardId',{unique:false});
        s.createIndex('setName','setName',{unique:false});
        s.createIndex('addedAt','addedAt',{unique:false});
      }
      if(!d.objectStoreNames.contains(SETTINGS)) d.createObjectStore(SETTINGS,{keyPath:'key'});
    };
    req.onsuccess=function(){resolve(req.result);};
    req.onerror=function(){reject(req.error);};
  });
}
function store(name,mode){return db.transaction(name,mode||'readonly').objectStore(name);}
function getAll(){
  return new Promise(function(resolve,reject){const r=store(COLLECTION).getAll();r.onsuccess=function(){resolve(r.result||[]);};r.onerror=function(){reject(r.error);};});
}
function getOne(uid){
  return new Promise(function(resolve,reject){const r=store(COLLECTION).get(uid);r.onsuccess=function(){resolve(r.result||null);};r.onerror=function(){reject(r.error);};});
}
function putOne(x){
  return new Promise(function(resolve,reject){const r=store(COLLECTION,'readwrite').put(x);r.onsuccess=function(){resolve(x);};r.onerror=function(){reject(r.error);};});
}
function delOne(uid){
  return new Promise(function(resolve,reject){const r=store(COLLECTION,'readwrite').delete(uid);r.onsuccess=function(){resolve();};r.onerror=function(){reject(r.error);};});
}
function clearAll(){
  return new Promise(function(resolve,reject){const r=store(COLLECTION,'readwrite').clear();r.onsuccess=function(){resolve();};r.onerror=function(){reject(r.error);};});
}
function getSetting(key,fallback){
  return new Promise(function(resolve,reject){const r=store(SETTINGS).get(key);r.onsuccess=function(){resolve(r.result?r.result.value:fallback);};r.onerror=function(){reject(r.error);};});
}
function setSetting(key,value){
  return new Promise(function(resolve,reject){const r=store(SETTINGS,'readwrite').put({key:key,value:value});r.onsuccess=function(){resolve(value);};r.onerror=function(){reject(r.error);};});
}

async function pokemonSearch(name,number){
  const p=new URLSearchParams();
  if(name) p.set('name',name.trim());
  if(number) p.set('localId',number.trim());
  const res=await fetch(API+'/cards?'+p.toString());
  if(!res.ok) throw new Error('TCGdex search failed ('+res.status+')');
  return res.json();
}
async function pokemonCard(id){
  const res=await fetch(API+'/cards/'+encodeURIComponent(id));
  if(!res.ok) throw new Error('Could not load card ('+res.status+')');
  return res.json();
}
function pokemonVariants(card){
  const v=card.variants||{};
  const out=[];
  if(v.normal) out.push('Normal');
  if(v.holo) out.push('Holofoil');
  if(v.reverse) out.push('Reverse Holofoil');
  if(v.firstEdition) out.push('1st Edition');
  if(v.firstEdition&&v.holo) out.push('1st Edition Holofoil');
  if(!out.length) out.push('Normal');
  return Array.from(new Set(out));
}
function variantPriceObject(tcg,variant){
  if(!tcg) return null;
  const map={
    'Normal':['normal','unlimited'],
    'Holofoil':['holofoil','holo','unlimited-holofoil'],
    'Reverse Holofoil':['reverse-holofoil','reverse'],
    '1st Edition':['1st-edition','first-edition','firstEdition'],
    '1st Edition Holofoil':['1st-edition-holofoil','first-edition-holofoil']
  };
  const keys=map[variant]||['normal'];
  for(let i=0;i<keys.length;i++) if(tcg[keys[i]]) return tcg[keys[i]];
  return null;
}
function pokemonPrice(card,variant,source){
  const pricing=card.pricing||{};
  if(source.indexOf('tcgplayer')===0){
    const obj=variantPriceObject(pricing.tcgplayer,variant);
    return {
      value:source==='tcgplayer-mid'?(obj&&obj.midPrice):(obj&&obj.marketPrice),
      currency:(pricing.tcgplayer&&pricing.tcgplayer.unit)||'USD',
      label:source==='tcgplayer-mid'?'TCGplayer Mid':'TCGplayer Market'
    };
  }
  const cm=pricing.cardmarket||{};
  const foil=String(variant).toLowerCase().indexOf('holo')>=0;
  const key=source==='cardmarket-7'?(foil?'avg7-holo':'avg7'):(foil?'avg30-holo':'avg30');
  return {value:cm[key],currency:cm.unit||'EUR',label:source==='cardmarket-7'?'Cardmarket 7-day':'Cardmarket 30-day'};
}

function go(view){
  $$('.view').forEach(function(v){v.classList.toggle('active',v.id===view);});
  $$('.bottomnav button').forEach(function(b){b.classList.toggle('active',b.dataset.go===view);});
  window.scrollTo({top:0,behavior:'smooth'});
  if(view==='dashboard') renderDashboard();
  if(view==='library') renderLibrary();
}

async function search(){
  const name=$('#searchName').value.trim();
  const number=$('#searchNumber').value.trim();
  if(!name&&!number){toast('Enter a name or collector number');return;}
  $('#searchStatus').textContent='Searching TCGdex…';
  $('#results').innerHTML='';
  try{
    const cards=await pokemonSearch(name,number);
    $('#searchStatus').textContent=cards.length+' match'+(cards.length===1?'':'es')+' found';
    renderResults(cards);
  }catch(e){$('#searchStatus').textContent=e.message;}
}
function renderResults(cards){
  const box=$('#results');
  box.innerHTML='';
  if(!cards.length){box.innerHTML='<div class="empty">No matching cards found.</div>';return;}
  cards.slice(0,60).forEach(function(c){
    const el=document.createElement('article');
    el.className='result';
    el.innerHTML='<img loading="lazy" src="'+esc(imageUrl(c.image,'low'))+'" alt="'+esc(c.name)+'"><div class="info"><strong>'+esc(c.name)+'</strong><div class="meta">#'+esc(c.localId)+' • '+esc(c.id)+'</div><button type="button">View / Add</button></div>';
    el.querySelector('button').addEventListener('click',function(){openCard(c.id);});
    box.appendChild(el);
  });
}
async function openCard(id){
  $('#dialogBody').innerHTML='<div class="empty">Loading card…</div>';
  $('#cardDialog').showModal();
  try{
    currentCard=await pokemonCard(id);
    const source=await getSetting('priceSource','tcgplayer-market');
    const variants=pokemonVariants(currentCard);
    const p=pokemonPrice(currentCard,variants[0],source);
    $('#dialogBody').innerHTML=
      '<div class="dialogtop"><img src="'+esc(imageUrl(currentCard.image,'high'))+'" alt="'+esc(currentCard.name)+'"><div><div class="eyebrow">'+esc((currentCard.set&&currentCard.set.name)||'Pokémon TCG')+'</div><h2>'+esc(currentCard.name)+'</h2><div class="muted">#'+esc(currentCard.localId)+(currentCard.rarity?' • '+esc(currentCard.rarity):'')+'</div><div class="pricebox"><div id="dialogPriceLabel" class="muted">'+esc(p.label)+'</div><div id="dialogPrice" class="pricebig">'+money(p.value,p.currency)+'</div></div></div></div>'+
      '<div class="fields"><label>Variant<select id="variant">'+variants.map(function(v){return '<option>'+esc(v)+'</option>';}).join('')+'</select></label><label>Condition<select id="condition"><option>Near Mint</option><option>Lightly Played</option><option>Moderately Played</option><option>Heavily Played</option><option>Damaged</option></select></label><label>Language<select id="language"><option>English</option><option>Japanese</option><option>French</option><option>German</option><option>Italian</option><option>Spanish</option></select></label><label>Quantity<input id="qty" type="number" min="1" value="1"></label></div>'+
      '<div class="dialogactions"><button id="addCard" type="button" class="primary">Add to collection</button><button class="secondary" value="cancel">Cancel</button></div>';
    $('#variant').addEventListener('change',async function(){const src=await getSetting('priceSource','tcgplayer-market');const q=pokemonPrice(currentCard,$('#variant').value,src);$('#dialogPrice').textContent=money(q.value,q.currency);$('#dialogPriceLabel').textContent=q.label;});
    $('#addCard').addEventListener('click',addCurrent);
  }catch(e){$('#dialogBody').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
async function addCurrent(){
  if(!currentCard) return;
  const variant=$('#variant').value;
  const condition=$('#condition').value;
  const language=$('#language').value;
  const qty=Math.max(1,parseInt($('#qty').value||'1',10));
  const source=await getSetting('priceSource','tcgplayer-market');
  const p=pokemonPrice(currentCard,variant,source);
  const uid=uidFor('pokemon',currentCard.id,variant,condition,language);
  const old=await getOne(uid);
  const now=new Date().toISOString();
  const entry={
    uid:uid,game:'pokemon',cardId:currentCard.id,name:currentCard.name,localId:String(currentCard.localId),
    setId:(currentCard.set&&currentCard.set.id)||'',setName:(currentCard.set&&currentCard.set.name)||'',rarity:currentCard.rarity||'',
    variant:variant,condition:condition,language:language,quantity:(old?Number(old.quantity):0)+qty,
    image:currentCard.image||'',price:p.value==null?null:Number(p.value),priceCurrency:p.currency,priceSource:p.label,
    priceUpdatedAt:now,addedAt:old?old.addedAt:now,updatedAt:now,notes:old?old.notes||'':''
  };
  await putOne(entry);
  $('#cardDialog').close();
  toast(currentCard.name+' ×'+entry.quantity);
  renderDashboard();
}

function rowFor(x,compact){
  const el=document.createElement('div');
  el.className='cardrow';
  const total=(Number(x.price)||0)*(Number(x.quantity)||0);
  el.innerHTML='<img loading="lazy" src="'+esc(imageUrl(x.image,'low'))+'" alt="'+esc(x.name)+'"><div class="cardmain"><div class="cardtitle">'+esc(x.name)+'</div><div class="cardmeta">'+esc(x.setName)+' • #'+esc(x.localId)+' • '+esc(x.variant)+' • '+esc(x.condition)+'</div>'+(compact?'':'<div class="qty"><button data-a="dec">−</button><span>'+esc(x.quantity)+'</span><button data-a="inc">+</button><button data-a="del">×</button></div>')+'</div><div class="cardprice">'+money(total,x.priceCurrency||'USD')+'<div class="cardmeta">×'+esc(x.quantity)+'</div></div>';
  if(!compact){
    el.querySelector('[data-a="inc"]').addEventListener('click',function(){adjust(x,1);});
    el.querySelector('[data-a="dec"]').addEventListener('click',function(){adjust(x,-1);});
    el.querySelector('[data-a="del"]').addEventListener('click',function(){removeEntry(x);});
  }
  return el;
}
async function adjust(x,d){
  x.quantity=Math.max(0,Number(x.quantity||0)+d);
  if(x.quantity===0) await delOne(x.uid); else {x.updatedAt=new Date().toISOString();await putOne(x);}
  renderLibrary();renderDashboard();
}
async function removeEntry(x){
  if(!confirm('Remove '+x.name+' from this collection?')) return;
  await delOne(x.uid); renderLibrary(); renderDashboard(); toast('Removed');
}
async function renderDashboard(){
  if(!db) return;
  const items=await getAll();
  const count=items.reduce(function(s,x){return s+Number(x.quantity||0);},0);
  const total=items.reduce(function(s,x){return s+((x.priceCurrency==='USD'||!x.priceCurrency)?Number(x.price||0)*Number(x.quantity||0):0);},0);
  $('#collectionValue').textContent=money(total,'USD');
  $('#totalCards').textContent=count.toLocaleString();
  $('#uniqueCards').textContent=items.length.toLocaleString();
  $('#duplicates').textContent=Math.max(0,count-items.length).toLocaleString();
  $('#setCount').textContent=new Set(items.map(function(x){return x.game+':'+x.setId;}).filter(Boolean)).size.toLocaleString();
  const recent=items.sort(function(a,b){return new Date(b.addedAt)-new Date(a.addedAt);}).slice(0,5);
  const box=$('#recent'); box.innerHTML='';
  if(!recent.length){box.className='panel empty';box.textContent='No cards yet.';return;}
  box.className='panel'; recent.forEach(function(x){box.appendChild(rowFor(x,true));});
}
async function renderLibrary(){
  if(!db) return;
  let items=await getAll();
  const q=$('#librarySearch').value.trim().toLowerCase();
  if(q) items=items.filter(function(x){return [x.name,x.setName,x.localId,x.variant,x.condition].some(function(v){return String(v||'').toLowerCase().indexOf(q)>=0;});});
  const sort=$('#librarySort').value;
  items.sort(function(a,b){
    if(sort==='name') return a.name.localeCompare(b.name);
    if(sort==='set') return (a.setName||'').localeCompare(b.setName||'')||a.name.localeCompare(b.name);
    if(sort==='value') return Number(b.price||0)*Number(b.quantity||0)-Number(a.price||0)*Number(a.quantity||0);
    if(sort==='quantity') return Number(b.quantity||0)-Number(a.quantity||0);
    return new Date(b.addedAt)-new Date(a.addedAt);
  });
  const box=$('#libraryList');box.innerHTML='';
  if(!items.length){box.innerHTML='<div class="empty">No cards match this view.</div>';return;}
  items.forEach(function(x){box.appendChild(rowFor(x,false));});
}
async function refreshPrices(){
  const items=await getAll();
  if(!items.length){toast('No cards to refresh');return;}
  const button=$('#refreshPrices');button.disabled=true;button.textContent='Refreshing…';
  const source=await getSetting('priceSource','tcgplayer-market');
  const ids=Array.from(new Set(items.filter(function(x){return x.game==='pokemon';}).map(function(x){return x.cardId;}))).slice(0,50);
  try{
    for(let i=0;i<ids.length;i++){
      try{
        const card=await pokemonCard(ids[i]);
        const entries=items.filter(function(x){return x.cardId===ids[i]&&x.game==='pokemon';});
        for(let j=0;j<entries.length;j++){
          const p=pokemonPrice(card,entries[j].variant,source);
          entries[j].price=p.value==null?null:Number(p.value);entries[j].priceCurrency=p.currency;entries[j].priceSource=p.label;entries[j].priceUpdatedAt=new Date().toISOString();entries[j].updatedAt=new Date().toISOString();
          await putOne(entries[j]);
        }
      }catch(e){console.warn('Price refresh failed',ids[i],e);}
    }
    toast('Prices refreshed');
  }finally{button.disabled=false;button.textContent='Refresh prices';renderLibrary();renderDashboard();}
}

async function startCamera(){
  try{
    if(stream) stream.getTracks().forEach(function(t){t.stop();});
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    $('#video').srcObject=stream;$('#cameraPlaceholder').classList.add('hidden');$('#video').classList.remove('hidden');$('#capturePreview').classList.add('hidden');
    $('#captureCard').disabled=false;$('#cameraStatus').textContent='Camera ready';$('#startCamera').textContent='Restart camera';
  }catch(e){$('#cameraStatus').textContent='Camera blocked';alert('Camera access failed. Use HTTPS and allow camera permission.\n\n'+e.message);}
}
function capture(){
  const v=$('#video');if(!v.videoWidth)return;
  const c=$('#canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0,c.width,c.height);
  $('#capturePreview').src=c.toDataURL('image/jpeg',.9);$('#capturePreview').classList.remove('hidden');v.classList.add('hidden');$('#captureCard').classList.add('hidden');$('#retake').classList.remove('hidden');$('#cameraStatus').textContent='Captured';toast('Card captured');
}
function retake(){
  $('#capturePreview').classList.add('hidden');$('#video').classList.remove('hidden');$('#captureCard').classList.remove('hidden');$('#retake').classList.add('hidden');$('#cameraStatus').textContent='Camera ready';
}

function download(content,type,name){
  const blob=new Blob([content],{type:type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function csv(v){const s=String(v==null?'':v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
async function exportJson(){
  const collection=await getAll();const settings={priceSource:await getSetting('priceSource','tcgplayer-market')};
  download(JSON.stringify({format:'deckvault-backup',version:1,exportedAt:new Date().toISOString(),collection:collection,settings:settings},null,2),'application/json','deckvault-backup-'+new Date().toISOString().slice(0,10)+'.json');
}
async function exportCsv(collectr){
  const items=await getAll();
  const cols=collectr?['Game','Card Name','Set','Card Number','Variant','Condition','Language','Quantity','Provider ID','Current Price','Currency']:['Game','Name','Set','Set ID','Card Number','Variant','Condition','Language','Quantity','Rarity','Provider ID','Price','Currency','Price Source','Added At','Updated At','Notes'];
  const rows=items.map(function(x){return collectr?[x.game,x.name,x.setName,x.localId,x.variant,x.condition,x.language,x.quantity,x.cardId,x.price||'',x.priceCurrency||'']:[x.game,x.name,x.setName,x.setId,x.localId,x.variant,x.condition,x.language,x.quantity,x.rarity,x.cardId,x.price||'',x.priceCurrency||'',x.priceSource||'',x.addedAt,x.updatedAt,x.notes||''];});
  download([cols].concat(rows).map(function(r){return r.map(csv).join(',');}).join('\n'),'text/csv;charset=utf-8',(collectr?'deckvault-collectr-transfer-':'deckvault-collection-')+new Date().toISOString().slice(0,10)+'.csv');
}
async function importBackup(file){
  const data=JSON.parse(await file.text());
  if(!data||!Array.isArray(data.collection)||!['deckvault-backup','pokescan-backup'].includes(data.format)) throw new Error('Not a valid DeckVault backup.');
  if(!confirm('Restore '+data.collection.length+' entries?')) return;
  for(let i=0;i<data.collection.length;i++) await putOne(data.collection[i]);
  if(data.settings&&data.settings.priceSource) await setSetting('priceSource',data.settings.priceSource);
  $('#priceSource').value=await getSetting('priceSource','tcgplayer-market');renderDashboard();renderLibrary();toast('Backup restored');
}

async function init(){
  try{db=await openDB();}catch(e){alert('DeckVault could not open local storage: '+e.message);return;}
  $$('[data-go]').forEach(function(b){b.addEventListener('click',function(){go(b.dataset.go);});});
  $('#searchBtn').addEventListener('click',search);
  $('#searchName').addEventListener('keydown',function(e){if(e.key==='Enter')search();});
  $('#searchNumber').addEventListener('keydown',function(e){if(e.key==='Enter')search();});
  $('#librarySearch').addEventListener('input',renderLibrary);$('#librarySort').addEventListener('change',renderLibrary);$('#refreshPrices').addEventListener('click',refreshPrices);
  $('#startCamera').addEventListener('click',startCamera);$('#captureCard').addEventListener('click',capture);$('#retake').addEventListener('click',retake);
  $('#exportJson').addEventListener('click',exportJson);$('#exportCsv').addEventListener('click',function(){exportCsv(false);});$('#exportCollectr').addEventListener('click',function(){exportCsv(true);});
  $('#importJson').addEventListener('change',async function(e){if(!e.target.files[0])return;try{await importBackup(e.target.files[0]);}catch(err){alert(err.message);}e.target.value='';});
  $('#clearData').addEventListener('click',async function(){if(confirm('Permanently clear the local DeckVault collection on this device?')){await clearAll();renderDashboard();renderLibrary();toast('Collection cleared');}});
  $('#priceSource').value=await getSetting('priceSource','tcgplayer-market');$('#priceSource').addEventListener('change',async function(e){await setSetting('priceSource',e.target.value);toast('Price source saved');});
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();installPrompt=e;$('#installBtn').classList.remove('hidden');});
  $('#installBtn').addEventListener('click',async function(){if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installBtn').classList.add('hidden');});
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
  renderDashboard();
}
document.addEventListener('DOMContentLoaded',init);
window.addEventListener('pagehide',function(){if(stream)stream.getTracks().forEach(function(t){t.stop();});});