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
let folders=[], folderMembership=new Map(), activeFolderId=null, folderAssignItemId=null;
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const money=(n,c='USD')=>n==null||Number.isNaN(Number(n))?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:c}).format(Number(n));
const imageUrl=(base,q='low')=>{
  if(!base)return '';
  if(/^https?:\/\//i.test(base)&&!base.includes('tcgdex.net'))return base;
  return base+'/'+q+'.webp';
};
function toast(m){const e=$('#toast');e.textContent=m;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),1800);}
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

  const {data:ban,error:banError}=await sb.from('user_bans').select('reason,banned_at,active').eq('user_id',user.id).eq('active',true).maybeSingle();
  if(!banError&&ban){
    $('#authGate').classList.add('hidden');
    $('#banReason').textContent=ban.reason||'Account access has been suspended.';
    $('#banDate').textContent=ban.banned_at?'Banned '+new Date(ban.banned_at).toLocaleString():'';
    $('#bannedGate').classList.remove('hidden');
    return false;
  }

  const {data:approved,error:approvalError}=await sb.from('approved_users').select('user_id').eq('user_id',user.id).maybeSingle();
  if(approvalError||!approved){
    await sb.auth.signOut();
    showAuth();
    setAuthMessage('This account has not been approved for DeckVault yet.',true);
    return false;
  }

  const doc=await getCurrentTerms();
  const {data:accepted}=await sb.from('terms_acceptances').select('terms_version').eq('user_id',user.id).eq('terms_version',doc.version).maybeSingle();
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
  await loadCollection();await loadFolders();renderDashboard();renderLibrary();
  if(window.refreshSocialState)setTimeout(()=>window.refreshSocialState(),50);
  return true;
}
async function loadCollection(){
  if(!currentUser){items=[];return;}
  const {data,error}=await sb.from('collection_items').select('*').eq('user_id',currentUser.id).order('added_at',{ascending:false});
  if(error){console.error(error);toast('Could not load collection');return;}
  items=(data||[]).map(fromRow);
}
async function loadFolders(){
  if(!currentUser){folders=[];folderMembership=new Map();return;}
  const [fRes,mRes]=await Promise.all([
    sb.from('collection_folders').select('*').eq('user_id',currentUser.id).order('name'),
    sb.from('collection_folder_items').select('folder_id,collection_item_id')
  ]);
  if(fRes.error||mRes.error){console.error(fRes.error||mRes.error);toast('Could not load library folders');return;}
  folders=fRes.data||[];
  folderMembership=new Map();
  (mRes.data||[]).forEach(row=>{
    if(!folderMembership.has(row.folder_id))folderMembership.set(row.folder_id,new Set());
    folderMembership.get(row.folder_id).add(row.collection_item_id);
  });
  if(activeFolderId&&!folders.some(f=>f.id===activeFolderId))activeFolderId=null;
  renderFolderChips();
  populateManualFolderSelect();
}

function folderItems(folderId){
  if(!folderId)return [...items];
  const ids=folderMembership.get(folderId)||new Set();
  return items.filter(x=>ids.has(x.id));
}
function collectionValue(rows){
  return rows.reduce((sum,x)=>sum+((x.priceCurrency==='USD'||!x.priceCurrency)?Number(x.price||0)*Number(x.quantity||0):0),0);
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
  const {error}=await sb.from('collection_folders').insert({user_id:currentUser.id,name:name.trim()});
  if(error)return toast(error.code==='23505'?'A folder with that name already exists':'Could not create folder');
  await loadFolders();renderLibrary();toast('Folder created');
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
  const selected=$('#folderAssignOptions input:checked').map(x=>x.value);
  for(const folder of folders){
    const has=(folderMembership.get(folder.id)||new Set()).has(folderAssignItemId);
    const want=selected.includes(folder.id);
    if(want&&!has)await sb.from('collection_folder_items').insert({folder_id:folder.id,collection_item_id:folderAssignItemId});
    if(!want&&has)await sb.from('collection_folder_items').delete().eq('folder_id',folder.id).eq('collection_item_id',folderAssignItemId);
  }
  $('#folderAssignDialog').close();
  await loadFolders();renderLibrary();toast('Folders updated');
}
function openManualCard(){
  $('#manualCardMessage').textContent='';
  $('#manualName').value='';$('#manualSetName').value='';$('#manualLocalId').value='';
  $('#manualVariant').value='Normal';$('#manualCondition').value='Near Mint';$('#manualLanguage').value='English';
  $('#manualQuantity').value='1';$('#manualCurrentValue').value='';$('#manualPricePaid').value='';$('#manualImageUrl').value='';
  populateManualFolderSelect();
  $('#manualCardDialog').showModal();
}
async function saveManualCard(){
  const name=$('#manualName').value.trim();
  if(!name){$('#manualCardMessage').textContent='Card name is required.';$('#manualCardMessage').classList.add('error');return;}
  const qty=Math.max(1,parseInt($('#manualQuantity').value||'1',10));
  const now=new Date().toISOString();
  const obj={
    game:$('#manualGame').value,
    cardId:'manual:'+crypto.randomUUID(),
    name,
    localId:$('#manualLocalId').value.trim(),
    setId:'',
    setName:$('#manualSetName').value.trim(),
    rarity:'',
    variant:$('#manualVariant').value.trim()||'Normal',
    condition:$('#manualCondition').value,
    language:$('#manualLanguage').value.trim()||'English',
    quantity:qty,
    image:$('#manualImageUrl').value.trim(),
    price:$('#manualCurrentValue').value===''?null:Number($('#manualCurrentValue').value),
    pricePaid:$('#manualPricePaid').value===''?null:Number($('#manualPricePaid').value),
    priceCurrency:'USD',
    priceSource:'Manual',
    priceUpdatedAt:now,
    entrySource:'manual',
    notes:'',
    addedAt:now
  };
  const {data,error}=await sb.from('collection_items').insert({...toRow(obj),added_at:now}).select().single();
  if(error){$('#manualCardMessage').textContent=error.message;$('#manualCardMessage').classList.add('error');return;}
  const folderId=$('#manualFolder').value;
  if(folderId)await sb.from('collection_folder_items').insert({folder_id:folderId,collection_item_id:data.id});
  $('#manualCardDialog').close();
  await loadCollection();await loadFolders();renderDashboard();renderLibrary();toast(name+' added');
}

function fromRow(r){return {id:r.id,game:r.game,cardId:r.card_id,name:r.name,localId:r.local_id,setId:r.set_id,setName:r.set_name,rarity:r.rarity,variant:r.variant,condition:r.condition,language:r.language,quantity:r.quantity,image:r.image_url,price:r.price==null?null:Number(r.price),pricePaid:r.price_paid==null?null:Number(r.price_paid),priceCurrency:r.price_currency,priceSource:r.price_source,priceUpdatedAt:r.price_updated_at,entrySource:r.entry_source||'provider',notes:r.notes||'',addedAt:r.added_at,updatedAt:r.updated_at};}
function toRow(x){return {user_id:currentUser.id,game:x.game,card_id:x.cardId,name:x.name,local_id:x.localId,set_id:x.setId,set_name:x.setName,rarity:x.rarity,variant:x.variant,condition:x.condition,language:x.language,quantity:x.quantity,image_url:x.image,price:x.price,price_paid:x.pricePaid,price_currency:x.priceCurrency,price_source:x.priceSource,price_updated_at:x.priceUpdatedAt,entry_source:x.entrySource||'provider',notes:x.notes||'',updated_at:new Date().toISOString()};}
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

function go(view){$$('.view').forEach(v=>v.classList.toggle('active',v.id===view));$$('.bottomnav button').forEach(b=>b.classList.toggle('active',b.dataset.go===view));window.scrollTo({top:0,behavior:'smooth'});if(view==='dashboard')renderDashboard();if(view==='library')renderLibrary();}
async function pokemonSearch(name,number){const p=new URLSearchParams();if(name)p.set('name',name.trim());if(number)p.set('localId',number.trim());const r=await fetch(API+'/cards?'+p);if(!r.ok)throw new Error('TCGdex search failed ('+r.status+')');return r.json();}
async function pokemonCard(id){const r=await fetch(API+'/cards/'+encodeURIComponent(id));if(!r.ok)throw new Error('Could not load card');return r.json();}
function pokemonVariants(c){const v=c.variants||{},o=[];if(v.normal)o.push('Normal');if(v.holo)o.push('Holofoil');if(v.reverse)o.push('Reverse Holofoil');if(v.firstEdition)o.push('1st Edition');if(v.firstEdition&&v.holo)o.push('1st Edition Holofoil');return o.length?[...new Set(o)]:['Normal'];}
function variantPriceObject(tcg,v){if(!tcg)return null;const m={'Normal':['normal','unlimited'],'Holofoil':['holofoil','holo','unlimited-holofoil'],'Reverse Holofoil':['reverse-holofoil','reverse'],'1st Edition':['1st-edition','first-edition','firstEdition'],'1st Edition Holofoil':['1st-edition-holofoil','first-edition-holofoil']};for(const k of (m[v]||['normal']))if(tcg[k])return tcg[k];return null;}
function pricePref(){return localStorage.getItem('deckvault-price-source')||'tcgplayer-market';}
function pokemonPrice(c,v,s=pricePref()){const p=c.pricing||{};if(s.startsWith('tcgplayer')){const o=variantPriceObject(p.tcgplayer,v);return {value:s==='tcgplayer-mid'?(o&&o.midPrice):(o&&o.marketPrice),currency:(p.tcgplayer&&p.tcgplayer.unit)||'USD',label:s==='tcgplayer-mid'?'TCGplayer Mid':'TCGplayer Market'};}const cm=p.cardmarket||{},foil=v.toLowerCase().includes('holo'),k=s==='cardmarket-7'?(foil?'avg7-holo':'avg7'):(foil?'avg30-holo':'avg30');return {value:cm[k],currency:cm.unit||'EUR',label:s==='cardmarket-7'?'Cardmarket 7-day':'Cardmarket 30-day'};}
async function search(){const n=$('#searchName').value.trim(),no=$('#searchNumber').value.trim();if(!n&&!no)return toast('Enter a name or collector number');$('#searchStatus').textContent='Searching TCGdex…';try{const cards=await pokemonSearch(n,no);$('#searchStatus').textContent=cards.length+' match'+(cards.length===1?'':'es')+' found';renderResults(cards);}catch(e){$('#searchStatus').textContent=e.message;}}
function renderResults(cards){const b=$('#results');b.innerHTML='';if(!cards.length){b.innerHTML='<div class="empty">No matching cards found.</div>';return;}cards.slice(0,60).forEach(c=>{const e=document.createElement('article');e.className='result';e.innerHTML='<img loading="lazy" src="'+esc(imageUrl(c.image))+'" alt="'+esc(c.name)+'"><div class="info"><strong>'+esc(c.name)+'</strong><div class="meta">#'+esc(c.localId)+' • '+esc(c.id)+'</div><button>View / Add</button></div>';e.querySelector('button').onclick=()=>openCard(c.id);b.appendChild(e);});}

async function openCard(id){
  $('#dialogBody').innerHTML='<div class="empty">Loading card…</div>';$('#cardDialog').showModal();
  try{
    currentCard=await pokemonCard(id);
    const variants=pokemonVariants(currentCard),p=pokemonPrice(currentCard,variants[0]);
    const folderOptions='<option value="">Main Library only</option>'+folders.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+'</option>').join('');
    $('#dialogBody').innerHTML='<div class="dialogtop"><img src="'+esc(imageUrl(currentCard.image,'high'))+'"><div><div class="eyebrow">'+esc(currentCard.set?.name||'Pokémon TCG')+'</div><h2>'+esc(currentCard.name)+'</h2><div class="muted">#'+esc(currentCard.localId)+(currentCard.rarity?' • '+esc(currentCard.rarity):'')+'</div><div class="pricebox"><div id="dialogPriceLabel" class="muted">'+esc(p.label)+'</div><div id="dialogPrice" class="pricebig">'+money(p.value,p.currency)+'</div></div></div></div><div class="fields"><label>Variant<select id="variant">'+variants.map(v=>'<option>'+esc(v)+'</option>').join('')+'</select></label><label>Condition<select id="condition"><option>Near Mint</option><option>Lightly Played</option><option>Moderately Played</option><option>Heavily Played</option><option>Damaged</option></select></label><label>Language<select id="language"><option>English</option><option>Japanese</option><option>French</option><option>German</option><option>Italian</option><option>Spanish</option></select></label><label>Quantity<input id="qty" type="number" min="1" value="1"></label><label>Price paid each <span class="muted">optional</span><input id="pricePaid" type="number" min="0" step="0.01" placeholder="0.00"></label><label>Add to folder<select id="addFolder">'+folderOptions+'</select></label></div><div class="dialogactions"><button id="addCard" type="button" class="primary">Add to collection</button><button class="secondary" value="cancel">Cancel</button></div>';
    $('#variant').onchange=()=>{const q=pokemonPrice(currentCard,$('#variant').value);$('#dialogPrice').textContent=money(q.value,q.currency);$('#dialogPriceLabel').textContent=q.label;};
    $('#addCard').onclick=addCurrent;
  }catch(e){$('#dialogBody').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
async function addCurrent(){
  const variant=$('#variant').value,condition=$('#condition').value,language=$('#language').value;
  const qty=Math.max(1,parseInt($('#qty').value||'1',10)),p=pokemonPrice(currentCard,variant);
  const old=items.find(x=>x.game==='pokemon'&&x.cardId===currentCard.id&&x.variant===variant&&x.condition===condition&&x.language===language);
  const now=new Date().toISOString();
  const paid=$('#pricePaid').value===''?(old?.pricePaid??null):Number($('#pricePaid').value);
  const x={game:'pokemon',cardId:currentCard.id,name:currentCard.name,localId:String(currentCard.localId),setId:currentCard.set?.id||'',setName:currentCard.set?.name||'',rarity:currentCard.rarity||'',variant,condition,language,quantity:(old?old.quantity:0)+qty,image:currentCard.image||'',price:p.value==null?null:Number(p.value),pricePaid:paid,priceCurrency:p.currency,priceSource:p.label,priceUpdatedAt:now,entrySource:'provider',notes:old?.notes||'',addedAt:old?.addedAt||now};
  let q;
  if(old)q=await sb.from('collection_items').update(toRow(x)).eq('id',old.id).select().single();
  else q=await sb.from('collection_items').insert({...toRow(x),added_at:now}).select().single();
  if(q.error)return toast('Could not save card');
  const folderId=$('#addFolder').value;
  if(folderId){
    await sb.from('collection_folder_items').upsert({folder_id:folderId,collection_item_id:q.data.id},{onConflict:'folder_id,collection_item_id'});
  }
  $('#cardDialog').close();
  await loadCollection();await loadFolders();renderDashboard();renderLibrary();toast(currentCard.name+' saved');
}
function rowFor(x,compact){const e=document.createElement('div');e.className='cardrow';const total=(Number(x.price)||0)*(Number(x.quantity)||0);e.innerHTML='<img loading="lazy" src="'+esc(imageUrl(x.image))+'"><div class="cardmain"><div class="cardtitle">'+esc(x.name)+'</div><div class="cardmeta">'+esc(x.setName)+' • #'+esc(x.localId)+' • '+esc(x.variant)+' • '+esc(x.condition)+'</div>'+(compact?'':'<div class="qty"><button data-a="dec">−</button><span>'+x.quantity+'</span><button data-a="inc">+</button><button data-a="del">×</button></div>')+'</div><div class="cardprice">'+money(total,x.priceCurrency||'USD')+'<div class="cardmeta">×'+x.quantity+'</div></div>';if(!compact){e.querySelector('[data-a="inc"]').onclick=()=>adjust(x,1);e.querySelector('[data-a="dec"]').onclick=()=>adjust(x,-1);e.querySelector('[data-a="del"]').onclick=()=>removeEntry(x);}return e;}
async function adjust(x,d){const q=x.quantity+d;if(q<=0)return removeEntry(x);const {error}=await sb.from('collection_items').update({quantity:q,updated_at:new Date().toISOString()}).eq('id',x.id);if(error)return toast('Could not update quantity');await loadCollection();renderLibrary();renderDashboard();}
async function removeEntry(x){if(!confirm('Remove '+x.name+' from this collection?'))return;const {error}=await sb.from('collection_items').delete().eq('id',x.id);if(error)return toast('Could not remove card');await loadCollection();await loadFolders();renderLibrary();renderDashboard();}
function renderDashboard(){const count=items.reduce((s,x)=>s+Number(x.quantity||0),0),total=items.reduce((s,x)=>s+((x.priceCurrency==='USD'||!x.priceCurrency)?Number(x.price||0)*Number(x.quantity||0):0),0);$('#collectionValue').textContent=money(total);$('#totalCards').textContent=count.toLocaleString();$('#uniqueCards').textContent=items.length.toLocaleString();$('#duplicates').textContent=Math.max(0,count-items.length).toLocaleString();$('#setCount').textContent=new Set(items.map(x=>x.game+':'+x.setId).filter(Boolean)).size.toLocaleString();const r=[...items].sort((a,b)=>new Date(b.addedAt)-new Date(a.addedAt)).slice(0,5),b=$('#recent');b.innerHTML='';if(!r.length){b.className='panel empty';b.textContent='No cards yet.';}else{b.className='panel';r.forEach(x=>b.appendChild(rowFor(x,true)));}}



const HISTORY_RANGES={
  '1d':1,'7d':7,'14d':14,'21d':21,'1m':30,'3m':90,'6m':180,'1y':365,'5y':1825,'max':null
};
let activeHistoryRange='1m';

function liveProviderValues(x,card,ebayRows=[]){
  const values=[];
  if(x.price!=null)values.push({provider:'DeckVault',label:x.priceSource||'Stored value',value:Number(x.price),currency:x.priceCurrency||'USD',kind:'selected'});
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
  $$('.historyrange').forEach(b=>b.onclick=()=>{
    activeHistoryRange=b.dataset.range;
    $$('.historyrange').forEach(x=>x.classList.toggle('active',x===b));
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
async function openLibraryCardDetails(x){
  const box=$('#libraryCardDetails');
  const total=Number(x.price||0)*Number(x.quantity||0);
  const img=x.image?'<img src="'+esc(imageUrl(x.image,'high'))+'" alt="'+esc(x.name)+'">':'<div class="librarydetailplaceholder">DV</div>';
  box.innerHTML='<div class="librarydetailtop">'+img+'<div><div class="eyebrow">'+esc(x.setName||'Collection card')+'</div><h2>'+esc(x.name)+'</h2><div class="muted">'+(x.localId?'#'+esc(x.localId)+' • ':'')+esc(x.variant)+' • '+esc(x.condition)+'</div><div class="detailmetrics"><div><span>Current value</span><strong>'+money(total,x.priceCurrency||'USD')+'</strong></div><div><span>Price paid each</span><strong>'+money(x.pricePaid,'USD')+'</strong></div><div><span>Quantity</span><strong>'+Number(x.quantity||0)+'</strong></div></div></div></div><div class="valuationsection"><div class="eyebrow">CURRENT VALUES</div><h3>Price sources</h3><div id="providerValueGrid" class="providervaluegrid"><div class="empty">Loading provider values…</div></div><p class="valuesnote">Provider prices are shown in their native currency and may represent different market methodologies. PriceCharting requires a paid API subscription before DeckVault can retrieve its current values. Historical charts only use recorded source data; DeckVault does not invent older prices.</p></div><div class="valuationsection"><div class="pricehistoryhead"><div><div class="eyebrow">PRICE HISTORY</div><h3>Value over time</h3></div><select id="priceHistoryMetric"><option>Loading…</option></select></div><div class="historyranges"><button type="button" class="historyrange" data-range="1d">1D</button><button type="button" class="historyrange" data-range="7d">7D</button><button type="button" class="historyrange" data-range="14d">14D</button><button type="button" class="historyrange" data-range="21d">21D</button><button type="button" class="historyrange active" data-range="1m">1M</button><button type="button" class="historyrange" data-range="3m">3M</button><button type="button" class="historyrange" data-range="6m">6M</button><button type="button" class="historyrange" data-range="1y">1Y</button><button type="button" class="historyrange" data-range="5y">5Y</button><button type="button" class="historyrange" data-range="max">Max</button></div><div id="priceHistoryChart" class="pricehistorychart"><div class="historyempty">Loading price history…</div></div><div id="priceHistorySummary" class="historysummary"></div></div><div class="salescomphead"><div><div class="eyebrow">MARKET COMPS</div><h3>Recent eBay Sales</h3></div><span id="ebayCompStatus" class="pill">Checking…</span></div><div id="ebayCompList" class="salescomplist"><div class="empty">Loading verified comps…</div></div><a id="openEbaySold" class="secondary ebaylink" target="_blank" rel="noopener noreferrer">View reported sold listings on eBay ↗</a><p class="salesdisclaimer">DeckVault only treats a comp as verified when the data source can confirm it remained a completed sale. eBay does not expose refund/cancellation outcomes for arbitrary third-party public sales, so ordinary public “sold” results may include transactions later reversed.</p>';
  $('#openEbaySold').href=ebaySoldSearchUrl(x);
  $('#libraryCardDialog').showModal();
  activeHistoryRange='1m';
  refreshCardValuation(x).catch(console.error);

  const {data,error}=await sb.from('sales_comps_cache')
    .select('provider,listing_id,title,sold_price,shipping_price,currency,sold_at,listing_url,image_url,condition_text,sale_status')
    .eq('game',x.game)
    .eq('card_id',x.cardId)
    .eq('sale_status','verified_completed')
    .order('sold_at',{ascending:false})
    .limit(20);

  const list=$('#ebayCompList'),status=$('#ebayCompStatus');
  if(error){
    console.error(error);
    status.textContent='Unavailable';
    list.innerHTML='<div class="empty">Could not load sold comps.</div>';
    return;
  }
  if(!data?.length){
    status.textContent='No verified feed yet';
    list.innerHTML='<div class="empty">No verified eBay transactions are available for this card yet. DeckVault will not label ordinary public sold results as final transactions when refund/cancellation status cannot be verified.</div>';
    return;
  }
  status.textContent=data.length+' verified';
  list.innerHTML='';
  data.forEach(c=>{
    const row=document.createElement(c.listing_url?'a':'div');
    row.className='salescomprow';
    if(c.listing_url){row.href=c.listing_url;row.target='_blank';row.rel='noopener noreferrer';}
    const landed=Number(c.sold_price||0)+Number(c.shipping_price||0);
    row.innerHTML=(c.image_url?'<img src="'+esc(c.image_url)+'" alt="">':'<div class="salescompimg">eBay</div>')+'<div class="salescompmain"><strong>'+esc(c.title)+'</strong><span>'+esc(c.condition_text||'Condition not provided')+'</span><small>'+(c.sold_at?new Date(c.sold_at).toLocaleDateString():'Date unavailable')+' • Verified completed</small></div><div class="salescompprice">'+money(c.sold_price,c.currency||'USD')+(Number(c.shipping_price||0)>0?'<small>+'+money(c.shipping_price,c.currency||'USD')+' ship</small>':'')+'<small>'+money(landed,c.currency||'USD')+' total</small></div>';
    list.appendChild(row);
  });
}
function libraryCardFor(x){
  const e=document.createElement('article');e.className='librarycard';
  const total=Number(x.price||0)*Number(x.quantity||0);
  const img=x.image?'<img loading="lazy" src="'+esc(imageUrl(x.image))+'" alt="'+esc(x.name)+'">':'<div class="librarycardplaceholder">DV</div>';
  e.innerHTML='<div class="librarycardimage">'+img+'<span class="qtybadge">×'+x.quantity+'</span></div><div class="librarycardbody"><strong>'+esc(x.name)+'</strong><span>'+esc(x.setName||'No set')+(x.localId?' • #'+esc(x.localId):'')+'</span><span>'+esc(x.variant)+' • '+esc(x.condition)+'</span><div class="libraryprices"><div><small>Value</small><b>'+money(total,x.priceCurrency||'USD')+'</b></div><div><small>Paid ea.</small><b>'+money(x.pricePaid,'USD')+'</b></div></div><div class="librarycardactions"><button class="secondary" data-folders>Folders</button><button data-dec>−</button><button data-inc>＋</button><button class="librarydelete" data-delete>×</button></div></div>';
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
    if(sort==='value_desc')return Number(y.price||0)*y.quantity-Number(x.price||0)*x.quantity;
    if(sort==='value_asc')return Number(x.price||0)*x.quantity-Number(y.price||0)*y.quantity;
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
async function refreshPrices(){if(!items.length)return toast('No cards to refresh');const btn=$('#refreshPrices');btn.disabled=true;btn.textContent='Refreshing…';for(const id of [...new Set(items.filter(x=>x.game==='pokemon'&&x.entrySource!=='manual'&&!String(x.cardId).startsWith('manual:')).map(x=>x.cardId))].slice(0,50)){try{const c=await pokemonCard(id);for(const x of items.filter(i=>i.cardId===id)){const p=pokemonPrice(c,x.variant);await sb.from('collection_items').update({price:p.value==null?null:Number(p.value),price_currency:p.currency,price_source:p.label,price_updated_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',x.id);}}catch(e){console.warn(e);}}await loadCollection();btn.disabled=false;btn.textContent='Refresh prices';renderLibrary();renderDashboard();toast('Prices refreshed');}
async function startCamera(){try{if(stream)stream.getTracks().forEach(t=>t.stop());stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});$('#video').srcObject=stream;$('#cameraPlaceholder').classList.add('hidden');$('#video').classList.remove('hidden');$('#capturePreview').classList.add('hidden');$('#captureCard').disabled=false;$('#cameraStatus').textContent='Camera ready';}catch(e){$('#cameraStatus').textContent='Camera blocked';alert('Camera access failed. '+e.message);}}
function capture(){const v=$('#video');if(!v.videoWidth)return;const c=$('#canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0,c.width,c.height);$('#capturePreview').src=c.toDataURL('image/jpeg',.9);$('#capturePreview').classList.remove('hidden');v.classList.add('hidden');$('#captureCard').classList.add('hidden');$('#retake').classList.remove('hidden');$('#cameraStatus').textContent='Captured';}
function retake(){$('#capturePreview').classList.add('hidden');$('#video').classList.remove('hidden');$('#captureCard').classList.remove('hidden');$('#retake').classList.add('hidden');$('#cameraStatus').textContent='Camera ready';}
function download(content,type,name){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const csv=v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
async function exportJson(){download(JSON.stringify({format:'deckvault-backup',version:2,exportedAt:new Date().toISOString(),collection:items},null,2),'application/json','deckvault-backup-'+new Date().toISOString().slice(0,10)+'.json');}
async function exportCsv(collectr){const cols=collectr?['Game','Card Name','Set','Card Number','Variant','Condition','Language','Quantity','Provider ID','Current Price','Currency']:['Game','Name','Set','Set ID','Card Number','Variant','Condition','Language','Quantity','Rarity','Provider ID','Price','Price Paid','Currency','Price Source','Added At','Updated At','Notes'];const rows=items.map(x=>collectr?[x.game,x.name,x.setName,x.localId,x.variant,x.condition,x.language,x.quantity,x.cardId,x.price||'',x.priceCurrency||'']:[x.game,x.name,x.setName,x.setId,x.localId,x.variant,x.condition,x.language,x.quantity,x.rarity,x.cardId,x.price||'',x.pricePaid??'',x.priceCurrency||'',x.priceSource||'',x.addedAt,x.updatedAt,x.notes||'']);download([cols,...rows].map(r=>r.map(csv).join(',')).join('\n'),'text/csv;charset=utf-8',(collectr?'deckvault-collectr-transfer-':'deckvault-collection-')+new Date().toISOString().slice(0,10)+'.csv');}
async function importBackup(file){const d=JSON.parse(await file.text());if(!d||!Array.isArray(d.collection))throw new Error('Not a valid DeckVault backup.');if(!confirm('Restore '+d.collection.length+' entries to this account?'))return;for(const x of d.collection){const cardId=x.cardId||x.card_id;if(!cardId)continue;const variant=x.variant||'Normal',condition=x.condition||'Near Mint',language=x.language||'English';const old=items.find(i=>i.game===(x.game||'pokemon')&&i.cardId===cardId&&i.variant===variant&&i.condition===condition&&i.language===language);const obj={game:x.game||'pokemon',cardId,name:x.name||'',localId:x.localId||x.local_id||'',setId:x.setId||x.set_id||'',setName:x.setName||x.set_name||'',rarity:x.rarity||'',variant,condition,language,quantity:Number(x.quantity||1),image:x.image||x.image_url||'',price:x.price==null?null:Number(x.price),pricePaid:(x.pricePaid??x.price_paid)==null?null:Number(x.pricePaid??x.price_paid),priceCurrency:x.priceCurrency||x.price_currency||'USD',priceSource:x.priceSource||x.price_source||'',priceUpdatedAt:x.priceUpdatedAt||x.price_updated_at||null,entrySource:x.entrySource||x.entry_source||'provider',notes:x.notes||'',addedAt:x.addedAt||x.added_at||new Date().toISOString()};if(old)await sb.from('collection_items').update(toRow({...obj,id:old.id})).eq('id',old.id);else await sb.from('collection_items').insert({...toRow(obj),added_at:obj.addedAt});}await loadCollection();renderDashboard();renderLibrary();toast('Backup restored');}

async function init(){
  $$('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
  $('#signInForm').onsubmit=signIn;$('#signUpForm').onsubmit=signUp;$('#resetForm').onsubmit=resetPassword;
  $('#staySignedIn').checked=localStorage.getItem(STAY_SIGNED_IN_KEY)==='true';
  $('#staySignedIn').onchange=e=>localStorage.setItem(STAY_SIGNED_IN_KEY,e.target.checked?'true':'false');
  $('#showSignUp').onclick=()=>showPane('applicationPane');$('#showSignIn').onclick=()=>showPane('signinPane');$('#showReset').onclick=()=>showPane('resetPane');$('#resetBack').onclick=()=>showPane('signinPane');
  $('#signOutBtn').onclick=signOut;$('#bannedSignOut').onclick=signOut;$('#termsSignOut').onclick=signOut;
  $('#viewTermsAuth').onclick=openTermsDialog;$('#viewTermsBtn').onclick=openTermsDialog;
  $('#acceptTermsCheck').onchange=e=>{$('#acceptTermsBtn').disabled=!e.target.checked;};
  $('#acceptTermsBtn').onclick=acceptCurrentTerms;
  $('#searchBtn').onclick=search;$('#searchName').onkeydown=e=>{if(e.key==='Enter')search();};$('#searchNumber').onkeydown=e=>{if(e.key==='Enter')search();};
  $('#librarySearch').oninput=renderLibrary;$('#librarySort').onchange=renderLibrary;$('#refreshPrices').onclick=refreshPrices;$('#manualAddCardBtn').onclick=openManualCard;$('#saveManualCardBtn').onclick=saveManualCard;$('#newFolderBtn').onclick=createFolder;$('#manageFoldersBtn').onclick=()=>{renderFolderManager();$('#manageFoldersDialog').showModal();};$('#saveFolderAssignmentsBtn').onclick=saveFolderAssignments;$('#startCamera').onclick=startCamera;$('#captureCard').onclick=capture;$('#retake').onclick=retake;
  $('#exportJson').onclick=exportJson;$('#exportCsv').onclick=()=>exportCsv(false);$('#exportCollectr').onclick=()=>exportCsv(true);$('#importJson').onchange=async e=>{if(e.target.files[0])try{await importBackup(e.target.files[0]);}catch(err){alert(err.message);}e.target.value='';};
  $('#clearData').onclick=async()=>{if(confirm('Delete every card in your DeckVault account collection?')){const {error}=await sb.from('collection_items').delete().eq('user_id',currentUser.id);if(error)return toast('Could not clear collection');await loadCollection();renderDashboard();renderLibrary();toast('Collection cleared');}};
  $('#priceSource').value=pricePref();$('#priceSource').onchange=e=>{localStorage.setItem('deckvault-price-source',e.target.value);toast('Price source saved');};
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installBtn').classList.remove('hidden');});$('#installBtn').onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installBtn').classList.add('hidden');};
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
  if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
document.addEventListener('DOMContentLoaded',init);
window.addEventListener('pagehide',()=>{if(stream)stream.getTracks().forEach(t=>t.stop());});