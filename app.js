/* ═══════════════════════════════════════════════════════
MGD CleanOS — Application Logic v3.3
Mustafa GÜNEŞDOĞDU / MGDizayn
Nazilli Devlet Hastanesi Bilgi İşlem 2026
═══════════════════════════════════════════════════════ */

(() => {
'use strict';

/* ═══════════════════════════════════════════════════════
   1) SABİTLER & KONFİGÜRASYON
═══════════════════════════════════════════════════════ */
const CONFIG = {
  BACKEND_URL: window.MGD_BACKEND_URL || 'http://192.168.1.100:8765',
  MQTT_BROKER: window.MGD_MQTT_BROKER || 'wss://broker.emqx.io:8084/mqtt',
  MQTT_TOPIC_PREFIX: 'mgd/cleanos',

  // SORUN #1 ÇÖZÜMÜ: QR Rate-limit
  QR_COOLDOWN_SUCCESS_MS: 1500,   // doğru QR sonrası bekleme
  QR_COOLDOWN_FAIL_MS:    3000,   // yanlış QR sonrası bekleme
  QR_REQUEST_TIMEOUT_MS:  8000,   // istek zaman aşımı
  QR_MIN_INTERVAL_MS:     800,    // aynı kod için minimum aralık

  // SORUN #3 ÇÖZÜMÜ: İşlem kilidi
  ISLEM_MIN_ARALIK_MS: 2000
};

/* ═══════════════════════════════════════════════════════
   2) UYGULAMA STATE
═══════════════════════════════════════════════════════ */
const State = {
  personelId: null,
  personelAd: null,
  birimId: null,
  birimAd: null,
  birimKod: null,
  birimOzel: false,
  talimatlar: [],
  aktifIslemBaslangic: null,
  timerInterval: null,
  mqttClient: null,
  mqttBagli: false,
  gonderilenMesajlar: new Set()
};

/* ═══════════════════════════════════════════════════════
   3) SORUN #2 ÇÖZÜMÜ — YEREL GÜN ANAHTARI (Europe/Istanbul)
═══════════════════════════════════════════════════════ */
function turkiyeBugunAnahtari(tarih = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(tarih);
}

function gunlukKey(prefix) {
  return `${prefix}__${turkiyeBugunAnahtari()}`;
}

function tcCacheOku() {
  return localStorage.getItem(gunlukKey('mgd-tc-cache'));
}
function tcCacheYaz(tc) {
  // Eski gün anahtarlarını temizle
  Object.keys(localStorage)
    .filter(k => k.startsWith('mgd-tc-cache__'))
    .forEach(k => localStorage.removeItem(k));
  localStorage.setItem(gunlukKey('mgd-tc-cache'), tc);
}

function talimatOnaylandiMi(birimId) {
  return localStorage.getItem(gunlukKey(`mgd-talimat-${birimId}`)) === '1';
}
function talimatOnayla(birimId) {
  localStorage.setItem(gunlukKey(`mgd-talimat-${birimId}`), '1');
}

/* ═══════════════════════════════════════════════════════
   4) AYARLAR YÖNETİCİSİ (ÖZELLİK #2)
═══════════════════════════════════════════════════════ */
const Ayarlar = {
  get sesAcik()      { return localStorage.getItem('mgd-ayar-ses') !== '0'; },
  get titresimAcik() { return localStorage.getItem('mgd-ayar-titresim') !== '0'; },
  get onayGerekli()  { return localStorage.getItem('mgd-ayar-onay-bitir') !== '0'; },
  set ses(v)         { localStorage.setItem('mgd-ayar-ses', v ? '1' : '0'); },
  set titresim(v)    { localStorage.setItem('mgd-ayar-titresim', v ? '1' : '0'); },
  set onayGerekli(v) { localStorage.setItem('mgd-ayar-onay-bitir', v ? '1' : '0'); }
};

/* ═══════════════════════════════════════════════════════
   5) SORUN #1 ÇÖZÜMÜ — QR YÖNETİCİSİ (rate-limit + in-flight lock)
═══════════════════════════════════════════════════════ */
const QRState = {
  isProcessing: false,
  lastScanAt: 0,
  cooldownUntil: 0,
  lastCode: null,
  abortController: null
};

let qrScanner = null;
let qrScannerSecurity = null;

async function birimDetaySorgula(qrKod, target = 'main') {
  const now = Date.now();

  // 1) Cooldown kontrolü
  if (now < QRState.cooldownUntil) {
    const kalan = Math.ceil((QRState.cooldownUntil - now) / 1000);
    qrGeriSayimGoster(kalan, target);
    return { durum: 'cooldown', kalan };
  }

  // 2) Aynı kodu kısa sürede tekrar okumayı engelle
  if (qrKod === QRState.lastCode && (now - QRState.lastScanAt) < CONFIG.QR_MIN_INTERVAL_MS) {
    return { durum: 'duplicate' };
  }

  // 3) In-flight lock
  if (QRState.isProcessing) {
    return { durum: 'busy' };
  }

  // 4) Önceki isteği iptal et
  if (QRState.abortController) QRState.abortController.abort();
  QRState.abortController = new AbortController();

  QRState.isProcessing = true;
  QRState.lastCode = qrKod;
  QRState.lastScanAt = now;

  // Scanner'ı durdur
  const scanner = target === 'security' ? qrScannerSecurity : qrScanner;
  if (scanner) {
    try { await scanner.pause(true); } catch {}
  }

  try {
    // Timeout koruması
    const timeoutId = setTimeout(() => QRState.abortController.abort(), CONFIG.QR_REQUEST_TIMEOUT_MS);

    const res = await fetch(`${CONFIG.BACKEND_URL}/api/birim-detay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qr_kod: qrKod }),
      signal: QRState.abortController.signal
    });

    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.hatali) {
      // YANLIŞ QR — uzun cooldown
      QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_FAIL_MS;
      uiHataGoster(data.mesaj || 'Geçersiz birim QR kodu');
      qrGeriSayimBaslat(CONFIG.QR_COOLDOWN_FAIL_MS, target);
      geriBildirimVer('hata');
      return { durum: 'fail', data };
    }

    // DOĞRU QR — kısa cooldown
    QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_SUCCESS_MS;
    geriBildirimVer('basari');
    return { durum: 'ok', data };

  } catch (err) {
    if (err.name === 'AbortError') {
      uiHataGoster('İstek zaman aşımına uğradı.');
      return { durum: 'timeout' };
    }
    QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_FAIL_MS;
    uiHataGoster('Bağlantı hatası. Tekrar deneyin.');
    qrGeriSayimBaslat(CONFIG.QR_COOLDOWN_FAIL_MS, target);
    return { durum: 'error', err };
  } finally {
    QRState.isProcessing = false;
    // Cooldown bitince scanner'ı tekrar aç
    const waitMs = Math.max(0, QRState.cooldownUntil - Date.now());
    setTimeout(() => {
      if (!QRState.isProcessing && scanner) {
        try { scanner.resume(); } catch {}
      }
    }, waitMs);
  }
}

function qrGeriSayimGoster(saniye, target = 'main') {
  const el = document.getElementById(target === 'security' ? 'qr-countdown-security' : 'qr-countdown');
  if (!el) return;
  el.textContent = `${saniye} saniye sonra tekrar deneyin...`;
  el.classList.add('active');
}

function qrGeriSayimBaslat(ms, target = 'main') {
  const el = document.getElementById(target === 'security' ? 'qr-countdown-security' : 'qr-countdown');
  if (!el) return;
  const start = Date.now();
  const end = Date.now() + ms;

  const tick = () => {
    const kalan = Math.max(0, end - Date.now());
    if (kalan <= 0) {
      el.textContent = 'Tekrar tarayabilirsiniz';
      setTimeout(() => el.classList.remove('active'), 1500);
      return;
    }
    el.textContent = `${Math.ceil(kalan / 1000)} saniye sonra tekrar deneyin...`;
    el.classList.add('active');
    requestAnimationFrame(tick);
  };
  tick();
}

/* ═══════════════════════════════════════════════════════
   6) SORUN #3 ÇÖZÜMÜ — İŞLEM KİLİDİ (çift dokunuş engelleme)
═══════════════════════════════════════════════════════ */
const IslemKilit = {
  aktif: false,
  sonIslem: null,
  sonZaman: 0
};

async function guvenliIslem(islemAdi, fn) {
  const now = Date.now();

  if (IslemKilit.aktif) {
    console.warn(`[Islem] ${islemAdi} engellendi — başka işlem devam ediyor`);
    return { durum: 'locked' };
  }

  if (IslemKilit.sonIslem === islemAdi && (now - IslemKilit.sonZaman) < CONFIG.ISLEM_MIN_ARALIK_MS) {
    return { durum: 'duplicate' };
  }

  IslemKilit.aktif = true;
  IslemKilit.sonIslem = islemAdi;
  IslemKilit.sonZaman = now;
  uiButonKilitle(islemAdi, true);

  try {
    const sonuc = await fn();
    return { durum: 'ok', sonuc };
  } catch (err) {
    console.error(`[Islem] ${islemAdi} hata:`, err);
    return { durum: 'error', err };
  } finally {
    IslemKilit.aktif = false;
    uiButonKilitle(islemAdi, false);
  }
}

function uiButonKilitle(islem, kilitli) {
  const btn = document.querySelector(`[data-islem="${islem}"]`);
  if (!btn) return;
  btn.disabled = kilitli;
  btn.classList.toggle('loading', kilitli);
  btn.setAttribute('aria-busy', kilitli ? 'true' : 'false');
}

/* ═══════════════════════════════════════════════════════
   7) ONAY DIALOG (ÖZELLİK #2)
═══════════════════════════════════════════════════════ */
function onaySor(baslik, mesaj, { onayMetni = 'Evet', iptalMetni = 'İptal' } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <h3>${baslik}</h3>
        <p>${mesaj}</p>
        <div class="confirm-actions">
          <button class="btn-cancel" data-act="cancel">${iptalMetni}</button>
          <button class="btn-confirm" data-act="confirm">${onayMetni}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (deger) => {
      overlay.remove();
      resolve(deger);
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });
    overlay.querySelector('[data-act="cancel"]').onclick = () => cleanup(false);
    overlay.querySelector('[data-act="confirm"]').onclick = () => cleanup(true);

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup(false);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

/* ═══════════════════════════════════════════════════════
   8) GERİ BİLDİRİM — ses + titreşim (ÖZELLİK #2)
═══════════════════════════════════════════════════════ */
async function geriBildirimVer(tip) {
  const config = {
    basari: { titresim: [100, 50, 100] },
    hata:   { titresim: [300, 100, 300, 100, 300] },
    uyari:  { titresim: [200] },
    info:   { titresim: [50] }
  }[tip] || { titresim: [50] };

  if (Ayarlar.titresimAcik && 'vibrate' in navigator) {
    try { navigator.vibrate(config.titresim); } catch {}
  }
}

/* ═══════════════════════════════════════════════════════
   9) MQTT YÖNETİMİ
═══════════════════════════════════════════════════════ */
async function mqttBaglan() {
  if (typeof mqtt === 'undefined') {
    console.warn('[MQTT] mqtt kütüphanesi yüklenemedi');
    return;
  }

  try {
    State.mqttClient = mqtt.connect(CONFIG.MQTT_BROKER, {
      clientId: `mgd_${State.personelId}_${Date.now()}`,
      clean: true,
      connectTimeout: 5000,
      reconnectPeriod: 3000
    });

    State.mqttClient.on('connect', () => {
      State.mqttBagli = true;
      uiDurumGuncelle('connected', '🟢 Bağlı');
      console.log('[MQTT] Bağlandı');
    });

    State.mqttClient.on('offline', () => {
      State.mqttBagli = false;
      uiDurumGuncelle('connecting', '🟡 Yeniden bağlanıyor');
    });

    State.mqttClient.on('error', (err) => {
      console.error('[MQTT] Hata:', err);
      uiDurumGuncelle('error', '🔴 Bağlantı hatası');
    });

    State.mqttClient.on('close', () => {
      State.mqttBagli = false;
      uiDurumGuncelle('connecting', '🟡 Bağlantı kesildi');
    });
  } catch (err) {
    console.error('[MQTT] Bağlantı hatası:', err);
    uiDurumGuncelle('error', '🔴 MQTT hatası');
  }
}

async function mqttPublish(action, payload) {
  if (!State.mqttClient || !State.mqttBagli) {
    throw new Error('MQTT bağlı değil');
  }
  const topic = `${CONFIG.MQTT_TOPIC_PREFIX}/${action.toLowerCase()}`;
  const msgId = `${State.personelId}_${State.birimId}_${Date.now()}`;

  // Dup koruması
  if (State.gonderilenMesajlar.has(msgId)) {
    throw new Error('duplicate');
  }
  State.gonderilenMesajlar.add(msgId);
  // 10 saniye sonra temizle
  setTimeout(() => State.gonderilenMesajlar.delete(msgId), 10000);

  return new Promise((resolve, reject) => {
    State.mqttClient.publish(topic, JSON.stringify({
      ...payload,
      msg_id: msgId,
      timestamp: Date.now()
    }), { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve(msgId);
    });
  });
}

/* ═══════════════════════════════════════════════════════
   10) İŞ AKIŞI FONKSİYONLARI
═══════════════════════════════════════════════════════ */
async function girisYap(tc) {
  if (!/^\d{11}$/.test(tc)) {
    uiHataGoster('TC kimlik numarası 11 haneli olmalıdır.');
    return;
  }

  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/giris`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tc })
    });
    const data = await res.json();

    if (!res.ok || data.hatali) {
      uiHataGoster(data.mesaj || 'Giriş başarısız');
      return;
    }

    State.personelId = tc;
    State.personelAd = data.ad || '';
    tcCacheYaz(tc);

    await mqttBaglan();
    ekranGoster('screen-unit-select');
    qrScannerBaslat('main');
  } catch (err) {
    uiHataGoster('Bağlantı hatası. Sunucuya ulaşılamıyor.');
  }
}

async function qrOkunduHandler(qrKod, target = 'main') {
  const sonuc = await birimDetaySorgula(qrKod, target);

  if (sonuc.durum === 'ok') {
    const data = sonuc.data;
    State.birimId = data.birim_id;
    State.birimAd = data.birim_ad;
    State.birimKod = data.birim_kod;
    State.birimOzel = !!data.ozel_birim;
    State.talimatlar = data.talimatlar || [];

    if (target === 'security') {
      // Güvenlik doğrulama başarılı
      modalKapat('modal-security');
      qrScannerDurdur('security');
      islemBaslat();
    } else {
      // Normal birim seçimi
      qrScannerDurdur('main');
      birimBilgiGoster();
      ekranGoster('screen-unit-info');
    }
  }
}

function birimBilgiGoster() {
  document.getElementById('unit-name').textContent = `🏢 ${State.birimAd}`;
  document.getElementById('unit-code').textContent = `Kod: ${State.birimKod}`;
  document.getElementById('talimat-sayisi').textContent = State.talimatlar.length;

  const unitCard = document.getElementById('unit-card');
  const warning = document.getElementById('unit-warning');
  const confirmedBadge = document.getElementById('talimat-confirmed-badge');
  const talimatSection = document.getElementById('talimat-confirm-section');

  if (State.birimOzel) {
    unitCard.classList.add('warning');
    warning.classList.remove('hidden');
    if (talimatOnaylandiMi(State.birimId)) {
      confirmedBadge.classList.remove('hidden');
      talimatSection.classList.add('hidden');
    } else {
      confirmedBadge.classList.add('hidden');
      talimatSection.classList.remove('hidden');
    }
  } else {
    unitCard.classList.remove('warning');
    warning.classList.add('hidden');
    confirmedBadge.classList.add('hidden');
    talimatSection.classList.add('hidden');
  }
}

async function islemBaslat() {
  const sonuc = await guvenliIslem('START', async () => {
    await mqttPublish('START', {
      personel_id: State.personelId,
      birim_id: State.birimId
    });

    // Backend'e de kaydet
    await fetch(`${CONFIG.BACKEND_URL}/api/islem/baslat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personel_id: State.personelId,
        birim_id: State.birimId
      })
    }).catch(() => {});

    return true;
  });

  if (sonuc.durum === 'ok') {
    State.aktifIslemBaslangic = Date.now();
    localStorage.setItem(gunlukKey(`mgd-aktif-islem-${State.birimId}`), JSON.stringify({
      baslangic: State.aktifIslemBaslangic,
      birim_id: State.birimId
    }));
    timerBaslat();
    ekranGoster('screen-active');
    document.getElementById('active-unit-name').textContent = State.birimAd;
  } else if (sonuc.durum === 'locked') {
    uiToast('İşlem devam ediyor, lütfen bekleyin...', 'error');
  } else if (sonuc.durum === 'error') {
    uiHataGoster('İşlem başlatılamadı. Tekrar deneyin.');
  }
}

async function executeEnd() {
  const sonuc = await guvenliIslem('END', async () => {
    await mqttPublish('END', {
      personel_id: State.personelId,
      birim_id: State.birimId
    });

    await fetch(`${CONFIG.BACKEND_URL}/api/islem/bitir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personel_id: State.personelId,
        birim_id: State.birimId
      })
    }).catch(() => {});

    return true;
  });

  if (sonuc.durum === 'ok') {
    geriBildirimVer('basari');
    uiToast('Görev başarıyla tamamlandı ✅', 'success');
    timerDurdur();
    localStorage.removeItem(gunlukKey(`mgd-aktif-islem-${State.birimId}`));
    State.birimId = null;
    State.birimAd = null;
    State.birimKod = null;
    ekranGoster('screen-unit-select');
    qrScannerBaslat('main');
  } else if (sonuc.durum === 'locked') {
    uiToast('İşlem devam ediyor, lütfen bekleyin...', 'error');
  }
}

async function executeEndWithConfirm() {
  if (Ayarlar.onayGerekli) {
    const onay = await onaySor(
      '🛑 Görevi Bitir',
      `${State.birimAd} birimindeki temizlik görevini bitirmek üzeresiniz. Emin misiniz?`,
      { onayMetni: '✅ Evet, Bitir', iptalMetni: 'İptal' }
    );
    if (!onay) {
      uiToast('İşlem iptal edildi.');
      return;
    }
  }
  await executeEnd();
}

/* ═══════════════════════════════════════════════════════
   11) QR SCANNER YÖNETİMİ
═══════════════════════════════════════════════════════ */
async function qrScannerBaslat(target = 'main') {
  const elementId = target === 'security' ? 'qr-reader-security' : 'qr-reader';
  const el = document.getElementById(elementId);
  if (!el) return;

  try {
    const scanner = new Html5Qrcode(elementId);
    if (target === 'security') qrScannerSecurity = scanner;
    else qrScanner = scanner;

    await scanner.start(
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        qrOkunduHandler(decodedText, target);
      },
      (errorMessage) => {
        // Sessizce geç — her frame'de hata veriyor
      }
    );
  } catch (err) {
    console.error(`[QR] Scanner başlatılamadı (${target}):`, err);
    uiHataGoster('Kamera erişimi sağlanamadı.');
  }
}

async function qrScannerDurdur(target = 'main') {
  const scanner = target === 'security' ? qrScannerSecurity : qrScanner;
  if (scanner) {
    try {
      const state = scanner.getState();
      if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) {
        await scanner.stop();
      }
    } catch (err) {
      console.warn(`[QR] Scanner durdurulurken hata (${target}):`, err);
    }
    if (target === 'security') qrScannerSecurity = null;
    else qrScanner = null;
  }
}

/* ═══════════════════════════════════════════════════════
   12) TIMER
═══════════════════════════════════════════════════════ */
function timerBaslat() {
  timerDurdur();
  const timerEl = document.getElementById('active-timer');
  State.timerInterval = setInterval(() => {
    if (!State.aktifIslemBaslangic) return;
    const elapsed = Math.floor((Date.now() - State.aktifIslemBaslangic) / 1000);
    const dk = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const sn = (elapsed % 60).toString().padStart(2, '0');
    timerEl.textContent = `${dk}:${sn}`;
  }, 1000);
}

function timerDurdur() {
  if (State.timerInterval) {
    clearInterval(State.timerInterval);
    State.timerInterval = null;
  }
  document.getElementById('active-timer').textContent = '00:00';
}

/* ═══════════════════════════════════════════════════════
   13) UI YARDIMCI FONKSİYONLAR
═══════════════════════════════════════════════════════ */
function ekranGoster(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

function uiDurumGuncelle(durum, metin) {
  const pill = document.getElementById('status-pill');
  const text = document.getElementById('status-text');
  pill.className = 'status-pill ' + durum;
  text.textContent = metin;
}

function uiHataGoster(mesaj) {
  uiToast(mesaj, 'error');
}

function uiToast(mesaj, tip = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = mesaj;
  toast.className = 'toast show ' + tip;
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function modalAc(modalId) {
  document.getElementById(modalId).classList.add('active');
}
function modalKapat(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

function talimatListesiGoster() {
  document.getElementById('modal-talimat-unit').textContent = State.birimAd;
  const list = document.getElementById('talimat-list');
  if (State.talimatlar.length === 0) {
    list.innerHTML = '<div style="text-align:center; color: var(--text-dim); padding: 20px;">Talimat bulunmuyor</div>';
  } else {
    list.innerHTML = State.talimatlar.map((t, i) => `
      <div class="talimat-item">
        <div class="num">${i + 1}</div>
        <div>${t}</div>
      </div>
    `).join('');
  }
  modalAc('modal-talimat');
}

async function cikisYap() {
  if (State.aktifIslemBaslangic) {
    const onay = await onaySor(
      'Çıkış Yap',
      'Aktif bir işleminiz var. Çıkmak istediğinize emin misiniz?',
      { onayMetni: 'Evet, Çık', iptalMetni: 'İptal' }
    );
    if (!onay) return;
  }

  if (State.mqttClient) {
    try { State.mqttClient.end(); } catch {}
  }
  qrScannerDurdur('main');
  qrScannerDurdur('security');
  timerDurdur();

  State.personelId = null;
  State.personelAd = null;
  State.birimId = null;
  State.aktifIslemBaslangic = null;

  ekranGoster('screen-login');
}

/* ═══════════════════════════════════════════════════════
   14) AYARLAR PANELİ
═══════════════════════════════════════════════════════ */
function ayarlarPaneliniBaslat() {
  const sesEl = document.getElementById('sett-ses');
  const titresimEl = document.getElementById('sett-titresim');
  const onayEl = document.getElementById('sett-onay-bitir');

  sesEl.checked = Ayarlar.sesAcik;
  titresimEl.checked = Ayarlar.titresimAcik;
  onayEl.checked = Ayarlar.onayGerekli;

  sesEl.onchange = e => Ayarlar.ses = e.target.checked;
  titresimEl.onchange = e => Ayarlar.titresim = e.target.checked;
  onayEl.onchange = e => Ayarlar.onayGerekli = e.target.checked;
}

/* ═══════════════════════════════════════════════════════
   15) EVENT LİSTENER'LAR
═══════════════════════════════════════════════════════ */
function eventListenerlariBaslat() {
  // Splash → Login
  document.getElementById('screen-splash').addEventListener('click', () => {
    const cached = tcCacheOku();
    if (cached) {
      document.getElementById('input-tc').value = cached;
    }
    ekranGoster('screen-login');
  });

  // Giriş
  document.getElementById('btn-login').addEventListener('click', () => {
    const tc = document.getElementById('input-tc').value.trim();
    girisYap(tc);
  });
  document.getElementById('input-tc').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const tc = e.target.value.trim();
      girisYap(tc);
    }
  });

  // Çıkış butonları
  document.getElementById('btn-logout-1').addEventListener('click', cikisYap);
  document.getElementById('btn-logout-2').addEventListener('click', cikisYap);

  // Birim bilgisi ekranı
  document.getElementById('btn-view-talimat').addEventListener('click', talimatListesiGoster);
  document.getElementById('btn-close-talimat').addEventListener('click', () => modalKapat('modal-talimat'));
  document.getElementById('btn-confirm-talimat').addEventListener('click', () => {
    talimatOnayla(State.birimId);
    birimBilgiGoster();
    modalKapat('modal-talimat');
    uiToast('Talimatlar onaylandı ✅', 'success');
    geriBildirimVer('basari');
  });

  document.getElementById('btn-back-select').addEventListener('click', () => {
    ekranGoster('screen-unit-select');
    qrScannerBaslat('main');
  });

  // Başla — özel birimse talimat onayı kontrol et
  document.getElementById('btn-start-work').addEventListener('click', () => {
    if (State.birimOzel && !talimatOnaylandiMi(State.birimId)) {
      uiHataGoster('Özel birim için talimatları okuyup onaylamanız gerekiyor.');
      return;
    }
    // Güvenlik doğrulaması — birimi tekrar okut
    document.getElementById('security-expected-name').textContent = State.birimAd;
    document.getElementById('security-expected-code').textContent = `Kod: ${State.birimKod}`;
    modalAc('modal-security');
    qrScannerBaslat('security');
  });

  // Bitir — onay ile
  document.getElementById('btn-end-work').addEventListener('click', executeEndWithConfirm);

  // Güvenlik doğrulama iptal
  document.getElementById('btn-cancel-security').addEventListener('click', () => {
    modalKapat('modal-security');
    qrScannerDurdur('security');
  });

  // Ayarlar
  document.getElementById('btn-back-from-settings').addEventListener('click', () => {
    ekranGoster(State.personelId ? 'screen-unit-select' : 'screen-login');
  });
}

/* ═══════════════════════════════════════════════════════
   16) SERVICE WORKER KAYDI
═══════════════════════════════════════════════════════ */
async function swKaydet() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      console.log('[SW] Kaydedildi');
    } catch (err) {
      console.error('[SW] Kayıt hatası:', err);
    }
  }
}

/* ═══════════════════════════════════════════════════════
   17) BAŞLANGIÇ
═══════════════════════════════════════════════════════ */
async function baslat() {
  await swKaydet();
  eventListenerlariBaslat();
  ayarlarPaneliniBaslat();

  // Önceki aktif işlemi geri yükle
  const aktifKeys = Object.keys(localStorage).filter(k => k.startsWith('mgd-aktif-islem__'));
  if (aktifKeys.length > 0) {
    try {
      const data = JSON.parse(localStorage.getItem(aktifKeys[0]));
      if (data && data.baslangic) {
        // Personel ve birim bilgisi backend'den alınabilir
        // Şimdilik basit tutuyoruz
        console.log('[Init] Aktif işlem bulundu:', data);
      }
    } catch {}
  }
}

// DOM hazır olunca başlat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', baslat);
} else {
  baslat();
}

})();