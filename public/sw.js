/* TrendHub 서비스워커 — 앱 셸은 캐시 우선, API는 네트워크 우선(오프라인 시 마지막 데이터) */
const CACHE = 'trendhub-v4';
const SHELL = ['/', '/app.css', '/app.js', '/xray.css', '/xray.js', '/xray3d.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api/stream') return; // SSE는 건드리지 않음

  if (url.pathname.startsWith('/api/')) {
    // 네트워크 우선, 실패 시 캐시된 마지막 응답
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
  } else {
    // 앱 셸: 캐시 우선, 백그라운드 갱신
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fresh = fetch(e.request)
          .then((res) => {
            caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      }),
    );
  }
});
