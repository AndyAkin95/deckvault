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
    assert(!tripleDollar.length, name+' contains accidental $$() selector helper usage at offsets '+tripleDollar.join(', '));
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
  const card={
    id:'22222222-2222-4222-8222-222222222222',user_id:user.id,game:'pokemon',card_id:'sv3-125',
    name:'Pikachu',local_id:'125',set_id:'sv3',set_name:'Obsidian Flames',rarity:'Common',
    variant:'Normal',condition:'Near Mint',language:'English',quantity:2,image_url:'',
    price:1.25,price_paid:0.50,price_currency:'USD',price_source:'TCGplayer Market',
    price_updated_at:now,entry_source:'provider',notes:'',added_at:now,updated_at:now
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
    if(table==='profiles') return terminal==='single'||terminal==='maybeSingle'?{data:profile,error:null}:{data:[profile],error:null};
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
    const chainMethods=['select','eq','neq','in','not','ilike','like','is','match','contains','order','limit','range','gte','lte','gt','lt','filter'];
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
    rpc:async()=>({data:[],error:null}),
    functions:{invoke:async()=>({data:{ok:true},error:null})},
    channel:()=>({on(){return this;},subscribe(){return this;},unsubscribe(){return this;}})
  };
  window.supabase={createClient:()=>client};
})();
`;

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

async function setupRoutes(page, signedIn) {
  await page.route('**/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.min.js', route =>
    route.fulfill({status:200,contentType:'application/javascript',body:signedIn?MOCK_SUPABASE:NO_SESSION_SUPABASE})
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
  const context=await browser.newContext({serviceWorkers:'allow'});
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

  const views=['dashboard','lookup','library','scanner','marketplace','community','settings'];
  for(const view of views){
    const button=page.locator('.bottomnav [data-go="'+view+'"]');
    await button.click();
    await page.waitForTimeout(120);
    assert(await page.locator('#'+view).evaluate(el=>el.classList.contains('active')), 'View did not activate: '+view);
  }

  // Community sub-tabs.
  await page.click('.bottomnav [data-go="community"]');
  for(const tab of ['forums','profiles','chat']){
    await page.click('[data-community-tab="'+tab+'"]');
    await page.waitForTimeout(100);
    const paneId=tab==='chat'?'communityChatPane':tab==='forums'?'communityForumsPane':'communityProfilesPane';
    assert(await page.locator('#'+paneId).evaluate(el=>el.classList.contains('active')), 'Community pane failed: '+tab);
  }

  // Library controls and card details.
  await page.click('.bottomnav [data-go="library"]');
  await page.selectOption('#librarySort','name_asc');
  await page.fill('#librarySearch','Pika');
  await page.fill('#librarySearch','');
  const cardImage=page.locator('.librarycardimage').first();
  assert(await cardImage.count()===1,'Mock library card did not render');
  await cardImage.click();
  await page.waitForSelector('#libraryCardDialog[open]');
  await page.waitForTimeout(250);
  await page.locator('#libraryCardDialog .close').click();

  await page.click('#manualAddCardBtn');
  await page.waitForSelector('#manualCardDialog[open]');
  await page.locator('#manualCardDialog .close').click();
  await page.click('#manageFoldersBtn');
  await page.waitForSelector('#manageFoldersDialog[open]');
  await page.locator('#manageFoldersDialog .close').click();

  // Settings diagnostics should render without throwing.
  await page.click('.bottomnav [data-go="settings"]');
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
} finally {
  await browser.close();
}
console.log('ALL HARD SCRUB PASSES OK');
