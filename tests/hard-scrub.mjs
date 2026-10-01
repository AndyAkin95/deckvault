import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.DECKVAULT_TEST_URL || 'http://127.0.0.1:4173';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function staticAudit() {
  const html = fs.readFileSync('index.html','utf8');
  const app = fs.readFileSync('app.js','utf8');
  const social = fs.readFileSync('social.js','utf8');
  const sw = fs.readFileSync('sw.js','utf8');

  const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);
  const counts=new Map();
  for(const id of ids) counts.set(id,(counts.get(id)||0)+1);
  const dup=[...counts].filter(([,n])=>n>1);
  assert(!dup.length,'Duplicate DOM IDs: '+JSON.stringify(dup));

  for (const [name,src] of [['app.js',app],['social.js',social]]) {
    const bad=[...src.matchAll(/(?<!\$)\$\(([^)]*)\)\.(forEach|map|filter|some|every|reduce)\b/g)]
      .map(m=>m[0]);
    assert(!bad.length, name+' uses single-element $() as a collection: '+bad.join(', '));

    const nativeBad=[...src.matchAll(/document\.querySelector\([^)]*\)\.(forEach|map|filter|some|every|reduce)\b/g)]
      .map(m=>m[0]);
    assert(!nativeBad.length, name+' uses querySelector as a collection: '+nativeBad.join(', '));

    const tripleDollar=[...src.matchAll(/\$\$\$\(/g)].map(m=>m.index);
    assert(!tripleDollar.length, name+' contains accidental $() selector helper usage at offsets '+tripleDollar.join(', '));

    const dollarDocument=[...src.matchAll(/\$document\b/g)].map(m=>m.index);
    assert(!dollarDocument.length, name+' contains accidental $document usage at offsets '+dollarDocument.join(', '));
  }

  const appInitStart=app.indexOf('async function init(){');
  const appInitEnd=app.indexOf("document.addEventListener('DOMContentLoaded'",appInitStart);
  const appInit=appInitStart>=0?app.slice(appInitStart,appInitEnd):'';
  const socialInitStart=social.lastIndexOf("document.addEventListener('DOMContentLoaded'");
  const socialInit=socialInitStart>=0?social.slice(socialInitStart):'';
  const startupSource=appInit+'\n'+socialInit;
  const boundIds=[...startupSource.matchAll(/\$\('#([^']+)'\)\.(?:onclick|onsubmit|onchange|oninput|onkeydown)\s*=/g)].map(m=>m[1]);
  const missing=[...new Set(boundIds)].filter(id=>!html.includes('id="'+id+'"'));
  assert(!missing.length,'Startup-bound IDs missing from HTML: '+missing.join(', '));

  const build=app.match(/const APP_BUILD='([^']+)'/)?.[1];
  assert(build,'APP_BUILD missing');
  assert(app.includes("serviceWorker.register('./sw.js?build='+encodeURIComponent(APP_BUILD)"),
    'Service worker registration is not tied to APP_BUILD');
  assert(sw.includes("const CACHE='deckvault-"),'Service worker cache name missing');

  console.log('STATIC AUDIT PASS', {ids:ids.length, boundIds:new Set(boundIds).size, build});
}

const MOCK_SUPABASE = String.raw`
(() => {
  const user={
    id:'11111111-1111-4111-8111-111111111111',
    email:'vm-test@deckvault.invalid',
    user_metadata:{requested_username:'vmcollector'}
  };
  const now='2026-10-01T12:00:00.000Z';
  const profile={
    id:user.id,username:'vmcollector',display_name:'VM Collector',bio:'Automated test profile',
    avatar_url:null,onboarding_complete:true,marketplace_mode:'off',marketplace_note:null,
    master_sets_visibility:'public',created_at:now,updated_at:now
  };
  const otherProfile={
    id:'55555555-5555-4555-8555-555555555555',username:'othercollector',display_name:'Other Collector',
    bio:'Messaging test collector',avatar_url:null,onboarding_complete:true,marketplace_mode:'trade',
    marketplace_note:null,master_sets_visibility:'public',created_at:now,updated_at:now
  };
  const privateConversation={
    id:'66666666-6666-4666-8666-666666666666',
    user_one:user.id,user_two:otherProfile.id,created_at:now
  };
  const privateMessage={
    id:'77777777-7777-4777-8777-777777777777',
    conversation_id:privateConversation.id,sender_id:otherProfile.id,
    body:'Hello from the messaging VM test',created_at:now
  };
  const card={
    id:'22222222-2222-4222-8222-222222222222',user_id:user.id,game:'pokemon',card_id:'sv3-125',
    name:'Pikachu',local_id:'125',set_id:'sv3',set_name:'Obsidian Flames',rarity:'Common',
    variant:'Normal',condition:'Near Mint',language:'English',quantity:2,image_url:'',
    price:1.25,price_paid:0.50,price_currency:'USD',price_source:'TCGplayer Market',
    price_updated_at:now,entry_source:'provider',card_state:'raw',grading_company:null,grade:null,cert_number:null,purchase_date:'2026-09-15',notes:'',added_at:now,updated_at:now
  };
  const watch={
    user_id:user.id,game:'pokemon',card_id:'sv3-125',variant:'Normal',card_name:'Pikachu',
    set_name:'Obsidian Flames',image_url:'',target_price:1.00,currency:'USD',
    notify_change_pct:10,last_seen_value:1.25,last_notified_value:null,last_notified_at:null,created_at:now
  };
  const copies=[
    {id:'88888888-8888-4888-8888-888888888881',user_id:user.id,collection_item_id:card.id,condition:'Near Mint',price_paid:.5,purchase_date:'2026-09-15',card_state:'raw',grading_company:null,grade:null,cert_number:null,notes:null,folder_id:'33333333-3333-4333-8333-333333333333',created_at:now,updated_at:now},
    {id:'88888888-8888-4888-8888-888888888882',user_id:user.id,collection_item_id:card.id,condition:'Lightly Played',price_paid:.4,purchase_date:'2026-09-20',card_state:'raw',grading_company:null,grade:null,cert_number:null,notes:null,folder_id:null,created_at:now,updated_at:now}
  ];
  const notification={
    id:'99999999-9999-4999-8999-999999999999',user_id:user.id,type:'price_change',
    title:'Watchlist price change',body:'Pikachu moved 12% to USD 1.25',
    actor_user_id:null,reference_type:'card',reference_id:'sv3-125',read_at:null,created_at:now
  };
  const folder={id:'33333333-3333-4333-8333-333333333333',user_id:user.id,name:'Favorites',created_at:now,updated_at:now};
  const tradeList={id:'44444444-4444-4444-8444-444444444444',user_id:user.id,name:'Trade / Sell',visibility:'public',system_key:'trade',collection_list_items:[]};

  function tableResult(table, terminal) {
    if(table==='user_bans') return terminal==='single'||terminal==='maybeSingle'?{data:null,error:null}:{data:[],error:null};
    if(table==='approved_users') return terminal==='single'||terminal==='maybeSingle'?{data:{user_id:user.id},error:null}:{data:[{user_id:user.id}],error:null};
    if(table==='legal_documents') return {data:{document_key:'terms',version:'2026-10-01',title:'DeckVault Terms',body:'Test terms',effective_at:now,is_current:true},error:null};
    if(table==='terms_acceptances') return terminal==='single'||terminal==='maybeSingle'?{data:{user_id:user.id,terms_version:'2026-10-01'},error:null}:{data:[{user_id:user.id,terms_version:'2026-10-01'}],error:null};
    if(table==='collection_items') return terminal==='single'||terminal==='maybeSingle'?{data:card,error:null}:{data:[card],error:null};
    if(table==='collection_folders') return terminal==='single'||terminal==='maybeSingle'?{data:folder,error:null}:{data:[folder],error:null};
    if(table==='collection_folder_items') return {data:[{folder_id:folder.id,collection_item_id:card.id}],error:null};
    if(table==='profiles') return terminal==='single'||terminal==='maybeSingle'?{data:profile,error:null}:{data:[profile,otherProfile],error:null};
    if(table==='private_conversations') return terminal==='single'||terminal==='maybeSingle'?{data:privateConversation,error:null}:{data:[privateConversation],error:null};
    if(table==='private_messages') return terminal==='single'||terminal==='maybeSingle'?{data:privateMessage,error:null}:{data:[privateMessage],error:null};
    if(table==='private_conversation_reads') return {data:[],error:null};
    if(table==='notifications') return terminal==='single'||terminal==='maybeSingle'?{data:notification,error:null}:{data:[notification],error:null};
    if(table==='card_watchlist') return terminal==='single'||terminal==='maybeSingle'?{data:watch,error:null}:{data:[watch],error:null};
    if(table==='collection_copies') return terminal==='single'||terminal==='maybeSingle'?{data:copies[0],error:null}:{data:copies,error:null};
    if(table==='user_blocks'||table==='user_reports'||table==='user_favorites') return {data:[],error:null};
    if(table==='profile_details') return {data:[],error:null};
    if(table==='admin_users') return terminal==='single'||terminal==='maybeSingle'?{data:null,error:null}:{data:[],error:null};
    if(table==='collection_lists') return terminal==='single'||terminal==='maybeSingle'?{data:tradeList,error:null}:{data:[tradeList],error:null};
    if(table==='collection_list_items') return {data:[],error:null};
    if(table==='community_messages'||table==='forum_threads'||table==='forum_posts'||table==='account_applications'||table==='admin_actions'||table==='master_set_cards'||table==='card_price_snapshots'||table==='sales_comps_cache'||table==='app_error_logs') return {data:[],error:null};
    return terminal==='single'||terminal==='maybeSingle'?{data:null,error:null}:{data:[],error:null};
  }

  function builder(table){
    const state={table,ops:[]};
    let proxy;
    const chainMethods=['select','eq','neq','in','or','not','ilike','like','is','match','contains','order','limit','range','gte','lte','gt','lt','filter'];
    const mutateMethods=['insert','update','upsert','delete'];
    proxy=new Proxy({},{
      get(_t,prop){
        if(prop==='then'){
          return (resolve,reject)=>Promise.resolve(tableResult(table,'many')).then(resolve,reject);
        }
        if(prop==='single') return ()=>Promise.resolve(tableResult(table,'single'));
        if(prop==='maybeSingle') return ()=>Promise.resolve(tableResult(table,'maybeSingle'));
        if(chainMethods.includes(prop)) return (...args)=>{state.ops.push([prop,args]);return proxy;};
        if(mutateMethods.includes(prop)) return (...args)=>{state.ops.push([prop,args]);return proxy;};
        return undefined;
      }
    });
    return proxy;
  }

  const client={
    auth:{
      getSession:async()=>({data:{session:{user,access_token:'vm-token'}},error:null}),
      getUser:async()=>({data:{user},error:null}),
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      signInWithPassword:async()=>({data:{user,session:{user}},error:null}),
      signOut:async()=>({error:null}),
      resetPasswordForEmail:async()=>({data:{},error:null}),
      updateUser:async()=>({data:{user},error:null}),
      refreshSession:async()=>({data:{session:{user}},error:null}),
      mfa:{
        listFactors:async()=>({data:{totp:[],phone:[]},error:null}),
        enroll:async()=>({data:{id:'factor',totp:{qr_code:'',secret:'TEST'}},error:null}),
        challenge:async()=>({data:{id:'challenge'},error:null}),
        verify:async()=>({data:{},error:null}),
        getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1',nextLevel:'aal1'},error:null})
      }
    },
    from:(table)=>builder(table),
    rpc:async(name,args)=>{
      if(name==='list_marketplace_cards')return {data:[{
        game:'pokemon',card_id:'sv3-125',card_name:'Pikachu',set_name:'Obsidian Flames',local_id:'125',image_url:'',
        seller_count:1,listing_count:1,total_offer_quantity:1,lowest_asking_price:2.50,price_currency:'USD',
        has_trade:true,has_sell:true,newest_listing:now
      }],error:null};
      if(name==='search_trade_offers')return {data:[{
        user_id:otherProfile.id,username:otherProfile.username,display_name:otherProfile.display_name,avatar_url:null,
        marketplace_mode:'both',marketplace_note:'VM marketplace note',collection_item_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        card_name:'Pikachu',set_name:'Obsidian Flames',local_id:'125',variant:'Normal',condition:'Near Mint',language:'English',
        offer_quantity:1,asking_price:2.50,price_currency:'USD',image_url:'',offer_note:'VM offer'
      }],error:null};
      return {data:[],error:null};
    },
    functions:{invoke:async()=>({data:{ok:true},error:null})},
    channel:()=>({on(){return this;},subscribe(){return this;},unsubscribe(){return this;}})
  };
  window.supabase={createClient:()=>client};
})();
`;

const MOCK_ADMIN_SUPABASE = MOCK_SUPABASE.replace(
  "if(table==='admin_users') return terminal==='single'||terminal==='maybeSingle'?{data:null,error:null}:{data:[],error:null};",
  "if(table==='admin_users') return terminal==='single'||terminal==='maybeSingle'?{data:{user_id:user.id},error:null}:{data:[{user_id:user.id}],error:null};"
);

const NO_SESSION_SUPABASE = String.raw`
(() => {
  const builder=()=>{let p;p=new Proxy({}, {get(_t,prop){if(prop==='then')return r=>Promise.resolve({data:[],error:null}).then(r);if(prop==='single'||prop==='maybeSingle')return ()=>Promise.resolve({data:null,error:null});return ()=>p;}});return p;};
  const client={
    auth:{
      getSession:async()=>({data:{session:null},error:null}),
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
      signInWithPassword:async()=>({data:{},error:{message:'Test login disabled'}}),
      signOut:async()=>({error:null}),
      resetPasswordForEmail:async()=>({data:{},error:null}),
      mfa:{listFactors:async()=>({data:{totp:[],phone:[]},error:null})}
    },
    from:()=>builder(),rpc:async()=>({data:[],error:null}),
    functions:{invoke:async()=>({data:{},error:null})},
    channel:()=>({on(){return this;},subscribe(){return this;}})
  };
  window.supabase={createClient:()=>client};
})();
`;

async function setupRoutes(page, signedIn, admin=false) {
  await page.route('**/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.min.js', route =>
    route.fulfill({status:200,contentType:'application/javascript',body:signedIn?(admin?MOCK_ADMIN_SUPABASE:MOCK_SUPABASE):NO_SESSION_SUPABASE})
  );
  await page.route('https://api.tcgdex.net/**', async route => {
    const url=route.request().url();
    if(url.includes('/cards/sv3-125')){
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
        id:'sv3-125',localId:'125',name:'Pikachu',rarity:'Common',image:'',
        set:{id:'sv3',name:'Obsidian Flames'},
        pricing:{
          tcgplayer:{unit:'USD',updated:Date.now(),normal:{marketPrice:1.25,lowPrice:1.0,midPrice:1.3,highPrice:2.0}},
          cardmarket:{unit:'EUR',updated:Date.now(),trend:1.1,low:0.9,avg1:1.1,avg7:1.05,avg30:1.0}
        }
      })});
    }
    if(url.endsWith('/sets')) return route.fulfill({status:200,contentType:'application/json',body:'[]'});
    return route.fulfill({status:200,contentType:'application/json',body:'[]'});
  });
  await page.route('https://cdn.jsdelivr.net/npm/tesseract.js@**', route =>
    route.fulfill({status:200,contentType:'application/javascript',body:'window.Tesseract={createWorker:async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:""}})})};'})
  );
}

function watch(page,label){
  const errors=[];
  page.on('pageerror',e=>errors.push('pageerror: '+e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text());});
  page.on('requestfailed',req=>{
    const u=req.url();
    if(!u.startsWith(BASE)) return;
    errors.push('requestfailed: '+u+' '+(req.failure()?.errorText||''));
  });
  return {
    errors,
    async assertClean(){
      const banner=page.locator('#startupError');
      if(await banner.count() && await banner.isVisible()) errors.push('startup banner: '+await banner.innerText());
      assert(!errors.length,label+' runtime errors:\n'+errors.join('\n'));
    }
  };
}

async function loggedOutPass(browser, pass) {
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();
  await setupRoutes(page,false);
  const w=watch(page,'logged-out pass '+pass);
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#signinPane:not(.hidden)');
  await page.click('#showSignUp');
  await page.waitForSelector('#applicationPane:not(.hidden)');
  await page.click('#applicationBack');
  await page.waitForSelector('#signinPane:not(.hidden)');
  await page.click('#showReset');
  await page.waitForSelector('#resetPane:not(.hidden)');
  await page.click('#resetBack');
  await page.waitForSelector('#signinPane:not(.hidden)');

  // Repeated reloads exercise service-worker takeover/update behavior.
  for(let i=0;i<2;i++){
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForSelector('#signinPane:not(.hidden)');
    await page.click('#showReset');
    await page.waitForSelector('#resetPane:not(.hidden)');
    await page.click('#resetBack');
  }
  await w.assertClean();
  await context.close();
  console.log('LOGGED-OUT PASS',pass,'OK');
}

async function adminSignedInPass(browser) {
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();
  await setupRoutes(page,true,true);
  const w=watch(page,'admin signed-in pass');
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#appShell:not(.hidden)',{timeout:15000});
  await page.waitForTimeout(500);
  await page.click('.bottomnav [data-go="settings"]');
  assert(await page.locator('#settingsSectionSelect option[value="admin"]').count()===1,'Administrator settings missing for admin');
  await page.selectOption('#settingsSectionSelect','admin');
  await page.waitForTimeout(120);
  assert(await page.locator('#adminPanel').evaluate(el=>el.classList.contains('active')),'Admin settings pane did not activate');
  await page.fill('#adminNoticeTarget','othercollector');
  await page.fill('#adminNoticeTitle','VM Admin Notice');
  await page.fill('#adminNoticeBody','Automated administrator notification test');
  await page.click('#sendAdminNoticeBtn');
  await page.waitForTimeout(100);
  await w.assertClean();
  await context.close();
  console.log('ADMIN SIGNED-IN PASS OK');
}

async function serviceWorkerPass(browser, pass) {
  const context=await browser.newContext({serviceWorkers:'allow'});
  const page=await context.newPage();
  await setupRoutes(page,false);
  const w=watch(page,'service-worker pass '+pass);
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#signinPane:not(.hidden)',{timeout:15000});
  await page.waitForFunction(()=>('serviceWorker' in navigator),null,{timeout:5000});
  // Allow install/controllerchange cycle to settle, then verify reloads remain healthy.
  await page.waitForTimeout(700);
  for(let i=0;i<2;i++){
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForSelector('#signinPane:not(.hidden)',{timeout:10000});
  }
  const swState=await page.evaluate(async()=>({
    supported:'serviceWorker' in navigator,
    controlled:!!navigator.serviceWorker.controller,
    registrations:(await navigator.serviceWorker.getRegistrations()).length
  }));
  assert(swState.supported,'Service workers are unexpectedly unsupported in Chromium test');
  assert(swState.registrations>=1,'DeckVault service worker did not register: '+JSON.stringify(swState));
  await w.assertClean();
  await context.close();
  console.log('SERVICE-WORKER PASS',pass,'OK',swState);
}

async function signedInPass(browser, pass) {
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();
  await setupRoutes(page,true);
  const w=watch(page,'signed-in pass '+pass);
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#appShell:not(.hidden)',{timeout:15000});
  await page.waitForTimeout(600);
  const shellState=await page.evaluate(()=>({
    appShell:document.querySelector('#appShell')?.className,
    authGate:document.querySelector('#authGate')?.className,
    onboardingGate:document.querySelector('#onboardingGate')?.className,
    termsGate:document.querySelector('#termsGate')?.className,
    navDisplay:getComputedStyle(document.querySelector('.bottomnav')).display,
    navVisibility:getComputedStyle(document.querySelector('.bottomnav')).visibility,
    navRect:document.querySelector('.bottomnav').getBoundingClientRect().toJSON()
  }));
  assert(!shellState.appShell.includes('hidden'),'App shell became hidden after signed-in initialization: '+JSON.stringify(shellState));
  assert(shellState.navDisplay!=='none'&&shellState.navVisibility!=='hidden'&&shellState.navRect.height>0,
    'Bottom nav is not visible after signed-in initialization: '+JSON.stringify(shellState));

  // v25 header modules.
  assert((await page.locator('#analyticsSpend').count())===1,'Analytics widgets missing');
  assert((await page.locator('#notificationBadge').innerText())==='1','Unread notification badge did not populate');
  await page.click('#notificationBtn');
  await page.waitForSelector('#notificationsDialog[open]');
  assert((await page.locator('#notificationsList').innerText()).includes('Watchlist price change'),'Notification center did not render seeded notification');
  await page.locator('#notificationsDialog .close').click();

  await page.click('#universalSearchBtn');
  await page.waitForSelector('#universalSearchDialog[open]');
  await page.fill('#universalSearchInput','Pika');
  await page.waitForTimeout(300);
  assert((await page.locator('#universalSearchResults').innerText()).includes('Pikachu'),'Universal search did not find library card');
  await page.locator('#universalSearchDialog .close').click();

    const views=['dashboard','lookup','library','scanner','marketplace','community','settings'];
  for(const view of views){
    const button=page.locator('.bottomnav [data-go="'+view+'"]');
    await button.click();
    await page.waitForTimeout(120);
    assert(await page.locator('#'+view).evaluate(el=>el.classList.contains('active')), 'View did not activate: '+view);
  }

  // Community sub-tabs.
  await page.click('.bottomnav [data-go="community"]');
  for(const tab of ['forums','profiles','messages','chat']){
    await page.click('[data-community-tab="'+tab+'"]');
    await page.waitForTimeout(150);
    const paneId=tab==='chat'?'communityChatPane':tab==='forums'?'communityForumsPane':tab==='messages'?'communityMessagesPane':'communityProfilesPane';
    assert(await page.locator('#'+paneId).evaluate(el=>el.classList.contains('active')), 'Community pane failed: '+tab);
    if(tab==='messages'){
      const conversation=page.locator('.conversationrow').first();
      assert(await conversation.count()===1,'Private message inbox did not render a conversation');
      await conversation.click();
      await page.waitForSelector('#privateConversationView:not(.hidden)');
      assert((await page.locator('#privateMessageThread').innerText()).includes('Hello from the messaging VM test'),'Private message thread did not render');
      await page.fill('#privateMessageInput','VM reply');
      await page.click('#privateMessageForm button[type="submit"]');
      await page.waitForTimeout(120);
    }
  }

  // Marketplace listing -> private message with card context.
  await page.click('.bottomnav [data-go="marketplace"]');
  await page.waitForTimeout(200);
  const marketCard=page.locator('.marketcard').first();
  assert(await marketCard.count()===1,'Marketplace feed did not render');
  await marketCard.click();await page.waitForTimeout(150);
  const saveListing=page.locator('#marketOffers [data-favorite]').first();
  assert(await saveListing.count()===1,'Save listing action missing');
  await saveListing.click();await page.waitForTimeout(80);
  assert((await saveListing.innerText()).includes('Saved'),'Marketplace favorite did not toggle');
    const messageSeller=page.locator('#marketOffers [data-message]').first();
  assert(await messageSeller.count()===1,'Message seller action missing');
  await messageSeller.click();await page.waitForSelector('#privateConversationView:not(.hidden)');
  assert((await page.locator('#privateMessageInput').getAttribute('placeholder')).includes('Pikachu'),'Marketplace card context did not reach DM composer');

    // Library controls and card details.
  await page.click('.bottomnav [data-go="library"]');
  await page.selectOption('#librarySort','name_asc');
  await page.fill('#librarySearch','Pika');
  await page.fill('#librarySearch','');
  const cardImage=page.locator('.librarycardimage').first();
  assert(await cardImage.count()===1,'Mock library card did not render');
  await cardImage.click();
  await page.waitForSelector('#libraryCardDialog[open]');
  await page.waitForTimeout(300);
  assert((await page.locator('#watchCardBtn').innerText()).includes('Watching'),'Seeded watchlist state did not load');
  await page.click('#manageCopiesBtn');
  await page.waitForSelector('#copiesDialog[open]');
  assert(await page.locator('.copyrow').count()===2,'Individual copy rows did not render');
  await page.locator('#copiesDialog .close').click();
  await page.locator('#libraryCardDialog .close').click();

  await page.click('#manualAddCardBtn');
  await page.waitForSelector('#manualCardDialog[open]');
  await page.locator('#manualCardDialog .close').click();
  await page.click('#manageFoldersBtn');
  await page.waitForSelector('#manageFoldersDialog[open]');
  await page.locator('#manageFoldersDialog .close').click();

  // Collector profile safety/report flow.
  await page.click('.bottomnav [data-go="community"]');
  await page.click('[data-community-tab="profiles"]');
  await page.fill('#communitySearch','other');
  await page.click('#communitySearchBtn');await page.waitForTimeout(120);
  const otherCard=page.locator('.profilecard').filter({hasText:'@othercollector'}).first();
  assert(await otherCard.count()===1,'Other collector profile was not searchable');
  await otherCard.click();await page.waitForTimeout(120);
  await page.click('#publicProfileView [data-report-user]');
  await page.waitForSelector('#reportDialog[open]');
  await page.fill('#reportReason','Automated VM report test');
  await page.click('#submitReportBtn');
  await page.waitForTimeout(100);
  assert(!(await page.locator('#reportDialog').getAttribute('open')),'Report dialog did not close after submission');

    // Settings dropdown should show one focused pane at a time; admin must not appear for a non-admin.
  await page.click('.bottomnav [data-go="settings"]');
  assert(await page.locator('#settingsSectionSelect option[value="admin"]').count()===0,'Administrator settings appeared for non-admin');
  for(const section of ['profile','marketplace','lists','valuation','favorites','backup','diagnostics','data','account']){
    await page.selectOption('#settingsSectionSelect',section);
    await page.waitForTimeout(80);
    assert(await page.locator('[data-settings-pane="'+section+'"]').evaluate(el=>el.classList.contains('active')),'Settings pane did not activate: '+section);
  }
  await page.selectOption('#settingsSectionSelect','profile');
  await page.click('#refreshBlocksBtn');
  await page.selectOption('#settingsSectionSelect','backup');
  assert(await page.locator('#importCollectionFormat option[value="pricecharting"]').count()===1,'PriceCharting import option missing');
  await page.selectOption('#settingsSectionSelect','diagnostics');
  await page.click('#refreshErrorLog');
  await page.waitForTimeout(150);

  // Offline fallback: after online sync, library remains browsable and network tabs disable.
  await context.setOffline(true);
  await page.waitForTimeout(250);
  assert(await page.locator('#offlineBanner').isVisible(),'Offline banner did not appear');
  assert(await page.locator('.bottomnav [data-go="marketplace"]').isDisabled(),'Marketplace was not disabled offline');
  assert(await page.locator('.bottomnav [data-go="library"]').isEnabled(),'Library should remain enabled offline');
  await page.click('.bottomnav [data-go="library"]');
  assert(await page.locator('.librarycard').count()===1,'Saved library disappeared offline');
  await page.click('#manualAddCardBtn');
  await page.waitForSelector('#manualCardDialog[open]');
  await page.fill('#manualName','Offline Test Card');
  await page.fill('#manualSetName','Offline Set');
  await page.click('#saveManualCardBtn');
  await page.waitForTimeout(120);
  assert(await page.locator('.librarycard').count()===2,'Offline manual add did not update library');
  assert((await page.locator('#offlineQueueStatus').innerText()).includes('queued'),'Offline mutation queue did not record change');
  await context.setOffline(false);
  await page.waitForTimeout(400);

  await w.assertClean();
  await context.close();
  console.log('SIGNED-IN PASS',pass,'OK');
}

staticAudit();
const browser=await chromium.launch({headless:true});
try{
  for(let pass=1;pass<=2;pass++) await loggedOutPass(browser,pass);
  for(let pass=1;pass<=2;pass++) await signedInPass(browser,pass);
  await adminSignedInPass(browser);
  for(let pass=1;pass<=2;pass++) await serviceWorkerPass(browser,pass);
} finally {
  await browser.close();
}
console.log('ALL HARD SCRUB PASSES OK');
