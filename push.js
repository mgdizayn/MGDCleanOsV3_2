/* ═══════════════════════════════════════════════════════
   MGD CleanOS — Push Notification Manager
   Personel PWA için bildirim aboneliği
   ═══════════════════════════════════════════════════════ */

// VAPID Public Key - web_admin_server.py'deki ile aynı olmalı
// python -c "from py_vapid import Vapid; v=Vapid(); v.generate_keys(); print(v.public_key)"
const VAPID_PUBLIC_KEY = window.MGD_VAPID_PUBLIC_KEY || '';

/**
 * URL-safe base64 string'i Uint8Array'e çevir
 */
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/**
 * Push bildirim iznini iste ve abone ol
 * @param {string} personelId - Personel TC veya ID
 * @param {string} backendUrl - Web Admin URL (örn: http://192.168.1.100:8765)
 */
async function pushAboneOl(personelId, backendUrl) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('[Push] Bu tarayıcı push bildirimleri desteklemiyor.');
        return false;
    }

    if (!VAPID_PUBLIC_KEY) {
        console.warn('[Push] VAPID public key tanımlı değil.');
        return false;
    }

    try {
        // İzin iste
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.warn('[Push] Bildirim izni reddedildi.');
            return false;
        }

        // Service Worker'ı bekle
        const registration = await navigator.serviceWorker.ready;

        // Mevcut aboneliği kontrol et
        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
            // Yeni abonelik oluştur
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }

        // Backend'e kaydet
        const response = await fetch(`${backendUrl}/api/push/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                personel_id: personelId,
                subscription: subscription.toJSON()
            })
        });

        if (response.ok) {
            console.log('[Push] Abonelik başarıyla kaydedildi.');
            localStorage.setItem('mgd-push-subscribed', '1');
            localStorage.setItem('mgd-push-personel', personelId);
            return true;
        } else {
            console.error('[Push] Backend kayıt hatası:', response.status);
            return false;
        }

    } catch (err) {
        console.error('[Push] Abonelik hatası:', err);
        return false;
    }
}

/**
 * Push aboneliğini iptal et
 * @param {string} backendUrl
 */
async function pushAbonelikIptal(backendUrl) {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            const personelId = localStorage.getItem('mgd-push-personel');
            await fetch(`${backendUrl}/api/push/unsubscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    personel_id: personelId,
                    endpoint: subscription.endpoint
                })
            }).catch(() => {});
            await subscription.unsubscribe();
            localStorage.removeItem('mgd-push-subscribed');
            localStorage.removeItem('mgd-push-personel');
            console.log('[Push] Abonelik iptal edildi.');
        }
    } catch (err) {
        console.error('[Push] İptal hatası:', err);
    }
}

/**
 * Push bildirim durumunu kontrol et
 */
async function pushDurumKontrol() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return { destekleniyor: false, izin: 'unsupported', abone: false };
    }
    const izin = Notification.permission;
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    let abone = false;
    if (registration) {
        const sub = await registration.pushManager.getSubscription().catch(() => null);
        abone = !!sub;
    }
    return { destekleniyor: true, izin, abone };
}

// Global'e aktar
window.MGDPush = { pushAboneOl, pushAbonelikIptal, pushDurumKontrol };
