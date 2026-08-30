// Service worker for the admin PWA.
//
// Deliberately minimal about caching: this is an authenticated admin app whose whole point is
// showing live state (who is online, how many minutes are left). A cached page would show
// yesterday's truth, and a cached *authenticated* page would linger on a shared phone. So HTML is
// not cached — with exactly one exception.
//
// The exception is /family-code. That page renders no server data at all: every code on it is
// computed by family-code.js, from a secret this browser holds only if the Admin trusted it
// (PRD §5.4). So caching it leaks nothing that was not already on the device, and it is the one page
// that must survive the server being unreachable — a blocked PC and a dead server arrive together.

// ASSETS is substituted by the server when it serves this file (src/assets.js): the shell list with
// a content hash on every URL, and a cache name derived from those hashes. It used to be a literal
// list and a hand-bumped 'digital-aid-shell-v6' — which meant a stylesheet change rendered stale once
// on every device, and stayed stale if anyone forgot the bump. A changed file is now a changed URL,
// so cache-first below is fresh-first without the human step.
const ASSETS = __ASSETS__;

const CACHE = `digital-aid-shell-${ASSETS.version}`;
const FAMILY_CODE = '/family-code';
const SHELL = ASSETS.shell;
// Versioned like the rest, so the offline fallback has to be looked up by the URL it was cached
// under rather than by its bare path.
const OFFLINE = ASSETS.offline;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Anything that changes state, or that must be fresh to be correct, goes straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/family-code/current') return;

  if (request.mode === 'navigate') {
    if (url.pathname === FAMILY_CODE) {
      // Network first so a redeployed page lands, but keep the last good copy — including the login
      // redirect case, which is not cached, so an expired session still ends up at the login screen
      // when the server is reachable.
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok && !response.redirected) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(FAMILY_CODE, copy));
            }
            return response;
          })
          .catch(() => caches.match(FAMILY_CODE).then((c) => c || caches.match(OFFLINE)))
      );
      return;
    }
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }

  if (url.pathname.startsWith('/public/')) {
    // Cache-first, but refresh in the background so a redeployed stylesheet lands next time.
    event.respondWith(
      caches.match(request).then((cached) => {
        const fresh = fetch(request)
          .then((response) => {
            // Clone before returning: once the browser starts streaming the body, a clone() an
            // async tick later throws "Response body is already used" (the /family-code branch
            // above has always done it this way).
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
  }
});

// --- Alerts (CONTEXT.md: Alert) ------------------------------------------------------------------
// The half of Web Push that has to live in a service worker, because the OS wakes *this* rather than
// a page — which is the entire point: an Alert reaches a phone with no tab open and the screen off.

self.addEventListener('push', (event) => {
  // A push with no body, or one this build cannot read, still has to produce a notification: every
  // push permission comes with a promise to show something, and browsers punish a broken promise by
  // showing a generic "this site was updated in the background" of their own.
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }

  const title = payload.title || 'Digital Aid';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    icon: '/public/icons/icon-192.png',
    badge: '/public/icons/icon-192.png',
    // The tag is what makes a later Alert *replace* an earlier one instead of stacking beneath it.
    // A Request that one parent has answered stops sitting on the other parent's lock screen
    // because the verdict arrives under the same tag (ADR-0013).
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    // Deliberately no actions: an Alert carries a fact and a destination, never a control. Approving
    // a Request from a lock screen would be deciding without the picture that decides it.
    data: { url: payload.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    // Reuse a window that is already open rather than piling up tabs — on an installed PWA there is
    // only ever one, and focusing it is what a person expects from tapping an app's notification.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
