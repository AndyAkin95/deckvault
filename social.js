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
let marketplaceFeedRows=[];
let mfaEnrollmentFactorId=null;
let pendingAdminAction=null;
let communityChannel=null, privateMessageChannel=null, notificationChannel=null, activeForumThreadId=null;
let activePrivateConversationId=null,activePrivateOtherUserId=null,pendingPrivateReference=null,pendingReportTarget=null;
let blockedUserIds=new Set();
let masterSetListCache=null,masterSetDetailCache=new Map();


async function refreshBlockedUsers(){
  if(!currentUser)return;
  const {data,error}=await sb.from('user_blocks').select('blocked_id').eq('blocker_id',currentUser.id);
  if(error){console.error(error);return;}
  blockedUserIds=new Set((data||[]).map(x=>x.blocked_id));
}
async function loadBlockedUsersSettings(){
  const box=$('#blockedUsersList');if(!box)return;
  await refreshBlockedUsers();box.innerHTML='';
  if(!blockedUserIds.size){box.innerHTML='<div class="empty">No blocked collectors.</div>';return;}
  const {data}=await sb.from('profiles').select('id,username,display_name,avatar_url').in('id',[...blockedUserIds]);
  (data||[]).forEach(p=>{
    const e=document.createElement('div');e.className='applicationrow';
    e.innerHTML='<div class="useridentity">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'<div><strong>@'+esc(p.username||'collector')+'</strong><small>'+esc(p.display_name||'')+'</small></div></div><button class="secondary" type="button">Unblock</button>';
    e.querySelector('button').onclick=()=>unblockUser(p.id);
    box.appendChild(e);
  });
}
async function blockUser(userId){
  if(!userId||userId===currentUser.id)return;
  if(!confirm('Block this collector? They will not be able to message you, and their marketplace listings will be hidden.'))return;
  const {error}=await sb.from('user_blocks').insert({blocker_id:currentUser.id,blocked_id:userId});
  if(error&&error.code!=='23505')return toast('Could not block user');
  blockedUserIds.add(userId);await loadBlockedUsersSettings();loadPrivateInbox().catch(()=>{});toast('Collector blocked');
}
async function unblockUser(userId){
  const {error}=await sb.from('user_blocks').delete().eq('blocker_id',currentUser.id).eq('blocked_id',userId);
  if(error)return toast('Could not unblock user');
  blockedUserIds.delete(userId);await loadBlockedUsersSettings();toast('Collector unblocked');
}
function openReport(target){
  pendingReportTarget=target;$('#reportTargetLabel').textContent=target.label||'Report DeckVault content';$('#reportReason').value='';$('#reportCategory').value=target.category||'other';$('#reportDialog').showModal();
}
async function submitReport(){
  if(!pendingReportTarget)return;
  const reason=$('#reportReason').value.trim();if(reason.length<3)return toast('Add a little more detail');
  const {error}=await sb.from('user_reports').insert({
    reporter_user_id:currentUser.id,target_user_id:pendingReportTarget.userId||null,
    target_type:pendingReportTarget.type,target_id:pendingReportTarget.id?String(pendingReportTarget.id):null,
    category:$('#reportCategory').value,reason
  });
  if(error){console.error(error);return toast('Could not submit report');}
  $('#reportDialog').close();pendingReportTarget=null;toast('Report submitted');
}
function updateNotificationBadge(count){
  const b=$('#notificationBadge');if(!b)return;const n=Math.max(0,Number(count||0));
  b.textContent=n>99?'99+':String(n);b.classList.toggle('hidden',n===0);
}
async function loadNotifications(){
  if(!currentUser)return;
  const {data,error}=await sb.from('notifications').select('*').eq('user_id',currentUser.id).order('created_at',{ascending:false}).limit(100);
  const box=$('#notificationsList');if(!box)return;box.innerHTML='';
  if(error){console.error(error);box.innerHTML='<div class="empty">Could not load notifications.</div>';return;}
  const rows=data||[];updateNotificationBadge(rows.filter(n=>!n.read_at).length);
  if(!rows.length){box.innerHTML='<div class="empty">No notifications yet.</div>';return;}
  rows.forEach(n=>{
    const b=document.createElement('button');b.type='button';b.className='notificationrow'+(n.read_at?'':' unread');
    b.innerHTML='<div><strong>'+esc(n.title)+'</strong><p>'+esc(n.body||'')+'</p><small>'+new Date(n.created_at).toLocaleString()+'</small></div><span>›</span>';
    b.onclick=()=>openNotification(n);box.appendChild(b);
  });
}
async function openNotification(n){
  if(!n.read_at)await sb.from('notifications').update({read_at:new Date().toISOString()}).eq('id',n.id);
  $('#notificationsDialog').close();loadNotifications().catch(()=>{});
  if(n.reference_type==='private_conversation'){
    const {data:c}=await sb.from('private_conversations').select('id,user_one,user_two').eq('id',n.reference_id).maybeSingle();
    if(c){go('community');switchCommunityTab('messages');const other=c.user_one===currentUser.id?c.user_two:c.user_one;await openPrivateConversation(c.id,other);}
  }else if(n.reference_type==='forum_thread'){
    go('community');switchCommunityTab('forums');openForumThread(n.reference_id);
  }else if(n.reference_type==='card'){
    const card=items.find(x=>x.cardId===n.reference_id);if(card){go('library');openLibraryCardDetails(card);}
  }
}
async function markAllNotificationsRead(){
  const {error}=await sb.from('notifications').update({read_at:new Date().toISOString()}).eq('user_id',currentUser.id).is('read_at',null);
  if(error)return toast('Could not update notifications');loadNotifications();
}
function startNotificationRealtime(){
  if(notificationChannel||!currentUser)return;
  notificationChannel=sb.channel('deckvault-notifications-'+currentUser.id)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:'user_id=eq.'+currentUser.id},()=>loadNotifications())
    .subscribe();
}
async function searchSocialUniversal(q){
  const nodes=[];
  try{
    const safe=q.replace(/[%_]/g,'');
    const [{data:profiles},{data:market}]=await Promise.all([
      sb.from('profiles').select('id,username,display_name').ilike('username','%'+safe+'%').limit(6),
      sb.rpc('list_marketplace_cards',{p_game:'pokemon',p_search:q,p_limit:6})
    ]);
    const visibleProfiles=(profiles||[]).filter(p=>p.id!==currentUser.id&&!blockedUserIds.has(p.id));
    if(visibleProfiles.length){const h=document.createElement('h3');h.textContent='Collectors';nodes.push(h);}
    visibleProfiles.forEach(p=>{const b=document.createElement('button');b.className='globalsearchrow';b.innerHTML='<strong>@'+esc(p.username||'collector')+'</strong><span>'+esc(p.display_name||'')+'</span>';b.onclick=()=>{$('#universalSearchDialog').close();go('community');switchCommunityTab('profiles');viewProfile(p.id);};nodes.push(b);});
    if(market?.length){const h=document.createElement('h3');h.textContent='Marketplace';nodes.push(h);}
    (market||[]).forEach(c=>{const b=document.createElement('button');b.className='globalsearchrow';b.innerHTML='<strong>'+esc(c.card_name)+'</strong><span>'+esc(c.set_name||'')+' • '+Number(c.seller_count||0)+' collector(s)</span>';b.onclick=()=>{$('#universalSearchDialog').close();go('marketplace');findTradeOffers({id:c.card_id,name:c.card_name,setName:c.set_name,localId:c.local_id,image:c.image_url,sellerCount:Number(c.seller_count||0)});};nodes.push(b);});
  }catch(e){console.error(e);}
  return nodes;
}
window.searchSocialUniversal=searchSocialUniversal;


async function favoriteState(type,referenceId){
  if(!currentUser)return null;
  const {data,error}=await sb.from('user_favorites').select('*')
    .eq('user_id',currentUser.id).eq('favorite_type',type).eq('reference_id',String(referenceId)).maybeSingle();
  if(error){console.error(error);return null;}
  return data||null;
}
async function saveFavorite(type,referenceId,label,imageUrl='',metadata={}){
  const existing=await favoriteState(type,referenceId);
  if(existing){
    const {error}=await sb.from('user_favorites').delete().eq('user_id',currentUser.id).eq('favorite_type',type).eq('reference_id',String(referenceId));
    if(error)return toast('Could not remove favorite');
    toast('Removed from favorites');return false;
  }
  const {error}=await sb.from('user_favorites').insert({
    user_id:currentUser.id,favorite_type:type,reference_id:String(referenceId),label,image_url:imageUrl||null,metadata
  });
  if(error)return toast('Could not save favorite');
  haptic?.(16);toast('Saved to favorites');return true;
}
async function loadSavedItems(){
  if(!currentUser||!$('#savedWatchlist'))return;
  const [{data:watch,error:wErr},{data:favs,error:fErr}]=await Promise.all([
    sb.from('card_watchlist').select('*').eq('user_id',currentUser.id).order('created_at',{ascending:false}),
    sb.from('user_favorites').select('*').eq('user_id',currentUser.id).order('created_at',{ascending:false})
  ]);
  const wb=$('#savedWatchlist'),fb=$('#savedFavorites');wb.innerHTML='';fb.innerHTML='';
  if(wErr){wb.innerHTML='<div class="empty">Could not load watchlist.</div>';}
  else if(!watch?.length)wb.innerHTML='<div class="empty compact">No watched cards yet.</div>';
  else (watch||[]).forEach(w=>{
    const e=document.createElement('div');e.className='saveditem';
    e.innerHTML=(w.image_url?'<img src="'+esc(imageUrl(w.image_url))+'" alt="">':'<div class="savedicon">★</div>')+
      '<div><strong>'+esc(w.card_name)+'</strong><span>'+esc(w.set_name||'')+' • '+esc(w.variant||'Normal')+'</span><small>'+(w.target_price!=null?'Target '+money(w.target_price,w.currency||'USD')+' • ':'')+'Alert at '+Number(w.notify_change_pct||10)+'% change</small></div>'+
      '<div><button class="secondary" data-open type="button">Open</button><button class="ghost" data-remove type="button">Remove</button></div>';
    e.querySelector('[data-open]').onclick=()=>{const card=items.find(x=>x.cardId===w.card_id&&x.variant===w.variant);if(card){go('library');openLibraryCardDetails(card);}else toast('Card is not currently in your library');};
    e.querySelector('[data-remove]').onclick=async()=>{await sb.from('card_watchlist').delete().eq('user_id',currentUser.id).eq('game',w.game).eq('card_id',w.card_id).eq('variant',w.variant);loadSavedItems();renderDashboard();};
    wb.appendChild(e);
  });
  if(fErr){fb.innerHTML='<div class="empty">Could not load favorites.</div>';}
  else if(!favs?.length)fb.innerHTML='<div class="empty compact">No favorite sets or listings yet.</div>';
  else (favs||[]).forEach(f=>{
    const e=document.createElement('div');e.className='saveditem';
    e.innerHTML=(f.image_url?'<img src="'+esc(imageUrl(f.image_url))+'" alt="">':'<div class="savedicon">'+(f.favorite_type==='set'?'▦':'⇄')+'</div>')+
      '<div><strong>'+esc(f.label)+'</strong><span>'+esc(f.favorite_type==='set'?'Pokémon set':'Marketplace listing')+'</span></div>'+
      '<div><button class="secondary" data-open type="button">Open</button><button class="ghost" data-remove type="button">Remove</button></div>';
    e.querySelector('[data-remove]').onclick=async()=>{await sb.from('user_favorites').delete().eq('user_id',currentUser.id).eq('favorite_type',f.favorite_type).eq('reference_id',f.reference_id);loadSavedItems();};
    e.querySelector('[data-open]').onclick=async()=>{
      if(f.favorite_type==='marketplace_listing'&&f.metadata?.card_id){
        go('marketplace');findTradeOffers({id:f.metadata.card_id,name:f.metadata.card_name||f.label,setName:f.metadata.set_name||'',localId:f.metadata.local_id||'',image:f.image_url||'',sellerCount:0});
      }else if(f.favorite_type==='set'){
        go('community');switchCommunityTab('profiles');await viewProfile(currentUser.id);
        const sets=await allMasterSets(),set=sets.find(x=>x.id===f.reference_id);
        if(set){const owned=await masterOwnedMap(currentUser.id);openMasterSet(currentUser.id,set,owned);}
      }
    };
    fb.appendChild(e);
  });
}
async function sendAdminNotice(){
  if(!isAdmin)return;
  const target=$('#adminNoticeTarget').value.trim(),title=$('#adminNoticeTitle').value.trim(),body=$('#adminNoticeBody').value.trim();
  if(!title||!body)return toast('Add a title and message');
  let q=sb.from('profiles').select('id,username');
  if(target)q=q.eq('username',target);
  const {data:profiles,error}=await q;
  if(error)return toast('Could not find recipients');
  if(!profiles?.length)return toast('No matching recipient');
  const rows=profiles.map(p=>({user_id:p.id,type:'admin_notice',title,body,actor_user_id:currentUser.id,reference_type:'admin_notice'}));
  const {error:insertErr}=await sb.from('notifications').insert(rows);
  if(insertErr)return toast('Could not send notification');
  $('#adminNoticeTitle').value='';$('#adminNoticeBody').value='';toast('Notification sent to '+profiles.length+' account'+(profiles.length===1?'':'s'));
}

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
  await refreshBlockedUsers();
  await loadProfileSettings();
  await loadMyLists();
  await loadTradeList();
  startPrivateMessageRealtime();startNotificationRealtime();
  loadPrivateInbox().catch(console.error);loadNotifications().catch(console.error);
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
    $('#masterSetsVisibility').value=p.master_sets_visibility||'public';
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
    master_sets_visibility:$('#masterSetsVisibility').value,
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
  const visible=(data||[]).filter(p=>p.id===currentUser.id||!blockedUserIds.has(p.id));
  if(!visible.length){box.innerHTML='<div class="empty">No profiles found.</div>';return;}
  visible.forEach(p=>{
    const e=document.createElement('button');e.className='profilecard';
    e.innerHTML=(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'<div><strong>@'+esc(p.username)+'</strong><span>'+esc(p.display_name||'')+'</span><small>'+esc((p.bio||'').slice(0,90))+'</small></div>';
    e.onclick=()=>viewProfile(p.id);box.appendChild(e);
  });
}

async function viewProfile(userId){
  const [{data:p,error},{data:details},{data:lists}]=await Promise.all([
    sb.from('profiles').select('id,username,display_name,bio,avatar_url,marketplace_mode,marketplace_note,master_sets_visibility').eq('id',userId).single(),
    sb.from('profile_details').select('field_key,field_value,visibility').eq('user_id',userId),
    sb.from('collection_lists').select('id,name,description,visibility').eq('user_id',userId).order('created_at',{ascending:false})
  ]);
  if(error)return toast('Profile unavailable');
  const box=$('#publicProfileView');box.classList.remove('hidden');
  const d=(details||[]).filter(x=>userId===currentUser.id||x.visibility==='public');
  const marketBadge=p.marketplace_mode&&p.marketplace_mode!=='off'?'<span class="marketbadge '+esc(p.marketplace_mode)+'">'+esc(marketplaceLabel(p.marketplace_mode))+'</span>':'';
  box.innerHTML='<div class="profilehero">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'">':'<div class="avatarfallback large">DV</div>')+'<div><div class="eyebrow">COLLECTOR PROFILE</div><h2>@'+esc(p.username||'collector')+'</h2>'+marketBadge+'<strong>'+esc(p.display_name||'')+'</strong><p>'+esc(p.bio||'')+'</p>'+(p.marketplace_mode!=='off'&&p.marketplace_note?'<p class="marketnote">'+esc(p.marketplace_note)+'</p>':'')+(userId!==currentUser.id?'<div class="profilesafetyactions"><button class="primary profilemessagebtn" type="button" data-message-user="'+esc(userId)+'">Message collector</button><button class="secondary" type="button" data-block-user>'+ (blockedUserIds.has(userId)?'Unblock':'Block') +'</button><button class="ghost" type="button" data-report-user>Report</button></div>':'')+'</div></div>'+
    '<div class="publicdetails">'+d.map(x=>'<div><span>'+esc(PROFILE_FIELDS.find(f=>f[0]===x.field_key)?.[1]||x.field_key)+'</span><strong>'+esc(x.field_value)+'</strong></div>').join('')+'</div>'+
    '<div class="profilemaster"><div class="pagehead"><div><div class="eyebrow">POKÉMON CHECKLIST</div><h3>Master Sets</h3></div></div><div id="profileMasterSets"></div></div>'+
    '<h3>Public lists</h3><div id="profileLists" class="liststack"></div><div id="profileListContents"></div>';
  const messageBtn=box.querySelector('[data-message-user]');if(messageBtn)messageBtn.onclick=()=>startPrivateConversation(userId);
  const blockBtn=box.querySelector('[data-block-user]');if(blockBtn)blockBtn.onclick=()=>blockedUserIds.has(userId)?unblockUser(userId):blockUser(userId);
  const reportBtn=box.querySelector('[data-report-user]');if(reportBtn)reportBtn.onclick=()=>openReport({type:'profile',userId,label:'Report @'+(p.username||'collector'),category:'other'});
  const lb=$('#profileLists');
  const visible=(lists||[]).filter(l=>userId===currentUser.id||l.visibility==='public');
  if(!visible.length)lb.innerHTML='<div class="empty">This collector has no public lists.</div>';
  else visible.forEach(l=>{const b=document.createElement('button');b.className='listcard';b.innerHTML='<strong>'+esc(l.name)+'</strong><span>'+esc(l.description||'')+'</span>';b.onclick=()=>viewPublicList(l);lb.appendChild(b);});
  renderMasterSetHub(userId).catch(e=>{console.error(e);if($('#profileMasterSets'))$('#profileMasterSets').innerHTML='<div class="empty">Could not load Master Sets.</div>';});
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
  const customLists=(data||[]).filter(l=>!l.system_key);
  if(!customLists.length){box.innerHTML='<div class="empty">No custom lists yet.</div>';return;}
  customLists.forEach(l=>{
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
  if($('#marketplace')?.classList.contains('active'))await loadMarketplaceFeed();
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
  if($('#marketplace')?.classList.contains('active'))await loadMarketplaceFeed();
  toast('Trade / Sell listing saved');
}

async function removeTradeCard(itemId){
  if(!tradeListId)return;
  const {error}=await sb.from('collection_list_items').delete().eq('list_id',tradeListId).eq('collection_item_id',itemId);
  if(error)return toast('Could not remove listing');
  await loadTradeList();
  if($('#marketplace')?.classList.contains('active'))await loadMarketplaceFeed();
  toast('Listing removed');
}


function marketplaceCardTags(row){
  const tags=[];
  if(row.has_trade&&row.has_sell)tags.push('<span class="marketbadge both">Trade + Sell</span>');
  else if(row.has_trade)tags.push('<span class="marketbadge trade">Trade</span>');
  else if(row.has_sell)tags.push('<span class="marketbadge sell">For Sale</span>');
  return tags.join('');
}

async function loadMarketplaceFeed(){
  if(!currentUser||!$('#marketFeed'))return;
  const q=$('#marketFeedSearch')?.value.trim()||'';
  const filter=$('#marketFeedFilter')?.value||'all';
  const status=$('#marketFeedStatus');
  const box=$('#marketFeed');
  status.textContent='Loading active marketplace cards…';
  box.innerHTML='';
  const {data,error}=await sb.rpc('list_marketplace_cards',{
    p_game:'pokemon',
    p_search:q||null,
    p_limit:180
  });
  if(error){
    console.error(error);
    status.textContent='Could not load marketplace cards.';
    box.innerHTML='<div class="empty">Marketplace feed unavailable.</div>';
    return;
  }
  marketplaceFeedRows=(data||[]).filter(row=>{
    if(filter==='trade')return row.has_trade;
    if(filter==='sell')return row.has_sell;
    if(filter==='both')return row.has_trade&&row.has_sell;
    return true;
  });
  $('#marketFeedCount').textContent=marketplaceFeedRows.length+' card'+(marketplaceFeedRows.length===1?'':'s');
  status.textContent=marketplaceFeedRows.length?'Tap a card to see every collector offering that exact printing.':'No active listings match this search.';
  if(!marketplaceFeedRows.length){
    box.innerHTML='<div class="empty">No cards currently match this marketplace view.</div>';
    return;
  }
  marketplaceFeedRows.forEach(row=>{
    const e=document.createElement('button');
    e.className='marketcard';
    const price=row.lowest_asking_price!=null
      ?'<div class="marketcardprice">From '+money(row.lowest_asking_price,row.price_currency||'USD')+'</div>'
      :(row.has_trade?'<div class="marketcardprice tradeonly">Trade offers</div>':'');
    const sellerLabel=Number(row.seller_count||0)+' collector'+(Number(row.seller_count||0)===1?'':'s');
    const qtyLabel=Number(row.total_offer_quantity||0)+' available';
    e.innerHTML='<div class="marketcardimg"><img loading="lazy" src="'+esc(imageUrl(row.image_url))+'" alt="'+esc(row.card_name)+'"></div><div class="marketcardbody"><strong>'+esc(row.card_name)+'</strong><span>'+esc(row.set_name)+' • #'+esc(row.local_id)+'</span><div class="marketcardtags">'+marketplaceCardTags(row)+'</div><div class="marketcardmeta"><span>'+esc(sellerLabel)+'</span><span>'+esc(qtyLabel)+'</span></div>'+price+'</div>';
    e.onclick=()=>findTradeOffers({
      id:row.card_id,
      name:row.card_name,
      localId:row.local_id,
      setName:row.set_name,
      image:row.image_url,
      sellerCount:Number(row.seller_count||0)
    });
    box.appendChild(e);
  });
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
  const count=card.sellerCount?'<div class="muted">'+card.sellerCount+' collector'+(card.sellerCount===1?'':'s')+' currently offering this printing</div>':'';
  $('#marketOfferHeading').innerHTML='<div class="selectedmarketcard">'+(card.image?'<img src="'+esc(imageUrl(card.image))+'" alt="">':'')+'<div><div class="eyebrow">AVAILABLE FROM COLLECTORS</div><h2>'+esc(card.name)+'</h2><div class="muted">'+esc(card.setName||'')+(card.localId?' • #'+esc(card.localId):'')+'</div>'+count+'</div></div>';
  $('#marketOffers').innerHTML='<div class="skeletonline"></div><div class="skeletonline short"></div>';
  const {data,error}=await sb.rpc('search_trade_offers',{p_game:'pokemon',p_card_id:card.id});
  const box=$('#marketOffers');box.innerHTML='';
  if(error){console.error(error);box.innerHTML='<div class="empty">Could not search marketplace.</div>';return;}
  if(!data?.length){box.innerHTML='<div class="empty">No approved collectors currently have this card in an active Trade / Sell list.</div>';return;}
  data.forEach(o=>{
    const e=document.createElement('article');e.className='offercard';
    const who=o.user_id===currentUser.id?'You':'@'+(o.username||'collector');
    let dealText='';
    if(o.marketplace_mode==='trade')dealText='<div class="offerprice tradeonly">Trade only</div>';
    else if(o.asking_price!=null)dealText='<div class="offerprice">'+money(o.asking_price,o.price_currency||'USD')+'</div>';
    else if(o.marketplace_mode==='sell')dealText='<div class="offerprice unsetprice">Price not set</div>';
    else dealText='<div class="offerprice tradeonly">Trade + Sell</div>';
    const actions=o.user_id===currentUser.id
      ?'<button type="button" class="secondary" data-view>View my profile</button>'
      :'<button type="button" class="primary" data-message>Message '+esc(o.username||'collector')+'</button><button type="button" class="secondary" data-favorite>☆ Save listing</button><button type="button" class="secondary" data-view>View profile</button><button type="button" class="ghost" data-report>Report listing</button>';
    e.innerHTML='<div class="offeruser">'+(o.avatar_url?'<img src="'+esc(o.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'<div><strong>'+esc(who)+'</strong><span class="marketbadge '+esc(o.marketplace_mode)+'">'+esc(marketplaceLabel(o.marketplace_mode))+'</span></div>'+dealText+'</div><div class="offerbody"><strong>'+esc(o.card_name)+'</strong><span>'+esc(o.set_name)+' • #'+esc(o.local_id)+'</span><span>'+esc(o.variant)+' • '+esc(o.condition)+' • '+esc(o.language)+'</span><span>Available quantity: '+Number(o.offer_quantity||1)+'</span>'+(o.offer_note?'<p>'+esc(o.offer_note)+'</p>':'')+(o.marketplace_note?'<p class="marketnote">'+esc(o.marketplace_note)+'</p>':'')+'<div class="offeractions">'+actions+'</div></div>';
    e.querySelector('[data-view]').onclick=()=>{go('community');switchCommunityTab('profiles');viewProfile(o.user_id);};
    const msg=e.querySelector('[data-message]');if(msg)msg.onclick=()=>{go('community');startPrivateConversation(o.user_id,{type:'marketplace_listing',id:o.collection_item_id,label:o.card_name+' — '+o.set_name+' #'+o.local_id});};
    const fav=e.querySelector('[data-favorite]');if(fav)fav.onclick=async()=>{const on=await saveFavorite('marketplace_listing',o.collection_item_id,o.card_name+' — @'+(o.username||'collector'),o.image_url||'',{card_id:card.id,card_name:o.card_name,set_name:o.set_name,local_id:o.local_id,seller_id:o.user_id});fav.textContent=on?'★ Saved':'☆ Save listing';};
    const rep=e.querySelector('[data-report]');if(rep)rep.onclick=()=>openReport({type:'marketplace_listing',id:o.collection_item_id,userId:o.user_id,label:'Report '+o.card_name+' listing by @'+(o.username||'collector'),category:'fraud'});
    box.appendChild(e);
  });
  $('#marketOfferHeading').scrollIntoView({behavior:'smooth',block:'start'});
}

async function profileMapFor(userIds){
  const ids=[...new Set((userIds||[]).filter(Boolean))];
  if(!ids.length)return {};
  const {data}=await sb.from('profiles').select('id,username,display_name,avatar_url').in('id',ids);
  return Object.fromEntries((data||[]).map(p=>[p.id,p]));
}
function switchCommunityTab(tab){
  document.querySelectorAll('[data-community-tab]').forEach(b=>b.classList.toggle('active',b.dataset.communityTab===tab));
  $('#communityChatPane').classList.toggle('active',tab==='chat');
  $('#communityMessagesPane').classList.toggle('active',tab==='messages');
  $('#communityForumsPane').classList.toggle('active',tab==='forums');
  $('#communityProfilesPane').classList.toggle('active',tab==='profiles');
  if(tab==='chat')loadCommunityChat();
  if(tab==='messages'){loadPrivateInbox();startPrivateMessageRealtime();}
  if(tab==='forums')loadForumThreads();
  if(tab==='profiles')searchCommunity();
}
async function loadCommunityChat(){
  if(!currentUser||!$('#communityChatMessages'))return;
  const {data,error}=await sb.from('community_messages').select('id,user_id,body,created_at').order('created_at',{ascending:false}).limit(100);
  const box=$('#communityChatMessages');box.innerHTML='';
  if(error){console.error(error);box.innerHTML='<div class="empty">Could not load community chat.</div>';return;}
  const rows=[...(data||[])].reverse();
  const profiles=await profileMapFor(rows.map(x=>x.user_id));
  if(!rows.length){box.innerHTML='<div class="empty">No messages yet. Start the conversation.</div>';return;}
  rows.forEach(m=>{
    const p=profiles[m.user_id]||{};
    const mine=m.user_id===currentUser.id;
    const e=document.createElement('div');e.className='chatmessage'+(mine?' mine':'');
    e.innerHTML='<div class="chatavatar">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'</div><div class="chatbubble"><div class="chatmeta"><strong>'+(mine?'You':'@'+esc(p.username||'collector'))+'</strong><span>'+new Date(m.created_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'</span></div><p>'+esc(m.body)+'</p>'+(mine||isAdmin?'<button class="chatdelete" type="button" title="Delete message">×</button>':'')+(!mine?'<button class="messagereport" type="button">Report</button>':'')+'</div>';
    const del=e.querySelector('.chatdelete');
    if(del)del.onclick=async()=>{const {error}=await sb.from('community_messages').delete().eq('id',m.id);if(error)return toast('Could not delete message');loadCommunityChat();};
    const report=e.querySelector('.messagereport');if(report)report.onclick=()=>openReport({type:'community_message',id:m.id,userId:m.user_id,label:'Report community message from @'+(p.username||'collector'),category:'harassment'});
    box.appendChild(e);
  });
  box.scrollTop=box.scrollHeight;
}
async function sendCommunityMessage(e){
  e.preventDefault();
  const input=$('#communityChatInput'),body=input.value.trim();
  if(!body)return;
  const {error}=await sb.from('community_messages').insert({user_id:currentUser.id,body});
  if(error)return toast('Could not send message');
  input.value='';
  await loadCommunityChat();
}
function startCommunityRealtime(){
  if(communityChannel)return;
  communityChannel=sb.channel('deckvault-community-chat')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'community_messages'},()=>loadCommunityChat())
    .on('postgres_changes',{event:'DELETE',schema:'public',table:'community_messages'},()=>loadCommunityChat())
    .subscribe();
}

function updatePrivateMessageBadge(count){
  const badge=$('#privateMessageBadge');if(!badge)return;
  const n=Math.max(0,Number(count||0));
  badge.textContent=n>99?'99+':String(n);
  badge.classList.toggle('hidden',n===0);
}

async function loadPrivateInbox(){
  if(!currentUser||!$('#privateConversationList'))return;
  const box=$('#privateConversationList');
  const {data:conversations,error}=await sb.from('private_conversations')
    .select('id,user_one,user_two,created_at')
    .or('user_one.eq.'+currentUser.id+',user_two.eq.'+currentUser.id)
    .order('created_at',{ascending:false});
  if(error){console.error(error);box.innerHTML='<div class="empty">Could not load private messages.</div>';return;}

  const rows=conversations||[];
  if(!rows.length){
    box.innerHTML='<div class="empty">No private conversations yet.</div>';
    updatePrivateMessageBadge(0);
    return;
  }

  const conversationIds=rows.map(x=>x.id);
  const otherIds=[...new Set(rows.map(x=>x.user_one===currentUser.id?x.user_two:x.user_one))];
  const [{data:messages,error:messageError},{data:reads},profiles]=await Promise.all([
    sb.from('private_messages').select('id,conversation_id,sender_id,body,created_at,reference_type,reference_id,reference_label')
      .in('conversation_id',conversationIds).order('created_at',{ascending:false}).limit(300),
    sb.from('private_conversation_reads').select('conversation_id,last_read_at')
      .eq('user_id',currentUser.id).in('conversation_id',conversationIds),
    profileMapFor(otherIds)
  ]);
  if(messageError)console.error(messageError);

  const latest={};
  const unread={};
  const readMap=Object.fromEntries((reads||[]).map(r=>[r.conversation_id,new Date(r.last_read_at).getTime()]));
  (messages||[]).forEach(m=>{
    if(!latest[m.conversation_id])latest[m.conversation_id]=m;
    if(m.sender_id!==currentUser.id&&new Date(m.created_at).getTime()>(readMap[m.conversation_id]||0)){
      unread[m.conversation_id]=(unread[m.conversation_id]||0)+1;
    }
  });

  rows.sort((a,b)=>{
    const ad=new Date(latest[a.id]?.created_at||a.created_at).getTime();
    const bd=new Date(latest[b.id]?.created_at||b.created_at).getTime();
    return bd-ad;
  });

  box.innerHTML='';
  let totalUnread=0;
  rows.forEach(c=>{
    const otherId=c.user_one===currentUser.id?c.user_two:c.user_one;
    const p=profiles[otherId]||{};
    const last=latest[c.id];
    const unreadCount=unread[c.id]||0;totalUnread+=unreadCount;
    const b=document.createElement('button');
    b.type='button';
    b.className='conversationrow'+(c.id===activePrivateConversationId?' active':'');
    b.innerHTML=(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+
      '<div class="conversationrowmain"><div><strong>@'+esc(p.username||'collector')+'</strong>'+
      (unreadCount?'<span class="unreadcount">'+unreadCount+'</span>':'')+'</div>'+
      '<p>'+esc(last?.body||'Start the conversation')+'</p>'+
      '<small>'+(last?new Date(last.created_at).toLocaleString():new Date(c.created_at).toLocaleDateString())+'</small></div>';
    b.onclick=()=>openPrivateConversation(c.id,otherId);
    box.appendChild(b);
  });
  updatePrivateMessageBadge(totalUnread);
}

async function markPrivateConversationRead(conversationId){
  if(!currentUser||!conversationId)return;
  const {error}=await sb.from('private_conversation_reads').upsert({
    conversation_id:conversationId,user_id:currentUser.id,last_read_at:new Date().toISOString()
  },{onConflict:'conversation_id,user_id'});
  if(error)console.error(error);
}

async function openPrivateConversation(conversationId,otherUserId){
  if(!currentUser)return;
  activePrivateConversationId=conversationId;activePrivateOtherUserId=otherUserId;
  const [{data:messages,error},profiles]=await Promise.all([
    sb.from('private_messages').select('id,conversation_id,sender_id,body,created_at,reference_type,reference_id,reference_label')
      .eq('conversation_id',conversationId).order('created_at',{ascending:true}).limit(250),
    profileMapFor([otherUserId])
  ]);
  if(error){console.error(error);return toast('Could not open private conversation');}
  const p=profiles[otherUserId]||{};
  $('#privateConversationEmpty').classList.add('hidden');$('#privateConversationView').classList.remove('hidden');
  $('#privateConversationHeader').innerHTML=(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+
    '<div><div class="eyebrow">PRIVATE MESSAGE</div><strong>@'+esc(p.username||'collector')+'</strong><span>'+esc(p.display_name||'')+'</span></div>'+
    '<div class="conversationactions"><button class="ghost" data-report-user type="button">Report</button><button class="ghost" data-block-user type="button">'+(blockedUserIds.has(otherUserId)?'Unblock':'Block')+'</button></div>';
  $('#privateConversationHeader [data-report-user]').onclick=()=>openReport({type:'user',userId:otherUserId,label:'Report @'+(p.username||'collector'),category:'harassment'});
  $('#privateConversationHeader [data-block-user]').onclick=()=>blockedUserIds.has(otherUserId)?unblockUser(otherUserId):blockUser(otherUserId);
  const box=$('#privateMessageThread');box.innerHTML='';
  if(!messages?.length)box.innerHTML='<div class="empty">No messages yet. Say hello.</div>';
  else messages.forEach(m=>{
    const mine=m.sender_id===currentUser.id,e=document.createElement('div');e.className='privatemessage'+(mine?' mine':'');
    const ref=m.reference_label?'<div class="messageref">Regarding: '+esc(m.reference_label)+'</div>':'';
    e.innerHTML='<div class="privatebubble">'+ref+'<p>'+esc(m.body)+'</p><small>'+new Date(m.created_at).toLocaleString()+'</small>'+
      (!mine?'<button class="messagereport" type="button">Report</button>':'')+'</div>';
    const report=e.querySelector('.messagereport');
    if(report)report.onclick=()=>openReport({type:'private_message',id:m.id,userId:m.sender_id,label:'Report private message from @'+(p.username||'collector'),category:'harassment'});
    box.appendChild(e);
  });
  if(pendingPrivateReference){
    $('#privateMessageInput').placeholder='Message @'+(p.username||'collector')+' about '+pendingPrivateReference.label+'…';
  }else $('#privateMessageInput').placeholder='Write a private message…';
  box.scrollTop=box.scrollHeight;await markPrivateConversationRead(conversationId);await loadPrivateInbox();
}
async function sendPrivateMessage(e){
  e.preventDefault();
  if(!activePrivateConversationId)return toast('Choose a conversation first');
  const input=$('#privateMessageInput'),body=input.value.trim();if(!body)return;
  const ref=pendingPrivateReference;
  const {error}=await sb.from('private_messages').insert({
    conversation_id:activePrivateConversationId,sender_id:currentUser.id,body,
    reference_type:ref?.type||null,reference_id:ref?.id?String(ref.id):null,reference_label:ref?.label||null
  });
  if(error){console.error(error);return toast(error.code==='42501'?'Messaging is unavailable between these accounts':'Could not send private message');}
  pendingPrivateReference=null;input.value='';haptic?.(18);await openPrivateConversation(activePrivateConversationId,activePrivateOtherUserId);
}
async function findPrivateMessageRecipients(){
  if(!currentUser)return;
  const q=$('#privateMessageSearch').value.trim();
  const box=$('#privateMessageSearchResults');box.innerHTML='';
  if(q.length<2){box.innerHTML='<div class="empty compact">Type at least 2 characters.</div>';return;}
  const safe=q.replace(/[%_]/g,'');
  const {data,error}=await sb.from('profiles')
    .select('id,username,display_name,avatar_url')
    .neq('id',currentUser.id)
    .ilike('username','%'+safe+'%')
    .limit(8);
  if(error){console.error(error);box.innerHTML='<div class="empty compact">Could not search collectors.</div>';return;}
  const visible=(data||[]).filter(p=>!blockedUserIds.has(p.id));
  if(!visible.length){box.innerHTML='<div class="empty compact">No collectors found.</div>';return;}
  visible.forEach(p=>{
    const b=document.createElement('button');b.type='button';b.className='recipientrow';
    b.innerHTML=(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+
      '<div><strong>@'+esc(p.username||'collector')+'</strong><span>'+esc(p.display_name||'')+'</span></div><b>Message</b>';
    b.onclick=()=>startPrivateConversation(p.id);
    box.appendChild(b);
  });
}

async function getOrCreatePrivateConversation(otherUserId){
  if(!currentUser||!otherUserId||otherUserId===currentUser.id)return null;
  const pair=[currentUser.id,otherUserId].sort();
  let existing=await sb.from('private_conversations').select('id,user_one,user_two')
    .eq('user_one',pair[0]).eq('user_two',pair[1]).maybeSingle();
  if(existing.error)throw existing.error;
  if(existing.data)return existing.data;
  const created=await sb.from('private_conversations').insert({user_one:pair[0],user_two:pair[1]}).select().single();
  if(!created.error)return created.data;
  if(created.error.code==='23505'){
    existing=await sb.from('private_conversations').select('id,user_one,user_two')
      .eq('user_one',pair[0]).eq('user_two',pair[1]).maybeSingle();
    if(existing.data)return existing.data;
  }
  throw created.error;
}

async function startPrivateConversation(otherUserId,reference=null){
  try{
    if(blockedUserIds.has(otherUserId))return toast('Unblock this collector before messaging them');
    const c=await getOrCreatePrivateConversation(otherUserId);if(!c)return;
    pendingPrivateReference=reference||null;
    switchCommunityTab('messages');$('#privateMessageSearchResults').innerHTML='';$('#privateMessageSearch').value='';
    await openPrivateConversation(c.id,otherUserId);
  }catch(e){console.error(e);toast(e?.code==='42501'?'Messaging is unavailable between these accounts':'Could not start private conversation');}
}
function startPrivateMessageRealtime(){
  if(privateMessageChannel||!currentUser)return;
  privateMessageChannel=sb.channel('deckvault-private-messages-'+currentUser.id)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'private_messages'},payload=>{
      const row=payload.new||{};
      if(row.conversation_id===activePrivateConversationId&&activePrivateOtherUserId){
        openPrivateConversation(activePrivateConversationId,activePrivateOtherUserId).catch(console.error);
      }else{
        loadPrivateInbox().catch(console.error);
      }
    })
    .subscribe();
}

const SETTINGS_HINTS={
  account:'Account access, legal information, and sign out.',
  profile:'Your public collector profile and field-level privacy.',
  marketplace:'Trade / Sell availability and the permanent marketplace list.',
  lists:'Create and manage your custom public or private lists.',
  valuation:'Choose which supported market value DeckVault displays by default.',
  favorites:'Watched cards, favorite Pokémon sets, and saved marketplace listings.',
  backup:'Export, transfer, or restore your collection data.',
  diagnostics:'Review DeckVault runtime errors and export troubleshooting data.',
  data:'Collection deletion and app information.',
  admin:'Account approvals, moderation, MFA, and administrator audit history.'
};

function switchSettingsSection(section){
  const select=$('#settingsSectionSelect');if(!select)return;
  const allowed=[...select.options].map(o=>o.value);
  if(!allowed.includes(section))section='account';
  select.value=section;
  document.querySelectorAll('[data-settings-pane]').forEach(p=>p.classList.toggle('active',p.dataset.settingsPane===section));
  $('#settingsSectionHint').textContent=SETTINGS_HINTS[section]||'';
  if(section==='favorites')loadSavedItems();
  if(section==='admin'&&isAdmin)Promise.all([checkAdminMfa(),loadApplications(),loadUserManagement(),loadAdminAudit(),loadReports()]);
}

function syncAdminSettingsOption(){
  const select=$('#settingsSectionSelect');if(!select)return;
  let option=select.querySelector('option[value="admin"]');
  if(isAdmin&&!option){
    option=document.createElement('option');option.value='admin';option.textContent='Administrator';
    select.appendChild(option);
  }else if(!isAdmin&&option){
    const wasSelected=select.value==='admin';option.remove();
    if(wasSelected)switchSettingsSection('account');
  }
  $('#adminPanel').classList.toggle('admin-available',isAdmin);
}
async function loadForumThreads(){
  if(!currentUser||!$('#forumThreads'))return;
  const [{data:threads,error},{data:posts}]=await Promise.all([
    sb.from('forum_threads').select('id,user_id,title,body,created_at,updated_at,locked').order('updated_at',{ascending:false}).limit(100),
    sb.from('forum_posts').select('thread_id')
  ]);
  const box=$('#forumThreads');box.innerHTML='';
  if(error){box.innerHTML='<div class="empty">Could not load forums.</div>';return;}
  if(!threads?.length){box.innerHTML='<div class="empty">No forum threads yet.</div>';return;}
  const profiles=await profileMapFor(threads.map(t=>t.user_id));
  const counts={};(posts||[]).forEach(p=>counts[p.thread_id]=(counts[p.thread_id]||0)+1);
  threads.forEach(t=>{
    const p=profiles[t.user_id]||{};
    const e=document.createElement('button');e.className='forumthreadcard';
    e.innerHTML='<div><strong>'+esc(t.title)+'</strong><span>by @'+esc(p.username||'collector')+' • '+new Date(t.created_at).toLocaleDateString()+'</span><p>'+esc(t.body.slice(0,180))+(t.body.length>180?'…':'')+'</p></div><div class="forumcount"><b>'+Number(counts[t.id]||0)+'</b><small>replies</small></div>';
    e.onclick=()=>openForumThread(t.id);
    box.appendChild(e);
  });
}
async function createForumThread(){
  const title=$('#newForumTitle').value.trim(),body=$('#newForumBody').value.trim(),msg=$('#newForumMessage');
  msg.textContent='';msg.classList.remove('error');
  if(title.length<3||!body){msg.textContent='Add a title and post.';msg.classList.add('error');return;}
  const {data,error}=await sb.from('forum_threads').insert({user_id:currentUser.id,title,body}).select().single();
  if(error){msg.textContent=error.message;msg.classList.add('error');return;}
  $('#newForumThreadDialog').close();$('#newForumTitle').value='';$('#newForumBody').value='';
  await loadForumThreads();openForumThread(data.id);
}
async function openForumThread(threadId){
  activeForumThreadId=threadId;
  const [{data:thread,error},{data:posts}]=await Promise.all([
    sb.from('forum_threads').select('*').eq('id',threadId).single(),
    sb.from('forum_posts').select('*').eq('thread_id',threadId).order('created_at',{ascending:true})
  ]);
  if(error)return toast('Could not open thread');
  const profiles=await profileMapFor([thread.user_id,...(posts||[]).map(p=>p.user_id)]);
  const author=profiles[thread.user_id]||{};
  $('#forumListView').classList.add('hidden');$('#forumThreadView').classList.remove('hidden');
  $('#forumThreadHeader').innerHTML='<div class="eyebrow">THREAD</div><h2>'+esc(thread.title)+'</h2><div class="forumauthor">@'+esc(author.username||'collector')+' • '+new Date(thread.created_at).toLocaleString()+(thread.locked?' • Locked':'')+'</div><p>'+esc(thread.body)+'</p>';
  const box=$('#forumPosts');box.innerHTML='';
  (posts||[]).forEach(post=>{
    const p=profiles[post.user_id]||{},mine=post.user_id===currentUser.id;
    const e=document.createElement('article');e.className='forumpost';
    e.innerHTML='<div class="forumpostuser">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'<div><strong>'+(mine?'You':'@'+esc(p.username||'collector'))+'</strong><small>'+new Date(post.created_at).toLocaleString()+'</small></div></div><p>'+esc(post.body)+'</p><div class="forumpostactions">'+(mine||isAdmin?'<button class="dangerbtn forumdelete" type="button">Delete</button>':'')+(!mine?'<button class="ghost forumreport" type="button">Report</button>':'')+'</div>';
    const del=e.querySelector('.forumdelete');
    if(del)del.onclick=async()=>{if(!confirm('Delete this reply?'))return;const {error}=await sb.from('forum_posts').delete().eq('id',post.id);if(error)return toast('Could not delete reply');openForumThread(threadId);};
    const report=e.querySelector('.forumreport');if(report)report.onclick=()=>openReport({type:'forum_post',id:post.id,userId:post.user_id,label:'Report forum reply by @'+(p.username||'collector'),category:'harassment'});
    box.appendChild(e);
  });
  $('#forumReplyForm').classList.toggle('hidden',thread.locked);
}
async function sendForumReply(e){
  e.preventDefault();
  if(!activeForumThreadId)return;
  const body=$('#forumReplyBody').value.trim();if(!body)return;
  const {error}=await sb.from('forum_posts').insert({thread_id:activeForumThreadId,user_id:currentUser.id,body});
  if(error)return toast('Could not post reply');
  await sb.from('forum_threads').update({updated_at:new Date().toISOString()}).eq('id',activeForumThreadId);
  $('#forumReplyBody').value='';openForumThread(activeForumThreadId);
}
function openCommunity(){
  switchCommunityTab('chat');
  startCommunityRealtime();
  startPrivateMessageRealtime();
  loadPrivateInbox().catch(console.error);
}


async function allMasterSets(){
  if(masterSetListCache)return masterSetListCache;
  const r=await fetch(API+'/sets');if(!r.ok)throw new Error('Could not load Pokémon sets');
  masterSetListCache=await r.json();return masterSetListCache;
}
async function masterSetDetail(setId){
  if(masterSetDetailCache.has(setId))return masterSetDetailCache.get(setId);
  const r=await fetch(API+'/sets/'+encodeURIComponent(setId));if(!r.ok)throw new Error('Could not load set');
  const data=await r.json();masterSetDetailCache.set(setId,data);return data;
}
async function syncLibraryToMasterSets(){
  if(!currentUser||!items?.length)return;
  const rows=[...new Map(items.filter(x=>x.game==='pokemon'&&x.setId&&x.cardId&&!String(x.cardId).startsWith('manual:')).map(x=>[x.setId+'|'+x.cardId,{user_id:currentUser.id,game:'pokemon',set_id:x.setId,card_id:x.cardId}])).values()];
  if(rows.length)await sb.from('master_set_cards').upsert(rows,{onConflict:'user_id,game,set_id,card_id'});
}
async function masterOwnedMap(userId){
  const {data,error}=await sb.from('master_set_cards').select('set_id,card_id').eq('user_id',userId).eq('game','pokemon');
  if(error)return new Map();
  const map=new Map();
  (data||[]).forEach(r=>{if(!map.has(r.set_id))map.set(r.set_id,new Set());map.get(r.set_id).add(r.card_id);});
  return map;
}
async function renderMasterSetHub(userId){
  const box=$('#profileMasterSets');if(!box)return;
  box.innerHTML='<div class="empty">Loading Pokémon sets…</div>';
  const mine=userId===currentUser.id;
  if(mine)await syncLibraryToMasterSets();
  const [{data:p},sets,owned]=await Promise.all([
    sb.from('profiles').select('master_sets_visibility').eq('id',userId).single(),
    allMasterSets(),
    masterOwnedMap(userId)
  ]);
  if(!mine&&p?.master_sets_visibility!=='public'){box.innerHTML='<div class="empty">This collector keeps Master Sets private.</div>';return;}
  box.innerHTML='<div class="mastersettools"><input id="masterSetSearch" placeholder="Search Pokémon sets…"><span id="masterSetCount" class="pill"></span></div><div id="masterSetGrid" class="mastersetgrid"></div><div id="masterSetCardsView"></div>';
  const render=()=>{
    const q=$('#masterSetSearch').value.trim().toLowerCase();
    const filtered=(sets||[]).filter(s=>!q||String(s.name||'').toLowerCase().includes(q));
    $('#masterSetCount').textContent=filtered.length+' sets';
    const grid=$('#masterSetGrid');grid.innerHTML='';
    filtered.forEach(set=>{
      const n=(owned.get(set.id)||new Set()).size,total=Number(set.cardCount?.total||0);
      const b=document.createElement('button');b.className='mastersettile';
      const logo=set.logo?'<img loading="lazy" src="'+esc(set.logo)+'.webp" alt="">':'<div class="setlogofallback">Pokémon</div>';
      b.innerHTML=logo+'<div><strong>'+esc(set.name)+'</strong><span>'+n+' / '+total+' owned</span><div class="setprogress"><i style="width:'+(total?Math.min(100,n/total*100):0)+'%"></i></div></div>';
      b.onclick=()=>openMasterSet(userId,set,owned);
      grid.appendChild(b);
    });
  };
  $('#masterSetSearch').oninput=render;render();
}
async function openMasterSet(userId,setBrief,ownedMap){
  const host=$('#profileMasterSets');if(!host)return;
  const set=await masterSetDetail(setBrief.id),mine=userId===currentUser.id;
  const owned=ownedMap.get(set.id)||new Set();
  host.innerHTML='<div class="mastersethead"><button id="masterSetBack" class="ghost" type="button">← All sets</button><div><div class="eyebrow">MASTER SET</div><h3>'+esc(set.name)+'</h3><span id="masterSetProgressText">'+owned.size+' / '+Number(set.cardCount?.total||set.cards?.length||0)+' owned</span></div><button id="masterSetFavorite" class="secondary" type="button">☆ Favorite set</button></div><div id="masterSetCardGrid" class="mastercardgrid"></div>';
  $('#masterSetBack').onclick=()=>renderMasterSetHub(userId);
  const fav=await favoriteState('set',set.id);$('#masterSetFavorite').textContent=fav?'★ Favorited':'☆ Favorite set';
  $('#masterSetFavorite').onclick=async()=>{const on=await saveFavorite('set',set.id,set.name,set.logo||'',{set_id:set.id});$('#masterSetFavorite').textContent=on?'★ Favorited':'☆ Favorite set';};
  const grid=$('#masterSetCardGrid');
  (set.cards||[]).forEach(card=>{
    const isOwned=owned.has(card.id);
    const b=document.createElement('button');b.className='mastercard '+(isOwned?'owned':'missing');
    b.type='button';b.disabled=!mine;
    b.innerHTML='<div class="mastercardimg"><img loading="lazy" src="'+esc(imageUrl(card.image))+'" alt="'+esc(card.name)+'"><span class="mastercheck">✓</span></div><strong>'+esc(card.name)+'</strong><span>#'+esc(card.localId)+'</span>';
    if(mine)b.onclick=async()=>{
      if(owned.has(card.id)){
        const {error}=await sb.from('master_set_cards').delete().eq('user_id',currentUser.id).eq('game','pokemon').eq('set_id',set.id).eq('card_id',card.id);
        if(error)return toast('Could not update Master Set');
        owned.delete(card.id);b.classList.remove('owned');b.classList.add('missing');
      }else{
        const {error}=await sb.from('master_set_cards').insert({user_id:currentUser.id,game:'pokemon',set_id:set.id,card_id:card.id});
        if(error)return toast('Could not update Master Set');
        owned.add(card.id);b.classList.remove('missing');b.classList.add('owned');
      }
      $('#masterSetProgressText').textContent=owned.size+' / '+Number(set.cardCount?.total||set.cards?.length||0)+' owned';
    };
    grid.appendChild(b);
  });
}

async function checkAdminMfa(){
  if(!isAdmin)return false;
  const {data,error}=await sb.auth.mfa.listFactors();
  if(error){$('#adminMfaStatus').textContent='Could not check MFA';return false;}
  const verified=(data.totp||[]).find(f=>f.status==='verified');
  $('#adminMfaStatus').textContent=verified?'Enabled — fresh code required for every admin action':'Not configured';
  $('#setupAdminMfaBtn').textContent=verified?'Authenticator MFA enabled':'Set up 6-digit authenticator';
  $('#setupAdminMfaBtn').disabled=!!verified;
  return !!verified;
}

async function startAdminMfaEnrollment(){
  if(!isAdmin)return;
  const factors=await sb.auth.mfa.listFactors();
  if(factors.error)return toast('Could not start MFA setup');
  const verified=(factors.data.totp||[]).find(f=>f.status==='verified');
  if(verified){toast('Authenticator MFA is already enabled');return;}
  for(const factor of (factors.data.totp||[]).filter(f=>f.status!=='verified')){
    try{await sb.auth.mfa.unenroll({factorId:factor.id});}catch(e){}
  }
  const {data,error}=await sb.auth.mfa.enroll({factorType:'totp',friendlyName:'DeckVault Admin'});
  if(error)return toast(error.message||'Could not enroll MFA');
  mfaEnrollmentFactorId=data.id;
  const qr=data.totp?.qr_code||'';
  const src=qr.trim().startsWith('<svg')?'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(qr):qr;
  $('#mfaQrWrap').innerHTML=src?'<img src="'+esc(src)+'" alt="Authenticator QR code">':'';
  $('#mfaSecret').textContent=data.totp?.secret?'Manual key: '+data.totp.secret:'';
  $('#mfaEnrollCode').value='';
  $('#mfaEnrollMessage').textContent='';
  $('#mfaEnrollDialog').showModal();
}

async function verifyAdminMfaEnrollment(){
  const code=$('#mfaEnrollCode').value.trim();
  if(!/^\d{6}$/.test(code)){const m=$('#mfaEnrollMessage');m.textContent='Enter the 6-digit code from your authenticator app.';m.classList.add('error');return;}
  const m=$('#mfaEnrollMessage');m.textContent='Verifying…';m.classList.remove('error');
  const ch=await sb.auth.mfa.challenge({factorId:mfaEnrollmentFactorId});
  if(ch.error){m.textContent=ch.error.message;m.classList.add('error');return;}
  const v=await sb.auth.mfa.verify({factorId:mfaEnrollmentFactorId,challengeId:ch.data.id,code});
  if(v.error){m.textContent=v.error.message;m.classList.add('error');return;}
  await sb.auth.refreshSession();
  $('#mfaEnrollDialog').close();
  await checkAdminMfa();
  toast('Administrator MFA enabled');
}

async function verifyFreshAdminTotp(code){
  const factors=await sb.auth.mfa.listFactors();
  if(factors.error)throw factors.error;
  const factor=(factors.data.totp||[]).find(f=>f.status==='verified');
  if(!factor)throw new Error('Set up administrator authenticator MFA first.');
  const challenge=await sb.auth.mfa.challenge({factorId:factor.id});
  if(challenge.error)throw challenge.error;
  const verify=await sb.auth.mfa.verify({factorId:factor.id,challengeId:challenge.data.id,code});
  if(verify.error)throw verify.error;
  const refreshed=await sb.auth.refreshSession();
  if(refreshed.error)throw refreshed.error;
}

async function openAdminAction(type,payload){
  if(!await checkAdminMfa()){await startAdminMfaEnrollment();return;}
  pendingAdminAction={type,...payload};
  const titleMap={approve:'Approve account?',deny:'Deny account?',ban:'Ban user?',unban:'Unban user?'};
  const textMap={
    approve:'Are you sure you want to approve '+(payload.label||'this account')+'? An account invitation/setup email will be sent.',
    deny:'Are you sure you want to deny '+(payload.label||'this application')+'?',
    ban:'Are you sure you want to ban '+(payload.label||'this user')+'? Their account and records will remain preserved for review.',
    unban:'Are you sure you want to restore access for '+(payload.label||'this user')+'?'
  };
  $('#adminActionTitle').textContent=titleMap[type]||'Are you sure?';
  $('#adminActionText').textContent=textMap[type]||'Confirm this administrator action.';
  $('#adminActionReason').value='';
  $('#adminActionNotes').value='';
  $('#adminActionCode').value='';
  $('#adminActionMessage').textContent='';
  $('#adminActionMessage').classList.remove('error');
  $('#adminActionReasonWrap').classList.toggle('hidden',type==='approve');
  $('#adminActionNotesWrap').classList.toggle('hidden',type!=='ban');
  $('#confirmAdminActionBtn').textContent=type==='approve'?'Approve':type==='deny'?'Deny':type==='ban'?'Ban user':'Unban user';
  $('#confirmAdminActionBtn').className=type==='approve'?'primary':'dangerbtn';
  $('#adminActionDialog').showModal();
}

async function executeAdminAction(){
  if(!pendingAdminAction)return;
  const code=$('#adminActionCode').value.trim();
  const reason=$('#adminActionReason').value.trim();
  const notes=$('#adminActionNotes').value.trim();
  const msg=$('#adminActionMessage');
  msg.classList.remove('error');
  if(!/^\d{6}$/.test(code)){msg.textContent='Enter your current 6-digit authenticator code.';msg.classList.add('error');return;}
  if(pendingAdminAction.type==='ban'&&!reason){msg.textContent='A ban reason is required.';msg.classList.add('error');return;}
  $('#confirmAdminActionBtn').disabled=true;
  msg.textContent='Verifying code…';
  try{
    await verifyFreshAdminTotp(code);
    msg.textContent='Applying action…';
    let result;
    if(['approve','deny'].includes(pendingAdminAction.type)){
      result=await sb.functions.invoke('review-account-application',{
        body:{application_id:pendingAdminAction.applicationId,action:pendingAdminAction.type,reason:reason||null}
      });
    }else{
      result=await sb.functions.invoke('moderate-user',{
        body:{
          target_user_id:pendingAdminAction.userId,
          action:pendingAdminAction.type,
          reason:reason||null,
          admin_notes:notes||null
        }
      });
    }
    if(result.error||result.data?.error)throw new Error(result.data?.error||result.error?.message||'Admin action failed');
    $('#adminActionDialog').close();
    toast(pendingAdminAction.type==='approve'?'Account approved':pendingAdminAction.type==='deny'?'Application denied':pendingAdminAction.type==='ban'?'User banned':'User unbanned');
    pendingAdminAction=null;
    await Promise.all([loadApplications(),loadUserManagement(),loadAdminAudit()]);
  }catch(e){
    msg.textContent=e.message||'Admin action failed';
    msg.classList.add('error');
  }finally{$('#confirmAdminActionBtn').disabled=false;}
}

async function loadUserManagement(){
  if(!isAdmin)return;
  const [{data:profiles,error},{data:bans}]=await Promise.all([
    sb.from('profiles').select('id,username,display_name,avatar_url,created_at').order('created_at',{ascending:true}),
    sb.from('user_bans').select('user_id,active,reason,banned_at,unbanned_at')
  ]);
  const box=$('#userManagement');box.innerHTML='';
  if(error){box.innerHTML='<div class="empty">Could not load users.</div>';return;}
  const banMap=Object.fromEntries((bans||[]).map(b=>[b.user_id,b]));
  const rows=(profiles||[]).filter(p=>p.id!==currentUser.id);
  if(!rows.length){box.innerHTML='<div class="empty">No other approved users yet.</div>';return;}
  rows.forEach(p=>{
    const ban=banMap[p.id];
    const e=document.createElement('div');e.className='applicationrow';
    e.innerHTML='<div class="useridentity">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':'<div class="avatarfallback">DV</div>')+'<div><strong>@'+esc(p.username||'unconfigured')+'</strong><small>'+esc(p.display_name||'')+'</small>'+(ban?.active?'<small class="banlabel">BANNED — '+esc(ban.reason)+'</small>':'<small>Active</small>')+'</div></div><div><button class="'+(ban?.active?'secondary':'dangerbtn')+'" data-moderate>'+(ban?.active?'Unban':'Ban')+'</button></div>';
    e.querySelector('[data-moderate]').onclick=()=>openAdminAction(ban?.active?'unban':'ban',{userId:p.id,label:'@'+(p.username||'user')});
    box.appendChild(e);
  });
}

async function loadReports(){
  if(!isAdmin||!$('#reportQueue'))return;
  const [{data:reports,error},{data:profiles}]=await Promise.all([
    sb.from('user_reports').select('*').order('created_at',{ascending:false}).limit(100),
    sb.from('profiles').select('id,username')
  ]);
  const box=$('#reportQueue');box.innerHTML='';
  if(error){box.innerHTML='<div class="empty">Could not load reports.</div>';return;}
  const names=Object.fromEntries((profiles||[]).map(p=>[p.id,p.username]));
  const pending=(reports||[]).filter(r=>r.status==='pending'||r.status==='reviewed');
  if(!pending.length){box.innerHTML='<div class="empty">No open reports.</div>';return;}
  pending.forEach(r=>{
    const e=document.createElement('article');e.className='reportrow';
    const target=r.target_user_id?(names[r.target_user_id]?'@'+names[r.target_user_id]:r.target_user_id.slice(0,8)):(r.target_type||'content');
    e.innerHTML='<div><div class="eyebrow">'+esc(r.category.toUpperCase())+'</div><strong>'+esc(target)+'</strong><p>'+esc(r.reason)+'</p><small>'+esc(r.target_type)+' • '+new Date(r.created_at).toLocaleString()+'</small></div><div class="reportactions"><button class="secondary" data-reviewed type="button">Mark reviewed</button>'+(r.target_user_id?'<button class="dangerbtn" data-ban type="button">Ban user</button>':'')+'<button class="ghost" data-dismiss type="button">Dismiss</button></div>';
    e.querySelector('[data-reviewed]').onclick=()=>updateReportStatus(r.id,'reviewed');
    e.querySelector('[data-dismiss]').onclick=()=>updateReportStatus(r.id,'dismissed');
    const ban=e.querySelector('[data-ban]');if(ban)ban.onclick=()=>openAdminAction('ban',{userId:r.target_user_id,label:target});
    box.appendChild(e);
  });
}
async function updateReportStatus(id,status){
  const {error}=await sb.from('user_reports').update({status,reviewed_at:new Date().toISOString(),reviewed_by:currentUser.id}).eq('id',id);
  if(error)return toast('Could not update report');loadReports();toast('Report updated');
}

async function loadAdminAudit(){
  if(!isAdmin)return;
  const [{data:actions,error},{data:profiles}]=await Promise.all([
    sb.from('admin_actions').select('id,action_type,target_user_id,reason,created_at').order('created_at',{ascending:false}).limit(20),
    sb.from('profiles').select('id,username')
  ]);
  const box=$('#adminAuditLog');box.innerHTML='';
  if(error){box.innerHTML='<div class="empty">Could not load audit log.</div>';return;}
  if(!actions?.length){box.innerHTML='<div class="empty">No admin actions recorded yet.</div>';return;}
  const names=Object.fromEntries((profiles||[]).map(p=>[p.id,p.username]));
  actions.forEach(a=>{
    const e=document.createElement('div');e.className='auditrow';
    const target=a.target_user_id?(names[a.target_user_id]?'@'+names[a.target_user_id]:a.target_user_id.slice(0,8)):'application';
    e.innerHTML='<strong>'+esc(a.action_type.replaceAll('_',' '))+'</strong><span>'+esc(target)+'</span><small>'+new Date(a.created_at).toLocaleString()+(a.reason?' • '+esc(a.reason):'')+'</small>';
    box.appendChild(e);
  });
}

async function checkAdmin(){
  const {data}=await sb.from('admin_users').select('user_id').eq('user_id',currentUser.id).maybeSingle();
  isAdmin=!!data;
  syncAdminSettingsOption();
  if(isAdmin)await Promise.all([checkAdminMfa(),loadApplications(),loadUserManagement(),loadAdminAudit(),loadReports()]);
}

async function loadApplications(){
  if(!isAdmin)return;
  const {data,error}=await sb.from('account_applications').select('*').eq('status','pending').order('created_at',{ascending:true});
  const box=$('#applicationQueue');box.innerHTML='';
  if(error){box.innerHTML='<div class="empty">Could not load applications.</div>';return;}
  if(!data?.length){box.innerHTML='<div class="empty">No pending applications.</div>';return;}
  data.forEach(a=>{
    const e=document.createElement('div');e.className='applicationrow';
    const label='@'+a.requested_username+' ('+a.email+')';
    e.innerHTML='<div><strong>@'+esc(a.requested_username)+'</strong><small>'+esc(a.email)+'</small><small>'+new Date(a.created_at).toLocaleString()+'</small></div><div><button class="primary" data-approve>Approve</button><button class="dangerbtn" data-deny>Deny</button></div>';
    e.querySelector('[data-approve]').onclick=()=>openAdminAction('approve',{applicationId:a.id,label});
    e.querySelector('[data-deny]').onclick=()=>openAdminAction('deny',{applicationId:a.id,label});
    box.appendChild(e);
  });
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
  document.querySelectorAll('[data-community-tab]').forEach(b=>b.onclick=()=>switchCommunityTab(b.dataset.communityTab));
  $('#communityChatForm').onsubmit=sendCommunityMessage;
  $('#refreshChatBtn').onclick=loadCommunityChat;
  $('#privateMessageForm').onsubmit=sendPrivateMessage;
  $('#refreshPrivateMessages').onclick=loadPrivateInbox;
  $('#privateMessageSearchBtn').onclick=findPrivateMessageRecipients;
  $('#privateMessageSearch').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();findPrivateMessageRecipients();}};
  $('#settingsSectionSelect').onchange=e=>switchSettingsSection(e.target.value);
  $('#notificationBtn').onclick=()=>{loadNotifications();$('#notificationsDialog').showModal();};
  $('#markAllNotificationsRead').onclick=markAllNotificationsRead;
  $('#submitReportBtn').onclick=submitReport;
  $('#refreshBlocksBtn').onclick=loadBlockedUsersSettings;
  $('#refreshReports').onclick=loadReports;
  $('#refreshSavedItemsBtn').onclick=loadSavedItems;
  $('#sendAdminNoticeBtn').onclick=sendAdminNotice;
  $('#newForumThreadBtn').onclick=()=>{$('#newForumThreadDialog').showModal();};
  $('#createForumThreadBtn').onclick=createForumThread;
  $('#backToForumsBtn').onclick=()=>{$('#forumThreadView').classList.add('hidden');$('#forumListView').classList.remove('hidden');loadForumThreads();};
  $('#forumReplyForm').onsubmit=sendForumReply;
  $('#marketSearchBtn').onclick=marketCardSearch;
  $('#refreshMarketplace').onclick=loadMarketplaceFeed;
  let marketFeedTimer=null;
  $('#marketFeedSearch').oninput=()=>{
    clearTimeout(marketFeedTimer);
    marketFeedTimer=setTimeout(loadMarketplaceFeed,250);
  };
  $('#marketFeedFilter').onchange=loadMarketplaceFeed;
  $('#marketSearchName').onkeydown=e=>{if(e.key==='Enter')marketCardSearch();};
  $('#marketSearchNumber').onkeydown=e=>{if(e.key==='Enter')marketCardSearch();};
  $('#communitySearch').onkeydown=e=>{if(e.key==='Enter')searchCommunity();};
  $('#refreshApplications').onclick=loadApplications;
  $('#refreshUsers').onclick=()=>Promise.all([loadUserManagement(),loadAdminAudit()]);
  $('#setupAdminMfaBtn').onclick=startAdminMfaEnrollment;
  $('#verifyMfaEnrollBtn').onclick=verifyAdminMfaEnrollment;
  $('#confirmAdminActionBtn').onclick=executeAdminAction;
  document.querySelectorAll('[data-go="community"]').forEach(b=>b.addEventListener('click',openCommunity));
  document.querySelectorAll('[data-go="marketplace"]').forEach(b=>b.addEventListener('click',loadMarketplaceFeed));
  document.querySelectorAll('[data-go="settings"]').forEach(b=>b.addEventListener('click',()=>{switchSettingsSection($('#settingsSectionSelect').value||'account');loadProfileSettings();loadMyLists();loadTradeList();loadBlockedUsersSettings();if(isAdmin&&$('#settingsSectionSelect').value==='admin')Promise.all([checkAdminMfa(),loadApplications(),loadUserManagement(),loadAdminAudit(),loadReports()]);}));
  if(window.installSwipeBack){
    installSwipeBack($('#privateConversationView'),()=>{
      activePrivateConversationId=null;activePrivateOtherUserId=null;pendingPrivateReference=null;
      $('#privateConversationView').classList.add('hidden');$('#privateConversationEmpty').classList.remove('hidden');
    });
    installSwipeBack($('#forumThreadView'),()=>{
      $('#forumThreadView').classList.add('hidden');$('#forumListView').classList.remove('hidden');loadForumThreads();
    });
  }
    // Authentication lifecycle is owned by app.js. Community realtime starts on demand.
});
window.refreshSocialState=refreshSocialState;
window.installSwipeBack=window.installSwipeBack||((el,cb)=>{});
window.loadDeckVaultNotifications=loadNotifications;
