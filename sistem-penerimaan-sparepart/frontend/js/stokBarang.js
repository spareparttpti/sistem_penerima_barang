/* =========================================================
   SPB · stokBarang.js
   Dashboard Stok Barang (ATK) — snapshot qty on hand dari Odoo (stock.quant
   di lokasi WH/Stok), ditarik cron 5 menit sekali (sama pola dengan WH/OUT).
   Ditambah tombol "Sync dari Odoo" manual, filter cari + ketersediaan, dan
   pagination — pola paginationHtml() disalin dari whOut.js.
   ========================================================= */

(function () {
  'use strict';

  const PAGE_SIZE = 15;
  const POLL_MS = 20000; // auto-refresh data tiap 20 detik, TANPA perlu klik Sync
  let currentPage = 1;
  let syncing = false;
  let pollTimer = null;
  const filters = { q: '', availability: '', category: 'ATK' };

  function statCard(icon, iconClass, label, value, sub) {
    return '<div class="stat-card">' +
      '<div><p class="stat-label">' + label + '</p>' +
      '<p class="stat-value">' + value + '</p>' +
      (sub ? '<p class="stat-sub">' + sub + '</p>' : '') + '</div>' +
      '<div class="stat-icon ' + iconClass + '"><i data-lucide="' + icon + '" class="icon-md"></i></div>' +
    '</div>';
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
        '" onclick="SPB.stokBarang.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.stokBarang.goToPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.stokBarang.goToPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  function chartCard(icon, title, bodyHtml) {
    return '<div class="chart-card">' +
      '<p class="chart-title"><i data-lucide="' + icon + '" class="icon-md"></i>' + title + '</p>' +
      bodyHtml +
    '</div>';
  }

  // Ranking SKU dengan qty fisik terbanyak — pola sama dengan Vendor Terbanyak
  // di dashboard WH/IN (hbar-chart), biar langsung kelihatan barang apa yang
  // stoknya paling menumpuk di gudang.
  function topStokHtml(rows) {
    const TOP_N = 8;
    const sorted = rows.slice().sort(function (a, b) { return Number(b.qty_on_hand || 0) - Number(a.qty_on_hand || 0); });
    const top = sorted.slice(0, TOP_N);

    if (!top.length) {
      return chartCard('bar-chart-3', 'Stok Terbanyak',
        '<div class="empty-state" style="padding:2rem 0">Belum ada data stok.</div>');
    }

    // Skala LOG, bukan linear — qty di gudang gampang jomplang jauh (satu SKU
    // 33.000 pcs, yang lain cuma puluhan), jadi kalau linear murni, batang buat
    // qty kecil jadi <1% lebar (nyaris tak kelihatan, semua kelihatan "kosong
    // sama rata"). Skala log bikin perbedaan tetap kelihatan proporsional
    // walau rentang datanya beda ribuan kali lipat. Lantai minimum 4% biar
    // batang manapun tetap ada wujudnya, tidak pernah benar-benar hilang.
    const maxLog = Math.log(Number(top[0].qty_on_hand || 0) + 1) || 1;
    const bars = top.map(function (r) {
      const v = Number(r.qty_on_hand || 0);
      const pct = Math.max(4, Math.round((Math.log(v + 1) / maxLog) * 100));
      return '<div class="hbar-row">' +
        '<div class="hbar-label" title="' + esc(r.product_name) + '">' + esc(r.sku) + '</div>' +
        '<div class="hbar-track" title="' + esc(r.product_name) + ': ' + r.qty_on_hand + ' ' + esc(r.uom || '') + '">' +
          '<div class="hbar-fill" style="width:' + pct + '%;background:var(--sky-600)"></div>' +
        '</div>' +
        '<div class="hbar-value">' + r.qty_on_hand + '</div>' +
      '</div>';
    }).join('');

    return chartCard('bar-chart-3', 'Stok Terbanyak',
      '<div class="hbar-chart">' + bars + '</div>' +
      '<p class="chart-foot">Top ' + top.length + ' SKU dengan qty fisik terbanyak (gabungan semua satuan) · skala logaritmik, angka di kanan adalah qty asli.</p>');
  }

  function columnLegendHtml() {
    const items = [
      { label: 'Qty Fisik', text: 'Jumlah barang yang benar-benar ada di rak gudang saat ini.' },
      { label: 'Direservasi', text: 'Bagian dari Qty Fisik yang sudah "dijanjikan" buat WH/OUT yang lagi diproses (belum di-Validate) — fisiknya masih di rak, tapi sudah ada pemiliknya.' },
      { label: 'Tersedia', text: 'Qty Fisik dikurangi Direservasi — ini angka yang paling jujur soal berapa yang BENERAN bisa dikasih ke permintaan baru sekarang.' },
    ];
    return '<div class="status-legend">' +
      items.map(function (it) {
        return '<div class="status-legend-item"><span class="badge badge-draft"><span class="badge-dot"></span>' + it.label + '</span>' +
          '<span class="status-legend-text">' + it.text + '</span></div>';
      }).join('') +
    '</div>';
  }

  // goToPage/setCategory/applyFilter itu SEMUA cuma nyaring data yang SUDAH
  // ada di memori (lastAllRows) — TIDAK perlu fetch ulang ke server. Cukup
  // renderLocal(), bukan renderRows(true) yang selalu fetch + munculin
  // "Memuat..." (sebelumnya ini bikin tiap ketik 1 huruf di kotak cari fetch
  // ulang ke Supabase & innerHTML kepasang ulang, fokus & kursor ilang).
  function goToPage(page) { currentPage = page; renderLocal(); }
  function setCategory(cat) { filters.category = cat; currentPage = 1; renderLocal(); }
  function applyFilter(key, value) {
    filters[key] = value;
    currentPage = 1;
    // Simpan posisi kursor SEBELUM render ulang (innerHTML replace bikin
    // elemen lama—termasuk fokusnya—hilang), lalu kembalikan lagi ke input
    // yang baru sesudahnya supaya user bisa lanjut ngetik tanpa klik ulang.
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

  function fmtDateTime(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtRupiah(v) {
    return 'Rp' + Number(v || 0).toLocaleString('id-ID');
  }

  // Auto-refresh diam-diam tiap POLL_MS SELAMA user masih di halaman ini —
  // berhenti sendiri begitu hash pindah ke halaman lain (tidak perlu hook
  // "onLeave" khusus di router, cukup dicek tiap tick).
  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (location.hash.replace(/^#/, '') !== '/stok-barang') {
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      if (syncing) return; // lagi sync manual, jangan tabrakan
      renderRows(false);
    }, POLL_MS);
  }

  let lastAllRows = []; // snapshot terakhir dari server, dipakai renderLocal()
  let everLoaded = false; // sudah pernah berhasil narik data di sesi ini?

  function render() {
    currentPage = 1;
    ensurePolling();
    // Stale-while-revalidate: kalau sebelumnya (di sesi/tab ini) sudah pernah
    // berhasil narik data, langsung tampil pakai data lama itu TANPA spinner
    // (instan), sambil diam-diam ambil data terbaru di belakang layar dan
    // ganti begitu datang — jadi cuma kunjungan PERTAMA yang kelihatan
    // "Memuat...", bukan tiap kali pindah ke halaman ini.
    if (everLoaded) {
      buildAndShow(lastAllRows);
      renderRows(false);
    } else {
      renderRows(true);
    }
  }

  // Render ulang PAKAI DATA YANG SUDAH ADA di memori — tanpa fetch, tanpa
  // "Memuat...". Dipakai buat interaksi lokal murni (cari, filter, ganti
  // tab kategori, pindah halaman).
  function renderLocal() { buildAndShow(lastAllRows); }

  // Dipanggil diam-diam sekali begitu app.js selesai boot (BUKAN saat user
  // buka halaman ini) — supaya begitu user beneran klik menu "Stok Barang",
  // data kemungkinan besar udah siap di memori dan render() langsung tampil
  // instan lewat jalur stale-while-revalidate di atas, tanpa "Memuat..." lagi.
  // Lagi di halaman Stok Barang beneran (bukan cuma datanya lagi ditarik di
  // belakang layar dari halaman lain)? Dicek SEBELUM nulis ke #app di
  // callback fetch — kalau tidak, kejadian begini: fetch (polling 20 detik/
  // stale-while-revalidate) masih jalan, user keburu pindah ke halaman lain,
  // begitu fetch itu selesai dia nimpa balik layar ke Stok Barang, seolah
  // klik pindah halamannya "tidak ngefek".
  function onThisPage() { return location.hash.replace(/^#/, '') === '/stok-barang'; }

  function prefetch() {
    if (everLoaded) return;
    window.SPB.dbStokBarang.list().then(function (allRows) {
      lastAllRows = allRows;
      everLoaded = true;
    }).catch(function () { /* diam-diam gagal juga gapapa — render() biasa yang nanggung kalau user beneran buka halamannya */ });
  }

  function renderRows(showLoading) {
    const app = document.getElementById('app');
    if (showLoading) {
      // Tetap pakai layout() (sidebar & header tetap kelihatan) — sebelumnya
      // ini nge-replace SELURUH #app termasuk sidebar, jadi tiap buka Stok
      // Barang layar sempat blank total sebelum data datang.
      app.innerHTML = window.SPB.ui.layout('stok-barang',
        '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>');
      window.SPB.ui.afterRender();
    }

    window.SPB.dbStokBarang.list().then(function (allRows) {
      lastAllRows = allRows;
      everLoaded = true;
      if (onThisPage()) buildAndShow(allRows);
    }).catch(function (err) {
      if (onThisPage()) window.SPB.ui.toast('Gagal memuat', err.message, 'error');
    });
  }

  function buildAndShow(allRows) {
    const app = document.getElementById('app');
    // "Semua Barang" itu SEMUA barang SELAIN ATK — dua kategori ini
      // sengaja saling eksklusif (tidak ada barang ATK yang nyelip di tab
      // "Semua Barang"), sesuai permintaan user.
      const rows = allRows.filter(function (r) { return (r.category || 'Lainnya') === filters.category; });
      const totalSku = rows.length;
      const tersediaCount = rows.filter(function (r) { return Number(r.qty_available || 0) > 0; }).length;
      const habisCount = rows.filter(function (r) { return Number(r.qty_available || 0) <= 0; }).length;
      const lastSync = rows.reduce(function (a, r) { return (!a || r.updated_at > a) ? r.updated_at : a; }, null);

      let filtered = rows;
      if (filters.q) {
        const q = filters.q.toLowerCase();
        filtered = filtered.filter(function (r) {
          return (r.sku || '').toLowerCase().indexOf(q) !== -1 ||
                 (r.product_name || '').toLowerCase().indexOf(q) !== -1;
        });
      }
      if (filters.availability === 'habis') {
        filtered = filtered.filter(function (r) { return Number(r.qty_available || 0) <= 0; });
      } else if (filters.availability === 'tersedia') {
        filtered = filtered.filter(function (r) { return Number(r.qty_available || 0) > 0; });
      }

      const totalRows = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
      if (currentPage > totalPages) currentPage = totalPages;
      if (currentPage < 1) currentPage = 1;
      const pageStart = (currentPage - 1) * PAGE_SIZE;
      const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

      const tableRows = pageRows.map(function (r) {
        const habis = Number(r.qty_available || 0) <= 0;
        return '<tr>' +
          '<td style="font-weight:600;color:var(--slate-700)">' + esc(r.sku) + '</td>' +
          '<td style="color:var(--slate-600)">' + esc(r.product_name) + '</td>' +
          '<td style="font-weight:700">' + r.qty_on_hand + ' <span style="font-weight:400;color:var(--slate-400)">' + esc(r.uom || '') + '</span></td>' +
          '<td>' + r.qty_reserved + '</td>' +
          '<td><span class="qty-cmp ' + (habis ? 'over' : 'ok') + '">' + r.qty_available + '</span></td>' +
          '<td style="color:var(--slate-600)">' + fmtRupiah(r.sales_price) + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="6" class="empty-state">Tidak ada data.</td></tr>';

      const isAtk = filters.category === 'ATK';
      app.innerHTML = window.SPB.ui.layout('stok-barang',
        '<div class="page-head">' +
          '<div><h1 class="page-title">Stok Barang</h1>' +
          '<p class="page-sub">Snapshot stok dari Odoo (gudang WH/Stok) — Odoo ditarik tiap 5 menit, halaman ini auto-refresh sendiri.</p></div>' +
          '<div class="page-head-actions">' +
            '<button type="button" class="btn btn-primary" ' + (syncing ? 'disabled' : '') + ' onclick="SPB.stokBarang.sync()">' +
              '<i data-lucide="' + (syncing ? 'loader-2' : 'refresh-cw') + '" class="icon-sm' + (syncing ? ' spin' : '') + '"></i>' +
              (syncing ? 'Sinkron...' : 'Sync dari Odoo') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="source-tabs">' +
          '<button type="button" class="source-tab' + (isAtk ? ' active' : '') + '" onclick="SPB.stokBarang.setCategory(\'ATK\')">' +
            '<i data-lucide="pencil" class="icon-sm"></i>Barang ATK</button>' +
          '<button type="button" class="source-tab' + (!isAtk ? ' active' : '') + '" onclick="SPB.stokBarang.setCategory(\'Lainnya\')">' +
            '<i data-lucide="box" class="icon-sm"></i>Semua Barang</button>' +
        '</div>' +
        '<div class="grid-stats" style="margin-top:1.25rem">' +
          statCard('package', 'indigo', 'Jenis Barang', totalSku, isAtk ? 'SKU ATK' : 'SKU non-ATK') +
          statCard('check-circle-2', 'sky', 'Barang Tersedia', tersediaCount, 'jenis barang dengan stok > 0') +
          statCard('alert-triangle', 'red', 'Stok Habis', habisCount, 'perlu restock') +
        '</div>' +
        '<div style="margin-top:1.25rem">' + topStokHtml(rows) + '</div>' +
        '<div class="table-card" id="table-card" style="margin-top:1.25rem">' +
          '<div class="table-head">' +
            '<h2 class="table-title"><i data-lucide="list-filter" class="icon-md"></i>Daftar Stok — ' + (isAtk ? 'Barang ATK' : 'Semua Barang') + '</h2>' +
            '<div class="table-tools">' +
              '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari SKU / nama barang..." value="' + esc(filters.q) + '" oninput="SPB.stokBarang.applyFilter(\'q\', this.value)"></div>' +
              '<select class="select-input" onchange="SPB.stokBarang.applyFilter(\'availability\', this.value)">' +
                '<option value="">Semua Ketersediaan</option>' +
                '<option value="tersedia"' + (filters.availability === 'tersedia' ? ' selected' : '') + '>Tersedia</option>' +
                '<option value="habis"' + (filters.availability === 'habis' ? ' selected' : '') + '>Stok Habis</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
            '<thead><tr><th>SKU</th><th>Nama Barang</th><th>Qty Fisik</th><th>Direservasi</th><th>Tersedia</th><th>Sales Price</th></tr></thead>' +
            '<tbody>' + tableRows + '</tbody>' +
          '</table></div></div>' +
          paginationHtml(currentPage, totalPages, totalRows) +
          '<p style="padding:0 1.25rem 0.75rem;font-size:0.75rem;color:var(--slate-400)">terakhir sinkron ' + fmtDateTime(lastSync) + '</p>' +
        '</div>' +
        '<div class="callout"><i data-lucide="info" class="icon-md"></i>' + columnLegendHtml() + '</div>'
      );
      window.SPB.ui.afterRender();
  }
  // (end buildAndShow)

  function sync() {
    if (syncing) return;
    syncing = true;
    renderRows(true);
    window.SPB.dbStokBarang.syncNow().then(function (res) {
      syncing = false;
      window.SPB.ui.toast('Sinkron selesai', res.fetched + ' SKU diperbarui.', 'success');
      renderRows(true);
    }).catch(function (err) {
      syncing = false;
      window.SPB.ui.toast('Sinkron gagal', err.message, 'error');
      renderRows(true);
    });
  }

  window.SPB = window.SPB || {};
  window.SPB.stokBarang = { render: render, applyFilter: applyFilter, setCategory: setCategory, goToPage: goToPage, sync: sync, prefetch: prefetch };
})();
