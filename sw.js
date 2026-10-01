const CACHE='deckvault-v22-static';
const CORE=['./','./index.html','./styles.css','./app.js','./social.js','./manifest.json','./icon.svg'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(async cache=>{
        for(const asset of CORE){
          try{await cache.add(asset);}catch(e){console.warn('Precache skipped',asset,e);}
        }
      })
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type!=='CACHE_URLS'||!Array.isArray(data.urls))return;
  const urls=data.urls.slice(0,300).filter(u=>{
    try{
      const x=new URL(u);
      return x.hostname==='assets.tcgdex.net'||x.origin===self.location.origin;
    }catch{return false;}
  });
  event.waitUntil(
    caches.open(CACHE).then(async cache=>{
      for(const url of urls){
        try{
          const hit=await cache.match(url);
          if(hit)continue;
          const response=await fetch(url);
          if(response.ok||response.type==='opaque')await cache.put(url,response.clone());
        }catch{}
      }
    })
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  const sameOrigin=url.origin===self.location.origin;
  const cacheableExternal=url.hostname==='cdn.jsdelivr.net'||url.hostname==='assets.tcgdex.net';

  if(cacheableExternal){
    event.respondWith(
      caches.match(event.request).then(cached=>{
        if(cached)return cached;
        return fetch(event.request).then(response=>{
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{});
          return response;
        });
      })
    );
    return;
  }

  if(!sameOrigin)return;
  event.respondWith(
    fetch(event.request)
      .then(response=>{
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{});
        return response;
      })
      .catch(()=>caches.match(event.request).then(cached=>cached||caches.match('./index.html')))
  );
});