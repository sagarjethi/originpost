const PUBLIC_CACHE_PREFIX = "originpost-public-shell-";
const PUBLIC_CACHE = `${PUBLIC_CACHE_PREFIX}v2`;
const LEGACY_CACHE_PREFIXES = ["originpost-shell-"];
const OFFLINE_PATH = "/offline.html";
const PUBLIC_SHELL_ASSETS = [
  OFFLINE_PATH,
  "/icons/originpost-180.png",
  "/icons/originpost-192.png",
  "/icons/originpost-512.png",
  "/icons/originpost-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(PUBLIC_CACHE).then((cache) => cache.addAll(PUBLIC_SHELL_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (
        (name.startsWith(PUBLIC_CACHE_PREFIX) && name !== PUBLIC_CACHE)
        || LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
      ))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === "/v1" || url.pathname.startsWith("/v1/") || url.pathname === "/public/v1" || url.pathname.startsWith("/public/v1/")) return;
  event.respondWith((async () => {
    try {
      return await fetch(request, { cache: "no-store" });
    } catch {
      const offline = await caches.match(OFFLINE_PATH, { cacheName: PUBLIC_CACHE, ignoreSearch: true });
      return offline ?? Response.error();
    }
  })());
});
