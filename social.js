'use strict';

// Bootstrap mode stays false until the owner's account is created and promoted to admin.
// After that, it is flipped to true so new visitors apply instead of self-registering.
const APPLICATION_MODE=true;

const PROFILE_FIELDS=[
  ['birthday','Birthday','date'],
  ['location','Location','text'],
  ['website','Website','url'],
  ['instagram','Instagram','text'],
  ['x','X / Twitter','text'],
  ['tiktok','TikTok','text'],
  ['youtube','YouTube','text'],
  ['discord','Discord','text'],
  ['facebook','Facebook','text'],
  ['threads','Threads','text'],
  ['bluesky','Bluesky','text']
];

let currentProfile=null;
let isAdmin=false;
let tradeListId=null;

function marketplaceLabel(mode){
  return ({off:'Not trading',trade:'Trade only',sell:'Sell / cash only',both:'Trade + Sell'})[mode]||'Not trading';
}

function authPane(id){
  ['signinPane','signupPane','applicationPane','resetPane'].forEach(x=>$('#'+x).classList.toggle('hidden',x!==id));
  setAuthMessage('');
}

async function submitApplication(e){
  e.preventDefault();
  setAuthMessage('Submitting application…');
  const {data,error}=await sb.functions.invoke('submit-account-application',{
    body:{email:$('#applicationEmail').value.trim(),username:$('#applicationUsername').value.trim()}
  });
  if(error)return setAuthMessage(error.message||'Could not submit application.',true);
  if(data?.error)return setAuthMessage(data.error,true);
  if(data?.status==='pending') return setAuthMessage('Your application is already pending review.');
  if(data?.status==='approved') return setAuthMessage('This email has already been approved. Check your email for your invitation.');
  $('#applicationForm').reset();
  setAuthMessage('Application submitted. You’ll receive an email if it is approved.');
}

async function ensureProfile(){
  if(!currentUser)return null;
  let {data,error}=await sb.from('profiles').select('*').eq('id',currentUser.id).maybeSingle();
  if(error){console.error(error);return null;}
  if(!data){
    const requested=currentUser.user_metadata?.requested_username||null;
    const ins=await sb.from('profiles').insert({
      id:currentUser.id,
      username:requested,
      display_name:null,
      bio:null,
      onboarding_complete:false
    }).select().single();
    if(ins.error){console.error(ins.error);return null;}
    data=ins.data;
  }
  currentProfile=data;
  return data;
}

async function refreshSocialState(){
  if(!currentUser)return;
  const p=await ensureProfile();
  if(!p)return;
  await checkAdmin();
  if(!p.onboarding_complete){
    $('#onboardingUsername').value=p.username||currentUser.user_metadata?.requested_username||'';
    $('#onboardingDisplayName').value=p.display_name||'';
    $('#onboardingBio').value=p.bio||'';
    $('#onboardingGate').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
  }else{
    $('#onboardingGate').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
  }
  await loadProfileSettings();
  await loadMyLists();
  await loadTradeList();
}

async function finishOnboarding(e){
  e.preventDefault();
  const username=$('#onboardingUsername').value.trim();
  const display=$('#onboardingDisplayName').value.trim();
  const bio=$('#onboardingBio').value.trim();
  const password=$('#onboardingPassword').value;
  const msg=$('#onboardingMessage');
  msg.textContent='';
  msg.classList.remove('error');
  if(!/^[A-Za-z0-9_.-]{3,24}$/.test(username)){
    msg.textContent='Username must be 3–24 characters using letters, numbers, ., _ or -.';
    msg.classList.add('error'); return;
  }
  if(currentUser.user_metadata?.deckvault_approved && password.length<8){
    msg.textContent='Set a password of at least 8 characters to finish your invited account.';
    msg.classList.add('error'); return;
  }
  if(password){
    const u=await sb.auth.updateUser({password});
    if(u.error){msg.textContent=u.error.message;msg.classList.add('error');return;}
  }
  const {data,error}=await sb.from('profiles').update({
    username,display_name:display||null,bio:bio||null,onboarding_complete:true,updated_at:new Date().toISOString()
  }).eq('id',currentUser.id).select().single();
  if(error){msg.textContent=error.code==='23505'?'That username is already taken.':error.message;msg.classList.add('error');return;}
  currentProfile=data;
  $('#onboardingGate').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  await loadProfileSettings();
  toast('Account setup complete');
}

async function loadProfileSettings(){
  if(!currentUser)return;
  const {data:p}=await sb.from('profiles').select('*').eq('id',currentUser.id).maybeSingle();
  if(p){
    currentProfile=p;
    $('#profileUsername').value=p.username||'';
    $('#profileDisplayName').value=p.display_name||'';
    $('#profileBio').value=p.bio||'';
    $('#profileAvatarUrl').value=p.avatar_url||'';
    $('#marketplaceMode').value=p.marketplace_mode||'off';
    $('#marketplaceNote').value=p.marketplace_note||'';
  }
  const {data:details}=await sb.from('profile_details').select('*').eq('user_id',currentUser.id);
  const map=Object.fromEntries((details||[]).map(d=>[d.field_key,d]));
  const box=$('#profileDetailsForm');
  box.innerHTML='';
  PROFILE_FIELDS.forEach(([key,label,type])=>{
    const d=map[key]||{};
    const row=document.createElement('div');
    row.className='detailrow';
    row.innerHTML='<label>'+esc(label)+'<input data-field="'+esc(key)+'" type="'+esc(type)+'" value="'+esc(d.field_value||'')+'"></label><label class="privacylabel">Visibility<select data-visibility="'+esc(key)+'"><option value="private">Private</option><option value="public">Public</option></select></label>';
    row.querySelector('[data-visibility]').value=d.visibility||'private';
    box.appendChild(row);
  });
}

async function saveProfile(){
  const username=$('#profileUsername').value.trim();
  if(!/^[A-Za-z0-9_.-]{3,24}$/.test(username))return toast('Username must be 3–24 valid characters');
  const {data,error}=await sb.from('profiles').update({
    username,
    display_name:$('#profileDisplayName').value.trim()||null,
    bio:$('#profileBio').value.trim()||null,
    avatar_url:$('#profileAvatarUrl').value.trim()||null,
    updated_at:new Date().toISOString()
  }).eq('id',currentUser.id).select().single();
  if(error)return toast(error.code==='23505'?'Username already taken':'Could not save profile');
  currentProfile=data;toast('Profile saved');
}

async function saveProfileDetails(){
  for(const [key] of PROFILE_FIELDS){
    const val=$('[data-field="'+key+'"]').value.trim();
    const visibility=$('[data-visibility="'+key+'"]').value;
    if(!val){
      await sb.from('profile_details').delete().eq('user_id',currentUser.id).eq('field_key',key);
    }else{
      const {error}=await sb.from('profile_details').upsert({
        user_id:currentUser.id,field_key:key,field_value:val,visibility,updated_at:new Date().toISOString()
      },{onConflict:'user_id,field_key'});
      if(error){console.error(error);return toast('Could not save '+key);}
    }
  }
  toast('Profile privacy saved');
}

async function searchCommunity(){
  const q=$('#communitySearch').value.trim();
  let query=sb.from('profiles').select('id,username,display_name,bio,avatar_url,marketplace_mode,marketplace_note').not('username','is',null).limit(30);
  if(q)query=query.ilike('username','%'+q.replace(/[%_]/g,'')+'%');
  const {data,error}=await query;
  const box=$('#communityResults');box.innerHTML='';
  $('#publicProfileView').classList.add('hidden');
  if(error){box.innerHTML='<div class="empty">Could not load profiles.</div>';return;}
  if(!data?.length){box.innerHTML='<div class="empty">No profiles found.</div>';return;}
  data.forEach(p=>{
    const e=document.createElement('button');e.className='profilecard';
    e.innerHTML=(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'<div><strong>@'+esc(p.username)+'</strong><span>'+esc(p.display_name||'')+'</span><small>'+esc((p.bio||'').slice(0,90))+'</small></div>';
    e.onclick=()=>viewProfile(p.id);box.appendChild(e);
  });
}

async function viewProfile(userId){
  const [{data:p,error},{data:details},{data:lists}]=await Promise.all([
    sb.from('profiles').select('id,username,display_name,bio,avatar_url,marketplace_mode,marketplace_note').eq('id',userId).single(),
    sb.from('profile_details').select('field_key,field_value,visibility').eq('user_id',userId),
    sb.from('collection_lists').select('id,name,description,visibility').eq('user_id',userId).order('created_at',{ascending:false})
  ]);
  if(error)return toast('Profile unavailable');
  const box=$('#publicProfileView');box.classList.remove('hidden');
  const d=(details||[]).filter(x=>userId===currentUser.id||x.visibility==='public');
  const marketBadge=p.marketplace_mode&&p.marketplace_mode!=='off'?'<span class="marketbadge '+esc(p.marketplace_mode)+'">'+esc(marketplaceLabel(p.marketplace_mode))+'</span>':'';
  box.innerHTML='<div class="profilehero">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'">':'<div class="avatarfallback large">DV</div>')+'<div><div class="eyebrow">COLLECTOR PROFILE</div><h2>@'+esc(p.username||'collector')+'</h2>'+marketBadge+'<strong>'+esc(p.display_name||'')+'</strong><p>'+esc(p.bio||'')+'</p>'+(p.marketplace_mode!=='off'&&p.marketplace_note?'<p class="marketnote">'+esc(p.marketplace_note)+'</p>':'')+'</div></div>'+
    '<div class="publicdetails">'+d.map(x=>'<div><span>'+esc(PROFILE_FIELDS.find(f=>f[0]===x.field_key)?.[1]||x.field_key)+'</span><strong>'+esc(x.field_value)+'</strong></div>').join('')+'</div>'+
    '<h3>Public lists</h3><div id="profileLists" class="liststack"></div><div id="profileListContents"></div>';
  const lb=$('#profileLists');
  const visible=(lists||[]).filter(l=>userId===currentUser.id||l.visibility==='public');
  if(!visible.length)lb.innerHTML='<div class="empty">This collector has no public lists.</div>';
  else visible.forEach(l=>{const b=document.createElement('button');b.className='listcard';b.innerHTML='<strong>'+esc(l.name)+'</strong><span>'+esc(l.description||'')+'</span>';b.onclick=()=>viewPublicList(l);lb.appendChild(b);});
  box.scrollIntoView({behavior:'smooth',block:'start'});
}

async function viewPublicList(list){
  const {data,error}=await sb.from('collection_list_items').select('collection_item_id,collection_items(*)').eq('list_id',list.id);
  const box=$('#profileListContents');
  if(error){box.innerHTML='<div class="empty">Could not load list.</div>';return;}
  box.innerHTML='<h3>'+esc(list.name)+'</h3><div id="publicListCards" class="library"></div>';
  const cards=$('#publicListCards');
  const rows=(data||[]).map(r=>r.collection_items).filter(Boolean).map(fromRow);
  if(!rows.length)cards.innerHTML='<div class="empty">No cards in this list yet.</div>';
  else rows.forEach(x=>cards.appendChild(rowFor(x,true)));
}

async function loadMyLists(){
  if(!currentUser||!$('#myLists'))return;
  const {data,error}=await sb.from('collection_lists').select('*').eq('user_id',currentUser.id).order('created_at',{ascending:false});
  const box=$('#myLists');box.innerHTML='';
  if(error){box.innerHTML='<div class="empty">Could not load lists.</div>';return;}
  if(!data?.length){box.innerHTML='<div class="empty">No lists yet.</div>';return;}
  data.filter(l=>!l.system_key).forEach(l=>{
    const e=document.createElement('div');e.className='listmanager';
    e.innerHTML='<div class="listmanagerhead"><div><strong>'+esc(l.name)+'</strong><small>'+esc(l.description||'')+'</small></div><select data-vis><option value="private">Private</option><option value="public">Public</option></select></div><div class="listadd"><select data-card><option value="">Add a card…</option>'+items.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name+' — '+x.setName+' #'+x.localId)+'</option>').join('')+'</select><button class="secondary" data-add>Add</button><button class="dangerbtn" data-delete>Delete list</button></div>';
    e.querySelector('[data-vis]').value=l.visibility;
    e.querySelector('[data-vis]').onchange=async ev=>{await sb.from('collection_lists').update({visibility:ev.target.value,updated_at:new Date().toISOString()}).eq('id',l.id);toast('List visibility updated');};
    e.querySelector('[data-add]').onclick=async()=>{const id=e.querySelector('[data-card]').value;if(!id)return;const {error}=await sb.from('collection_list_items').upsert({list_id:l.id,collection_item_id:id},{onConflict:'list_id,collection_item_id'});if(error)return toast('Could not add card');toast('Card added to '+l.name);};
    e.querySelector('[data-delete]').onclick=async()=>{if(!confirm('Delete list "'+l.name+'"?'))return;await sb.from('collection_lists').delete().eq('id',l.id);loadMyLists();};
    box.appendChild(e);
  });
}

async function createList(){
  const name=$('#newListName').value.trim();if(!name)return toast('Enter a list name');
  const {error}=await sb.from('collection_lists').insert({user_id:currentUser.id,name,visibility:$('#newListVisibility').value});
  if(error)return toast('Could not create list');
  $('#newListName').value='';await loadMyLists();toast('List created');
}


async function saveMarketplaceSettings(){
  const mode=$('#marketplaceMode').value;
  const note=$('#marketplaceNote').value.trim()||null;
  const {data,error}=await sb.from('profiles').update({
    marketplace_mode:mode,
    marketplace_note:note,
    updated_at:new Date().toISOString()
  }).eq('id',currentUser.id).select().single();
  if(error)return toast('Could not save marketplace status');
  currentProfile=data;
  await loadTradeList();
  toast(mode==='off'?'Marketplace hidden':'Marketplace status saved');
}

async function loadTradeList(){
  if(!currentUser||!$('#tradeListItems'))return;
  const {data:list,error}=await sb.from('collection_lists')
    .select('id,name,visibility,system_key,collection_list_items(collection_item_id,offer_quantity,asking_price,offer_note,collection_items(*))')
    .eq('user_id',currentUser.id)
    .eq('system_key','trade')
    .maybeSingle();
  if(error){console.error(error);$('#tradeListItems').innerHTML='<div class="empty">Could not load Trade / Sell list.</div>';return;}
  tradeListId=list?.id||null;
  const mode=currentProfile?.marketplace_mode||'off';
  $('#tradeListStatus').textContent=mode==='off'?'Hidden':marketplaceLabel(mode);
  $('#tradeListStatus').classList.toggle('active',mode!=='off');

  const select=$('#tradeCardSelect');
  select.innerHTML='<option value="">Choose a card…</option>'+items.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name+' — '+x.setName+' #'+x.localId+' — '+x.condition)+'</option>').join('');

  const box=$('#tradeListItems');box.innerHTML='';
  const rows=list?.collection_list_items||[];
  if(!rows.length){box.innerHTML='<div class="empty">No cards in your Trade / Sell list yet.</div>';return;}
  rows.forEach(r=>{
    const c=r.collection_items?fromRow(r.collection_items):null;
    if(!c)return;
    const e=document.createElement('div');e.className='tradeentry';
    e.innerHTML='<img src="'+esc(imageUrl(c.image))+'" alt=""><div class="tradeentrymain"><strong>'+esc(c.name)+'</strong><span>'+esc(c.setName)+' • #'+esc(c.localId)+' • '+esc(c.variant)+' • '+esc(c.condition)+'</span><small>Offering '+Math.min(Number(r.offer_quantity||1),Number(c.quantity||1))+' of '+c.quantity+' owned'+(r.asking_price!=null?' • Asking '+money(r.asking_price,c.priceCurrency||'USD'):'')+'</small>'+(r.offer_note?'<small>'+esc(r.offer_note)+'</small>':'')+'</div><button class="dangerbtn" data-remove>Remove</button>';
    e.querySelector('[data-remove]').onclick=()=>removeTradeCard(c.id);
    box.appendChild(e);
  });
}

async function addTradeCard(){
  if(!tradeListId)await loadTradeList();
  const itemId=$('#tradeCardSelect').value;
  const owned=items.find(x=>x.id===itemId);
  if(!owned)return toast('Choose a card from your collection');
  const qty=Math.max(1,parseInt($('#tradeOfferQuantity').value||'1',10));
  if(qty>Number(owned.quantity||1))return toast('Offer quantity is more than you own');
  const rawPrice=$('#tradeAskingPrice').value.trim();
  const asking=rawPrice===''?null:Number(rawPrice);
  const note=$('#tradeOfferNote').value.trim()||null;
  const {error}=await sb.from('collection_list_items').upsert({
    list_id:tradeListId,
    collection_item_id:itemId,
    offer_quantity:qty,
    asking_price:asking,
    offer_note:note
  },{onConflict:'list_id,collection_item_id'});
  if(error){console.error(error);return toast('Could not add marketplace listing');}
  $('#tradeOfferQuantity').value='1';$('#tradeAskingPrice').value='';$('#tradeOfferNote').value='';
  await loadTradeList();
  toast('Trade / Sell listing saved');
}

async function removeTradeCard(itemId){
  if(!tradeListId)return;
  const {error}=await sb.from('collection_list_items').delete().eq('list_id',tradeListId).eq('collection_item_id',itemId);
  if(error)return toast('Could not remove listing');
  await loadTradeList();toast('Listing removed');
}

async function marketCardSearch(){
  const name=$('#marketSearchName').value.trim(), number=$('#marketSearchNumber').value.trim();
  if(!name&&!number)return toast('Enter a card name or collector number');
  $('#marketSearchStatus').textContent='Searching card database…';
  $('#marketCardResults').innerHTML='';$('#marketOffers').innerHTML='';$('#marketOfferHeading').classList.add('hidden');
  try{
    const cards=await pokemonSearch(name,number);
    $('#marketSearchStatus').textContent=cards.length+' card match'+(cards.length===1?'':'es');
    const box=$('#marketCardResults');
    if(!cards.length){box.innerHTML='<div class="empty">No matching cards found.</div>';return;}
    cards.slice(0,30).forEach(c=>{
      const e=document.createElement('article');e.className='result';
      e.innerHTML='<img loading="lazy" src="'+esc(imageUrl(c.image))+'" alt="'+esc(c.name)+'"><div class="info"><strong>'+esc(c.name)+'</strong><div class="meta">#'+esc(c.localId)+' • '+esc(c.id)+'</div><button type="button">Find offers</button></div>';
      e.querySelector('button').onclick=()=>findTradeOffers(c);
      box.appendChild(e);
    });
  }catch(err){$('#marketSearchStatus').textContent=err.message;}
}

async function findTradeOffers(card){
  $('#marketOfferHeading').classList.remove('hidden');
  $('#marketOfferHeading').innerHTML='<h2>'+esc(card.name)+' offers</h2><div class="muted">#'+esc(card.localId)+' • '+esc(card.id)+'</div>';
  $('#marketOffers').innerHTML='<div class="empty">Checking active Trade / Sell lists…</div>';
  const {data,error}=await sb.rpc('search_trade_offers',{p_game:'pokemon',p_card_id:card.id});
  const box=$('#marketOffers');box.innerHTML='';
  if(error){console.error(error);box.innerHTML='<div class="empty">Could not search marketplace.</div>';return;}
  if(!data?.length){box.innerHTML='<div class="empty">No approved collectors currently have this card in an active Trade / Sell list.</div>';return;}
  data.forEach(o=>{
    const e=document.createElement('article');e.className='offercard';
    const who=o.user_id===currentUser.id?'You':'@'+(o.username||'collector');
    const asking=o.asking_price!=null&&['sell','both'].includes(o.marketplace_mode)?'<div class="offerprice">'+money(o.asking_price,o.price_currency||'USD')+'</div>':'';
    e.innerHTML='<div class="offeruser">'+(o.avatar_url?'<img src="'+esc(o.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'<div><strong>'+esc(who)+'</strong><span class="marketbadge '+esc(o.marketplace_mode)+'">'+esc(marketplaceLabel(o.marketplace_mode))+'</span></div>'+asking+'</div><div class="offerbody"><strong>'+esc(o.card_name)+'</strong><span>'+esc(o.set_name)+' • #'+esc(o.local_id)+'</span><span>'+esc(o.variant)+' • '+esc(o.condition)+' • '+esc(o.language)+'</span><span>Available quantity: '+Number(o.offer_quantity||1)+'</span>'+(o.offer_note?'<p>'+esc(o.offer_note)+'</p>':'')+(o.marketplace_note?'<p class="marketnote">'+esc(o.marketplace_note)+'</p>':'')+'<button type="button" class="secondary">View profile</button></div>';
    e.querySelector('button').onclick=()=>{go('community');viewProfile(o.user_id);};
    box.appendChild(e);
  });
  $('#marketOfferHeading').scrollIntoView({behavior:'smooth',block:'start'});
}

async function checkAdmin(){
  const {data}=await sb.from('admin_users').select('user_id').eq('user_id',currentUser.id).maybeSingle();
  isAdmin=!!data;
  $('#adminPanel').classList.toggle('hidden',!isAdmin);
  if(isAdmin)await loadApplications();
}

async function loadApplications(){
  if(!isAdmin)return;
  const {data,error}=await sb.from('account_applications').select('*').eq('status','pending').order('created_at',{ascending:true});
  const box=$('#applicationQueue');box.innerHTML='';
  if(error){box.innerHTML='<div class="empty">Could not load applications.</div>';return;}
  if(!data?.length){box.innerHTML='<div class="empty">No pending applications.</div>';return;}
  data.forEach(a=>{
    const e=document.createElement('div');e.className='applicationrow';
    e.innerHTML='<div><strong>@'+esc(a.requested_username)+'</strong><small>'+esc(a.email)+'</small><small>'+new Date(a.created_at).toLocaleString()+'</small></div><div><button class="primary" data-approve>Approve</button><button class="dangerbtn" data-deny>Deny</button></div>';
    e.querySelector('[data-approve]').onclick=()=>reviewApplication(a.id,'approve');
    e.querySelector('[data-deny]').onclick=()=>reviewApplication(a.id,'deny');
    box.appendChild(e);
  });
}

async function reviewApplication(id,action){
  const {data,error}=await sb.functions.invoke('review-account-application',{body:{application_id:id,action}});
  if(error||data?.error)return toast(data?.error||error?.message||'Review failed');
  toast(action==='approve'?'Approved — invitation sent':'Application denied');
  await loadApplications();
}

document.addEventListener('DOMContentLoaded',()=>{
  // DeckVault account creation is approval-only.
  $('#showSignUp').onclick=()=>authPane(APPLICATION_MODE?'applicationPane':'signupPane');
  $('#applicationBack').onclick=()=>authPane('signinPane');
  $('#applicationForm').onsubmit=submitApplication;
  $('#onboardingForm').onsubmit=finishOnboarding;
  $('#saveProfileBtn').onclick=saveProfile;
  $('#saveMarketplaceBtn').onclick=saveMarketplaceSettings;
  $('#addTradeCardBtn').onclick=addTradeCard;
  $('#saveProfileDetailsBtn').onclick=saveProfileDetails;
  $('#createListBtn').onclick=createList;
  $('#communitySearchBtn').onclick=searchCommunity;
  $('#marketSearchBtn').onclick=marketCardSearch;
  $('#marketSearchName').onkeydown=e=>{if(e.key==='Enter')marketCardSearch();};
  $('#marketSearchNumber').onkeydown=e=>{if(e.key==='Enter')marketCardSearch();};
  $('#communitySearch').onkeydown=e=>{if(e.key==='Enter')searchCommunity();};
  $('#refreshApplications').onclick=loadApplications;
  document.querySelectorAll('[data-go="community"]').forEach(b=>b.addEventListener('click',searchCommunity));
  document.querySelectorAll('[data-go="settings"]').forEach(b=>b.addEventListener('click',()=>{loadProfileSettings();loadMyLists();loadTradeList();if(isAdmin)loadApplications();}));
  sb.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT'){$('#onboardingGate').classList.add('hidden');return;}
    if(session?.user)setTimeout(refreshSocialState,50);
  });
  setTimeout(()=>{if(currentUser)refreshSocialState();},250);
});