/* ═══════════════════════════════════════════════════════
MGD CleanOS — Application Logic v3.3.1 (MQTT v3 protokolü)
Mustafa GÜNEŞDOĞDU / MGDizayn
Nazilli Devlet Hastanesi Bilgi İşlem 2026

Sunucu ile haberleşme (server_gui.py ile birebir uyumlu):
  İstek : MGD/Temizlik/v3/Istek          {dev_id, tip, birim, tc}
  Cevap : MGD/Temizlik/v3/Cevap/<dev_id> {status: "OK"|"HATA", message, ...}
  tip   : KONTROL | BIRIM_DETAY | TALIMAT_ONAY | START | END
═══════════════════════════════════════════════════════ */
(() => {
'use strict';

const CONFIG = {
  MQTT_BROKER: window.MGD_MQTT_BROKER || 'wss://broker.hivemq.com:8884/mqtt',
  TOPIC_ISTEK: 'MGD/Temizlik/v3/Istek',
  TOPIC_CEVAP_BASE: 'MGD/Temizlik/v3/Cevap/',
  QR_COOLDOWN_SUCCESS_MS: 1500,
  QR_COOLDOWN_FAIL_MS: 3000,
  QR_MIN_INTERVAL_MS: 800,
  ISLEM_MIN_ARALIK_MS: 2000,
  YANIT_TIMEOUT_MS: 10000,
  MQTT_BAGLANTI_TIMEOUT_MS: 8000
};

const DEV_ID = 'WEB_' + Math.random().toString(36).slice(2, 8).toUpperCase();

const State = {
  personelId: null,
  personelAd: '',
  personelSoyad: '',
  kurumAdi: '',
  birimKod: null,
  birimAd: null,
  birimOzel: false,
  talimatOnayli: false,
  talimatlar: [],
  aktifIslemBaslangic: null,
  timerInterval: null,
  mqttClient: null,
  mqttBagli: false
};

/* ───────── Günlük cache (TR saatine göre) ───────── */
function turkiyeBugunAnahtari(tarih = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(tarih);
}
function gunlukKey(prefix) { return `${prefix}__${turkiyeBugunAnahtari()}`; }
function tcCacheOku() { try { return localStorage.getItem(gunlukKey('mgd-tc-cache')); } catch { return null; } }
function tcCacheYaz(tc) {
  try {
    Object.keys(localStorage).filter(k => k.startsWith('mgd-tc-cache__')).forEach(k => localStorage.removeItem(k));
    localStorage.setItem(gunlukKey('mgd-tc-cache'), tc);
  } catch {}
}
function aktifIslemKey(birimKod) { return gunlukKey(`mgd-aktif-islem-${State.personelId}-${birimKod}`); }

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
        <h3></h3><p></p>
        <div class="confirm-actions">
          <button class="btn-cancel" data-act="cancel"></button>
          <button class="btn-confirm" data-act="confirm"></button>
        </div>
      </div>`;
    overlay.querySelector('h3').textContent = baslik;
    overlay.querySelector('p').textContent = mesaj;
    overlay.querySelector('[data-act="cancel"]').textContent = iptalMetni;
    overlay.querySelector('[data-act="confirm"]').textContent = onayMetni;
    document.body.appendChild(overlay);
    const escHandler = (e) => { if (e.key === 'Escape') cleanup(false); };
    const cleanup = (deger) => {
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
      resolve(deger);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector('[data-act="cancel"]').onclick = () => cleanup(false);
    overlay.querySelector('[data-act="confirm"]').onclick = () => cleanup(true);
    document.addEventListener('keydown', escHandler);
  });
}

/* ═══════════════ MQTT: bağlantı + istek/cevap ═══════════════ */
let bekleyenIstek = null;           // {resolve}
let istekZinciri = Promise.resolve(); // istekler sırayla gider (cevapta istek no yok)

function mqttBaglan() {
  if (typeof mqtt === 'undefined') {
    uiDurumGuncelle('error', '🔴 MQTT kütüphanesi yüklenemedi');
    return;
  }
  if (State.mqttClient) return; // zaten var, mqtt.js kendi yeniden bağlanır
  uiDurumGuncelle('connecting', '🟡 Bağlanıyor');
  try {
    const client = mqtt.connect(CONFIG.MQTT_BROKER, {
      clientId: DEV_ID,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 3000
    });
    State.mqttClient = client;

    client.on('connect', () => {
      State.mqttBagli = true;
      uiDurumGuncelle('connected', '🟢 Bağlı');
      client.subscribe(`${CONFIG.TOPIC_CEVAP_BASE}${DEV_ID}`, (err) => {
        if (err) console.error('[MQTT] Abonelik hatası:', err);
      });
    });

    client.on('message', (topic, message) => {
      let data;
      try { data = JSON.parse(message.toString()); }
      catch (e) { console.error('[MQTT] Parse hatası:', e); return; }
      if (bekleyenIstek) bekleyenIstek.resolve(data);
    });

    const koptu = () => { State.mqttBagli = false; uiDurumGuncelle('connecting', '🟡 Yeniden bağlanıyor'); };
    client.on('offline', koptu);
    client.on('close', koptu);
    client.on('error', (err) => {
      console.error('[MQTT] Hata:', err);
      uiDurumGuncelle('error', '🔴 Bağlantı hatası');
    });
  } catch (err) {
    console.error('[MQTT] Bağlantı hatası:', err);
    uiDurumGuncelle('error', '🔴 MQTT hatası');
  }
}

async function mqttHazirBekle() {
  if (!State.mqttClient) mqttBaglan();
  let bekleme = 0;
  while (!State.mqttBagli && bekleme < CONFIG.MQTT_BAGLANTI_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 250));
    bekleme += 250;
  }
  if (!State.mqttBagli) {
    throw new Error('MQTT bağlantısı sağlanamadı. Ağınızı kontrol edin.');
  }
}

function mqttIstek(tip, birim = '', tc = '') {
  const calis = () => new Promise((resolve, reject) => {
    if (!State.mqttClient || !State.mqttBagli) {
      reject(new Error('Sunucuya bağlı değil'));
      return;
    }
    const timer = setTimeout(() => {
      bekleyenIstek = null;
      reject(new Error('Sunucu yanıt vermedi. Sunucunun çalıştığından emin olun.'));
    }, CONFIG.YANIT_TIMEOUT_MS);

    bekleyenIstek = {
      resolve: (data) => { clearTimeout(timer); bekleyenIstek = null; resolve(data); }
    };

    State.mqttClient.publish(
      CONFIG.TOPIC_ISTEK,
      JSON.stringify({ dev_id: DEV_ID, tip, birim, tc }),
      (err) => {
        if (err) {
          clearTimeout(timer);
          bekleyenIstek = null;
          reject(new Error('Mesaj gönderilemedi'));
        }
      }
    );
  });
  const sonuc = istekZinciri.then(calis);
  istekZinciri = sonuc.catch(() => {});
  return sonuc;
}

/* ═══════════════ Giriş ═══════════════ */
async function girisYap(tc) {
  if (!/^\d{11}$/.test(tc)) {
    uiHataGoster('TC kimlik numarası 11 haneli olmalıdır.');
    return;
  }
  const btn = document.querySelector('[data-islem="GIRIS"]');
  if (btn && btn.disabled) return;
  uiButonKilitle('GIRIS', true);

  try {
    if (!State.mqttBagli) uiToast('Sunucuya bağlanılıyor...', 'info');
    await mqttHazirBekle();

    const yanit = await mqttIstek('KONTROL', '', tc);

    if (yanit && yanit.status === 'OK') {
      State.personelId = tc;
      State.personelAd = yanit.personel?.ad || '';
      State.personelSoyad = yanit.personel?.soyad || '';
      State.kurumAdi = yanit.personel?.kurum_adi || '';
      tcCacheYaz(tc);

      if (yanit.aktif_islem) {
        // Devam eden temizlik var → doğrudan aktif ekran
        State.birimKod = yanit.aktif_islem.birim_kodu;
        State.birimAd = yanit.aktif_islem.birim_adi;
        State.birimOzel = !!yanit.aktif_islem.ozellikli;
        let baslangic = Date.now();
        try {
          const kayit = JSON.parse(localStorage.getItem(aktifIslemKey(State.birimKod)) || 'null');
          if (kayit && kayit.baslangic) baslangic = kayit.baslangic;
        } catch {}
        aktifEkranaGec(baslangic);
        uiToast(`Hoş geldiniz ${State.personelAd}, devam eden işleminiz var.`, 'info');
      } else {
        ekranGoster('screen-unit-select');
        qrScannerBaslat('main');
        uiToast(`Hoş geldiniz ${State.personelAd} 👋`, 'success');
      }
      geriBildirimVer('basari');
    } else {
      geriBildirimVer('hata');
      uiHataGoster(yanit?.message || 'Personel bulunamadı');
    }
  } catch (err) {
    geriBildirimVer('hata');
    uiHataGoster(err.message);
  } finally {
    uiButonKilitle('GIRIS', false);
  }
}

function aktifEkranaGec(baslangic) {
  State.aktifIslemBaslangic = baslangic;
  try {
    localStorage.setItem(aktifIslemKey(State.birimKod), JSON.stringify({ baslangic, birim_kod: State.birimKod }));
  } catch {}
  document.getElementById('active-unit-name').textContent = State.birimAd || State.birimKod || '-';
  timerBaslat();
  ekranGoster('screen-active');
}

/* ═══════════════ QR → birim detay ═══════════════ */
const QRState = { isProcessing: false, lastScanAt: 0, cooldownUntil: 0, lastCode: null };
let qrScanner = null;
let qrScannerSecurity = null;

async function birimDetaySorgula(qrKod, target = 'main') {
  const now = Date.now();
  if (now < QRState.cooldownUntil) {
    qrGeriSayimGoster(Math.ceil((QRState.cooldownUntil - now) / 1000), target);
    return;
  }
  if (qrKod === QRState.lastCode && (now - QRState.lastScanAt) < CONFIG.QR_MIN_INTERVAL_MS) return;
  if (QRState.isProcessing) return;

  QRState.isProcessing = true;
  QRState.lastCode = qrKod;
  QRState.lastScanAt = now;

  const scanner = qrScanner;
  if (scanner) { try { scanner.pause(true); } catch {} }

  let basarili = false;
  try {
    const yanit = await mqttIstek('BIRIM_DETAY', qrKod, State.personelId);

    if (yanit && yanit.status === 'OK' && yanit.birim) {
      basarili = true;
      QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_SUCCESS_MS;
      State.birimKod = yanit.birim.kod || qrKod;
      State.birimAd = yanit.birim.adi || qrKod;
      State.birimOzel = !!yanit.birim.ozellikli;
      State.talimatOnayli = !!yanit.birim.onay_durumu;
      State.talimatlar = String(yanit.birim.talimatlar || '')
        .split('\n').map(s => s.trim()).filter(Boolean);

      geriBildirimVer('basari');
      await qrScannerDurdur('main');
      birimBilgiGoster();
      ekranGoster('screen-unit-info');
    } else {
      QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_FAIL_MS;
      uiHataGoster(yanit?.message || 'Geçersiz birim QR kodu');
      qrGeriSayimBaslat(CONFIG.QR_COOLDOWN_FAIL_MS, 'main');
      geriBildirimVer('hata');
    }
  } catch (err) {
    QRState.cooldownUntil = Date.now() + CONFIG.QR_COOLDOWN_FAIL_MS;
    uiHataGoster(err.message);
    qrGeriSayimBaslat(CONFIG.QR_COOLDOWN_FAIL_MS, 'main');
    geriBildirimVer('hata');
  } finally {
    QRState.isProcessing = false;
    if (!basarili && scanner) {
      setTimeout(() => { try { scanner.resume(); } catch {} },
        Math.max(0, QRState.cooldownUntil - Date.now()));
    }
  }
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

/* ═══════════════ İşlem kilidi (çift tıklama koruması) ═══════════════ */
const IslemKilit = { aktif: false, sonIslem: null, sonZaman: 0 };

async function guvenliIslem(islemAdi, calistir) {
  const now = Date.now();
  if (IslemKilit.aktif) return { durum: 'locked' };
  if (IslemKilit.sonIslem === islemAdi && (now - IslemKilit.sonZaman) < CONFIG.ISLEM_MIN_ARALIK_MS) return { durum: 'duplicate' };

  IslemKilit.aktif = true;
  IslemKilit.sonIslem = islemAdi;
  IslemKilit.sonZaman = now;
  uiButonKilitle(islemAdi, true);
  try {
    const yanit = await calistir();
    return { durum: 'ok', yanit };
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

/* ═══════════════ Başlat / Bitir / Talimat ═══════════════ */
async function islemBaslat() {
  const sonuc = await guvenliIslem('START', () => mqttIstek('START', State.birimKod, State.personelId));
  if (sonuc.durum === 'locked' || sonuc.durum === 'duplicate') { uiToast('İşlem devam ediyor, lütfen bekleyin...', 'error'); return; }
  if (sonuc.durum === 'error') { uiHataGoster(sonuc.err.message); geriBildirimVer('hata'); return; }

  const yanit = sonuc.yanit;
  if (yanit && yanit.status === 'OK') {
    geriBildirimVer('basari');
    aktifEkranaGec(Date.now());
    uiToast(`${State.birimAd} temizliği başlatıldı ✅`, 'success');
  } else {
    geriBildirimVer('hata');
    uiHataGoster(yanit?.message || 'İşlem başlatılamadı');
  }
}

async function executeEndWithConfirm() {
  if (Ayarlar.onayGerekli) {
    const onay = await onaySor('🛑 Görevi Bitir', `${State.birimAd} birimindeki temizlik görevini bitirmek üzeresiniz. Emin misiniz?`, { onayMetni: '✅ Evet, Bitir', iptalMetni: 'İptal' });
    if (!onay) { uiToast('İşlem iptal edildi.'); return; }
  }
  const sonuc = await guvenliIslem('END', () => mqttIstek('END', State.birimKod, State.personelId));
  if (sonuc.durum === 'locked' || sonuc.durum === 'duplicate') { uiToast('İşlem devam ediyor, lütfen bekleyin...', 'error'); return; }
  if (sonuc.durum === 'error') { uiHataGoster(sonuc.err.message); geriBildirimVer('hata'); return; }

  const yanit = sonuc.yanit;
  if (yanit && yanit.status === 'OK') {
    geriBildirimVer('basari');
    uiToast('Görev başarıyla tamamlandı ✅', 'success');
    timerDurdur();
    try { localStorage.removeItem(aktifIslemKey(State.birimKod)); } catch {}
    birimDurumunuSifirla();
    State.aktifIslemBaslangic = null;
    ekranGoster('screen-unit-select');
    qrScannerBaslat('main');
  } else {
    geriBildirimVer('hata');
    uiHataGoster(yanit?.message || 'İşlem bitirilemedi');
  }
}

async function talimatOnayla() {
  const btn = document.getElementById('btn-confirm-talimat');
  btn.disabled = true;
  try {
    const yanit = await mqttIstek('TALIMAT_ONAY', State.birimKod, State.personelId);
    if (yanit && yanit.status === 'OK') {
      State.talimatOnayli = true;
      birimBilgiGoster();
      modalKapat('modal-talimat');
      uiToast('Talimatlar onaylandı ✅', 'success');
      geriBildirimVer('basari');
    } else {
      uiHataGoster(yanit?.message || 'Onay kaydedilemedi');
      geriBildirimVer('hata');
    }
  } catch (err) {
    uiHataGoster(err.message);
  } finally {
    btn.disabled = false;
  }
}

function birimDurumunuSifirla() {
  State.birimKod = null; State.birimAd = null; State.birimOzel = false;
  State.talimatOnayli = false; State.talimatlar = [];
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
    if (State.talimatOnayli) { confirmedBadge.classList.remove('hidden'); talimatSection.classList.add('hidden'); }
    else { confirmedBadge.classList.add('hidden'); talimatSection.classList.remove('hidden'); }
  } else {
    unitCard.classList.remove('warning');
    warning.classList.add('hidden');
    confirmedBadge.classList.add('hidden');
    talimatSection.classList.add('hidden');
  }
}

function talimatListesiGoster() {
  document.getElementById('modal-talimat-unit').textContent = State.birimAd;
  const list = document.getElementById('talimat-list');
  list.innerHTML = '';
  if (State.talimatlar.length === 0) {
    const bos = document.createElement('div');
    bos.style.cssText = 'text-align:center; color: var(--text-dim); padding: 20px;';
    bos.textContent = 'Talimat bulunmuyor';
    list.appendChild(bos);
  } else {
    State.talimatlar.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = 'talimat-item';
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = i + 1;
      const metin = document.createElement('div');
      metin.textContent = t.replace(/^\d+[.\-)]\s*/, ''); // baştaki "1." numarasını tekrarlama
      item.appendChild(num);
      item.appendChild(metin);
      list.appendChild(item);
    });
  }
  birimBilgiGoster(); // onay bölümünün görünürlüğünü güncelle
  modalAc('modal-talimat');
}

/* ═══════════════ QR tarayıcı ═══════════════ */
async function qrScannerBaslat(target = 'main') {
  const elementId = target === 'security' ? 'qr-reader-security' : 'qr-reader';
  const el = document.getElementById(elementId);
  if (!el) return;
  await qrScannerDurdur(target);
  let sonYanlisUyari = 0;
  try {
    const scanner = new Html5Qrcode(elementId);
    if (target === 'security') qrScannerSecurity = scanner; else qrScanner = scanner;
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10 },
      (decodedText) => {
        if (target === 'security') {
          if (decodedText === State.birimKod) {
            modalKapat('modal-security');
            qrScannerDurdur('security');
            islemBaslat();
          } else if (Date.now() - sonYanlisUyari > 2000) {
            sonYanlisUyari = Date.now();
            geriBildirimVer('hata');
            uiHataGoster(`Yanlış birim! Beklenen: ${State.birimAd}`);
          }
        } else {
          birimDetaySorgula(decodedText, 'main');
        }
      },
      () => {}
    );
  } catch (err) {
    console.error(`[QR] Scanner başlatılamadı (${target}):`, err);
    uiHataGoster('Kamera erişimi sağlanamadı. Tarayıcı izinlerini kontrol edin.');
  }
}

async function qrScannerDurdur(target = 'main') {
  const scanner = target === 'security' ? qrScannerSecurity : qrScanner;
  if (scanner) {
    try {
      const durum = scanner.getState();
      if (durum === Html5QrcodeScannerState.SCANNING || durum === Html5QrcodeScannerState.PAUSED) await scanner.stop();
    } catch (err) {}
    if (target === 'security') qrScannerSecurity = null; else qrScanner = null;
  }
}

/* ═══════════════ Zamanlayıcı & UI yardımcıları ═══════════════ */
function timerBaslat() {
  timerDurdur();
  const guncelle = () => {
    if (!State.aktifIslemBaslangic) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - State.aktifIslemBaslangic) / 1000));
    const dk = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const sn = (elapsed % 60).toString().padStart(2, '0');
    document.getElementById('active-timer').textContent = `${dk}:${sn}`;
  };
  guncelle();
  State.timerInterval = setInterval(guncelle, 1000);
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
  if (!pill || !text) return;
  pill.className = 'status-pill ' + durum;
  text.textContent = metin;
}
function uiHataGoster(mesaj) { uiToast(mesaj, 'error'); }
let toastZamanlayici = null;
function uiToast(mesaj, tip = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = mesaj;
  toast.className = 'toast show ' + tip;
  clearTimeout(toastZamanlayici);
  toastZamanlayici = setTimeout(() => toast.classList.remove('show'), 3500);
}
function modalAc(modalId) { document.getElementById(modalId).classList.add('active'); }
function modalKapat(modalId) { document.getElementById(modalId).classList.remove('active'); }

async function cikisYap() {
  if (State.aktifIslemBaslangic) {
    const onay = await onaySor('Çıkış Yap', 'Aktif bir işleminiz var. Çıkmak istediğinize emin misiniz? (İşleminiz sunucuda açık kalır.)', { onayMetni: 'Evet, Çık', iptalMetni: 'İptal' });
    if (!onay) return;
  }
  qrScannerDurdur('main'); qrScannerDurdur('security'); timerDurdur();
  State.personelId = null; State.personelAd = ''; State.personelSoyad = '';
  State.aktifIslemBaslangic = null;
  birimDurumunuSifirla();
  ekranGoster('screen-login');
}

/* ═══════════════ Olay bağlama ═══════════════ */
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
  document.getElementById('btn-confirm-talimat').addEventListener('click', talimatOnayla);

  document.getElementById('btn-back-select').addEventListener('click', () => {
    birimDurumunuSifirla();
    ekranGoster('screen-unit-select');
    qrScannerBaslat('main');
  });

  document.getElementById('btn-start-work').addEventListener('click', () => {
    if (State.birimOzel && !State.talimatOnayli) {
      uiHataGoster('Özellikli birim için talimatları okuyup onaylamanız gerekiyor.');
      talimatListesiGoster();
      return;
    }
    document.getElementById('security-expected-name').textContent = State.birimAd;
    document.getElementById('security-expected-code').textContent = `Kod: ${State.birimKod}`;
    modalAc('modal-security');
    qrScannerBaslat('security');
  });

  document.getElementById('btn-end-work').addEventListener('click', executeEndWithConfirm);
  document.getElementById('btn-cancel-security').addEventListener('click', () => { modalKapat('modal-security'); qrScannerDurdur('security'); });

  const geri = document.getElementById('btn-back-from-settings');
  if (geri) geri.addEventListener('click', () => ekranGoster(State.personelId ? 'screen-unit-select' : 'screen-login'));

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
  eventListenerlariBaslat();
  mqttBaglan();          // sayfa açılır açılmaz bağlan, durum rozeti canlı olsun
  swKaydet();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', baslat);
else baslat();
})();
