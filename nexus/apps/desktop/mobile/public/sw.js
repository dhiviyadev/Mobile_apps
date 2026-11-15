// NEXUS phone app service worker: caches the app shell only.
// Never caches /api or /ws — your data always comes live from your Mac.
const CACHE = "nexus-shell-v2";
const SHELL = ["/m/", "/m/manifest.webmanifest", "/m/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/m/")) return;
  if (e.request.mode === "navigate") {
    // Network first so updates arrive immediately; fall back to the cached shell offline.
    e.respondWith(fetch(e.request).catch(() => caches.match("/m/")));
    return;
  }
  if (url.pathname.startsWith("/m/assets/")) {
    // Hashed, immutable assets: cache first.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })),
    );
  }
});

// Notifications from your Mac. The payload is encrypted end to end; only this phone can read it.
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "NEXUS", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || "NEXUS", {
      body: data.body || "",
      icon: "/m/icons/icon-192.png",
      badge: "/m/icons/icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/m/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/m/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).pathname.startsWith("/m/")) {
          w.navigate(url).catch(() => undefined);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
