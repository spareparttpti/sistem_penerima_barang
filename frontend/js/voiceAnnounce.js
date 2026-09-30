/* =========================================================
   SPB · voiceAnnounce.js
   Voice-over (Text-to-Speech) pesanan dari portal operator — GLOBAL, jalan
   di halaman admin MANAPUN (Stok Barang, Log Penerimaan, dst), bukan cuma
   pas lagi buka Antrean & Riwayat. Polling sendiri tiap 15 detik selama
   admin login & bukan lagi di portal publik (/pesan, /tiket, /login).
   Murni Web Speech API browser (window.speechSynthesis) — nggak ada
   rekaman/file suara, nggak butuh server, cuma jalan selama tab ini kebuka.

   DUA PERAN, DUA PENGUMUMAN BEDA (lihat auth_setup.sql role admin/crew vs
   admin_divisi):
   - Admin gudang (role 'admin'/'crew') → dengar begitu ada pesanan BARU
     masuk (status "waiting") dari divisi MANA PUN, biar langsung diproses.
   - Admin divisi (role 'admin_divisi', terkunci ke 1 divisi lewat
     meta.divisi) → dengar begitu pesanan DIVISINYA SENDIRI berubah jadi
     "siap diambil" (status "ready"), bukan pas baru masuk (itu bukan
     urusan dia, itu urusan admin gudang yang notifikasi barang barusan).
   ========================================================= */

(function () {
  'use strict';

  let voiceKnownStatus = null; // null = belum pernah nge-set baseline; Map id -> status
  function loadVoicePref() {
    try { return localStorage.getItem('spb-voice-announce') !== 'off'; } catch (e) { return true; }
  }
  let voiceEnabled = loadVoicePref();

  let voicesCache = [];
  function refreshVoicesCache() {
    if (window.speechSynthesis) voicesCache = window.speechSynthesis.getVoices() || [];
  }
  if (window.speechSynthesis) {
    refreshVoicesCache();
    window.speechSynthesis.onvoiceschanged = refreshVoicesCache;
  }
  function pickFemaleVoice() {
    if (!voicesCache.length) return null;
    const idVoices = voicesCache.filter(function (v) { return /^id[-_]?id/i.test(v.lang) || /indonesia/i.test(v.name); });
    const femalePattern = /female|wanita|perempuan|zira|samantha|victoria|susan|karen|tessa|moira|joanna|salli|damayanti|google\s*b(ahasa)?\s*indo/i;
    const pool = idVoices.length ? idVoices : voicesCache;
    return pool.find(function (v) { return femalePattern.test(v.name); }) || idVoices[0] || null;
  }
  // Beberapa browser "mengunci" speechSynthesis sampai ada interaksi
  // pengguna PERTAMA di halaman (mirip aturan autoplay audio/video) —
  // ngomong dari timer polling doang (tanpa klik apa pun sebelumnya) bisa
  // diam-diam gagal di kondisi itu. Sekali klik/keydown pertama di halaman
  // manapun langsung "membangunkan" speech engine-nya (ucapan kosong,
  // volume nyaris nol, nggak kedengeran) supaya panggilan speak() berikutnya
  // dari poll() beneran bunyi.
  let warmedUp = false;
  function warmUpSpeechEngine() {
    if (warmedUp || !window.speechSynthesis) return;
    warmedUp = true;
    try {
      const warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
    } catch (e) { /* nggak fatal, speak() asli nanti tetap dicoba */ }
  }
  document.addEventListener('click', warmUpSpeechEngine, { once: true, capture: true });
  document.addEventListener('keydown', warmUpSpeechEngine, { once: true, capture: true });

  function speakAnnouncement(text) {
    if (!voiceEnabled || !window.speechSynthesis) return;
    try {
      const utter = new SpeechSynthesisUtterance(text);
      const voice = pickFemaleVoice();
      if (voice) { utter.voice = voice; utter.lang = voice.lang; } else { utter.lang = 'id-ID'; utter.pitch = 1.25; }
      utter.rate = 0.98;
      window.speechSynthesis.speak(utter);
    } catch (e) { /* browser nggak dukung / diblokir — diem-diem gagal, bukan fitur wajib */ }
  }
  function queueLabel(p) {
    const d = (p.divisi || '').trim();
    const n = p.divisi_seq != null ? p.divisi_seq : p.queue_no;
    return (d ? d.charAt(0).toUpperCase() : 'A') + '-' + String(n).padStart(4, '0');
  }
  function itemsTextOf(p) {
    const items = (p.items || []).map(function (it) { return it.nama_barang + ' ' + it.qty + ' ' + (it.satuan || ''); });
    return items.length
      ? (items.length === 1 ? items[0] : items.slice(0, -1).join(', ') + ', dan ' + items[items.length - 1])
      : 'tanpa rincian barang';
  }

  // Wording admin gudang — pesanan BARU masuk, dari divisi mana pun.
  function buildGudangAnnouncement(p) {
    const divisiText = p.divisi ? (p.divisi + (p.sub_divisi ? ' bagian ' + p.sub_divisi : '')) : 'divisi tidak diketahui';
    const prefix = p.is_urgent ? 'Perhatian, pesanan mendesak masuk. ' : 'Pesanan baru masuk. ';
    return prefix + 'Dari ' + p.karyawan_name + ', divisi ' + divisiText + '. Barang yang diminta: ' + itemsTextOf(p) + '. Nomor antrian ' + queueLabel(p) + '.';
  }
  // Wording admin divisi — pesanan divisinya SIAP DIAMBIL.
  function buildDivisiAnnouncement(p) {
    return 'Antrian nomor ' + queueLabel(p) + ', pesanan atas nama ' + p.karyawan_name +
      ', dengan jenis barang ' + itemsTextOf(p) + ', sudah siap diambil.';
  }

  function toggleVoiceAnnounce() {
    voiceEnabled = !voiceEnabled;
    try { localStorage.setItem('spb-voice-announce', voiceEnabled ? 'on' : 'off'); } catch (e) { /* private mode dsb */ }
    if (!voiceEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
    else if (voiceEnabled) speakAnnouncement('Pengumuman suara pesanan diaktifkan.');
  }
  function isVoiceEnabled() { return voiceEnabled; }

  function announceChanges(rows) {
    const auth = window.SPB.auth;
    const isDivisiAdmin = !!(auth && auth.isDivisiScoped && auth.isDivisiScoped());
    const myDivisi = isDivisiAdmin ? (auth.currentDivisi() || '').trim().toLowerCase() : null;

    const currentStatus = new Map(rows.map(function (p) { return [p.id, p.status]; }));
    if (voiceKnownStatus === null) { voiceKnownStatus = currentStatus; return; } // baseline pertama, jangan umumin apa-apa

    const toAnnounce = [];
    if (isDivisiAdmin) {
      // Cuma pesanan DIVISINYA yang baru saja berubah jadi "ready" (transisi,
      // bukan sekadar "belum pernah kelihat" — kalau nggak gitu, pesanan
      // yang sudah lama Ready sebelum baseline pertama nggak akan pernah
      // diumumin, sesuai desain "jangan umumin backlog lama").
      rows.forEach(function (p) {
        if ((p.divisi || '').trim().toLowerCase() !== myDivisi) return;
        if (p.status !== 'ready') return;
        const prev = voiceKnownStatus.get(p.id);
        if (prev !== undefined && prev !== 'ready') toAnnounce.push(p);
      });
    } else {
      // Admin gudang: pesanan yang bener-bener baru muncul (id belum pernah
      // kelihat) & masih menunggu diproses.
      rows.forEach(function (p) {
        if (p.status === 'waiting' && !voiceKnownStatus.has(p.id)) toAnnounce.push(p);
      });
    }
    voiceKnownStatus = currentStatus;
    if (!toAnnounce.length) return;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    toAnnounce.forEach(function (p) {
      speakAnnouncement(isDivisiAdmin ? buildDivisiAnnouncement(p) : buildGudangAnnouncement(p));
    });
  }

  // Polling sendiri, LEPAS dari halaman mana pun yang lagi kebuka — beda
  // dari fetchQuiet() punya permintaan.js yang cuma jalan pas di halaman itu.
  function shouldPoll() {
    const auth = window.SPB.auth;
    if (auth && auth.isDemo && auth.isDemo()) return false;
    if (auth && auth.isAuthed && !auth.isAuthed()) return false;
    const hash = location.hash.replace(/^#/, '');
    if (/^\/pesan|^\/tiket\/|^\/login/.test(hash)) return false; // portal publik / halaman login
    return true;
  }
  let pollTimer = null;
  function poll() {
    if (!shouldPoll()) return;
    if (!window.SPB.dbPesanan) return;
    window.SPB.dbPesanan.listAll().then(function (rows) {
      announceChanges(rows);
    }).catch(function () { /* diem-diem gagal, halaman lain punya error handling sendiri */ });
  }
  // 2 detik (bukan 15 detik kayak polling tabel di permintaan.js) — voice-over
  // ini yang bikin admin sadar ada pesanan baru/siap diambil TANPA mantengin
  // layar, jadi delay-nya lebih kerasa kalau kelamaan dibanding sekadar
  // tabel yang emang lagi dipelototin.
  function start() {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, 2000);
  }
  start();

  window.SPB.voiceAnnounce = {
    toggle: toggleVoiceAnnounce,
    isEnabled: isVoiceEnabled
  };
})();
