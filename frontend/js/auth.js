/* =========================================================
   SPB · auth.js
   Sesi login (Supabase Auth, USERNAME + password) dan client Supabase mentah
   yang dipakai bareng oleh supabaseClient.js untuk baca/tulis data.

   demoMode=true  → tidak ada gerbang login sama sekali (localStorage, siapa
                    saja yang buka browser langsung masuk — dipakai untuk demo).
   demoMode=false → wajib login. Akun dibuat lewat aplikasi sendiri (modal
                    Tambah Pengguna / halaman Manajemen Pengguna), lihat
                    database/auth_setup.sql — tidak perlu Supabase Dashboard.

   Login pakai USERNAME, bukan email — Supabase Auth internal tetap berbasis
   email, jadi username diam-diam diubah jadi "email sintetis"
   <username>@spb.local sebelum dikirim ke Supabase, dan diubah balik lagi
   saat ditampilkan. Domain ini HARUS SAMA PERSIS dengan yang dipakai di
   database/auth_setup.sql (fungsi create_user_account) — kalau salah satu
   diubah tanpa yang lain, login akan gagal karena email yang dicari beda.

   Harus dimuat SETELAH library Supabase (CDN) & config.js, SEBELUM
   supabaseClient.js dan modul lain yang butuh window.SPB.sb.
   ========================================================= */

(function () {
  'use strict';

  const CFG = window.SPB_CONFIG;
  const DEMO = CFG.demoMode;
  const USERNAME_DOMAIN = '@spb.local'; // HARUS sama dengan database/auth_setup.sql

  function usernameToEmail(username) {
    return String(username || '').trim().toLowerCase() + USERNAME_DOMAIN;
  }

  let client = null;
  if (!DEMO) {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      // persistSession: true (default) — sesi DIINGAT lewat localStorage,
      // jadi refresh/buka tab baru dalam waktu dekat TIDAK perlu login ulang.
      // "Auto-logout" yang sebenarnya diinginkan diurus manual di bawah lewat
      // idle timeout 5 menit (lihat IDLE_LIMIT_MS) — bukan lewat matiin
      // persistSession, karena itu bikin refresh SELALU minta login ulang
      // (tidak dibedakan dari "diam 5 menit").
      client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    } else {
      // Kalau ini muncul, cek urutan <script> di index.html — CDN supabase-js
      // harus dimuat sebelum auth.js.
      console.error('SPB: library Supabase-js belum termuat saat auth.js jalan.');
    }
  }

  let session = null;
  let initPromise = null;
  const listeners = [];

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(session); } catch (e) { /* satu listener error tidak boleh menghentikan yang lain */ }
    });
  }

  /* ---------- Idle timeout: 5 menit tanpa aktivitas -> auto logout ----------
     Sesi TETAP diingat lewat localStorage (persistSession di atas), tapi
     "diam" 5 menit (nggak ada klik/ketik/scroll sama sekali) dianggap sesi
     basi — dipaksa signOut() otomatis, balik ke halaman Login. Timestamp
     aktivitas terakhir disimpan localStorage (bukan cuma variabel in-memory)
     supaya kedeteksi juga kalau tab-nya sempat ditutup terus dibuka lagi
     setelah lebih dari 5 menit. */
  const IDLE_LIMIT_MS = 5 * 60 * 1000;
  const LAST_ACTIVITY_KEY = 'spb-last-activity';
  function recordActivity() {
    try { localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now())); } catch (e) { /* private mode dsb */ }
  }
  function getLastActivity() {
    try { return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0; } catch (e) { return 0; }
  }
  function isIdleExpired() {
    const last = getLastActivity();
    return last > 0 && (Date.now() - last) > IDLE_LIMIT_MS;
  }
  // Direkam sekali per beberapa detik (bukan tiap event mousemove mentah,
  // biar nggak nulis localStorage ratusan kali per detik) — cukup buat
  // nandain "masih ada orang di depan layar ini".
  let lastRecordAt = 0;
  function onUserActivity() {
    const now = Date.now();
    if (now - lastRecordAt < 3000) return;
    lastRecordAt = now;
    recordActivity();
  }
  ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach(function (evt) {
    document.addEventListener(evt, onUserActivity, { passive: true });
  });
  let idleCheckTimer = null;
  function startIdleWatcher() {
    if (idleCheckTimer) return;
    idleCheckTimer = setInterval(function () {
      if (session && isIdleExpired()) signOut();
    }, 15000); // cek tiap 15 detik — cukup responsif, nggak boros
  }

  /* Dipanggil sekali saat boot. Mengembalikan Promise supaya app.js bisa
     menunggu status login diketahui SEBELUM memutuskan render halaman mana. */
  function init() {
    if (initPromise) return initPromise;
    if (DEMO || !client) {
      api.__ready = true;
      initPromise = Promise.resolve(null);
      return initPromise;
    }
    // Sesi lama (localStorage) tapi sudah diam lebih dari 5 menit sejak
    // aktivitas terakhir -> jangan dipulihkan sama sekali, anggap basi.
    if (isIdleExpired()) {
      initPromise = client.auth.signOut().catch(function () {}).then(function () {
        session = null;
        api.__ready = true;
        recordActivity();
        startIdleWatcher();
        return null;
      });
      return initPromise;
    }
    initPromise = client.auth.getSession().then(function (res) {
      session = res.data.session;
      client.auth.onAuthStateChange(function (_event, newSession) {
        session = newSession;
        notify();
      });
      recordActivity();
      startIdleWatcher();
      return session;
    }).catch(function (err) {
      console.error('SPB: gagal ambil sesi login:', err.message);
      return null;
    }).finally(function () {
      api.__ready = true;
    });
    return initPromise;
  }

  function getSession() { return session; }

  // Di demoMode, aplikasi dianggap selalu "sudah login" — tidak ada gerbang.
  function isAuthed() { return DEMO || !!session; }

  /* Username asli disimpan di user_metadata (diisi create_user_account SQL);
     fallback ke potongan sebelum '@' pada email sintetis kalau metadata itu
     entah kenapa kosong (mis. akun dibuat lewat jalur lain). */
  function currentUsername() {
    if (!session || !session.user) return null;
    const meta = session.user.user_metadata || {};
    if (meta.username) return meta.username;
    return String(session.user.email || '').split('@')[0] || null;
  }

  /* Role disimpan di user_metadata (diisi create_user_account SQL) — 'admin'
     atau 'crew'. Default 'crew' kalau entah kenapa kosong (aman: makin kecil
     hak akses default-nya, makin baik). */
  function currentRole() {
    if (!session || !session.user) return null;
    const meta = session.user.user_metadata || {};
    return meta.role || 'crew';
  }

  /* Cuma untuk kontrol tampilan (sembunyikan menu Pengguna dari yang bukan
     admin) — penjaga SUNGGUHAN ada di SQL (list_user_accounts &
     create_user_account menolak sendiri kalau role pemanggil bukan admin),
     jadi ini aman dijadikan pengecekan sisi klien saja. */
  function isAdmin() {
    return currentRole() === 'admin';
  }

  /* Divisi yang ditugaskan ke akun ini — cuma diisi kalau role-nya
     'admin_divisi' (lihat create_user_account di auth_setup.sql). Dipakai
     buat menyaring Live Antrean & wording voice-over (lihat voiceAnnounce.js)
     supaya admin divisi cuma lihat/dengar pesanan divisinya sendiri. */
  function currentDivisi() {
    if (!session || !session.user) return null;
    const meta = session.user.user_metadata || {};
    return meta.divisi || null;
  }

  function isAdminDivisi() {
    return currentRole() === 'admin_divisi';
  }

  /* Role 'spinning' — dashboard & sidebar TOTAL beda (bukan cuma versi
     terfilter dari dashboard gudang seperti admin_divisi), lihat
     spinningDashboard.js & app.js layout(). Tetap dianggap "divisi-scoped"
     yang sama kayak admin_divisi buat modul yang di-reuse (Antrean/Laporan
     ATK) — lihat isDivisiScoped(). */
  function isSpinning() {
    return currentRole() === 'spinning';
  }

  /* Dipakai modul yang di-reuse lintas role (permintaan.js, laporanDivisi.js,
     voiceAnnounce.js) buat nyaring data cuma punya divisinya sendiri —
     admin_divisi DAN spinning dua-duanya masuk kategori ini. */
  function isDivisiScoped() {
    return isAdminDivisi() || isSpinning();
  }

  /* Akses 'edit' (default) atau 'view' — CUMA relevan buat role 'spinning',
     diatur admin lewat halaman Manajemen Pengguna (update_user_access_level
     RPC). 'view' bikin spinningPartMesin.js mendisable semua tombol
     ajukan/approve/tambah, murni sisi tampilan (RLS tabelnya tetap
     `authenticated` biasa — cukup buat tim kecil yang saling percaya). */
  function currentAccessLevel() {
    if (!session || !session.user) return 'edit';
    const meta = session.user.user_metadata || {};
    return meta.access_level || 'edit';
  }
  function isViewOnly() {
    return isSpinning() && currentAccessLevel() === 'view';
  }

  async function signIn(username, password) {
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');
    const { data, error } = await client.auth.signInWithPassword({
      email: usernameToEmail(username),
      password: password,
    });
    if (error) {
      // Pesan asli Supabase ("Invalid login credentials") sudah cukup jelas,
      // tapi diberi konteks tambahan karena akun di sini dibuat lewat app sendiri.
      if (/invalid login credentials/i.test(error.message)) {
        throw new Error('Username atau password salah.');
      }
      throw error;
    }
    session = data.session;
    recordActivity();
    startIdleWatcher();
    notify();
    return session;
  }

  async function signOut() {
    if (client) await client.auth.signOut();
    session = null;
    notify();
  }

  function onChange(fn) { listeners.push(fn); }

  /* Buat akun baru lewat fungsi SQL `create_user_account` (lihat
     database/auth_setup.sql) — dipanggil sebagai RPC biasa lewat client
     Supabase yang sama dipakai query data lain. Tidak ada Edge Function,
     tidak ada service_role key di frontend: fungsi SQL-nya sendiri yang
     bertindak sebagai "penjaga pintu" (security definer + pengecekan
     auth.uid() di dalamnya) — dijelaskan lengkap di file SQL itu.

     Sengaja bisa dipanggil tanpa sesi login (client tetap terbentuk dengan
     anon key walau belum ada yang login) — akun pertama harus bisa dibuat
     sebelum ada siapa pun yang bisa login. Fungsi SQL sendiri yang menolak
     kalau ternyata sudah ada akun lain dan pemanggil belum login. */
  async function createUserAccount(username, password, role, divisi, accessLevel) {
    if (DEMO) throw new Error('Fitur ini hanya tersedia setelah Supabase dikonfigurasi (bukan mode demo).');
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');

    const { data, error } = await client.rpc('create_user_account', {
      p_username: username,
      p_password: password,
      p_role: role || 'crew',
      p_divisi: divisi || null,
      p_access_level: accessLevel || 'edit',
    });
    if (error) {
      // Pesan dari `raise exception` di SQL muncul di error.message apa adanya.
      throw new Error(error.message || 'Gagal membuat akun.');
    }
    return { ok: true, user: data }; // data = { id, username, role }
  }

  /* Ubah access_level (edit|view) akun role spinning yang SUDAH ada — beda
     dari createUserAccount (bikin baru). Cuma admin yang boleh (dicek lagi
     di SQL, bukan cuma di sini). */
  async function updateAccessLevel(username, accessLevel) {
    if (DEMO) throw new Error('Fitur ini hanya tersedia setelah Supabase dikonfigurasi (bukan mode demo).');
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');
    const { error } = await client.rpc('update_user_access_level', {
      p_username: username, p_access_level: accessLevel,
    });
    if (error) throw new Error(error.message || 'Gagal mengubah akses.');
    return { ok: true };
  }

  /* Daftar semua akun — dipakai halaman Manajemen Pengguna. */
  async function listUserAccounts() {
    if (DEMO) return [];
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');
    const { data, error } = await client.rpc('list_user_accounts');
    if (error) throw new Error(error.message || 'Gagal mengambil daftar pengguna.');
    return data || [];
  }

  /* "Lupa Password" versi admin — nggak ada email asli di sistem ini buat
     ngirim link reset (email-nya sintetis <username>@spb.local), jadi admin
     yang reset langsung dari halaman Manajemen Pengguna, termasuk buat akun
     admin itu sendiri kalau lupa password login-nya sendiri. */
  async function resetUserPassword(username, newPassword) {
    if (DEMO) throw new Error('Fitur ini hanya tersedia setelah Supabase dikonfigurasi (bukan mode demo).');
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');
    const { error } = await client.rpc('reset_user_account_password', {
      p_username: username, p_new_password: newPassword,
    });
    if (error) throw new Error(error.message || 'Gagal reset password.');
    return { ok: true };
  }

  /* "Lupa Password" versi halaman Login — dipanggil TANPA sesi login sama
     sekali (beda dari resetUserPassword di atas yang wajib admin login dulu).
     Sengaja tanpa verifikasi tambahan, sesuai keputusan eksplisit pemilik
     sistem ini — lihat komentar forgot_password_reset di auth_setup.sql. */
  async function forgotPassword(username, newPassword) {
    if (DEMO) throw new Error('Fitur ini hanya tersedia setelah Supabase dikonfigurasi (bukan mode demo).');
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');
    const { error } = await client.rpc('forgot_password_reset', {
      p_username: username, p_new_password: newPassword,
    });
    if (error) throw new Error(error.message || 'Gagal reset password.');
    return { ok: true };
  }

  /* Hapus akun login — admin-only, tidak bisa hapus diri sendiri/admin
     terakhir (dicek lagi di SQL). Dipakai tombol "Hapus" di Manajemen
     Pengguna. */
  async function deleteUserAccount(username) {
    if (DEMO) throw new Error('Fitur ini hanya tersedia setelah Supabase dikonfigurasi (bukan mode demo).');
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');
    const { error } = await client.rpc('delete_user_account', { p_username: username });
    if (error) throw new Error(error.message || 'Gagal menghapus pengguna.');
    return { ok: true };
  }

  const api = {
    init: init,
    getSession: getSession,
    isAuthed: isAuthed,
    currentUsername: currentUsername,
    currentRole: currentRole,
    isAdmin: isAdmin,
    currentDivisi: currentDivisi,
    isAdminDivisi: isAdminDivisi,
    isSpinning: isSpinning,
    isDivisiScoped: isDivisiScoped,
    currentAccessLevel: currentAccessLevel,
    isViewOnly: isViewOnly,
    updateAccessLevel: updateAccessLevel,
    signIn: signIn,
    signOut: signOut,
    createUserAccount: createUserAccount,
    listUserAccounts: listUserAccounts,
    resetUserPassword: resetUserPassword,
    forgotPassword: forgotPassword,
    deleteUserAccount: deleteUserAccount,
    onChange: onChange,
    isDemo: function () { return DEMO; },
    __ready: false, // true setelah init() menyelesaikan pengecekan sesi pertama
  };

  window.SPB = window.SPB || {};
  window.SPB.sb = client; // client Supabase mentah — dipakai supabaseClient.js
  window.SPB.auth = api;
})();
