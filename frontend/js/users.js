/* =========================================================
   SPB · users.js
   Halaman Manajemen Pengguna (#/pengguna) — daftar semua akun login +
   tombol Tambah Pengguna. Bukan modal kecil, ini halaman penuh di dalam
   layout utama, dipakai admin/siapa pun yang sudah login untuk mengelola
   siapa saja yang bisa masuk ke SPB.
   ========================================================= */

(function () {
  'use strict';

  const PAGE_SIZE = 15;
  let rows = [];
  let currentPage = 1;
  let loading = true;
  let loadError = '';

  function roleBadge(role) {
    const isAdmin = role === 'admin';
    return '<span class="role-badge ' + (isAdmin ? 'role-admin' : 'role-crew') + '">' +
      (isAdmin ? 'Admin' : 'Crew') + '</span>';
  }

  function goToPage(page) { currentPage = page; render(); }

  // Pola sama persis dengan paginationHtml() di whOut.js — biar konsisten
  // sama halaman list lainnya, semua punya page navigation.
  function paginationHtml(page, totalPages, totalRows) {
    if (totalRows === 0) return '';
    if (totalPages <= 1) return '<div class="pagination"><span class="pagination-info">' + totalRows + ' data</span></div>';
    const pages = [];
    const add = function (p) { if (pages.indexOf(p) === -1) pages.push(p); };
    add(1); add(totalPages);
    for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) add(p);
    pages.sort(function (a, b) { return a - b; });
    let numbersHtml = '';
    let prev = 0;
    pages.forEach(function (p) {
      if (p - prev > 1) numbersHtml += '<span class="pagination-ellipsis">…</span>';
      numbersHtml += '<button type="button" class="pagination-num' + (p === page ? ' active' : '') +
        '" onclick="SPB.users.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.users.goToPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.users.goToPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  function fmtDateTime(v) {
    if (!v) return '<span class="muted">belum pernah login</span>';
    const d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  async function load() {
    loading = true;
    loadError = '';
    render();
    try {
      rows = await window.SPB.auth.listUserAccounts();
    } catch (err) {
      rows = [];
      loadError = err.message || 'Gagal memuat daftar pengguna.';
    }
    loading = false;
    render();
  }

  function openAddUser() {
    window.SPB.addUser.open(function () { load(); }); // refresh daftar setelah akun baru dibuat
  }

  function render() {
    const app = document.getElementById('app');
    const ui = window.SPB.ui;
    const myUsername = window.SPB.auth.currentUsername();

    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const pageStart = (currentPage - 1) * PAGE_SIZE;
    const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

    const tableRows = pageRows.map(function (r) {
      const isMe = r.username === myUsername;
      return '<tr>' +
        '<td><p class="font-bold" style="color:var(--slate-800)">' + esc(r.username) +
          (isMe ? ' <span class="me-tag">kamu</span>' : '') + '</p></td>' +
        '<td>' + roleBadge(r.role) + '</td>' +
        '<td style="font-size:0.875rem;color:var(--slate-500)">' + fmtDateTime(r.created_at) + '</td>' +
        '<td style="font-size:0.875rem;color:var(--slate-500)">' + fmtDateTime(r.last_sign_in_at) + '</td>' +
        '<td class="text-right"><button type="button" class="btn btn-outline btn-sm" onclick="SPB.resetPassword.open(\'' + esc(r.username).replace(/'/g, "\\'") + '\')">' +
          '<i data-lucide="key-round" class="icon-sm"></i>Reset Password</button></td>' +
      '</tr>';
    }).join('');

    const mobileCards = pageRows.map(function (r) {
      const isMe = r.username === myUsername;
      return '<div class="mobile-card" style="cursor:default">' +
        '<div class="mobile-card-top"><div>' +
          '<p class="mobile-card-po">' + esc(r.username) + (isMe ? ' <span class="me-tag">kamu</span>' : '') + '</p>' +
          '<p class="mobile-card-vendor">Dibuat: ' + fmtDateTime(r.created_at) + '</p>' +
        '</div>' + roleBadge(r.role) + '</div>' +
        '<div class="mobile-card-bottom"><span>Login terakhir: ' + fmtDateTime(r.last_sign_in_at) + '</span>' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.resetPassword.open(\'' + esc(r.username).replace(/'/g, "\\'") + '\')">' +
            '<i data-lucide="key-round" class="icon-sm"></i>Reset Password</button></div>' +
      '</div>';
    }).join('') || '<div class="empty-state">Belum ada pengguna.</div>';

    let body;
    if (loading) {
      body = '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat daftar pengguna...</div>';
    } else if (loadError) {
      body = '<div class="empty-state" style="color:var(--red-600)">' + esc(loadError) + '</div>';
    } else {
      body =
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Username</th><th>Role</th><th>Dibuat</th><th>Login Terakhir</th><th></th></tr></thead>' +
          '<tbody>' + (tableRows || '<tr><td colspan="5" class="empty-state">Belum ada pengguna.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
        '<div class="mobile-cards">' + mobileCards + '</div>' +
        paginationHtml(currentPage, totalPages, rows.length);
    }

    app.innerHTML = ui.layout('users',
      '<div class="page-head">' +
        '<div><h1 class="page-title">Manajemen Pengguna</h1>' +
        '<p class="page-sub">Daftar akun yang bisa login ke SPB — ' + rows.length + ' akun terdaftar.</p></div>' +
        '<button type="button" class="btn btn-primary" onclick="SPB.users.openAddUser()">' +
          '<i data-lucide="user-plus" class="icon-sm"></i>Tambah Pengguna</button>' +
      '</div>' +
      '<div class="table-card">' + body + '</div>' +
      '<div class="callout"><i data-lucide="info" class="icon-md"></i>' +
        '<p>Login pakai <b>username</b>, bukan email. <b>Admin</b> bisa lihat halaman ini & kelola ' +
        'pengguna; <b>Crew</b> cuma lihat Dashboard dan Input Barang (alur terima barang) — menu ' +
        'ini tersembunyi buat mereka.</p></div>'
    );
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.users = { render: load, openAddUser: openAddUser, goToPage: goToPage };
})();
