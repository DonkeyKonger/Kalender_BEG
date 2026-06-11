const CACHE_NAME = "kalender-baustellen-v4";
const APP_SHELL = ["/manifest.webmanifest", "/icon.svg"];

function isFreshnessCriticalAsset(request) {
  return ["script", "style", "manifest"].includes(request.destination);
}

function isCacheableAsset(request, response) {
  if (!response || !response.ok) {
    return false;
  }
  const contentType = response.headers.get("content-type") || "";
  if (request.destination === "style") {
    return contentType.includes("text/css");
  }
  if (request.destination === "script") {
    return contentType.includes("javascript") || contentType.includes("ecmascript");
  }
  if (request.destination === "manifest") {
    return contentType.includes("manifest") || contentType.includes("json");
  }
  if (request.destination === "image" || request.destination === "font") {
    return true;
  }
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request));
    return;
  }

  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (isFreshnessCriticalAsset(request)) {
      event.respondWith(
        fetch(request).then((response) => {
          if (isCacheableAsset(request, response)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }).catch(() => caches.match(request)),
      );
      return;
    }

    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
        if (isCacheableAsset(request, response)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })),
    );
  }
});
