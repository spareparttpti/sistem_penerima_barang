/* =========================================================
   SPB · purchaseOrder.js
   Dashboard "Purchase Order" (#/purchase-order) — daftar semua permintaan
   restock (tabel permintaan_restock, lihat wh_out_analitik_schema.sql) dari
   SEMUA WH/OUT sekaligus, bukan cuma yang kelihatan 1-1 di halaman detail
   WH/OUT-nya masing-masing.

   BELUM terhubung ke PO beneran di Odoo (Purchase app) — ini murni catatan
   internal SPB ("barang ini perlu di-PO-kan, sisanya kurang segini") biar
   admin gudang punya 1 tempat buat pantau semua permintaan restock yang
   masih nunggu, tanpa harus buka WH/OUT satu-satu. Integrasi ke WH/IN
   (Log Penerimaan, begitu barang PO-nya beneran datang) dijelaskan/
   dibangun belakangan — SENGAJA belum ada di sini dulu.
   ========================================================= */

(function () {
  'use strict';

  const PAGE_SIZE = 15;
  let currentPage = 1;
  const filters = { q: '', status: '' };
  let lastAllRows = [];
  let everLoaded = false;
  let pollTimer = null;

  // 'Dipesan' — udah ditulis mau pesan ke vendor mana + berapa (catatan
  // internal SPB doang, TIDAK ada apa pun yang ditulis ke Odoo), beda dari
  // 'Menunggu' (baru ketahuan kurang, vendor belum diputusin).
  const STATUS_LABEL = { Menunggu: 'Menunggu', Dipesan: 'Dipesan', Selesai: 'Selesai', Dibatalkan: 'Dibatalkan' };
  const STATUS_BADGE = { Menunggu: 'badge-draft', Dipesan: 'badge-inspection', Selesai: 'badge-approved', Dibatalkan: 'badge-rejected' };

  function fmtDateTime(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDate(v) {
    if (!v) return '-';
    return new Date(v + 'T00:00:00').toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  // Versi "premium" — dipakai KHUSUS di dashboard ini (bukan statCard biasa
  // yang dipakai halaman lain), lebih gede & ada aksen warna per kartu biar
  // lebih enak dipakai kelola sehari-hari.
  const PO_ACCENT = {
    amber: { fg: 'var(--amber-600)', bg: 'var(--amber-50)' },
    sky: { fg: 'var(--sky-600)', bg: 'var(--sky-50)' },
    emerald: { fg: 'var(--emerald-600)', bg: 'var(--emerald-50)' },
    red: { fg: 'var(--red-600)', bg: 'var(--red-50)' },
  };
  function statCard(icon, colorKey, label, value, sub) {
    const c = PO_ACCENT[colorKey] || PO_ACCENT.sky;
    return '<div class="po-stat-card" style="--po-accent:' + c.fg + ';--po-accent-bg:' + c.bg + '">' +
      '<div class="po-stat-top">' +
        '<span class="po-stat-label">' + label + '</span>' +
        '<span class="po-stat-icon"><i data-lucide="' + icon + '" class="icon-sm"></i></span>' +
      '</div>' +
      '<p class="po-stat-value">' + value + '</p>' +
      (sub ? '<p class="po-stat-sub">' + sub + '</p>' : '') +
    '</div>';
  }
  function statusBadgeHtml(status) {
    return '<span class="badge ' + (STATUS_BADGE[status] || 'badge-draft') + '"><span class="badge-dot"></span>' + (STATUS_LABEL[status] || status) + '</span>';
  }
  function paginate(rows) {
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    return { pageRows: rows.slice(start, start + PAGE_SIZE), totalPages: totalPages, totalRows: totalRows };
  }
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
        '" onclick="SPB.purchaseOrder.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.purchaseOrder.goToPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.purchaseOrder.goToPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  function applyFilter(key, value) {
    filters[key] = value;
    currentPage = 1;
    // Simpan posisi kursor sebelum render ulang, kembalikan lagi sesudahnya
    // (sama pola dengan stokBarang.js/karyawan.js) — biar bisa ngetik/hapus
    // di kotak cari tanpa harus klik ulang tiap huruf.
    const active = document.activeElement;
    const isSearchBox = key === 'q' && active && active.classList.contains('search-input');
    const caret = isSearchBox ? active.selectionStart : null;
    renderLocal();
    if (isSearchBox) {
      const el = document.querySelector('.search-input');
      if (el) {
        el.focus();
        const pos = caret == null ? el.value.length : caret;
        el.setSelectionRange(pos, pos);
      }
    }
  }
  function goToPage(p) { currentPage = p; renderLocal(); }

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (location.hash.replace(/^#/, '') !== '/purchase-order') { clearInterval(pollTimer); pollTimer = null; return; }
      window.SPB.dbRestock.listAll().then(function (rows) {
        lastAllRows = rows;
        renderLocal();
      }).catch(function () { /* diam-diam gagal juga gapapa, kesusul poll berikutnya */ });
    }, 20000);
  }

  function render() {
    currentPage = 1;
    filters.q = '';
    filters.status = '';
    ensurePolling();
    if (everLoaded) {
      renderLocal();
      fetchQuiet();
    } else {
      const app = document.getElementById('app');
      app.innerHTML = window.SPB.ui.layout('purchase-order',
        '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>');
      window.SPB.ui.afterRender();
      fetchQuiet();
    }
  }
  function fetchQuiet() {
    window.SPB.dbRestock.listAll().then(function (rows) {
      lastAllRows = rows;
      everLoaded = true;
      if (location.hash.replace(/^#/, '') === '/purchase-order') renderLocal();
    }).catch(function (err) {
      if (location.hash.replace(/^#/, '') === '/purchase-order') window.SPB.ui.toast('Gagal memuat', err.message, 'error');
    });
  }
  function renderLocal() { buildAndShow(lastAllRows); }

  async function markStatus(id, status) {
    try {
      await window.SPB.dbRestock.updateStatus(id, status);
      window.SPB.ui.toast('Diperbarui', 'Permintaan restock ditandai "' + STATUS_LABEL[status] + '".', 'success');
      const rows = await window.SPB.dbRestock.listAll();
      lastAllRows = rows;
      renderLocal();
    } catch (err) {
      window.SPB.ui.toast('Gagal memperbarui', err.message, 'error');
    }
  }

  function buildAndShow(rows) {
    const menungguCount = rows.filter(function (r) { return r.status === 'Menunggu'; }).length;
    const dipesanCount = rows.filter(function (r) { return r.status === 'Dipesan'; }).length;
    const selesaiCount = rows.filter(function (r) { return r.status === 'Selesai'; }).length;
    const dibatalkanCount = rows.filter(function (r) { return r.status === 'Dibatalkan'; }).length;

    let filtered = rows;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      filtered = filtered.filter(function (r) {
        const p = r.pengeluaran || {};
        return (r.sku || '').toLowerCase().indexOf(q) !== -1 ||
               (r.product_name || '').toLowerCase().indexOf(q) !== -1 ||
               (p.wh_out_ref || '').toLowerCase().indexOf(q) !== -1 ||
               (p.employee_name || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    if (filters.status) filtered = filtered.filter(function (r) { return r.status === filters.status; });

    const { pageRows, totalPages, totalRows } = paginate(filtered);
    const rowsHtml = pageRows.map(function (r) {
      const p = r.pengeluaran || {};
      return '<tr>' +
        '<td style="font-size:0.8125rem">' + fmtDateTime(r.created_at) + '</td>' +
        '<td style="font-weight:600;color:var(--slate-700)">' + esc(r.sku || '-') + '</td>' +
        '<td style="color:var(--slate-600)">' + esc(r.product_name || '-') + '</td>' +
        '<td style="font-weight:700">' + (r.qty_diajukan != null ? r.qty_diajukan : r.qty_diminta) +
          (r.qty_diajukan != null && r.qty_diajukan !== r.qty_diminta ? ' <span class="muted" style="font-weight:400;font-size:0.75rem">(kurang asli ' + r.qty_diminta + ')</span>' : '') + '</td>' +
        '<td>' + (p.wh_out_ref ? '<a href="#/wh-out/' + esc(r.pengeluaran_id) + '" style="color:var(--brand-600);font-weight:600">' + esc(p.wh_out_ref) + '</a>' : '<span class="muted">-</span>') + '</td>' +
        '<td><p style="font-weight:600">' + esc(p.employee_name || '-') + '</p>' +
          '<p class="muted" style="font-size:0.75rem">' + esc(p.department || '-') + '</p></td>' +
        '<td style="font-size:0.8125rem">' +
          (r.po_ref ? '<b style="color:var(--brand-700)">' + esc(r.po_ref) + '</b><br>' : '') +
          (r.supplier_name ? '<span class="muted">' + esc(r.supplier_name) + '</span>' : (r.po_ref ? '' : '<span class="muted">-</span>')) +
        '</td>' +
        '<td style="font-size:0.8125rem">' + fmtDate(r.deadline_date) + '</td>' +
        '<td style="font-size:0.8125rem">' + esc(r.created_by || '-') + '</td>' +
        '<td>' + statusBadgeHtml(r.status) + '</td>' +
        '<td class="text-right">' + (r.status === 'Menunggu' || r.status === 'Dipesan'
          ? '<div style="display:flex;gap:0.375rem;justify-content:flex-end">' +
              '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.purchaseOrder.markStatus(\'' + r.id + '\', \'Selesai\')">Selesai</button>' +
              '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.purchaseOrder.markStatus(\'' + r.id + '\', \'Dibatalkan\')">Batalkan</button>' +
            '</div>'
          : '<span class="muted">-</span>') + '</td>' +
      '</tr>';
    }).join('');
    const emptyState =
      '<div class="po-empty">' +
        '<div class="po-empty-icon"><i data-lucide="package-search" class="icon-lg"></i></div>' +
        '<p class="po-empty-title">Belum ada permintaan restock</p>' +
        '<p class="po-empty-sub">Begitu ada WH/OUT yang stoknya kurang/habis dan diajukan lewat "Ajukan Pemesanan (PO)", daftarnya bakal muncul di sini.</p>' +
      '</div>';

    const app = document.getElementById('app');
    app.innerHTML = window.SPB.ui.layout('purchase-order',
      '<div class="po-hero">' +
        '<div class="po-hero-icon"><i data-lucide="shopping-cart" class="icon-lg"></i></div>' +
        '<div><h1 class="po-hero-title">Purchase Order (ATK)</h1>' +
        '<p class="po-hero-sub">Daftar barang yang diajukan restock dari WH/OUT yang stoknya kurang/habis — catatan internal SPB, belum terhubung ke Odoo.</p></div>' +
      '</div>' +
      '<div class="po-stats">' +
        statCard('clock', 'amber', 'Menunggu', menungguCount, 'belum sempat di-PO-kan') +
        statCard('shopping-cart', 'sky', 'Dipesan', dipesanCount, 'sudah ditulis mau pesan ke vendor') +
        statCard('check-circle-2', 'emerald', 'Selesai', selesaiCount, 'stok sudah masuk lagi') +
        statCard('x-circle', 'red', 'Dibatalkan', dibatalkanCount, 'nggak jadi di-PO-kan') +
      '</div>' +
      '<div class="table-card" style="margin-top:1.5rem">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="shopping-cart" class="icon-md"></i>Daftar Permintaan Restock</h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari SKU / nama barang / WH-OUT / karyawan..." value="' + esc(filters.q) + '" oninput="SPB.purchaseOrder.applyFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.purchaseOrder.applyFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              Object.keys(STATUS_LABEL).map(function (s) { return '<option value="' + s + '"' + (filters.status === s ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>'; }).join('') +
            '</select>' +
          '</div>' +
        '</div>' +
        (rowsHtml
          ? '<div class="table-wrap"><table class="table">' +
              '<thead><tr><th>Tanggal</th><th>SKU</th><th>Nama Barang</th><th>Qty Diajukan</th><th>WH/OUT</th><th>Karyawan</th><th>PO / Vendor</th><th>Dibutuhkan</th><th>Diajukan Oleh</th><th>Status</th><th></th></tr></thead>' +
              '<tbody>' + rowsHtml + '</tbody>' +
            '</table></div>' +
            paginationHtml(currentPage, totalPages, totalRows)
          : emptyState) +
      '</div>'
    );
    window.SPB.ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.purchaseOrder = {
    render: render,
    applyFilter: applyFilter,
    goToPage: goToPage,
    markStatus: markStatus,
  };
})();
