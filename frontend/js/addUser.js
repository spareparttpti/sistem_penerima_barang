/* =========================================================
   SPB · addUser.js
   Modal "Tambah Pengguna" — buat akun login baru (username + password + role)
   lewat fungsi SQL create_user_account (lihat database/auth_setup.sql), tanpa
   perlu buka Supabase Dashboard. Role dipilih di form (admin/crew) KECUALI
   saat bootstrap (akun pertama, belum ada sesi login) — SQL selalu memaksa
   admin untuk kasus itu, jadi selector-nya disembunyikan.

   Dipanggil dari dua tempat:
   - Halaman Masuk (login.js), sebelum ada akun sama sekali (bootstrap)
   - Halaman Manajemen Pengguna (users.js), setelah login — open() menerima
     callback opsional yang dipanggil setelah akun berhasil dibuat, supaya
     halaman itu bisa me-refresh daftarnya.
   ========================================================= */

(function () {
  'use strict';

  let open = false;
  let submitting = false;
  let errorMsg = '';
  let successMsg = '';
  let onSuccess = null;
  let role = '';
  let divisiValue = '';
  let usernameValue = '';
  let passwordValue = '';
  let accessLevel = 'edit';

  function openModal(onSuccessCb) {
    open = true;
    errorMsg = '';
    successMsg = '';
    role = '';
    divisiValue = '';
    usernameValue = '';
    passwordValue = '';
    accessLevel = 'edit';
    onSuccess = typeof onSuccessCb === 'function' ? onSuccessCb : null;
    render();
  }

  // Dipanggil dari onchange <select> role — bukan cuma renderLocal biasa,
  // soalnya field Divisi cuma muncul/hilang tergantung role yang dipilih.
  // Username/password yang udah diketik disimpan dulu SEBELUM render ulang,
  // soalnya render() nulis ulang innerHTML dari nol — kalau nggak disimpan,
  // isian yang sudah diketik bakal ikut hilang cuma gara-gara ganti role.
  function onRoleChange() {
    const roleEl = document.getElementById('au-role');
    const userEl = document.getElementById('au-username');
    const pwEl = document.getElementById('au-password');
    const accessEl = document.getElementById('au-access');
    if (userEl) usernameValue = userEl.value;
    if (pwEl) passwordValue = pwEl.value;
    if (accessEl) accessLevel = accessEl.value;
    role = roleEl ? roleEl.value : '';
    render();
    const divisiEl = document.getElementById('au-divisi');
    if (divisiEl) divisiEl.focus();
  }

  function closeModal() {
    open = false;
    onSuccess = null;
    const el = document.getElementById('adduser-modal-root');
    if (el) el.innerHTML = '';
  }

  function render() {
    let root = document.getElementById('adduser-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'adduser-modal-root';
      document.body.appendChild(root);
    }
    if (!open) { root.innerHTML = ''; return; }

    root.innerHTML =
      '<div class="modal-backdrop">' +
        '<div class="modal slide-up" role="dialog" aria-modal="true" aria-label="Tambah Pengguna">' +
          '<p class="modal-title">Tambah Pengguna</p>' +
          '<p class="modal-sub">Buat akun login baru untuk rekan kerja — langsung aktif.</p>' +
          (errorMsg ? '<div class="login-error"><i data-lucide="alert-circle" class="icon-sm"></i>' + esc(errorMsg) + '</div>' : '') +
          (successMsg
            ? '<div class="adduser-success"><i data-lucide="check-circle-2" class="icon-sm"></i>' + esc(successMsg) + '</div>'
            : '<form onsubmit="event.preventDefault();SPB.addUser.submit()">' +
                '<label class="field-label" for="au-username">Username</label>' +
                '<input type="text" id="au-username" class="input" placeholder="cth: budi" autocapitalize="off" ' +
                  'autocomplete="off" required ' + (submitting ? 'disabled' : '') + ' value="' + esc(usernameValue) + '">' +
                '<p class="adduser-hint" style="margin-top:0.25rem">3-32 karakter: huruf, angka, titik, underscore, atau strip. Tanpa spasi.</p>' +
                '<label class="field-label" for="au-password" style="margin-top:0.75rem">Password Awal</label>' +
                '<input type="text" id="au-password" class="input" placeholder="bebas, terserah" ' +
                  'autocomplete="off" required ' + (submitting ? 'disabled' : '') + ' value="' + esc(passwordValue) + '">' +
                '<p class="adduser-hint">Password ditampilkan apa adanya (bukan titik-titik) supaya mudah ' +
                  'dicatat/diberikan langsung ke orangnya — sampaikan lewat jalur yang aman.</p>' +
                // Bootstrap (akun pertama, belum ada sesi login) selalu dipaksa jadi
                // admin di sisi SQL apa pun yang dikirim — jadi pilihan role cuma
                // ditampilkan kalau sudah ada sesi login (menambah rekan kerja).
                (window.SPB.auth.isAuthed()
                  ? '<div class="adduser-role-field">' +
                    '<label class="field-label adduser-role-label" for="au-role">Role</label>' +
                    '<select id="au-role" class="select" required ' + (submitting ? 'disabled' : '') + ' onchange="SPB.addUser.onRoleChange()">' +
                      '<option value="" selected disabled>— Pilih Role —</option>' +
                      '<option value="crew"' + (role === 'crew' ? ' selected' : '') + '>Crew — cuma alur terima barang</option>' +
                      '<option value="admin"' + (role === 'admin' ? ' selected' : '') + '>Admin — kelola pengguna juga</option>' +
                      '<option value="admin_divisi"' + (role === 'admin_divisi' ? ' selected' : '') + '>Admin Divisi — cuma pesanan divisinya (voice "siap diambil")</option>' +
                      '<option value="spinning"' + (role === 'spinning' ? ' selected' : '') + '>Spinning — dashboard &amp; modul sendiri (ATK + Part Mesin)</option>' +
                    '</select></div>' +
                    (role === 'admin_divisi'
                      ? '<div class="adduser-role-field">' +
                        '<label class="field-label adduser-role-label" for="au-divisi">Divisi</label>' +
                        '<input type="text" id="au-divisi" class="input" placeholder="cth: Umum, Produksi, Finance" ' +
                          'autocomplete="off" required ' + (submitting ? 'disabled' : '') + ' value="' + esc(divisiValue) + '">' +
                        '<p class="adduser-hint">Harus PERSIS sama dengan nama divisi yang dipakai operator saat memesan lewat portal.</p>' +
                      '</div>'
                      : role === 'spinning'
                      ? '<p class="adduser-hint adduser-role-label">Akun ini otomatis terkunci ke divisi <b>Spinning</b>, dengan dashboard &amp; sidebar sendiri (bukan tampilan gudang biasa).</p>' +
                        '<div class="adduser-role-field">' +
                          '<label class="field-label" for="au-access">Akses Modul Part Mesin</label>' +
                          '<select id="au-access" class="select" ' + (submitting ? 'disabled' : '') + '>' +
                            '<option value="edit"' + (accessLevel === 'edit' ? ' selected' : '') + '>Bisa Edit — ajukan, approve, tambah data</option>' +
                            '<option value="view"' + (accessLevel === 'view' ? ' selected' : '') + '>View Only — cuma bisa lihat</option>' +
                          '</select>' +
                          '<p class="adduser-hint">Bisa diubah belakangan lewat tombol "Ubah Akses" di halaman ini.</p>' +
                        '</div>'
                      : '')
                  : '<p class="adduser-hint adduser-role-label">Akun pertama ini otomatis jadi <b>Admin</b>.</p>') +
                '<div class="modal-actions">' +
                  '<button type="button" class="btn btn-outline" onclick="SPB.addUser.close()" ' + (submitting ? 'disabled' : '') + '>Batal</button>' +
                  '<button type="submit" class="btn btn-primary" ' + (submitting ? 'disabled' : '') + '>' +
                    (submitting ? '<i data-lucide="loader-2" class="icon-sm spin"></i>Membuat...' : '<i data-lucide="user-plus" class="icon-sm"></i>Buat Akun') +
                  '</button>' +
                '</div>' +
              '</form>') +
          (successMsg ? '<div class="modal-actions-single"><button type="button" class="btn btn-primary" onclick="SPB.addUser.close()">Selesai</button></div>' : '') +
        '</div>' +
      '</div>';
    window.SPB.ui.afterRender();
    root.querySelector('.modal-backdrop').addEventListener('click', function (e) {
      if (e.target === this && !submitting) closeModal();
    });
  }

  async function submit() {
    const userEl = document.getElementById('au-username');
    const pwEl = document.getElementById('au-password');
    const roleEl = document.getElementById('au-role');
    const divisiEl = document.getElementById('au-divisi');
    const accessEl = document.getElementById('au-access');
    const username = (userEl.value || '').trim();
    const password = pwEl.value || '';
    usernameValue = userEl.value || '';
    passwordValue = pwEl.value || '';
    role = roleEl ? roleEl.value : 'admin'; // tanpa selector = bootstrap, SQL akan paksa admin
    divisiValue = divisiEl ? (divisiEl.value || '').trim() : '';
    accessLevel = accessEl ? accessEl.value : 'edit';

    if (roleEl && !role) {
      errorMsg = 'Pilih role dulu (Admin, Crew, atau Admin Divisi).';
      render();
      return;
    }

    // Validasi cepat di sisi klien — cocok dengan pola di database/auth_setup.sql,
    // supaya kesalahan ketik ketahuan sebelum kirim ke server (bukan pengganti
    // validasi server, cuma mempercepat feedback-nya).
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      errorMsg = 'Username 3-32 karakter: huruf, angka, titik, underscore, atau strip. Tanpa spasi.';
      render();
      return;
    }
    if (!password) {
      errorMsg = 'Password tidak boleh kosong.';
      render();
      return;
    }
    if (role === 'admin_divisi' && !divisiValue) {
      errorMsg = 'Isi nama divisinya dulu.';
      render();
      return;
    }

    submitting = true;
    errorMsg = '';
    render();

    try {
      const res = await window.SPB.auth.createUserAccount(username, password, role, divisiValue, accessLevel);
      submitting = false;
      const roleLabel = res.user.role === 'admin' ? 'Admin'
        : res.user.role === 'admin_divisi' ? ('Admin Divisi ' + res.user.divisi)
        : res.user.role === 'spinning' ? 'Spinning'
        : 'Crew';
      successMsg = 'Akun "' + res.user.username + '" (' + roleLabel + ') berhasil dibuat dan langsung aktif.';
      render();
      if (onSuccess) onSuccess(res.user);
    } catch (err) {
      submitting = false;
      errorMsg = err.message || 'Gagal membuat akun.';
      render();
    }
  }

  window.SPB = window.SPB || {};
  window.SPB.addUser = { open: openModal, close: closeModal, submit: submit, onRoleChange: onRoleChange };
})();
