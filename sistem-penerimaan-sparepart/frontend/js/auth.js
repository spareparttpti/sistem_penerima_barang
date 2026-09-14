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

  /* Dipanggil sekali saat boot. Mengembalikan Promise supaya app.js bisa
     menunggu status login diketahui SEBELUM memutuskan render halaman mana. */
  function init() {
    if (initPromise) return initPromise;
    if (DEMO || !client) {
      api.__ready = true;
      initPromise = Promise.resolve(null);
      return initPromise;
    }
    initPromise = client.auth.getSession().then(function (res) {
      session = res.data.session;
      client.auth.onAuthStateChange(function (_event, newSession) {
        session = newSession;
        notify();
      });
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
  async function createUserAccount(username, password, role) {
    if (DEMO) throw new Error('Fitur ini hanya tersedia setelah Supabase dikonfigurasi (bukan mode demo).');
    if (!client) throw new Error('Supabase belum dikonfigurasi di config.js.');

    const { data, error } = await client.rpc('create_user_account', {
      p_username: username,
      p_password: password,
      p_role: role || 'crew',
    });
    if (error) {
      // Pesan dari `raise exception` di SQL muncul di error.message apa adanya.
      throw new Error(error.message || 'Gagal membuat akun.');
    }
    return { ok: true, user: data }; // data = { id, username, role }
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

  const api = {
    init: init,
    getSession: getSession,
    isAuthed: isAuthed,
    currentUsername: currentUsername,
    currentRole: currentRole,
    isAdmin: isAdmin,
    signIn: signIn,
    signOut: signOut,
    createUserAccount: createUserAccount,
    listUserAccounts: listUserAccounts,
    resetUserPassword: resetUserPassword,
    forgotPassword: forgotPassword,
    onChange: onChange,
    isDemo: function () { return DEMO; },
    __ready: false, // true setelah init() menyelesaikan pengecekan sesi pertama
  };

  window.SPB = window.SPB || {};
  window.SPB.sb = client; // client Supabase mentah — dipakai supabaseClient.js
  window.SPB.auth = api;
})();
