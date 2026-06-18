const CACHE_NAME = "kalender-baustellen-v5";
const APP_SHELL = ["/manifest.webmanifest", "/icon.svg"];
const DEFAULT_NOTIFICATION_TITLE = "Kalender Baustellen";
const DEFAULT_NOTIFICATION_BODY = "Es gibt eine neue Aktualisierung.";
const DEFAULT_NOTIFICATION_URL = "/me/assignments";

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

self.addEventListener("push", (event) => {
  event.waitUntil(showPushNotification(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = getNotificationUrl(event.notification.data);
  event.waitUntil(openOrFocusClient(targetUrl));
});

async function showPushNotification(event) {
  try {
    const payload = parsePushPayload(event.data);
    const notification = payload.notification || {};
    const data = payload.data || {};
    const title = payload.title || notification.title || DEFAULT_NOTIFICATION_TITLE;
    const options = {
      body: payload.body || payload.message || notification.body || DEFAULT_NOTIFICATION_BODY,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: {
        url: payload.url || payload.targetUrl || data.url || data.targetUrl || DEFAULT_NOTIFICATION_URL,
        type: payload.type || data.type || null,
        site_id: payload.site_id || data.site_id || null,
        measurement_id: payload.measurement_id || data.measurement_id || null,
      },
    };
    await self.registration.showNotification(title, options);
  } catch (error) {
    console.warn("Push notification handling failed", error);
    await self.registration.showNotification(DEFAULT_NOTIFICATION_TITLE, {
      body: DEFAULT_NOTIFICATION_BODY,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: DEFAULT_NOTIFICATION_URL },
    });
  }
}

function parsePushPayload(data) {
  if (!data) {
    return {};
  }
  try {
    return data.json();
  } catch (_error) {
    return { body: data.text() };
  }
}

function getNotificationUrl(data) {
  if (!data || typeof data.url !== "string") {
    return DEFAULT_NOTIFICATION_URL;
  }
  return data.url.startsWith("/") ? data.url : DEFAULT_NOTIFICATION_URL;
}

async function openOrFocusClient(url) {
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const absoluteUrl = new URL(url, self.location.origin).href;
  for (const client of windowClients) {
    if ("focus" in client) {
      if (client.url === absoluteUrl || client.url.startsWith(self.location.origin)) {
        await client.focus();
        if ("navigate" in client) {
          await client.navigate(absoluteUrl);
        }
        return;
      }
    }
  }
  if (self.clients.openWindow) {
    await self.clients.openWindow(absoluteUrl);
  }
}
