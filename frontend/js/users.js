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

  /* ---------- Edit Permissions PER PENGGUNA (bukan per role/halaman
     terpisah) — user_permissions, lihat rolePermissionsClient.js
     (dbUserPermissions) & database/auth_setup.sql. Modul yang ditampilkan
     BEDA tergantung role akun yang lagi diedit: role 'spinning' dapat daftar
     modul sesuai sidebar Spinning-nya sendiri (lihat spinningSidebarHtml di
     app.js), role lain dapat daftar modul gudang biasa. ---------- */
  const GENERIC_MODULES = [
    { key: 'dashboard', label: 'Log Penerimaan' },
    { key: 'overview', label: 'Dashboard Ringkasan' },
    { key: 'input-barang', label: 'Input Barang' },
    { key: 'purchase-order', label: 'Purchase Order (ATK)' },
    { key: 'wh-out', label: 'WH/OUT' },
    { key: 'stok-barang', label: 'Stok Barang' },
    { key: 'karyawan', label: 'Karyawan' },
    { key: 'permintaan', label: 'Permintaan Barang' },
    { key: 'laporan', label: 'Laporan' },
    { key: 'pengguna', label: 'Pengguna' },
  ];
  // Persis urutan grup TRANSAKSI/MASTER DATA/LAPORAN di sidebar Spinning.
  const SPINNING_MODULES = [
    { key: 'spinning-dashboard', label: 'Dashboard' },
    { key: 'spinning-supplier', label: 'Supplier' },
    { key: 'spinning-inventory', label: 'Inventory / Stok Gudang', expandable: true },
    { key: 'spinning-satuan', label: 'Satuan' },
    { key: 'spinning-karyawan', label: 'Karyawan' },
    { key: 'spinning-pr', label: 'Purchase Request' },
    { key: 'spinning-po', label: 'Purchase Order' },
    { key: 'spinning-penerimaan', label: 'Penerimaan Barang' },
    { key: 'spinning-wo', label: 'Data Work Order' },
    { key: 'spinning-laporan', label: 'Laporan' },
  ];
  const PERM_ACTIONS = [
    { key: 'lihat', label: 'Lihat' }, { key: 'tambah', label: 'Tambah' }, { key: 'ubah', label: 'Ubah' },
    { key: 'hapus', label: 'Hapus' }, { key: 'approve', label: 'Approve' }, { key: 'ekspor', label: 'Ekspor' },
  ];
  let permEditingUsername = null;
  let permEditingRole = null;
  let permMatrix = null;
  let permLoading = false;
  let permSaving = false;
  let permDirty = false;
  // Cabang "lihat/edit per category sparepart" di baris Inventory — cuma
  // muncul kalau permEditingRole==='spinning'. Reuse role_inventory_access
  // yang sama dipakai halaman Inventory Spinning (masih di-scope per ROLE
  // 'spinning', bukan per username — semua akun Spinning berbagi aturan
  // category yang sama, cuma ditaruh di sini biar gampang diaksesnya).
  let inventoryExpanded = false;
  let accessRules = [];
  let accessCategories = [];
  let accessLoading = false;
  let accessNewType = 'category';

  function currentPermModules() { return permEditingRole === 'spinning' ? SPINNING_MODULES : GENERIC_MODULES; }
  function permEmptyMatrix(modules) {
    const m = {};
    modules.forEach(function (mod) { m[mod.key] = {}; PERM_ACTIONS.forEach(function (a) { m[mod.key][a.key] = false; }); });
    return m;
  }
  function permCountSelected() {
    let n = 0;
    currentPermModules().forEach(function (mod) { PERM_ACTIONS.forEach(function (a) { if (permMatrix[mod.key][a.key]) n++; }); });
    return n;
  }
  async function openPermEditor(username, role) {
    permEditingUsername = username;
    permEditingRole = role;
    permMatrix = permEmptyMatrix(currentPermModules());
    permDirty = false;
    permLoading = true;
    inventoryExpanded = false;
    render();
    try {
      const rows2 = await window.SPB.dbUserPermissions.listByUsername(username);
      rows2.forEach(function (r) { if (permMatrix[r.module]) permMatrix[r.module][r.action] = !!r.allowed; });
      if (role === 'spinning') await loadAccessRules();
    } catch (err) {
      window.SPB.ui.toast('Gagal memuat permissions', err.message, 'error');
    }
    permLoading = false;
    render();
  }
  async function closePermEditor() {
    if (permDirty && !await window.SPB.ui.confirm('Ada perubahan belum disimpan. Tutup tanpa menyimpan?', { danger: true, okText: 'Ya, Tutup' })) return;
    permEditingUsername = null;
    permEditingRole = null;
    permMatrix = null;
    render();
  }
  function permToggleCell(moduleKey, actionKey) {
    permMatrix[moduleKey][actionKey] = !permMatrix[moduleKey][actionKey];
    permDirty = true;
    render();
  }
  function permToggleRow(moduleKey) {
    const allOn = PERM_ACTIONS.every(function (a) { return permMatrix[moduleKey][a.key]; });
    PERM_ACTIONS.forEach(function (a) { permMatrix[moduleKey][a.key] = !allOn; });
    permDirty = true;
    render();
  }
  function permBulkSelectAll() {
    currentPermModules().forEach(function (mod) { PERM_ACTIONS.forEach(function (a) { permMatrix[mod.key][a.key] = true; }); });
    permDirty = true;
    render();
  }
  async function permBulkClearAll() {
    if (!await window.SPB.ui.confirm('Kosongkan semua izin untuk pengguna ini?', { danger: true, okText: 'Ya, Kosongkan' })) return;
    permMatrix = permEmptyMatrix(currentPermModules());
    permDirty = true;
    render();
  }
  function permBulkViewOnly() {
    currentPermModules().forEach(function (mod) { PERM_ACTIONS.forEach(function (a) { permMatrix[mod.key][a.key] = a.key === 'lihat'; }); });
    permDirty = true;
    render();
  }
  async function savePermMatrix() {
    permSaving = true;
    render();
    try {
      const allowedPairs = [];
      currentPermModules().forEach(function (mod) { PERM_ACTIONS.forEach(function (a) { if (permMatrix[mod.key][a.key]) allowedPairs.push({ module: mod.key, action: a.key }); }); });
      await window.SPB.dbUserPermissions.saveMatrix(permEditingUsername, allowedPairs);
      permDirty = false;
      window.SPB.ui.toast('Permissions disimpan', permEditingUsername, 'success');
    } catch (err) {
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
    }
    permSaving = false;
    render();
  }
  async function deleteUser(username) {
    if (!await window.SPB.ui.confirm('Hapus akun "' + username + '" secara permanen? Tindakan ini tidak bisa dibatalkan.', { danger: true, okText: 'Ya, Hapus' })) return;
    try {
      await window.SPB.auth.deleteUserAccount(username);
      window.SPB.ui.toast('Pengguna dihapus', username, 'success');
      load();
    } catch (err) {
      window.SPB.ui.toast('Gagal menghapus', err.message, 'error');
    }
  }

  /* ---------- Cabang Akses Inventory per Category (khusus role Spinning,
     nested di dalam baris "Inventory / Stok Gudang") ---------- */
  async function loadAccessRules() {
    accessLoading = true;
    try {
      const [ruleRows, categories] = await Promise.all([
        window.SPB.dbRoleAccess.listByRole('spinning'),
        window.SPB.dbRoleAccess.listDistinctCategories(),
      ]);
      accessRules = ruleRows;
      accessCategories = categories;
    } catch (err) {
      window.SPB.ui.toast('Gagal memuat aturan akses inventory', err.message, 'error');
    }
    accessLoading = false;
  }
  function toggleInventoryExpanded() { inventoryExpanded = !inventoryExpanded; render(); }
  function setAccessNewType(type) { accessNewType = type; render(); }
  async function addAccessRule() {
    const input = document.getElementById('access-new-value');
    const value = (input.value || '').trim();
    if (!value) { window.SPB.ui.toast('Isi dulu', 'Pilih/ketik category atau prefix SKU.', 'error'); return; }
    try {
      await window.SPB.dbRoleAccess.add('spinning', accessNewType, value);
      window.SPB.ui.toast('Aturan ditambahkan', value, 'success');
      await loadAccessRules();
      render();
    } catch (err) {
      window.SPB.ui.toast('Gagal menambah aturan', err.message.indexOf('duplicate') !== -1 ? 'Aturan ini sudah ada.' : err.message, 'error');
    }
  }
  async function removeAccessRule(id) {
    if (!await window.SPB.ui.confirm('Hapus aturan akses ini? Produk yang cocok jadi tidak kelihatan lagi buat role Spinning.', { danger: true, okText: 'Ya, Hapus' })) return;
    try {
      await window.SPB.dbRoleAccess.remove(id);
      await loadAccessRules();
      render();
    } catch (err) {
      window.SPB.ui.toast('Gagal menghapus', err.message, 'error');
    }
  }
  function accessChip(r) {
    return '<span class="access-chip ' + (r.match_type === 'category' ? 'category' : 'sku') + '">' +
      '<span class="dot"></span>' + esc(r.match_value) +
      (r.created_by ? '<span class="by">&middot; ' + esc(r.created_by) + '</span>' : '') +
      '<button type="button" onclick="SPB.users.removeAccessRule(\'' + r.id + '\')" title="Hapus aturan" aria-label="Hapus"><i data-lucide="x" style="width:0.7rem;height:0.7rem"></i></button>' +
    '</span>';
  }
  function inventoryAccessBranchHtml() {
    const categoryRules = accessRules.filter(function (r) { return r.match_type === 'category'; });
    const skuRules = accessRules.filter(function (r) { return r.match_type === 'sku_prefix'; });
    return '<tr><td colspan="' + (PERM_ACTIONS.length + 2) + '" style="background:var(--slate-50);padding:1rem 1.25rem 1.25rem">' +
      '<p style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--slate-500);margin-bottom:0.75rem">' +
        '<i data-lucide="corner-down-right" class="icon-sm" style="vertical-align:-2px;margin-right:0.3rem"></i>Akses per Category Sparepart (berlaku untuk semua akun role Spinning)</p>' +
      (accessLoading ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-sm spin" style="display:inline-block"></i> Memuat...</div>' :
      '<div class="access-section" style="margin-bottom:1rem">' +
        '<div class="access-section-head"><div class="access-section-icon category"><i data-lucide="tag" class="icon-sm"></i></div><span class="access-section-title">Category Odoo</span><span class="access-section-sub">' + categoryRules.length + ' aturan</span></div>' +
        '<div class="access-chips">' + (categoryRules.length ? categoryRules.map(accessChip).join('') : '<span class="access-empty-chip">Belum ada category yang diizinkan.</span>') + '</div>' +
      '</div>' +
      '<div class="access-section" style="margin-bottom:1rem">' +
        '<div class="access-section-head"><div class="access-section-icon sku"><i data-lucide="hash" class="icon-sm"></i></div><span class="access-section-title">Awalan SKU</span><span class="access-section-sub">' + skuRules.length + ' aturan</span></div>' +
        '<div class="access-chips">' + (skuRules.length ? skuRules.map(accessChip).join('') : '<span class="access-empty-chip">Belum ada awalan SKU khusus.</span>') + '</div>' +
      '</div>' +
      '<div class="access-add-row" style="margin-top:0">' +
        '<div><label class="field-label">Tipe</label><select id="access-new-type" class="select" onchange="SPB.users.setAccessNewType(this.value)">' +
          '<option value="category"' + (accessNewType === 'category' ? ' selected' : '') + '>Category</option>' +
          '<option value="sku_prefix"' + (accessNewType === 'sku_prefix' ? ' selected' : '') + '>SKU Prefix</option>' +
        '</select></div>' +
        '<div style="flex:1;min-width:14rem"><label class="field-label">' + (accessNewType === 'category' ? 'Category' : 'Awalan SKU') + '</label>' +
          (accessNewType === 'category'
            ? '<input id="access-new-value" class="input" list="access-category-list" placeholder="Pilih atau ketik category...">' +
              '<datalist id="access-category-list">' + accessCategories.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>'
            : '<input id="access-new-value" class="input" placeholder="mis. ATK-">') +
        '</div>' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.users.addAccessRule()"><i data-lucide="plus" class="icon-sm"></i>Tambah Aturan</button>' +
      '</div>') +
    '</td></tr>';
  }

  function permMatrixRow(mod) {
    const allOn = PERM_ACTIONS.every(function (a) { return permMatrix[mod.key][a.key]; });
    let out = '<tr>' +
      '<td style="font-weight:600">' + esc(mod.label) +
        (mod.expandable ? ' <button type="button" class="btn btn-outline btn-sm" style="padding:0.15rem 0.4rem;margin-left:0.35rem" onclick="SPB.users.toggleInventoryExpanded()" title="Akses per category"><i data-lucide="' + (inventoryExpanded ? 'chevron-up' : 'chevron-down') + '" class="icon-sm"></i></button>' : '') +
      '</td>' +
      PERM_ACTIONS.map(function (a) {
        return '<td class="text-center"><input type="checkbox" ' + (permMatrix[mod.key][a.key] ? 'checked' : '') + ' onchange="SPB.users.permToggleCell(\'' + mod.key + '\',\'' + a.key + '\')" style="width:1.1rem;height:1.1rem;cursor:pointer"></td>';
      }).join('') +
      '<td class="text-center"><button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.permToggleRow(\'' + mod.key + '\')" title="' + (allOn ? 'Kosongkan baris ini' : 'Pilih semua baris ini') + '"><i data-lucide="' + (allOn ? 'minus' : 'check') + '" class="icon-sm"></i></button></td>' +
    '</tr>';
    if (mod.expandable && inventoryExpanded) out += inventoryAccessBranchHtml();
    return out;
  }
  function permEditorModalHtml() {
    if (!permEditingUsername) return '';
    const modules = currentPermModules();
    const selected = permMatrix ? permCountSelected() : 0;
    const total = modules.length * PERM_ACTIONS.length;
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.users.closePermEditor()">' +
      '<div class="modal slide-up modal-2xl" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.users.closePermEditor()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="grid-3x3" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>Edit Permissions — ' + esc(permEditingUsername) + '</p>' +
        '<p class="modal-sub">Matriks modul x aksi khusus untuk akun ini' + (permEditingRole === 'spinning' ? ' (mengikuti menu sidebar Spinning).' : '.') + '</p>' +
        (permLoading ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>' :
        '<div>' +
          '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem">' +
            '<span class="badge-count" style="position:static">' + selected + ' / ' + total + ' izin dipilih</span>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.permBulkSelectAll()">Pilih Semua</button>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.permBulkClearAll()">Kosongkan</button>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.permBulkViewOnly()">Hanya Lihat</button>' +
          '</div>' +
          '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
            '<thead><tr><th>Modul</th>' + PERM_ACTIONS.map(function (a) { return '<th class="text-center">' + esc(a.label) + '</th>'; }).join('') + '<th class="text-center">Semua</th></tr></thead>' +
            '<tbody>' + modules.map(permMatrixRow).join('') + '</tbody>' +
          '</table></div></div>' +
        '</div>') +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.users.closePermEditor()">Batal</button>' +
          '<button type="button" class="btn btn-primary" onclick="SPB.users.savePermMatrix()" ' + (permSaving ? 'disabled' : '') + '>' +
            (permSaving ? '<i data-lucide="loader-2" class="icon-sm spin"></i>Menyimpan...' : '<i data-lucide="save" class="icon-sm"></i>Simpan Permissions') +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function roleBadge(role, divisi) {
    if (role === 'admin_divisi') {
      return '<span class="role-badge role-admin-divisi">Admin Divisi' + (divisi ? ' · ' + esc(divisi) : '') + '</span>';
    }
    if (role === 'spinning') {
      return '<span class="role-badge role-spinning">Spinning</span>';
    }
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
      const uArg = "'" + esc(r.username).replace(/'/g, "\\'") + "'";
      return '<tr>' +
        '<td><p class="font-bold" style="color:var(--slate-800)">' + esc(r.username) +
          (isMe ? ' <span class="me-tag">kamu</span>' : '') + '</p></td>' +
        '<td>' + roleBadge(r.role, r.divisi) + '</td>' +
        '<td style="font-size:0.875rem;color:var(--slate-500)">' + fmtDateTime(r.created_at) + '</td>' +
        '<td style="font-size:0.875rem;color:var(--slate-500)">' + fmtDateTime(r.last_sign_in_at) + '</td>' +
        '<td class="text-right" style="white-space:nowrap">' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.openPermEditor(' + uArg + ',\'' + r.role + '\')" title="Edit Permissions"><i data-lucide="pencil" class="icon-sm"></i>Edit</button> ' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.resetPassword.open(' + uArg + ')">' +
          '<i data-lucide="key-round" class="icon-sm"></i>Ubah Password</button> ' +
          (isMe ? '' : '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.deleteUser(' + uArg + ')" title="Hapus"><i data-lucide="trash-2" class="icon-sm"></i>Hapus</button>') +
        '</td>' +
      '</tr>';
    }).join('');

    const mobileCards = pageRows.map(function (r) {
      const isMe = r.username === myUsername;
      const uArg = "'" + esc(r.username).replace(/'/g, "\\'") + "'";
      return '<div class="mobile-card" style="cursor:default">' +
        '<div class="mobile-card-top"><div>' +
          '<p class="mobile-card-po">' + esc(r.username) + (isMe ? ' <span class="me-tag">kamu</span>' : '') + '</p>' +
          '<p class="mobile-card-vendor">Dibuat: ' + fmtDateTime(r.created_at) + '</p>' +
        '</div>' + roleBadge(r.role, r.divisi) + '</div>' +
        '<div class="mobile-card-bottom"><span>Login terakhir: ' + fmtDateTime(r.last_sign_in_at) + '</span>' +
          '<div style="display:flex;gap:0.5rem;flex-wrap:wrap">' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.openPermEditor(' + uArg + ',\'' + r.role + '\')"><i data-lucide="pencil" class="icon-sm"></i>Edit</button>' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.resetPassword.open(' + uArg + ')">' +
            '<i data-lucide="key-round" class="icon-sm"></i>Ubah Password</button>' +
          (isMe ? '' : '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.users.deleteUser(' + uArg + ')"><i data-lucide="trash-2" class="icon-sm"></i>Hapus</button>') +
          '</div></div>' +
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
        'ini tersembunyi buat mereka. Klik <b>Edit</b> di samping akun untuk atur permission modul/aksinya satu per satu.</p></div>'
    ) + permEditorModalHtml();
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.users = {
    render: load, openAddUser: openAddUser, goToPage: goToPage, deleteUser: deleteUser,
    setAccessNewType: setAccessNewType, addAccessRule: addAccessRule, removeAccessRule: removeAccessRule, toggleInventoryExpanded: toggleInventoryExpanded,
    openPermEditor: openPermEditor, closePermEditor: closePermEditor, permToggleCell: permToggleCell, permToggleRow: permToggleRow,
    permBulkSelectAll: permBulkSelectAll, permBulkClearAll: permBulkClearAll, permBulkViewOnly: permBulkViewOnly, savePermMatrix: savePermMatrix,
  };
})();
