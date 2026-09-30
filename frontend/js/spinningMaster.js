/* =========================================================
   SPB · spinningMaster.js
   Grup "MASTER DATA" role Spinning — 5 sub-halaman, 1 route per tab, semua
   di-handle file ini: #/master-data/supplier|category|inventory|satuan|karyawan.
   ========================================================= */

(function () {
  'use strict';

  let tab = 'supplier';
  let loading = true;
  let loadError = '';
  let mesinList = [];
  let partList = [];
  let supplierList = [];
  let satuanList = [];
  let karyawanList = []; // dari public.karyawan (sinkron Odoo), BUKAN spinning_karyawan — difilter divisi Spinning
  let stokList = []; // dari public.stok_barang (sinkron Odoo), difilter role_inventory_access (Admin Gudang atur)
  const karyawanFilters = { q: '', subDivisi: '', shift: '' };
  let karyawanView = 'list'; // 'list' | 'grid'
  let karyawanPage = 1;
  let karyawanPageSize = 10;
  const stokFilters = { q: '', category: '', availability: '' };
  let stokView = 'list'; // 'list' | 'grid'
  let stokPage = 1;
  let stokPageSize = 10;
  let stokDetailSku = null;
  let stokDetailLoading = false;
  let stokDetailMoves = [];
  let stokDetailPo = [];
  let stokDetailError = '';

  function t(key) { return window.SPB.spinningI18n.t(key); }
  function esc(s) { return window.esc(s); }
  // Re-render (render()) selalu ganti innerHTML dari nol — kalau dipanggil
  // langsung tiap keystroke di kotak cari, focus & posisi kursor ke-reset
  // tiap huruf, user jadi harus klik ulang ke kotaknya tiap mau ngetik huruf
  // berikutnya. Fix-nya: simpan posisi kursor SEBELUM render, balikin fokus +
  // posisi kursor itu SESUDAH render — sama pola yang sudah dipakai di
  // karyawan.js (modul Karyawan umum).
  function applyFilterKeepFocus(setFn) {
    const active = document.activeElement;
    const isSearchBox = active && active.classList && active.classList.contains('search-input');
    const caret = isSearchBox ? active.selectionStart : null;
    setFn();
    render();
    if (isSearchBox) {
      const el = document.querySelector('.search-input');
      if (el) {
        el.focus();
        const pos = caret == null ? el.value.length : caret;
        el.setSelectionRange(pos, pos);
      }
    }
  }
  function isViewOnly() { return !!(window.SPB.auth && window.SPB.auth.isViewOnly && window.SPB.auth.isViewOnly()); }
  function partLabel(p) {
    const parent = p.parent_id ? partList.find(function (x) { return x.id === p.parent_id; }) : null;
    return (parent ? parent.nama_part + ' > ' : '') + p.nama_part;
  }
  function viewOnlyBanner() {
    return '<div class="callout" style="margin-bottom:1.25rem"><i data-lucide="eye" class="icon-md"></i><p>' + esc(t('pm_viewonly_katalog')) + '</p></div>';
  }
  // Format department Odoo "DIVISI / SUB DIVISI / POS" — sama pola parsing
  // dengan karyawan.js/laporan.js, biar konsisten di seluruh app.
  function divisiOf(k) { return ((k.department || '').split(' / ')[0] || '').trim(); }
  function subDivisiOf(k) { return ((k.department || '').split(' / ')[1] || '').trim(); }

  async function load() {
    loading = true;
    loadError = '';
    render();
    try {
      const [mRows, ptRows, supRows, satRows, allKaryawan, allStok, accessRules] = await Promise.all([
        window.SPB.dbSpinning.listMesin(),
        window.SPB.dbSpinning.listPart(),
        window.SPB.dbSpinning.listSupplier(),
        window.SPB.dbSpinning.listSatuanOdoo(),
        window.SPB.dbKaryawan.list(),
        window.SPB.dbStokBarang.list(),
        window.SPB.dbRoleAccess.listByRole('spinning'),
      ]);
      mesinList = mRows; partList = ptRows; supplierList = supRows; satuanList = satRows;
      karyawanList = allKaryawan.filter(function (k) { return divisiOf(k).toLowerCase() === 'spinning'; });
      // Daftar category/prefix SKU yang boleh dilihat role Spinning SEKARANG
      // diatur Admin Gudang dari halaman Manajemen Pengguna (bukan hardcode
      // lagi) — lihat role_inventory_access di database/stok_barang_schema.sql
      // dan tab "Akses Inventory per Role" di users.js.
      stokList = allStok.filter(function (s) { return window.SPB.dbRoleAccess.matchRules(s, accessRules); });
    } catch (err) {
      loadError = err.message || 'Gagal memuat data.';
    }
    loading = false;
    render();
  }
  function setTab(tb) { tab = tb; location.hash = '#/master-data/' + tb; render(); }

  /* ---------- Supplier (Odoo, read-mostly) ---------- */
  const supplierFilters = { q: '', status: '' };
  let supplierProductsForId = null;
  let supplierProductsRows = [];
  let supplierProductsLoading = false;
  let supplierEditId = null;
  function supplierSetFilter(key, value) { applyFilterKeepFocus(function () { supplierFilters[key] = value; }); }
  function supplierResetFilter() { supplierFilters.q = ''; supplierFilters.status = ''; render(); }
  async function syncSuppliersFromOdoo() {
    try {
      const res = await window.SPB.dbSpinning.syncSuppliersFromOdoo();
      window.SPB.ui.toast('Sync selesai', res.fetched + ' supplier & ' + res.productsUpserted + ' item price list ditarik.', 'success');
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal sync', err.message, 'error'); }
  }
  async function deleteSupplier(id, nama) {
    const ok = await window.SPB.ui.confirm('Hapus supplier "' + nama + '"? Riwayat PO lama tetap ada, cuma sudah tidak terhubung ke master supplier ini.', { title: 'Hapus Supplier', danger: true, okText: 'Hapus' });
    if (!ok) return;
    try {
      await window.SPB.dbSpinning.deleteSupplier(id);
      window.SPB.ui.toast('Supplier dihapus', nama, 'success');
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  async function toggleSupplierStatus(id, currentStatus) {
    try {
      await window.SPB.dbSpinning.updateSupplierMeta(id, { status: currentStatus === 'Aktif' ? 'Nonaktif' : 'Aktif' });
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  async function saveSupplierTermin(id) {
    const input = document.getElementById('sup-termin-' + id);
    try {
      await window.SPB.dbSpinning.updateSupplierMeta(id, { termin_hari: input.value });
      window.SPB.ui.toast('Termin disimpan', '', 'success');
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  async function openSupplierProducts(id) {
    supplierProductsForId = id;
    supplierProductsRows = [];
    supplierProductsLoading = true;
    render();
    try {
      supplierProductsRows = await window.SPB.dbSpinning.listSupplierProducts(id);
    } catch (err) {
      window.SPB.ui.toast('Gagal memuat daftar produk', err.message, 'error');
    }
    supplierProductsLoading = false;
    render();
  }
  function closeSupplierProducts() { supplierProductsForId = null; render(); }
  function goToProductFromSupplier(sku) {
    if (!sku) return;
    supplierProductsForId = null; // tutup popup Vendor Pricelist dulu
    openStockDetail(sku); // baru buka popup Riwayat Pergerakan (Inventory)
  }
  function supplierProductsModalHtml() {
    if (!supplierProductsForId) return '';
    const supplier = supplierList.find(function (s) { return s.id === supplierProductsForId; });
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.spinningMaster.closeSupplierProducts()">' +
      '<div class="modal slide-up modal-lg" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.spinningMaster.closeSupplierProducts()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="package-search" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>Vendor Pricelist — ' + esc(supplier ? supplier.nama : '-') + '</p>' +
        '<p class="modal-sub">Daftar produk & harga dari supplier ini (ditarik dari Odoo).</p>' +
        (supplierProductsLoading ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>' :
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>SKU</th><th>Product</th><th class="text-right">Price</th><th>Currency</th><th class="text-right">Min Qty</th><th class="text-right">Delivery</th></tr></thead>' +
          '<tbody>' + (supplierProductsRows.length ? supplierProductsRows.map(function (p) {
            const clickable = !!p.sku;
            const skuSafe = clickable ? esc(p.sku).replace(/'/g, "\\'") : '';
            return '<tr' + (clickable ? ' style="cursor:pointer" onclick="SPB.spinningMaster.goToProductFromSupplier(\'' + skuSafe + '\')" title="Klik untuk lihat di Inventory/Stok Gudang"' : '') + '>' +
              '<td>' + esc(p.sku || '-') + '</td><td>' + esc(p.product_name) + '</td>' +
              '<td class="text-right">' + Number(p.price || 0).toLocaleString('id-ID') + '</td><td>' + esc(p.currency || '-') + '</td>' +
              '<td class="text-right">' + Number(p.min_qty || 0) + '</td><td class="text-right">' + (p.delay_hari != null ? p.delay_hari + ' hari' : '-') + '</td></tr>';
          }).join('') : '<tr><td colspan="6" class="empty-state">Belum ada Vendor Pricelist untuk supplier ini di Odoo.</td></tr>') + '</tbody>' +
        '</table></div></div>') +
        '<div class="modal-actions" style="grid-template-columns:1fr">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.spinningMaster.closeSupplierProducts()">Tutup</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function openSupplierEdit(id) { supplierEditId = id; render(); }
  function closeSupplierEdit() { supplierEditId = null; render(); }
  async function submitSupplierEdit(id) {
    const nama = document.getElementById('sup-e-nama').value.trim();
    if (!nama) { window.SPB.ui.toast('Data belum lengkap', 'Nama supplier tidak boleh kosong.', 'error'); return; }
    const status = document.querySelector('input[name="sup-e-status"]:checked').value;
    try {
      await window.SPB.dbSpinning.updateSupplierDetail(id, {
        kode: document.getElementById('sup-e-kode').value.trim(),
        nama: nama,
        kontak: document.getElementById('sup-e-kontak').value.trim(),
        telepon: document.getElementById('sup-e-telepon').value.trim(),
        email: document.getElementById('sup-e-email').value.trim(),
        kota: document.getElementById('sup-e-kota').value.trim(),
        alamat: document.getElementById('sup-e-alamat').value.trim(),
        npwp: document.getElementById('sup-e-npwp').value.trim(),
        kategori_utama: document.getElementById('sup-e-kategori').value.trim(),
        termin_hari: document.getElementById('sup-e-termin').value,
        rating: document.getElementById('sup-e-rating').value,
        status: status,
      });
      window.SPB.ui.toast('Supplier disimpan', nama, 'success');
      supplierEditId = null;
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  function supplierEditModalHtml() {
    if (!supplierEditId) return '';
    const s = supplierList.find(function (x) { return x.id === supplierEditId; });
    if (!s) return '';
    function field(label, id, value, opts) {
      opts = opts || {};
      return '<div><label class="field-label">' + label + '</label><input id="' + id + '" class="input" type="' + (opts.type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + (opts.placeholder ? ' placeholder="' + opts.placeholder + '"' : '') + '></div>';
    }
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.spinningMaster.closeSupplierEdit()">' +
      '<div class="modal slide-up modal-lg" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.spinningMaster.closeSupplierEdit()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="square-pen" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>Ubah Supplier</p>' +
        '<p class="modal-sub">Ubah data: ' + esc(s.nama) + '</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.85rem">' +
          field('Kode Supplier', 'sup-e-kode', s.kode) +
          field('Nama Supplier *', 'sup-e-nama', s.nama) +
          field('Nama PIC', 'sup-e-kontak', s.kontak) +
          field('Telepon', 'sup-e-telepon', s.telepon) +
          field('Email', 'sup-e-email', s.email, { type: 'email' }) +
          field('Kota', 'sup-e-kota', s.kota) +
          '<div style="grid-column:1/-1"><label class="field-label">Alamat</label><textarea id="sup-e-alamat" class="input" rows="2">' + esc(s.alamat || '') + '</textarea></div>' +
          field('NPWP', 'sup-e-npwp', s.npwp) +
          field('Kategori Utama', 'sup-e-kategori', s.kategori_utama, { placeholder: 'mis. Bearing & Seal' }) +
          field('Termin Pembayaran (hari)', 'sup-e-termin', s.termin_hari, { type: 'number' }) +
          field('Rating (0-5)', 'sup-e-rating', s.rating, { type: 'number' }) +
        '</div>' +
        '<div style="margin-top:0.85rem">' +
          '<label class="field-label">Status</label>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.6rem">' +
            '<label class="radio-card' + (s.status === 'Aktif' ? ' active' : '') + '" style="cursor:pointer;border:1px solid var(--border-color, #333);border-radius:0.5rem;padding:0.6rem 0.8rem">' +
              '<input type="radio" name="sup-e-status" value="Aktif" style="margin-right:0.4rem"' + (s.status === 'Aktif' ? ' checked' : '') + '>Aktif<div style="font-size:0.75rem;color:var(--slate-400)">Dapat dipilih pada PO</div></label>' +
            '<label class="radio-card' + (s.status === 'Nonaktif' ? ' active' : '') + '" style="cursor:pointer;border:1px solid var(--border-color, #333);border-radius:0.5rem;padding:0.6rem 0.8rem">' +
              '<input type="radio" name="sup-e-status" value="Nonaktif" style="margin-right:0.4rem"' + (s.status === 'Nonaktif' ? ' checked' : '') + '>Nonaktif<div style="font-size:0.75rem;color:var(--slate-400)">Arsip / tidak dipakai</div></label>' +
          '</div>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.spinningMaster.closeSupplierEdit()">Batal</button>' +
          '<button type="button" class="btn btn-primary" onclick="SPB.spinningMaster.submitSupplierEdit(\'' + s.id + '\')"><i data-lucide="save" class="icon-sm"></i>Simpan</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function supplierRow(s) {
    const viewOnly = isViewOnly();
    return '<tr style="cursor:pointer" onclick="SPB.spinningMaster.openSupplierProducts(\'' + s.id + '\')" title="Klik untuk lihat Vendor Pricelist">' +
      '<td style="font-weight:700;color:var(--brand-700)">' + esc(s.nama) +
        (s.kota ? '<div style="font-size:0.75rem;color:var(--slate-400);font-weight:400"><i data-lucide="map-pin" class="icon-sm" style="width:0.7rem;height:0.7rem;vertical-align:-1px"></i> ' + esc(s.kota) + '</div>' : '') +
      '</td>' +
      '<td><div style="font-size:0.8125rem">' + esc(s.email || '-') + '</div><div style="font-size:0.75rem;color:var(--slate-400)">' + esc(s.telepon || '-') + '</div></td>' +
      '<td style="font-size:0.8125rem;color:var(--slate-500)">' + esc(s.npwp || '-') + '</td>' +
      '<td onclick="event.stopPropagation()">' + (viewOnly ? s.termin_hari + ' hari' :
        '<div style="display:flex;gap:0.3rem;align-items:center"><input id="sup-termin-' + s.id + '" type="number" min="0" class="input" style="width:4.5rem;padding:0.3rem 0.5rem" value="' + s.termin_hari + '">' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.saveSupplierTermin(\'' + s.id + '\')" title="Simpan termin"><i data-lucide="check" class="icon-sm"></i></button></div>') + '</td>' +
      '<td onclick="event.stopPropagation()">' + (viewOnly ? '<span class="badge ' + (s.status === 'Aktif' ? 'badge-approved' : 'badge-rejected') + '">' + s.status + '</span>' :
        '<button type="button" class="badge ' + (s.status === 'Aktif' ? 'badge-approved' : 'badge-rejected') + '" style="border:0;cursor:pointer" onclick="SPB.spinningMaster.toggleSupplierStatus(\'' + s.id + '\',\'' + s.status + '\')">' + s.status + '</button>') + '</td>' +
      (viewOnly ? '' : '<td onclick="event.stopPropagation()" style="white-space:nowrap"><div style="display:flex;gap:0.3rem">' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.openSupplierEdit(\'' + s.id + '\')" title="Ubah supplier"><i data-lucide="pencil" class="icon-sm"></i></button>' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.deleteSupplier(\'' + s.id + '\', \'' + esc(s.nama).replace(/'/g, "\\'") + '\')" title="Hapus supplier"><i data-lucide="trash-2" class="icon-sm" style="color:var(--red-600)"></i></button>' +
      '</div></td>') +
    '</tr>';
  }
  function supplierHtml() {
    const viewOnly = isViewOnly();
    const q = supplierFilters.q.toLowerCase();
    const filtered = supplierList.filter(function (s) {
      if (q && (s.nama || '').toLowerCase().indexOf(q) === -1 && (s.email || '').toLowerCase().indexOf(q) === -1 && (s.kota || '').toLowerCase().indexOf(q) === -1) return false;
      if (supplierFilters.status && s.status !== supplierFilters.status) return false;
      return true;
    });
    return (viewOnly ? viewOnlyBanner() : '') +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="truck" class="icon-md"></i>' + t('mst_supplier_title') + '<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari nama, email, kota supplier..." value="' + esc(supplierFilters.q) + '" oninput="SPB.spinningMaster.supplierSetFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningMaster.supplierSetFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              '<option value="Aktif"' + (supplierFilters.status === 'Aktif' ? ' selected' : '') + '>Aktif</option>' +
              '<option value="Nonaktif"' + (supplierFilters.status === 'Nonaktif' ? ' selected' : '') + '>Nonaktif</option>' +
            '</select>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.supplierResetFilter()"><i data-lucide="rotate-ccw" class="icon-sm"></i>Reset</button>' +
            (viewOnly ? '' : '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningMaster.syncSuppliersFromOdoo()"><i data-lucide="refresh-cw" class="icon-sm"></i>Sync dari Odoo</button>') +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Nama Supplier</th><th>Kontak</th><th>NPWP</th><th>Termin</th><th>Status</th>' + (viewOnly ? '' : '<th>Aksi</th>') + '</tr></thead>' +
          '<tbody>' + (filtered.length ? filtered.map(supplierRow).join('') : '<tr><td colspan="' + (viewOnly ? 5 : 6) + '" class="empty-state">' + t('pm_empty') + ' — klik "Sync dari Odoo" dulu.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>' + supplierEditModalHtml();
  }

  /* ---------- Category Part Mesin (katalog mesin + part berhierarki) ---------- */
  async function submitTambahMesin() {
    const noMesin = document.getElementById('km-no-mesin').value.trim();
    const nama = document.getElementById('km-nama-mesin').value.trim();
    if (!noMesin) { window.SPB.ui.toast('Data belum lengkap', 'Isi No. Mesin dulu.', 'error'); return; }
    try {
      await window.SPB.dbSpinning.createMesin({ no_mesin: noMesin, nama_mesin: nama });
      window.SPB.ui.toast('Mesin ditambahkan', noMesin, 'success');
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  async function submitTambahPart() {
    const nama = document.getElementById('kp-nama').value.trim();
    const parentId = document.getElementById('kp-parent').value || null;
    const category = document.getElementById('kp-category').value.trim();
    const satuan = document.getElementById('kp-satuan').value;
    if (!nama) { window.SPB.ui.toast('Data belum lengkap', 'Isi nama part dulu.', 'error'); return; }
    try {
      await window.SPB.dbSpinning.createPart({ nama_part: nama, parent_id: parentId, category: category, satuan: satuan });
      window.SPB.ui.toast('Part ditambahkan', nama, 'success');
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  function categoryHtml() {
    const viewOnly = isViewOnly();
    const parentOptions = partList.filter(function (p) { return !p.parent_id; });
    return '' +
      (viewOnly ? viewOnlyBanner() : '') +
      '<div class="table-card" style="margin-bottom:1.25rem">' +
        '<div class="table-head"><h2 class="table-title"><i data-lucide="factory" class="icon-md"></i>' + t('pm_katalog_mesin_title') + '</h2></div>' +
        (viewOnly ? '' : '<form onsubmit="event.preventDefault();SPB.spinningMaster.submitTambahMesin()" style="padding:0.75rem 1.25rem;display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end">' +
          '<div><label class="field-label">' + t('pm_form_mesin') + '</label><input id="km-no-mesin" class="input" placeholder="e.g. RF-01"></div>' +
          '<div><label class="field-label">' + t('pm_col_nama_mesin') + '</label><input id="km-nama-mesin" class="input"></div>' +
          '<button type="submit" class="btn btn-primary btn-sm"><i data-lucide="plus" class="icon-sm"></i>' + t('pm_tambah') + '</button>' +
        '</form>') +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>' + t('pm_form_mesin') + '</th><th>' + t('pm_col_nama_mesin') + '</th></tr></thead>' +
          '<tbody>' + (mesinList.length ? mesinList.map(function (m) {
            return '<tr><td>' + esc(m.no_mesin) + '</td><td>' + esc(m.nama_mesin || '-') + '</td></tr>';
          }).join('') : '<tr><td colspan="2" class="empty-state">' + t('pm_empty') + '</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head"><h2 class="table-title"><i data-lucide="boxes" class="icon-md"></i>' + t('mst_category_title') + '</h2></div>' +
        (viewOnly ? '' : '<form onsubmit="event.preventDefault();SPB.spinningMaster.submitTambahPart()" style="padding:0.75rem 1.25rem;display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end">' +
          '<div><label class="field-label">' + t('pm_col_part') + '</label><input id="kp-nama" class="input"></div>' +
          '<div><label class="field-label">' + t('pm_col_part') + ' (parent)</label>' +
            '<select id="kp-parent" class="select"><option value="">—</option>' +
              parentOptions.map(function (p) { return '<option value="' + p.id + '">' + esc(p.nama_part) + '</option>'; }).join('') +
            '</select></div>' +
          '<div><label class="field-label">' + t('pm_col_category') + '</label><input id="kp-category" class="input"></div>' +
          '<div><label class="field-label">' + t('pm_col_satuan') + '</label>' +
            '<select id="kp-satuan" class="select"><option value="">—</option>' +
              satuanList.map(function (s) { return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>'; }).join('') +
            '</select></div>' +
          '<button type="submit" class="btn btn-primary btn-sm"><i data-lucide="plus" class="icon-sm"></i>' + t('pm_tambah') + '</button>' +
        '</form>') +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>' + t('pm_col_part') + '</th><th>' + t('pm_col_category') + '</th><th>' + t('pm_col_satuan') + '</th></tr></thead>' +
          '<tbody>' + (partList.length ? partList.map(function (p) {
            return '<tr><td>' + esc(partLabel(p)) + '</td><td>' + esc(p.category || '-') + '</td><td>' + esc(p.satuan || '-') + '</td></tr>';
          }).join('') : '<tr><td colspan="3" class="empty-state">' + t('pm_empty') + '</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>';
  }

  /* ---------- Inventory / Stok Gudang — dari Odoo (stok_barang), difilter
     sesuai aturan role_inventory_access, READ-ONLY.
     Tombol "Sync dari Odoo" pinjam mekanisme yang sama dengan Stok Barang
     gudang biasa (stokBarangClient.js -> Edge Function odoo-pull-stock),
     jadi nggak perlu pull terpisah khusus Spinning. ---------- */
  async function syncStokFromOdoo() {
    try {
      await window.SPB.dbStokBarang.syncNow();
      window.SPB.ui.toast('Sync dimulai', 'Stok akan diperbarui sebentar lagi.', 'success');
      setTimeout(load, 3000);
    } catch (err) { window.SPB.ui.toast('Gagal sync', err.message, 'error'); }
  }
  async function syncSatuanFromOdoo() {
    try {
      const res = await window.SPB.dbSpinning.syncSatuanFromOdoo();
      window.SPB.ui.toast('Sync selesai', res.fetched + ' satuan ditarik dari Odoo.', 'success');
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal sync', err.message, 'error'); }
  }
  function stokApplyFilter(key, value) { applyFilterKeepFocus(function () { stokFilters[key] = value; stokPage = 1; }); }
  function setStokPage(p) { stokPage = p; render(); }
  function setStokPageSize(v) { stokPageSize = Number(v); stokPage = 1; render(); }
  function setStokView(v) { stokView = v; render(); }
  function stokCardHtml(s) {
    const habis = Number(s.qty_available || 0) <= 0;
    return '<div class="stok-card">' +
      '<div class="stok-card-top">' +
        '<span class="stok-card-sku">' + esc(s.sku) + '</span>' +
        '<span class="badge ' + (habis ? 'badge-rejected' : 'badge-approved') + '">' + (habis ? 'Habis' : 'Tersedia') + '</span>' +
      '</div>' +
      '<p class="stok-card-nama">' + esc(s.product_name) + '</p>' +
      '<p class="stok-card-category">' + esc(s.odoo_category || '-') + '</p>' +
      '<div class="stok-card-qty">' +
        '<div><span>Qty Fisik</span><b>' + s.qty_on_hand + '</b></div>' +
        '<div><span>Direservasi</span><b>' + s.qty_reserved + '</b></div>' +
        '<div><span>Tersedia</span><b class="' + (habis ? 'stok-danger' : 'stok-ok') + '">' + s.qty_available + '</b></div>' +
      '</div>' +
      '<p class="stok-card-uom">Satuan: ' + esc(s.uom || '-') + '</p>' +
    '</div>';
  }
  // Format "YYYY-MM-DD HH:MM:SS" (Odoo, UTC) jadi tanggal & jam lokal terpisah
  // — biar gampang ditampilin sebagai 2 kolom (Tanggal / Jam) di popup.
  function splitOdooDatetime(s) {
    if (!s) return { tanggal: '-', jam: '-' };
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return { tanggal: s, jam: '-' };
    return {
      tanggal: d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }),
      jam: d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
    };
  }
  async function openStockDetail(sku) {
    stokDetailSku = sku;
    stokDetailLoading = true;
    stokDetailMoves = [];
    stokDetailPo = [];
    stokDetailError = '';
    render();
    try {
      const [moves, po] = await Promise.all([
        window.SPB.dbStokBarang.listMovesBySku(sku),
        window.SPB.dbSpinning.listPoBySku(sku),
      ]);
      stokDetailMoves = moves;
      stokDetailPo = po;
    } catch (err) {
      stokDetailError = err.message;
    }
    stokDetailLoading = false;
    render();
  }
  function closeStockDetail() { stokDetailSku = null; render(); }
  function stockDetailModalHtml() {
    if (!stokDetailSku) return '';
    const masuk = stokDetailMoves.filter(function (m) { return m.arah === 'masuk'; });
    const keluar = stokDetailMoves.filter(function (m) { return m.arah === 'keluar'; });
    function moveRow(m, isMasuk) {
      const dt = splitOdooDatetime(m.tanggal);
      return '<tr><td>' + dt.tanggal + '</td><td>' + dt.jam + '</td><td class="text-right">' + m.qty + '</td>' +
        '<td>' + esc(m.picking) + '</td>' +
        '<td>' + (m.partner ?
          (esc(m.partner) + (m.supplierIsDefault ? ' <span style="font-size:0.6875rem;color:var(--slate-400)" title="Bukan vendor asli mutasi ini (Odoo tidak menyimpan datanya) — ditampilkan vendor utama produk ini di Odoo">(vendor utama)</span>' : '')) :
          '<span style="color:var(--slate-400);font-style:italic">-</span>') + '</td>' +
        '<td style="color:var(--slate-400);font-size:0.75rem">' + esc(isMasuk ? m.lokasi_asal : m.lokasi_tujuan) + '</td></tr>';
    }
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.spinningMaster.closeStockDetail()">' +
      '<div class="modal slide-up modal-lg" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.spinningMaster.closeStockDetail()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="history" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>Riwayat Pergerakan — ' + esc(stokDetailSku) + '</p>' +
        '<p class="modal-sub">Ditarik langsung dari Odoo (stock.move.line), 100 pergerakan terakhir.</p>' +
        (stokDetailLoading ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>' :
        stokDetailError ? '<div class="empty-state" style="color:var(--red-600)">' + esc(stokDetailError) + '</div>' :
        '<div style="display:grid;gap:1rem">' +
          '<div>' +
            '<p style="font-weight:700;font-size:0.8125rem;margin-bottom:0.4rem"><i data-lucide="arrow-down-to-line" class="icon-sm" style="color:var(--green-600);vertical-align:-2px"></i> Barang Masuk (WH IN) — ' + masuk.length + ' kali</p>' +
            '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
              '<thead><tr><th>Tanggal</th><th>Jam</th><th class="text-right">Qty</th><th>No. WH IN</th><th>Supplier</th><th>Lokasi Asal</th></tr></thead>' +
              '<tbody>' + (masuk.length ? masuk.map(function (m) { return moveRow(m, true); }).join('') : '<tr><td colspan="6" class="empty-state">Belum ada riwayat barang masuk.</td></tr>') + '</tbody>' +
            '</table></div></div>' +
          '</div>' +
          '<div>' +
            '<p style="font-weight:700;font-size:0.8125rem;margin-bottom:0.4rem"><i data-lucide="arrow-up-from-line" class="icon-sm" style="color:var(--red-600);vertical-align:-2px"></i> Barang Keluar (WH OUT) — ' + keluar.length + ' kali</p>' +
            '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
              '<thead><tr><th>Tanggal</th><th>Jam</th><th class="text-right">Qty</th><th>No. WH OUT</th><th>Operator</th><th>Lokasi Tujuan</th></tr></thead>' +
              '<tbody>' + (keluar.length ? keluar.map(function (m) { return moveRow(m, false); }).join('') : '<tr><td colspan="6" class="empty-state">Belum ada riwayat barang keluar.</td></tr>') + '</tbody>' +
            '</table></div></div>' +
          '</div>' +
          '<div>' +
            '<p style="font-weight:700;font-size:0.8125rem;margin-bottom:0.4rem"><i data-lucide="file-text" class="icon-sm" style="color:var(--brand-600);vertical-align:-2px"></i> Purchase Order Terkait — ' + stokDetailPo.length + '</p>' +
            (stokDetailPo.length ?
              '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
                '<thead><tr><th>No. PO</th><th>Tanggal</th><th>Supplier</th><th>Status</th><th class="text-right">Qty PO</th><th class="text-right">Diterima</th></tr></thead>' +
                '<tbody>' + stokDetailPo.map(function (p) {
                  return '<tr><td>' + esc(p.nomor) + '</td><td>' + esc(p.tanggal) + '</td><td>' + esc(p.supplier_nama) + '</td><td>' + esc(p.status) + '</td><td class="text-right">' + p.qty + '</td><td class="text-right">' + p.qty_diterima + '</td></tr>';
                }).join('') + '</tbody>' +
              '</table></div></div>' :
              '<p class="empty-state" style="padding:0.75rem 0">Barang ini belum pernah masuk Purchase Request/PO ke Supplier di SPB.</p>') +
          '</div>' +
        '</div>') +
        '<div class="modal-actions" style="grid-template-columns:1fr">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.spinningMaster.closeStockDetail()">Tutup</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function inventoryHtml() {
    const categoryOptions = Array.from(new Set(stokList.map(function (s) { return s.odoo_category; }).filter(Boolean))).sort();
    const filtered = stokList.filter(function (s) {
      if (stokFilters.q) {
        const q = stokFilters.q.toLowerCase();
        if ((s.sku || '').toLowerCase().indexOf(q) === -1 && (s.product_name || '').toLowerCase().indexOf(q) === -1) return false;
      }
      if (stokFilters.category && s.odoo_category !== stokFilters.category) return false;
      if (stokFilters.availability === 'habis' && Number(s.qty_available || 0) > 0) return false;
      if (stokFilters.availability === 'tersedia' && Number(s.qty_available || 0) <= 0) return false;
      return true;
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / stokPageSize));
    if (stokPage > totalPages) stokPage = totalPages;
    if (stokPage < 1) stokPage = 1;
    const pageStart = (stokPage - 1) * stokPageSize;
    const pageRows = filtered.slice(pageStart, pageStart + stokPageSize);

    const tersediaCount = filtered.filter(function (s) { return Number(s.qty_available || 0) > 0; }).length;
    const habisCount = filtered.length - tersediaCount;
    const summaryBits = [filtered.length + ' dari ' + stokList.length + ' SKU'];
    if (stokFilters.category) summaryBits.push('Category "' + stokFilters.category + '": ' + filtered.length + ' SKU');
    summaryBits.push(tersediaCount + ' tersedia · ' + habisCount + ' habis');

    return '<div class="grid-stats" style="margin-bottom:1.25rem">' +
        '<div class="stat-card"><div><p class="stat-label">Total SKU (Spinning)</p><p class="stat-value">' + stokList.length + '</p>' +
        '<p class="stat-sub">' + esc(summaryBits.join(' · ')) + '</p></div>' +
        '<div class="stat-icon indigo"><i data-lucide="boxes" class="icon-md"></i></div></div>' +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="boxes" class="icon-md"></i>' + t('mst_inventory_title') + '<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari SKU / nama barang..." value="' + esc(stokFilters.q) + '" oninput="SPB.spinningMaster.stokApplyFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningMaster.stokApplyFilter(\'category\', this.value)">' +
              '<option value="">Semua Category</option>' +
              categoryOptions.map(function (c) { return '<option value="' + esc(c) + '"' + (stokFilters.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMaster.stokApplyFilter(\'availability\', this.value)">' +
              '<option value="">Semua Ketersediaan</option>' +
              '<option value="tersedia"' + (stokFilters.availability === 'tersedia' ? ' selected' : '') + '>Tersedia</option>' +
              '<option value="habis"' + (stokFilters.availability === 'habis' ? ' selected' : '') + '>Habis</option>' +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMaster.setStokPageSize(this.value)" title="Data per halaman">' +
              [5, 10, 15, 20, 50].map(function (n) { return '<option value="' + n + '"' + (stokPageSize === n ? ' selected' : '') + '>' + n + ' / halaman</option>'; }).join('') +
            '</select>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.syncStokFromOdoo()"><i data-lucide="refresh-cw" class="icon-sm"></i>Sync dari Odoo</button>' +
            '<div class="view-toggle">' +
              '<button type="button" class="view-toggle-btn' + (stokView === 'list' ? ' active' : '') + '" onclick="SPB.spinningMaster.setStokView(\'list\')" title="Tampilan daftar"><i data-lucide="menu" class="icon-sm"></i></button>' +
              '<button type="button" class="view-toggle-btn' + (stokView === 'grid' ? ' active' : '') + '" onclick="SPB.spinningMaster.setStokView(\'grid\')" title="Tampilan grid"><i data-lucide="layout-grid" class="icon-sm"></i></button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        (stokView === 'grid'
          ? '<div class="stok-grid">' + (pageRows.length ? pageRows.map(stokCardHtml).join('') : '<div class="empty-state">' + t('pm_empty') + '</div>') + '</div>'
          : '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>SKU</th><th>' + t('pm_col_part') + '</th><th>' + t('pm_col_category') + '</th><th>Satuan</th><th>Qty Fisik</th><th>Direservasi</th><th>Tersedia</th></tr></thead>' +
          '<tbody>' + (pageRows.length ? pageRows.map(function (s) {
            const habis = Number(s.qty_available || 0) <= 0;
            const skuSafe = esc(s.sku).replace(/'/g, "\\'");
            return '<tr style="cursor:pointer" onclick="SPB.spinningMaster.openStockDetail(\'' + skuSafe + '\')" title="Klik untuk lihat riwayat pergerakan">' +
              '<td style="font-weight:600">' + esc(s.sku) + '</td><td>' + esc(s.product_name) + '</td><td>' + esc(s.odoo_category || '-') + '</td><td>' + esc(s.uom || '-') + '</td>' +
              '<td>' + s.qty_on_hand + '</td><td>' + s.qty_reserved + '</td><td><span class="qty-cmp ' + (habis ? 'over' : 'ok') + '">' + s.qty_available + '</span></td></tr>';
          }).join('') : '<tr><td colspan="7" class="empty-state">' + t('pm_empty') + ' — pastikan ada produk Odoo dengan category Spinning/PLKUM/PLKEL.</td></tr>') + '</tbody>' +
          '</table></div></div>') +
        genericPaginationHtml(stokPage, totalPages, filtered.length, 'setStokPage') +
      '</div>';
  }

  /* ---------- Satuan — dari Odoo (uom.uom lewat satuan_odoo). Nggak ada
     tombol Tambah manual (data awal ikut Odoo persis), diganti "Sync dari
     Odoo". Edit/Hapus TETAP disediakan buat koreksi cepat/rapi-rapi nama —
     CATATAN: hasil edit bisa ketimpa lagi kalau "Sync dari Odoo" ditekan
     ulang (upsert-nya jalan dari data Odoo terbaru, per odoo_id). */
  const satuanFilters = { q: '', category: '', status: '' };
  let satuanPage = 1;
  let satuanPageSize = 10;
  let satuanEditingId = null;
  function satuanApplyFilter(key, value) { applyFilterKeepFocus(function () { satuanFilters[key] = value; satuanPage = 1; }); }
  function setSatuanPage(p) { satuanPage = p; render(); }
  function setSatuanPageSize(v) { satuanPageSize = Number(v); satuanPage = 1; render(); }
  function satuanStartEdit(id) { satuanEditingId = id; render(); }
  function satuanCancelEdit() { satuanEditingId = null; render(); }
  async function satuanSaveEdit(id) {
    const nama = document.getElementById('sat-edit-name').value.trim();
    const category = document.getElementById('sat-edit-category').value.trim();
    if (!nama) { window.SPB.ui.toast('Data belum lengkap', 'Nama satuan tidak boleh kosong.', 'error'); return; }
    try {
      await window.SPB.dbSpinning.updateSatuanOdoo(id, { name: nama, category: category });
      satuanEditingId = null;
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal menyimpan', err.message, 'error'); }
  }
  async function satuanDelete(id, nama) {
    if (!confirm('Hapus satuan "' + nama + '"? Kalau nanti Sync dari Odoo lagi dan satuan ini masih ada di Odoo, dia bakal muncul lagi.')) return;
    try {
      await window.SPB.dbSpinning.deleteSatuanOdoo(id);
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal menghapus', err.message, 'error'); }
  }
  let lastSatuanFiltered = [];
  function exportSatuanExcel() {
    if (!window.XLSX) { window.SPB.ui.toast('Gagal export', 'Library Excel belum termuat, coba refresh halaman.', 'error'); return; }
    if (!lastSatuanFiltered.length) { window.SPB.ui.toast('Tidak ada data', 'Tidak ada data sesuai filter.', 'error'); return; }
    const data = lastSatuanFiltered.map(function (s, i) {
      return { No: i + 1, 'Nama Satuan': s.name, Category: s.category || '-', Status: s.active ? 'Aktif' : 'Nonaktif' };
    });
    const ws = window.XLSX.utils.json_to_sheet(data);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Master Satuan');
    window.XLSX.writeFile(wb, 'Master-Satuan-' + new Date().toISOString().slice(0, 10) + '.xlsx');
    window.SPB.ui.toast('Excel terunduh', '', 'success');
  }
  function exportSatuanPdf() {
    const JsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDFCtor) { window.SPB.ui.toast('Gagal export', 'Library PDF belum termuat, coba refresh halaman.', 'error'); return; }
    if (!lastSatuanFiltered.length) { window.SPB.ui.toast('Tidak ada data', 'Tidak ada data sesuai filter.', 'error'); return; }
    const doc = new JsPDFCtor({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    doc.setFontSize(14); doc.setFont(undefined, 'bold');
    doc.text('Master Satuan — Spinning', 40, 40);
    doc.setFontSize(9); doc.setFont(undefined, 'normal');
    doc.text('Dicetak: ' + new Date().toLocaleString('id-ID'), 40, 56);
    doc.autoTable({
      head: [['No', 'Nama Satuan', 'Category', 'Status']],
      body: lastSatuanFiltered.map(function (s, i) { return [i + 1, s.name, s.category || '-', s.active ? 'Aktif' : 'Nonaktif']; }),
      startY: 72,
      theme: 'grid',
      headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold' },
      styles: { fontSize: 9.5, cellPadding: 6 },
    });
    doc.save('Master-Satuan-' + new Date().toISOString().slice(0, 10) + '.pdf');
  }
  function satuanRowHtml(s) {
    if (satuanEditingId === s.id) {
      return '<tr>' +
        '<td><input id="sat-edit-name" class="input" value="' + esc(s.name) + '" style="padding:0.4rem 0.6rem"></td>' +
        '<td><input id="sat-edit-category" class="input" value="' + esc(s.category || '') + '" style="padding:0.4rem 0.6rem"></td>' +
        '<td><span class="badge ' + (s.active ? 'badge-approved' : 'badge-rejected') + '">' + (s.active ? 'Aktif' : 'Nonaktif') + '</span></td>' +
        '<td class="text-right">' +
          '<button type="button" class="btn btn-success btn-sm" onclick="SPB.spinningMaster.satuanSaveEdit(\'' + s.id + '\')"><i data-lucide="check" class="icon-sm"></i></button> ' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.satuanCancelEdit()"><i data-lucide="x" class="icon-sm"></i></button>' +
        '</td>' +
      '</tr>';
    }
    return '<tr><td style="font-weight:600">' + esc(s.name) + '</td><td>' + esc(s.category || '-') + '</td>' +
      '<td><span class="badge ' + (s.active ? 'badge-approved' : 'badge-rejected') + '">' + (s.active ? 'Aktif' : 'Nonaktif') + '</span></td>' +
      '<td class="text-right">' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.satuanStartEdit(\'' + s.id + '\')"><i data-lucide="pencil" class="icon-sm"></i></button> ' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.satuanDelete(\'' + s.id + '\',\'' + esc(s.name).replace(/'/g, "\\'") + '\')"><i data-lucide="trash-2" class="icon-sm"></i></button>' +
      '</td></tr>';
  }
  function satuanHtml() {
    const categoryOptions = Array.from(new Set(satuanList.map(function (s) { return s.category; }).filter(Boolean))).sort();
    const filtered = satuanList.filter(function (s) {
      if (satuanFilters.q && (s.name || '').toLowerCase().indexOf(satuanFilters.q.toLowerCase()) === -1) return false;
      if (satuanFilters.category && s.category !== satuanFilters.category) return false;
      if (satuanFilters.status === 'aktif' && !s.active) return false;
      if (satuanFilters.status === 'nonaktif' && s.active) return false;
      return true;
    });
    lastSatuanFiltered = filtered;
    const totalPages = Math.max(1, Math.ceil(filtered.length / satuanPageSize));
    if (satuanPage > totalPages) satuanPage = totalPages;
    if (satuanPage < 1) satuanPage = 1;
    const pageStart = (satuanPage - 1) * satuanPageSize;
    const pageRows = filtered.slice(pageStart, pageStart + satuanPageSize);

    return '<div class="grid-stats" style="margin-bottom:1.25rem">' +
        '<div class="stat-card"><div><p class="stat-label">Total Satuan</p><p class="stat-value">' + satuanList.length + '</p>' +
        '<p class="stat-sub">' + filtered.length + ' dari ' + satuanList.length + ' · ' + filtered.filter(function (s) { return s.active; }).length + ' aktif' + (satuanFilters.category ? ' · Category "' + satuanFilters.category + '"' : '') + '</p></div>' +
        '<div class="stat-icon indigo"><i data-lucide="ruler" class="icon-md"></i></div></div>' +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="ruler" class="icon-md"></i>' + t('mst_satuan_title') + '<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari nama satuan..." value="' + esc(satuanFilters.q) + '" oninput="SPB.spinningMaster.satuanApplyFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningMaster.satuanApplyFilter(\'category\', this.value)">' +
              '<option value="">Semua Category</option>' +
              categoryOptions.map(function (c) { return '<option value="' + esc(c) + '"' + (satuanFilters.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMaster.satuanApplyFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              '<option value="aktif"' + (satuanFilters.status === 'aktif' ? ' selected' : '') + '>Aktif</option>' +
              '<option value="nonaktif"' + (satuanFilters.status === 'nonaktif' ? ' selected' : '') + '>Nonaktif</option>' +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMaster.setSatuanPageSize(this.value)" title="Data per halaman">' +
              [5, 10, 15, 20, 50].map(function (n) { return '<option value="' + n + '"' + (satuanPageSize === n ? ' selected' : '') + '>' + n + ' / halaman</option>'; }).join('') +
            '</select>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.exportSatuanExcel()"><i data-lucide="file-down" class="icon-sm"></i>Ekspor Excel</button>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMaster.exportSatuanPdf()"><i data-lucide="file-text" class="icon-sm"></i>Ekspor PDF</button>' +
            '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningMaster.syncSatuanFromOdoo()"><i data-lucide="refresh-cw" class="icon-sm"></i>Sync dari Odoo</button>' +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>' + t('mst_satuan_nama') + '</th><th>Category</th><th>Status</th><th class="text-right">Aksi</th></tr></thead>' +
          '<tbody>' + (pageRows.length ? pageRows.map(satuanRowHtml).join('') : '<tr><td colspan="4" class="empty-state">' + t('pm_empty') + ' — klik "Sync dari Odoo" dulu.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
        genericPaginationHtml(satuanPage, totalPages, filtered.length, 'setSatuanPage') +
      '</div>';
  }

  /* ---------- Karyawan — dari Odoo (public.karyawan, sinkron lewat
     sheet-pull-employees/dbKaryawan), difilter Divisi = 'Spinning'.
     READ-ONLY (bukan roster manual lagi) — sinkronisasinya dari halaman
     Karyawan gudang (menu itu nggak kelihatan di sidebar Spinning, tapi
     datanya sama, cukup difilter di sini). ---------- */
  function karyawanApplyFilter(key, value) { applyFilterKeepFocus(function () { karyawanFilters[key] = value; karyawanPage = 1; }); }
  function setKaryawanView(v) { karyawanView = v; render(); }
  function setKaryawanPage(p) { karyawanPage = p; render(); }
  function setKaryawanPageSize(v) { karyawanPageSize = Number(v); karyawanPage = 1; render(); }
  // Avatar bulat inisial — belum ada sinkron foto asli dari Odoo (field itu
  // belum ditarik sheet-pull-employees), jadi fallback-nya ini dulu, BUKAN
  // foto asli. Kalau field foto (mis. photo_url) sudah ada di tabel karyawan
  // suatu saat, tinggal dipakai di sini menggantikan inisial.
  function initialsOf(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
  }
  // Generik — dipakai Karyawan & Inventory, tinggal dikasih tau nama fungsi
  // setPage-nya (beda tab, beda state halaman, beda handler).
  function genericPaginationHtml(page, totalPages, totalRows, setPageFnName) {
    if (totalRows === 0) return '';
    const pages = [];
    const add = function (p) { if (pages.indexOf(p) === -1) pages.push(p); };
    add(1); add(totalPages);
    for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) add(p);
    pages.sort(function (a, b) { return a - b; });
    let numbersHtml = '';
    let prev = 0;
    pages.forEach(function (p) {
      if (p - prev > 1) numbersHtml += '<span class="pagination-ellipsis">…</span>';
      numbersHtml += '<button type="button" class="pagination-num' + (p === page ? ' active' : '') + '" onclick="SPB.spinningMaster.' + setPageFnName + '(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') + ' onclick="SPB.spinningMaster.' + setPageFnName + '(' + (page - 1) + ')"><i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') + ' onclick="SPB.spinningMaster.' + setPageFnName + '(' + (page + 1) + ')"><i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }
  function karyawanRowHtml(k) {
    return '<tr><td>' + esc(k.name) + '</td><td>' + esc(k.nip || '-') + '</td><td>' + esc(divisiOf(k) || '-') + '</td><td>' + esc(subDivisiOf(k) || '-') + '</td><td>' + esc(k.bagian || '-') + '</td><td>' + esc(k.jabatan || '-') + '</td><td>' + esc(k.shift || '-') + '</td></tr>';
  }
  function karyawanCardHtml(k) {
    return '<div class="karyawan-card">' +
      '<div class="karyawan-avatar">' + esc(initialsOf(k.name).toUpperCase()) + '</div>' +
      '<p class="karyawan-card-nama">' + esc(k.name) + '</p>' +
      '<p class="karyawan-card-jabatan">' + esc(k.jabatan || '-') + '</p>' +
      '<div class="karyawan-card-meta">' +
        '<span><i data-lucide="git-branch" class="icon-sm"></i>' + esc(subDivisiOf(k) || '-') + (k.bagian ? ' / ' + esc(k.bagian) : '') + '</span>' +
        '<span><i data-lucide="clock" class="icon-sm"></i>Shift ' + esc(k.shift || '-') + '</span>' +
      '</div>' +
    '</div>';
  }
  function karyawanHtml() {
    const subDivisiOptions = Array.from(new Set(karyawanList.map(subDivisiOf).filter(Boolean))).sort();
    const shiftOptions = Array.from(new Set(karyawanList.map(function (k) { return k.shift; }).filter(Boolean))).sort();
    const filtered = karyawanList.filter(function (k) {
      if (karyawanFilters.q && (k.name || '').toLowerCase().indexOf(karyawanFilters.q.toLowerCase()) === -1) return false;
      if (karyawanFilters.subDivisi && subDivisiOf(k) !== karyawanFilters.subDivisi) return false;
      if (karyawanFilters.shift && k.shift !== karyawanFilters.shift) return false;
      return true;
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / karyawanPageSize));
    if (karyawanPage > totalPages) karyawanPage = totalPages;
    if (karyawanPage < 1) karyawanPage = 1;
    const pageStart = (karyawanPage - 1) * karyawanPageSize;
    const pageRows = filtered.slice(pageStart, pageStart + karyawanPageSize);

    // Ringkasan per filter aktif — biar langsung kejawab "sub divisi TFO ada
    // berapa orang" tanpa harus ngitung manual dari tabel.
    const summaryBits = [];
    summaryBits.push(filtered.length + ' dari ' + karyawanList.length + ' karyawan');
    if (karyawanFilters.subDivisi) summaryBits.push('Sub Divisi ' + karyawanFilters.subDivisi + ': ' + filtered.length + ' orang');
    if (karyawanFilters.shift) summaryBits.push('Shift ' + karyawanFilters.shift + ': ' + filtered.length + ' orang');

    return '<div class="grid-stats" style="margin-bottom:1.25rem">' +
        '<div class="stat-card"><div><p class="stat-label">Total Karyawan</p><p class="stat-value">' + karyawanList.length + '</p>' +
        '<p class="stat-sub">' + esc(summaryBits.join(' · ')) + '</p></div>' +
        '<div class="stat-icon indigo"><i data-lucide="contact" class="icon-md"></i></div></div>' +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="contact" class="icon-md"></i>' + t('mst_karyawan_title') + '<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari nama..." value="' + esc(karyawanFilters.q) + '" oninput="SPB.spinningMaster.karyawanApplyFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningMaster.karyawanApplyFilter(\'subDivisi\', this.value)">' +
              '<option value="">Semua Sub Divisi</option>' +
              subDivisiOptions.map(function (d) { return '<option value="' + esc(d) + '"' + (karyawanFilters.subDivisi === d ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMaster.karyawanApplyFilter(\'shift\', this.value)">' +
              '<option value="">Semua Shift</option>' +
              shiftOptions.map(function (s) { return '<option value="' + esc(s) + '"' + (karyawanFilters.shift === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMaster.setKaryawanPageSize(this.value)" title="Data per halaman">' +
              [5, 10, 15, 20, 50].map(function (n) { return '<option value="' + n + '"' + (karyawanPageSize === n ? ' selected' : '') + '>' + n + ' / halaman</option>'; }).join('') +
            '</select>' +
            '<div class="view-toggle">' +
              '<button type="button" class="view-toggle-btn' + (karyawanView === 'list' ? ' active' : '') + '" onclick="SPB.spinningMaster.setKaryawanView(\'list\')" title="Tampilan daftar"><i data-lucide="menu" class="icon-sm"></i></button>' +
              '<button type="button" class="view-toggle-btn' + (karyawanView === 'grid' ? ' active' : '') + '" onclick="SPB.spinningMaster.setKaryawanView(\'grid\')" title="Tampilan grid"><i data-lucide="layout-grid" class="icon-sm"></i></button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        (karyawanView === 'grid'
          ? '<div class="karyawan-grid">' + (pageRows.length ? pageRows.map(karyawanCardHtml).join('') : '<div class="empty-state">' + t('pm_empty') + '</div>') + '</div>'
          : '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
              '<thead><tr><th>' + t('mst_karyawan_nama') + '</th><th>NIP</th><th>Divisi</th><th>Sub Divisi</th><th>Bagian</th><th>' + t('mst_karyawan_jabatan') + '</th><th>Shift</th></tr></thead>' +
              '<tbody>' + (pageRows.length ? pageRows.map(karyawanRowHtml).join('') : '<tr><td colspan="7" class="empty-state">' + t('pm_empty') + ' — pastikan ada karyawan Odoo dengan department diawali "Spinning".</td></tr>') + '</tbody>' +
            '</table></div></div>') +
        genericPaginationHtml(karyawanPage, totalPages, filtered.length, 'setKaryawanPage') +
      '</div>';
  }

  const TITLE_KEY = { supplier: 'nav_supplier', category: 'nav_category_part', inventory: 'nav_inventory', satuan: 'nav_satuan', karyawan: 'nav_karyawan' };

  function render() {
    const app = document.getElementById('app');
    const ui = window.SPB.ui;

    let body;
    if (loading) {
      body = '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> ...</div>';
    } else if (loadError) {
      body = '<div class="empty-state" style="color:var(--red-600)">' + esc(loadError) + '</div>';
    } else {
      // Navigasi antar sub-halaman CUKUP lewat sidebar (Supplier/Category/.../
      // Karyawan sudah masing-masing punya menu sendiri di grup MASTER DATA)
      // — nggak perlu tab bar duplikat lagi di sini.
      body = (tab === 'supplier' ? supplierHtml() : tab === 'category' ? categoryHtml() : tab === 'inventory' ? inventoryHtml() : tab === 'satuan' ? satuanHtml() : karyawanHtml());
      if (tab === 'supplier') body += supplierProductsModalHtml();
      // stockDetailModalHtml() bisa dipicu dari tab manapun (Inventory
      // langsung, ATAU dari popup Vendor Pricelist di tab Supplier lewat
      // goToProductFromSupplier) — jadi dirender di sini, bukan cuma nempel
      // di inventoryHtml() doang.
      body += stockDetailModalHtml();
    }

    app.innerHTML = ui.layout('master-' + tab,
      '<div class="page-head">' +
        '<div><h1 class="page-title">' + t(TITLE_KEY[tab]) + '</h1></div>' +
      '</div>' +
      body
    );
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.spinningMaster = {
    render: function (initialTab) { if (initialTab) tab = initialTab; load(); },
    setTab: setTab,
    submitTambahMesin: submitTambahMesin, submitTambahPart: submitTambahPart,
    syncStokFromOdoo: syncStokFromOdoo,
    syncSuppliersFromOdoo: syncSuppliersFromOdoo, toggleSupplierStatus: toggleSupplierStatus,
    saveSupplierTermin: saveSupplierTermin, openSupplierProducts: openSupplierProducts, closeSupplierProducts: closeSupplierProducts,
    goToProductFromSupplier: goToProductFromSupplier,
    supplierSetFilter: supplierSetFilter, supplierResetFilter: supplierResetFilter,
    openSupplierEdit: openSupplierEdit, closeSupplierEdit: closeSupplierEdit, submitSupplierEdit: submitSupplierEdit,
    deleteSupplier: deleteSupplier,
    karyawanApplyFilter: karyawanApplyFilter, setKaryawanView: setKaryawanView,
    setKaryawanPage: setKaryawanPage, setKaryawanPageSize: setKaryawanPageSize,
    stokApplyFilter: stokApplyFilter, setStokPage: setStokPage, setStokPageSize: setStokPageSize, setStokView: setStokView,
    openStockDetail: openStockDetail, closeStockDetail: closeStockDetail,
    satuanApplyFilter: satuanApplyFilter, setSatuanPage: setSatuanPage, setSatuanPageSize: setSatuanPageSize,
    satuanStartEdit: satuanStartEdit, satuanCancelEdit: satuanCancelEdit, satuanSaveEdit: satuanSaveEdit, satuanDelete: satuanDelete,
    exportSatuanExcel: exportSatuanExcel, exportSatuanPdf: exportSatuanPdf, syncSatuanFromOdoo: syncSatuanFromOdoo,
  };
})();
