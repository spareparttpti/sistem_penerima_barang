/* =========================================================
   SPB · login.js
   Halaman login (email + password, Supabase Auth). Dirender TANPA layout
   header/nav utama — pengguna yang belum login tidak perlu melihat menu
   internal aplikasi.

   Tidak ada form pendaftaran bebas (siapa saja isi sendiri) — akun dibuat lewat
   modal Tambah Pengguna (addUser.js): akun pertama lewat link di bawah form ini,
   akun berikutnya lewat tombol di header setelah login. Lihat auth.js & database/
   auth_setup.sql untuk aturan siapa boleh membuat akun kapan.

   Juga ada mode "Lupa Password" (toggle di form yang sama, bukan halaman
   terpisah) — reset password TANPA perlu login dulu, lewat RPC
   forgot_password_reset (lihat auth.js & auth_setup.sql). SENGAJA tanpa
   verifikasi identitas tambahan (nggak ada pertanyaan keamanan/PIN/email),
   sesuai keputusan eksplisit pemilik sistem ini — cukup username + password
   baru langsung ganti.
   ========================================================= */

(function () {
  'use strict';

  let submitting = false;
  let errorMsg = '';
  let successMsg = '';
  let mode = 'login'; // 'login' | 'forgot'

  function switchMode(next) {
    mode = next;
    errorMsg = '';
    successMsg = '';
    render();
  }

  function render() {
    const app = document.getElementById('app');
    const forgot = mode === 'forgot';
    app.innerHTML =
      '<div class="login-wrap">' +
        '<div class="login-card">' +
          '<div class="login-brand">' +
            '<span class="brand-logo"><i data-lucide="package" class="icon-md"></i></span>' +
            '<div><p class="login-brand-name">SPB · Sparepart</p>' +
            '<p class="login-brand-sub">Sistem Penerimaan Barang</p></div>' +
          '</div>' +
          '<h1 class="login-title">' + (forgot ? 'Lupa Password' : 'Masuk') + '</h1>' +
          '<p class="login-sub">' + (forgot
            ? 'Masukkan username & password baru — langsung diganti, tanpa email.'
            : 'Masukkan username &amp; password akun kamu.') + '</p>' +
          (errorMsg ? '<div class="login-error"><i data-lucide="alert-circle" class="icon-sm"></i>' + esc(errorMsg) + '</div>' : '') +
          (successMsg ? '<div class="adduser-success"><i data-lucide="check-circle-2" class="icon-sm"></i>' + esc(successMsg) + '</div>' : '') +
          (forgot ? forgotFormHtml() : loginFormHtml()) +
          '<p class="login-foot">' + (forgot
            ? '<a href="#" onclick="event.preventDefault();SPB.login.switchMode(\'login\')">← Kembali ke halaman Masuk</a>'
            : 'Lupa password? <a href="#" onclick="event.preventDefault();SPB.login.switchMode(\'forgot\')">Reset di sini</a>' +
              '<br>Belum ada akun sama sekali di sistem ini? ' +
              '<a href="#" onclick="event.preventDefault();SPB.addUser.open()">Buat akun pertama</a>') +
          '</p>' +
        '</div>' +
      '</div>';
    window.SPB.ui.afterRender();
  }

  function loginFormHtml() {
    return '<form onsubmit="event.preventDefault();SPB.login.submit()">' +
      '<label class="field-label" for="lg-username">Username</label>' +
      '<input type="text" id="lg-username" class="input" placeholder="cth: budi" autocapitalize="off" ' +
        'autocomplete="username" required ' + (submitting ? 'disabled' : '') + '>' +
      '<label class="field-label" for="lg-password" style="margin-top:0.75rem">Password</label>' +
      '<input type="password" id="lg-password" class="input" placeholder="••••••••" ' +
        'autocomplete="current-password" required ' + (submitting ? 'disabled' : '') + '>' +
      '<button type="submit" class="btn btn-primary login-btn" ' + (submitting ? 'disabled' : '') + '>' +
        (submitting
          ? '<i data-lucide="loader-2" class="icon-sm spin"></i>Masuk...'
          : '<i data-lucide="log-in" class="icon-sm"></i>Masuk') +
      '</button>' +
    '</form>';
  }

  function forgotFormHtml() {
    return '<form onsubmit="event.preventDefault();SPB.login.submitForgot()">' +
      '<label class="field-label" for="fp-username">Username</label>' +
      '<input type="text" id="fp-username" class="input" placeholder="cth: budi" autocapitalize="off" ' +
        'autocomplete="username" required ' + (submitting ? 'disabled' : '') + '>' +
      '<label class="field-label" for="fp-password" style="margin-top:0.75rem">Password Baru</label>' +
      '<input type="text" id="fp-password" class="input" placeholder="bebas, terserah" ' +
        'autocomplete="off" required ' + (submitting ? 'disabled' : '') + '>' +
      '<button type="submit" class="btn btn-primary login-btn" ' + (submitting ? 'disabled' : '') + '>' +
        (submitting
          ? '<i data-lucide="loader-2" class="icon-sm spin"></i>Menyimpan...'
          : '<i data-lucide="key-round" class="icon-sm"></i>Ganti Password') +
      '</button>' +
    '</form>';
  }

  async function submit() {
    const userEl = document.getElementById('lg-username');
    const pwEl = document.getElementById('lg-password');
    const username = (userEl.value || '').trim();
    const password = pwEl.value || '';

    if (!username || !password) {
      errorMsg = 'Isi username dan password.';
      render();
      return;
    }

    submitting = true;
    errorMsg = '';
    render();

    try {
      await window.SPB.auth.signIn(username, password);
      submitting = false;
      errorMsg = '';
      location.hash = '#/overview';
      // signIn men-trigger onChange -> router re-render, tapi dipanggil eksplisit
      // juga di sini untuk memastikan pindah dari #/login segera, tanpa nunggu
      // event listener lain.
      if (window.SPB.app && window.SPB.app.render) window.SPB.app.render();
    } catch (err) {
      submitting = false;
      errorMsg = err.message || 'Login gagal.';
      render();
    }
  }

  async function submitForgot() {
    const userEl = document.getElementById('fp-username');
    const pwEl = document.getElementById('fp-password');
    const username = (userEl.value || '').trim();
    const password = pwEl.value || '';

    if (!username || !password) {
      errorMsg = 'Isi username dan password baru.';
      render();
      return;
    }

    submitting = true;
    errorMsg = '';
    render();

    try {
      await window.SPB.auth.forgotPassword(username, password);
      submitting = false;
      successMsg = 'Password akun "' + username + '" berhasil diganti — silakan login pakai password baru.';
      mode = 'login';
      render();
      // Isi ulang username-nya di form login biar tinggal ketik password.
      const loginUserEl = document.getElementById('lg-username');
      if (loginUserEl) loginUserEl.value = username;
    } catch (err) {
      submitting = false;
      errorMsg = err.message || 'Gagal reset password.';
      render();
    }
  }

  // Dipanggil pas logout — tanpa ini, pesan sukses "Password berhasil diganti"
  // (atau error lama) ketinggal nempel di variabel modul ini dan kelihatan
  // lagi pas balik ke halaman login berikutnya, padahal itu sisa dari sesi
  // sebelumnya, bukan hasil aksi yang baru saja terjadi.
  function resetState() {
    submitting = false;
    errorMsg = '';
    successMsg = '';
    mode = 'login';
  }

  window.SPB = window.SPB || {};
  window.SPB.login = { render: render, submit: submit, submitForgot: submitForgot, switchMode: switchMode, resetState: resetState };
})();
