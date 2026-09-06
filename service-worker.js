const PREFIX = "sameslate-shell-";
const CACHE = "sameslate-shell-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=5",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/app-icon-192.png",
  "./assets/app-icon-512.png",
  "./assets/apple-touch-icon.png",
  "./assets/favicon-48.png",
  "./assets/gameshow-stage.webp",
  "./assets/social-share.jpg",
  "./src/app.js?v=4",
  "./src/config.js",
  "./src/core.js",
  "./src/data/question-bank.js",
  "./src/services/effects.js?v=2",
  "./src/services/firebase-service.js?v=2",
  "./src/services/live-suggestions.js",
  "./src/services/suggestion-quality.js",
  "./src/services/live-ui.js",
  "./src/services/messages.js?v=2",
  "./src/services/message-identity.js",
  "./src/services/storage.js",
  "./src/slate-core.js",
  "./src/data/cards.js"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy=response.clone(); event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === "navigate" ? await caches.match("./index.html") : Response.error())));
});
