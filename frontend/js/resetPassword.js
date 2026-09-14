/* =========================================================
   SPB · resetPassword.js
   Modal "Reset Password" — versi admin dari "Lupa Password", dipanggil dari
   halaman Manajemen Pengguna (users.js). Nggak ada alur email di sistem ini
   (email login itu sintetis <username>@spb.local, bukan email asli), jadi
   satu-satunya jalan reset itu admin yang set password baru langsung lewat
   RPC reset_user_account_password (lihat database/auth_setup.sql) — termasuk
   buat reset akun admin itu sendiri kalau lupa password login-nya sendiri.
   ========================================================= */

(function () {
  'use strict';

  let open = false;
  let submitting = false;
  let errorMsg = '';
  let successMsg = '';
  let targetUsername = '';

  function openModal(username) {
    open = true;
    targetUsername = username;
    errorMsg = '';
    successMsg = '';
    render();
  }

  function closeModal() {
    open = false;
    const el = document.getElementById('resetpw-modal-root');
    if (el) el.innerHTML = '';
  }

  function render() {
    let root = document.getElementById('resetpw-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'resetpw-modal-root';
      document.body.appendChild(root);
    }
    if (!open) { root.innerHTML = ''; return; }

    root.innerHTML =
      '<div class="modal-backdrop">' +
        '<div class="modal slide-up" role="dialog" aria-modal="true" aria-label="Reset Password">' +
          '<p class="modal-title">Reset Password</p>' +
          '<p class="modal-sub">Akun <b>' + esc(targetUsername) + '</b> — password lama langsung diganti, tanpa email.</p>' +
          (errorMsg ? '<div class="login-error"><i data-lucide="alert-circle" class="icon-sm"></i>' + esc(errorMsg) + '</div>' : '') +
          (successMsg
            ? '<div class="adduser-success"><i data-lucide="check-circle-2" class="icon-sm"></i>' + esc(successMsg) + '</div>'
            : '<form onsubmit="event.preventDefault();SPB.resetPassword.submit()">' +
                '<label class="field-label" for="rp-password">Password Baru</label>' +
                '<input type="text" id="rp-password" class="input" placeholder="bebas, terserah" ' +
                  'autocomplete="off" required ' + (submitting ? 'disabled' : '') + '>' +
                '<p class="adduser-hint">Password ditampilkan apa adanya (bukan titik-titik) supaya mudah ' +
                  'dicatat/diberikan langsung ke orangnya — sampaikan lewat jalur yang aman.</p>' +
                '<div class="modal-actions">' +
                  '<button type="button" class="btn btn-outline" onclick="SPB.resetPassword.close()" ' + (submitting ? 'disabled' : '') + '>Batal</button>' +
                  '<button type="submit" class="btn btn-primary" ' + (submitting ? 'disabled' : '') + '>' +
                    (submitting ? '<i data-lucide="loader-2" class="icon-sm spin"></i>Menyimpan...' : '<i data-lucide="key-round" class="icon-sm"></i>Simpan Password Baru') +
                  '</button>' +
                '</div>' +
              '</form>') +
          (successMsg ? '<div class="modal-actions-single"><button type="button" class="btn btn-primary" onclick="SPB.resetPassword.close()">Selesai</button></div>' : '') +
        '</div>' +
      '</div>';
    window.SPB.ui.afterRender();
    root.querySelector('.modal-backdrop').addEventListener('click', function (e) {
      if (e.target === this && !submitting) closeModal();
    });
  }

  async function submit() {
    const pwEl = document.getElementById('rp-password');
    const password = pwEl.value || '';
    if (!password) {
      errorMsg = 'Password tidak boleh kosong.';
      render();
      return;
    }

    submitting = true;
    errorMsg = '';
    render();

    try {
      await window.SPB.auth.resetUserPassword(targetUsername, password);
      submitting = false;
      successMsg = 'Password akun "' + targetUsername + '" berhasil diganti.';
      render();
    } catch (err) {
      submitting = false;
      errorMsg = err.message || 'Gagal reset password.';
      render();
    }
  }

  window.SPB = window.SPB || {};
  window.SPB.resetPassword = { open: openModal, close: closeModal, submit: submit };
})();
