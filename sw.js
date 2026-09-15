// Stale-while-revalidate cache: serve instantly from cache, refresh in the background.
const CACHE = "geographier-v2";
const SHELL = ["./", "index.html", "data/us-states.json", "data/countries.json", "data/map-africa.json", "data/map-asia.json", "data/map-europe.json", "data/map-north-america.json", "data/map-south-america.json", "data/map-oceania.json", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
    return cached || fresh;
  }));
});
