/* ═══════════════════════════════════════════════════════
   MGD CleanOS — Service Worker v3.2
   Mustafa GÜNEŞDOĞDU / MGDizayn
   Nazilli Devlet Hastanesi Bilgi İşlem 2026
   ═══════════════════════════════════════════════════════

   STRATEJİ:
   - App kabuğu (index.html, fontlar): Cache-first
   - MQTT ve dış API'lar: Network-only (gerçek zamanlı)
   - Diğer kaynaklar: Network-first, cache fallback
   - Scope: sw.js'nin bulunduğu dizin (GitHub Pages subdirectory
     dahil otomatik algılanır — start_url ile eşleşir)
   ═══════════════════════════════════════════════════════ */

const CACHE_VERSION = 'mgd-cleanos-v3.2.2';

/* Uygulama kabuğu — her zaman önbelleklenir */
const SHELL_URLS = [
    './',
    './index.html',
    './manifest.json',
    './logo.png',
    './splash-logo.png'
];

/* Dış kaynaklar — uygulama kodu için önbellek */
const ASSET_URLS = [
    'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
    'https://unpkg.com/mqtt@5.0.3/dist/mqtt.min.js',
    'https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap'
];

/* Önbelleğe alınmayacak (gerçek zamanlı / WebSocket) */
const BYPASS_PATTERNS = [
    'broker.emqx.io',
    'mqtt',
    'wss://',
    'ws://'
];

/* ─── INSTALL ─── */
self.addEventListener('install', event => {
    console.log('[SW] Install:', CACHE_VERSION);

    event.waitUntil(
        caches.open(CACHE_VERSION).then(cache => {
            /* Shell'i önce ekle (kritik) */
            return cache.addAll(SHELL_URLS).then(() => {
                /* Dış kaynakları ayrıca dene — hata olursa install engelleme */
                return Promise.allSettled(
                    ASSET_URLS.map(url =>
                        fetch(url, { cache: 'no-cache' })
                            .then(res => { if (res.ok) cache.put(url, res); })
                            .catch(() => { /* sessizce geç */ })
                    )
                );
            });
        }).then(() => self.skipWaiting())
    );
});

/* ─── ACTIVATE ─── */
self.addEventListener('activate', event => {
    console.log('[SW] Activate:', CACHE_VERSION);

    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(k => k !== CACHE_VERSION)
                    .map(k => {
                        console.log('[SW] Eski cache siliniyor:', k);
                        return caches.delete(k);
                    })
            )
        ).then(() => self.clients.claim())
    );
});

/* ─── FETCH ─── */
self.addEventListener('fetch', event => {
    const url = event.request.url;

    /* MQTT / WebSocket isteklerini atla */
    if (BYPASS_PATTERNS.some(p => url.includes(p))) return;

    /* Sadece GET isteklerini yönet */
    if (event.request.method !== 'GET') return;

    /* App shell — Cache-first */
    if (isShellRequest(event.request)) {
        event.respondWith(cacheFirst(event.request));
        return;
    }

    /* Diğer her şey — Network-first */
    event.respondWith(networkFirst(event.request));
});

/* ─── STRATEJİLER ─── */

/** Cache-first: önbellekten sun, yoksa ağdan al ve kaydet */
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return offlineFallback(request);
    }
}

/** Network-first: ağdan al, hata olursa önbellekten sun */
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        const cached = await caches.match(request);
        return cached || offlineFallback(request);
    }
}

/** Offline durumunda app shell'i döndür (navigation istekleri için) */
async function offlineFallback(request) {
    if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
    }
    return new Response('Çevrimdışısınız. Lütfen bağlantınızı kontrol edin.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

/** App shell isteği mi? */
function isShellRequest(request) {
    const url = new URL(request.url);
    return (
        url.pathname.endsWith('/') ||
        url.pathname.endsWith('/index.html') ||
        url.pathname.endsWith('/manifest.json') ||
        url.pathname.endsWith('.png') ||
        SHELL_URLS.some(s => url.pathname.endsWith(new URL(s, self.location.href).pathname))
    );
}


/* ─── PUSH BİLDİRİM ─── */
self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch(e) {}

    // gorev_id önce payload'dan gelir, yoksa localStorage'dan al
    const gorevId     = data.gorev_id     || null;
    const personelId  = data.personel_id  || null;
    const backendUrl  = data.backend_url  || '';

    const title = data.title || '⏰ MGD CleanOS';
    const options = {
        body: data.body || 'Görev hatırlatması',
        icon: './icon-192.png',
        badge: './favicon-32.png',
        tag: data.tag || 'mgd-gorev',
        renotify: true,
        requireInteraction: true,
        data: {
            url:         data.url || './',
            gorev_id:    gorevId,
            personel_id: personelId,
            backend_url: backendUrl
        },
        actions: [
            { action: 'bitir',  title: '✅ Görevi Bitir' },
            { action: 'ertele', title: '⏰ 15 dk Sonra Hatırlat' }
        ]
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

/* ─── BİLDİRİM TIKLAMASI ─── */
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const d = event.notification.data || {};
    const backendUrl = d.backend_url || '';
    const gorevId = d.gorev_id;
    const personelId = d.personel_id;

    if (event.action === 'bitir' && backendUrl && gorevId) {
        // Görevi bitir API çağrısı
        event.waitUntil(
            fetch(`${backendUrl}/api/push/gorev-bitir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gorev_id: gorevId, personel_id: personelId })
            }).catch(() => {})
        );
    } else if (event.action === 'ertele' && backendUrl && personelId) {
        // 15 dk sonra tekrar hatırlat
        event.waitUntil(
            fetch(`${backendUrl}/api/push/ertele`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ personel_id: personelId, dakika: 15 })
            }).catch(() => {})
        );
    } else {
        // PWA'yı aç
        event.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
                for (const c of list) {
                    if (c.url.includes('index.html') || c.url.endsWith('/')) {
                        return c.focus();
                    }
                }
                return clients.openWindow(d.url || './');
            })
        );
    }
});
