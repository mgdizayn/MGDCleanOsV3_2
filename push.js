/* ══════════════════════════════════════════════════════
MGD CleanOS — Push Notification Manager
═══════════════════════════════════════════════════════ */
const VAPID_PUBLIC_KEY = window.MGD_VAPID_PUBLIC_KEY || '';

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
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('[Push] Bildirim izni reddedildi.');
      return false;
    }
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
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

window.MGDPush = { pushAboneOl, pushAbonelikIptal, pushDurumKontrol };