/* ═══════════════════════════════════════════════════════
MGD CleanOS — Application Logic v3.3 (SADECE MQTT)
Mustafa GÜNEŞDOĞDU / MGDizayn
Nazilli Devlet Hastanesi Bilgi İşlem 2026
═══════════════════════════════════════════════════════ */
(() => {
'use strict';

const CONFIG = {
  MQTT_BROKER: window.MGD_MQTT_BROKER || 'wss://broker.hivemq.com:8884/mqtt',
  MQTT_TOPIC_PREFIX: 'mgd/cleanos',
  QR_COOLDOWN_SUCCESS_MS: 1500,
  QR_COOLDOWN_FAIL_MS: 3000,
  QR_MIN_INTERVAL_MS: 800,
  ISLEM_MIN_ARALIK_MS: 2000,
  GIRIS_TIMEOUT_MS: 5000,
  MQTT_BAGLANTI_TIMEOUT_MS: 4000
};

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
  mqttBagli: false
};

function turkiyeBugunAnahtari(tarih = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(tarih);
}

function gunlukKey(prefix) { return `${prefix}__${turkiyeBugunAnahtari()}`; }
function tcCacheOku() { return localStorage.getItem(gunlukKey('mgd-tc-cache')); }
function tcCacheYaz(tc) {
  Object.keys(localStorage).filter(k => k.startsWith('mgd-tc-cache__')).forEach(k => localStorage.removeItem(k));
  localStorage.setItem(gunlukKey('mgd-tc-cache'), tc);
}
function talimatOnaylandiMi(birimId) { return localStorage.getItem(gunlukKey(`mgd-talimat-${birimId}`)) === '1'; }
function talimatOnayla(birimId) { localStorage.setItem(gunlukKey(`mgd-talimat-${birimId}`), '1'); }

const Ayarlar = {
  get sesAcik() { return localStorage.getItem('mgd-ayar-ses') !== '0'; },
  get titresimAcik() { return localStorage.getItem('mgd-ayar-titresim') !== '0'; },
  get onayGerekli() { return localStorage.getItem('mgd-ayar-onay-bitir') !== '0'; }
};

async function geriBildirimVer(tip) {
  const config = {
    basari: { titresim: [100, 50, 100] },
    hata: { titresim: [300, 100, 300, 100, 300] },
    uyari: { titresim: [200] },
    info: { titresim: [50] }
  }[tip] || { titresim: [50] };
  if (Ayarlar.titresimAcik && 'vibrate' in navigator) {
    try { navigator.vibrate(config.titresim); } catch {}
  }
}

function onaySor(baslik, mesaj, { onayMetni = 'Evet', iptalMetni = 'İptal' } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <h3>${baslik}</h3><p>${mesaj}</p>
        <div class="confirm-actions">
          <button class="btn-cancel" data-act="cancel">${iptalMetni}</button>
          <button class="btn-confirm" data-act="confirm">${onayMetni}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (deger) => { overlay.remove(); resolve(deger); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector('[data-act="cancel"]').onclick = () => cleanup(false);
    overlay.querySelector('[data-act="confirm"]').onclick = () => cleanup(true);
    const escHandler = (e) => { if (e.key === 'Escape') { cleanup(false); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
  });
}

const QRState = { isProcessing: false, lastScanAt: 0, cooldownUntil: 0, lastCode: null };
let qrScanner = null;
let qrScannerSecurity = null;

async function birimDetaySorgula(qrKod, target = 'main') {
  const now = Date.now();
  if (now < QRState.cooldownUntil) {
    qrGeriSayimGoster(Math.ceil((QRState.cooldownUntil - now) / 1000), target);
    return { durum: 'cooldown' };
  }
  if (qrKod === QRState.lastCode && (now - QRState.lastScanAt) < CONFIG.QR_MIN_INTERVAL_MS) return { durum: 'duplicate' };
  if (QRState.isProcessing) return { durum: 'busy' };

  QRState.isProcessing = true;
  QRState.lastCode = qrKod;
  QRState.lastScanAt = now;

  const scanner = target === 'security' ? qrScannerSecurity : qrScanner;
  if (scanner) { try { await scanner.pause(true); } catch {} }

  State.mqttClient.publish(`${CONFIG.MQTT_TOPIC_PREFIX}/birim-detay`, JSON.stringify({
    qr_kod: qrKod,
    tc: State.personelId,
    req_id: `req_${now}`
  }), { qos: 1 });
}

function qrGeriSayimGoster(saniye, target = 'main') {
  const el = document.getElementById(target === 'security' ? 'qr-countdown-security' : 'qr-countdown');
  if (el) { el.textContent = `${saniye} saniye sonra tekrar deneyin...`; el.classList.add('active'); }
}

function qrGeriSayimBaslat(ms, target = 'main') {
  const el = document.getElementById(target === 'security' ? 'qr-countdown-security' : 'qr-countdown');
  if (!el) return;
  const end = Date.now() + ms;
  const tick = () => {
    const kalan = Math.max(0, end - Date.now());
    if (kalan <= 0) { el.textContent = 'Tekrar tarayabilirsiniz'; setTimeout(() => el.classList.remove('active'), 1500); return; }
    el.textContent = `${Math.ceil(kalan / 1000)} saniye sonra tekrar deneyin...`;
    el.classList.add('active');
    requestAnimationFrame(tick);
  };
  tick();
}

const IslemKilit = { aktif: false, sonIslem: null, sonZaman: 0 };

async function guvenliIslem(islemAdi, mqttPayload) {
  const now = Date.now();
  if (IslemKilit.aktif) return { durum: 'locked' };
  if (IslemKilit.sonIslem === islemAdi && (now - IslemKilit.sonZaman) < CONFIG.ISLEM_MIN_ARALIK_MS) return { durum: 'duplicate' };

  IslemKilit.aktif = true;
  IslemKilit.sonIslem = islemAdi;
  IslemKilit.sonZaman = now;
  uiButonKilitle(islemAdi, true);

  try {
    State.mqttClient.publish(`${CONFIG.MQTT_TOPIC_PREFIX}/islem`, JSON.stringify({
      islem: islemAdi,
      personel_id: State.personelId,
      birim_id: State.birimId,
      ...mqttPayload
    }), { qos: 1 });
    return { durum: 'ok' };
  } catch (err) {
    return { durum: 'error', err };
  } finally {
    IslemKilit.aktif = false;
    uiButonKilitle(islemAdi, false);
  }
}

function uiButonKilitle(islem, kilitli) {
  const btn = document.querySelector(`[data-islem="${islem}"]`);
  if (btn) {
    btn.disabled = kilitli;
    btn.classList.toggle('loading', kilitli);
    btn.setAttribute('aria-busy', kilitli ? 'true' : 'false');
  }
}

async function mqttBaglan() {
  if (typeof mqtt === 'undefined') return;
  try {
    State.mqttClient = mqtt.connect(CONFIG.MQTT_BROKER, {
      clientId: `mgd_${State.personelId || 'anon'}_${Date.now()}`,
      clean: true, connectTimeout: 5000, reconnectPeriod: 3000
    });

    State.mqttClient.on('connect', () => {
      State.mqttBagli = true;
      uiDurumGuncelle('connected', '🟢 Bağlı');
      State.mqttClient.subscribe(`${CONFIG.MQTT_TOPIC_PREFIX}/giris/cevap`);
      State.mqttClient.subscribe(`${CONFIG.MQTT_TOPIC_PREFIX}/birim-detay/cevap`);
      State.mqttClient.subscribe(`${CONFIG.MQTT_TOPIC_PREFIX}/islem/cevap`);
    });

    State.mqttClient.on('message', (topic, message) => {
      try { handleMqttMessage(topic, JSON.parse(message.toString())); } 
      catch (e) { console.error('[MQTT] Parse hatası:', e); }
    });

    State.mqttClient.on('offline', () => { State.mqttBagli = false; uiDurumGuncelle('connecting', '🟡 Yeniden bağlanıyor'); });
    State.mqttClient.on('error', (err) => { console.error('[MQTT] Hata:', err); uiDurumGuncelle('error', '🔴 Bağlantı hatası'); });
  } catch (err) {
    console.error('[MQTT] Bağlantı hatası:', err);
    uiDurumGuncelle('error', '🔴 MQTT hatası');
  }
}

function handleMqttMessage(topic, data) {
  if (topic === `${CONFIG.MQTT_TOPIC_PREFIX}/giris/cevap`) {
    if (data.tc === State.personelId) {
      uiButonKilitle('GIRIS', false);
      if (data.hatali) {
        uiHataGoster(data.mesaj || 'Giriş başarısız');
      } else {
        State.personelAd = data.ad || '';
        tcCacheYaz(State.personelId);
        ekranGoster('screen-unit-select');
        qrScannerBaslat('main');
      }
    }
  } 
  else if (topic === `${CONFIG.MQTT_TOPIC_PREFIX}/birim-detay/cevap`) {
    if (data.qr_kod === QRState.lastCode) {
      if (data.hatali) {
        QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_FAIL_MS;
        uiHataGoster(data.mesaj || 'Geçersiz birim QR kodu');
        qrGeriSayimBaslat(CONFIG.QR_COOLDOWN_FAIL_MS, 'main');
        geriBildirimVer('hata');
      } else {
        QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_SUCCESS_MS;
        State.birimId = data.birim_id;
        State.birimAd = data.birim_ad;
        State.birimKod = data.birim_kod;
        State.birimOzel = !!data.ozel_birim;
        State.talimatlar = data.talimatlar || [];
        geriBildirimVer('basari');
        qrScannerDurdur('main');
        birimBilgiGoster();
        ekranGoster('screen-unit-info');
      }
      QRState.isProcessing = false;
      const scanner = qrScanner;
      setTimeout(() => { 
        if (!QRState.isProcessing && scanner) { 
          try { scanner.resume(); } catch {} 
        } 
      }, Math.max(0, QRState.cooldownUntil - Date.now()));
    }
  } 
  else if (topic === `${CONFIG.MQTT_TOPIC_PREFIX}/islem/cevap`) {
    if (data.islem === 'BASLA' && data.birim_id === State.birimId) {
      if (!data.hatali) {
        State.aktifIslemBaslangic = Date.now();
        localStorage.setItem(gunlukKey(`mgd-aktif-islem-${State.birimId}`), JSON.stringify({ baslangic: State.aktifIslemBaslangic, birim_id: State.birimId }));
        timerBaslat();
        ekranGoster('screen-active');
        document.getElementById('active-unit-name').textContent = State.birimAd;
      } else {
        uiHataGoster(data.mesaj || 'İşlem başlatılamadı');
      }
    } 
    else if (data.islem === 'BITIR' && data.birim_id === State.birimId) {
      if (!data.hatali) {
        geriBildirimVer('basari');
        uiToast('Görev başarıyla tamamlandı ✅', 'success');
        timerDurdur();
        localStorage.removeItem(gunlukKey(`mgd-aktif-islem-${State.birimId}`));
        State.birimId = null; State.birimAd = null; State.birimKod = null;
        ekranGoster('screen-unit-select');
        qrScannerBaslat('main');
      } else {
        uiHataGoster(data.mesaj || 'İşlem bitirilemedi');
      }
    }
  }
}

async function girisYap(tc) {
  if (!/^\d{11}$/.test(tc)) { 
    uiHataGoster('TC kimlik numarası 11 haneli olmalıdır.'); 
    return; 
  }

  if (!State.mqttClient || !State.mqttBagli) {
    uiToast('MQTT sunucusuna bağlanılıyor...', 'info');
    State.personelId = tc;
    await mqttBaglan();

    let bekleme = 0;
    while (!State.mqttBagli && bekleme < CONFIG.MQTT_BAGLANTI_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 500));
      bekleme += 500;
    }

    if (!State.mqttBagli) {
      uiHataGoster('MQTT bağlantısı sağlanamadı. Lütfen ağınızı ve broker adresini kontrol edin.');
      uiButonKilitle('GIRIS', false);
      return;
    }
  }

  State.personelId = tc;
  uiButonKilitle('GIRIS', true);

  const reqId = `req_${Date.now()}`;
  State.mqttClient.publish(`${CONFIG.MQTT_TOPIC_PREFIX}/giris`, JSON.stringify({ 
    tc: tc, 
    req_id: reqId 
  }), { qos: 1 });

  setTimeout(() => {
    const btn = document.querySelector('[data-islem="GIRIS"]');
    if (btn && btn.disabled) {
      uiHataGoster('Sunucudan yanıt alınamadı. Python servisinin çalıştığından ve aynı MQTT broker\'a bağlı olduğundan emin olun.');
      uiButonKilitle('GIRIS', false);
    }
  }, CONFIG.GIRIS_TIMEOUT_MS);
}

function birimBilgiGoster() {
  document.getElementById('unit-name').textContent = ` ${State.birimAd}`;
  document.getElementById('unit-code').textContent = `Kod: ${State.birimKod}`;
  document.getElementById('talimat-sayisi').textContent = State.talimatlar.length;
  const unitCard = document.getElementById('unit-card');
  const warning = document.getElementById('unit-warning');
  const confirmedBadge = document.getElementById('talimat-confirmed-badge');
  const talimatSection = document.getElementById('talimat-confirm-section');

  if (State.birimOzel) {
    unitCard.classList.add('warning');
    warning.classList.remove('hidden');
    if (talimatOnaylandiMi(State.birimId)) { confirmedBadge.classList.remove('hidden'); talimatSection.classList.add('hidden'); }
    else { confirmedBadge.classList.add('hidden'); talimatSection.classList.remove('hidden'); }
  } else {
    unitCard.classList.remove('warning');
    warning.classList.add('hidden');
    confirmedBadge.classList.add('hidden');
    talimatSection.classList.add('hidden');
  }
}

async function executeEndWithConfirm() {
  if (Ayarlar.onayGerekli) {
    const onay = await onaySor('🛑 Görevi Bitir', `${State.birimAd} birimindeki temizlik görevini bitirmek üzeresiniz. Emin misiniz?`, { onayMetni: '✅ Evet, Bitir', iptalMetni: 'İptal' });
    if (!onay) { uiToast('İşlem iptal edildi.'); return; }
  }
  const sonuc = await guvenliIslem('BITIR', {});
  if (sonuc.durum === 'locked') uiToast('İşlem devam ediyor, lütfen bekleyin...', 'error');
  else if (sonuc.durum === 'error') uiHataGoster('İşlem bitirilemedi. Tekrar deneyin.');
}

async function qrScannerBaslat(target = 'main') {
  const elementId = target === 'security' ? 'qr-reader-security' : 'qr-reader';
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const scanner = new Html5Qrcode(elementId);
    if (target === 'security') qrScannerSecurity = scanner; else qrScanner = scanner;
    await scanner.start({ fps: 10, qrbox: { width: 250, height: 250 } }, (decodedText) => {
      if (target === 'security' && decodedText === State.birimKod) {
        modalKapat('modal-security');
        qrScannerDurdur('security');
        guvenliIslem('BASLA', {});
      } else if (target === 'main') {
        birimDetaySorgula(decodedText, 'main');
      }
    }, () => {});
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
      if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) await scanner.stop();
    } catch (err) {}
    if (target === 'security') qrScannerSecurity = null; else qrScanner = null;
  }
}

function timerBaslat() {
  timerDurdur();
  State.timerInterval = setInterval(() => {
    if (!State.aktifIslemBaslangic) return;
    const elapsed = Math.floor((Date.now() - State.aktifIslemBaslangic) / 1000);
    document.getElementById('active-timer').textContent = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  }, 1000);
}
function timerDurdur() {
  if (State.timerInterval) { clearInterval(State.timerInterval); State.timerInterval = null; }
  document.getElementById('active-timer').textContent = '00:00';
}

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
function uiHataGoster(mesaj) { uiToast(mesaj, 'error'); }
function uiToast(mesaj, tip = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = mesaj;
  toast.className = 'toast show ' + tip;
  setTimeout(() => toast.classList.remove('show'), 3000);
}
function modalAc(modalId) { document.getElementById(modalId).classList.add('active'); }
function modalKapat(modalId) { document.getElementById(modalId).classList.remove('active'); }

function talimatListesiGoster() {
  document.getElementById('modal-talimat-unit').textContent = State.birimAd;
  const list = document.getElementById('talimat-list');
  list.innerHTML = State.talimatlar.length === 0 
    ? '<div style="text-align:center; color: var(--text-dim); padding: 20px;">Talimat bulunmuyor</div>'
    : State.talimatlar.map((t, i) => `<div class="talimat-item"><div class="num">${i + 1}</div><div>${t}</div></div>`).join('');
  modalAc('modal-talimat');
}

async function cikisYap() {
  if (State.aktifIslemBaslangic) {
    const onay = await onaySor('Çıkış Yap', 'Aktif bir işleminiz var. Çıkmak istediğinize emin misiniz?', { onayMetni: 'Evet, Çık', iptalMetni: 'İptal' });
    if (!onay) return;
  }
  if (State.mqttClient) { try { State.mqttClient.end(); } catch {} }
  qrScannerDurdur('main'); qrScannerDurdur('security'); timerDurdur();
  State.personelId = null; State.personelAd = null; State.birimId = null; State.aktifIslemBaslangic = null;
  ekranGoster('screen-login');
}

function eventListenerlariBaslat() {
  document.getElementById('screen-splash').addEventListener('click', () => {
    const cached = tcCacheOku();
    if (cached) document.getElementById('input-tc').value = cached;
    ekranGoster('screen-login');
  });

  document.getElementById('btn-login').addEventListener('click', () => girisYap(document.getElementById('input-tc').value.trim()));
  document.getElementById('input-tc').addEventListener('keypress', (e) => { if (e.key === 'Enter') girisYap(e.target.value.trim()); });

  document.getElementById('btn-logout-1').addEventListener('click', cikisYap);
  document.getElementById('btn-logout-2').addEventListener('click', cikisYap);

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

  document.getElementById('btn-start-work').addEventListener('click', () => {
    if (State.birimOzel && !talimatOnaylandiMi(State.birimId)) {
      uiHataGoster('Özellikli birim için talimatları okuyup onaylamanız gerekiyor.');
      return;
    }
    document.getElementById('security-expected-name').textContent = State.birimAd;
    document.getElementById('security-expected-code').textContent = `Kod: ${State.birimKod}`;
    modalAc('modal-security');
    qrScannerBaslat('security');
  });

  document.getElementById('btn-end-work').addEventListener('click', executeEndWithConfirm);
  document.getElementById('btn-cancel-security').addEventListener('click', () => { modalKapat('modal-security'); qrScannerDurdur('security'); });

  ['ses', 'titresim', 'onay-bitir'].forEach(k => {
    const el = document.getElementById(`sett-${k}`);
    if (el) {
      el.checked = localStorage.getItem(`mgd-ayar-${k}`) !== '0';
      el.onchange = e => localStorage.setItem(`mgd-ayar-${k}`, e.target.checked ? '1' : '0');
    }
  });
}

async function swKaydet() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (err) { console.error('[SW] Kayıt hatası:', err); }
  }
}

async function baslat() {
  await swKaydet();
  eventListenerlariBaslat();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', baslat);
else baslat();
})();