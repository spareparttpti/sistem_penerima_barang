/* =========================================================
   SPB · whOut.js
   Dashboard WH/OUT (pengeluaran barang ATK) — polanya disederhanakan dari
   dashboard.js (WH/IN): stat cards, search + filter status/tanggal, tabel,
   klik baris -> detail (whOutDetail.js). Grafik ranking (vendor/status)
   sengaja belum dibawa ke sini dulu — bisa ditambah menyusul kalau memang
   dibutuhkan, prioritas pertama alur Draft -> Approve -> Distribusi jalan.
   ========================================================= */

(function () {
  'use strict';

  const PAGE_SIZE = 15;
  let currentPage = 1;
  const filters = { q: '', status: '', date: '' };

  // Status 'Rejected' di DB (nilai enum lama, dipakai bareng WH/IN yang
  // makna aslinya beda — di sana emang "barang ditolak") — di WH/OUT ini
  // makna sebenarnya adalah "Cancel", jadi labelnya ditampilkan "Cancelled"
  // di sini TANPA ngubah statusBadge() global (app.js), biar WH/IN nggak
  // ikut kena.
  function statusBadgeWhOut(status) {
    if (status === 'Rejected') return '<span class="badge badge-rejected"><span class="badge-dot"></span>Cancelled</span>';
    return window.SPB.ui.statusBadge(status);
  }

  function fmtDate(v) {
    if (!v) return '-';
    const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(v) {
    return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function dateCell(r) {
    if (r.status === 'Draft' || r.status === 'Menunggu Stok') {
      return '<p style="font-weight:500;color:var(--slate-600)">' + fmtDate(r.order_date) + '</p>' +
             '<p class="date-tag pesan">tgl pemesanan</p>';
    }
    return '<p style="font-weight:500;color:var(--slate-600)">' + fmtDateTime(r.arrival_date || r.created_at) + '</p>' +
           '<p class="date-tag datang">tgl barang datang</p>';
  }
  function displayedDateValue(r) {
    const raw = (r.status === 'Draft' || r.status === 'Menunggu Stok') ? r.order_date : (r.arrival_date || r.created_at);
    const t = raw ? new Date(raw).getTime() : NaN;
    return isNaN(t) ? 0 : t;
  }
  function displayedDayValue(r) {
    const t = displayedDateValue(r);
    if (!t) return 0;
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function createdAtValue(r) {
    const t = r.created_at ? new Date(r.created_at).getTime() : NaN;
    return isNaN(t) ? 0 : t;
  }
  function compareRows(a, b) {
    const favA = a.is_favorite ? 1 : 0, favB = b.is_favorite ? 1 : 0;
    if (favA !== favB) return favB - favA;
    const dayDiff = displayedDayValue(b) - displayedDayValue(a);
    if (dayDiff !== 0) return dayDiff;
    return createdAtValue(b) - createdAtValue(a);
  }

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
        '" onclick="SPB.whOut.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.whOut.goToPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.whOut.goToPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  function goToPage(page) { currentPage = page; draw(); }
  function applyFilter(key, value) {
    filters[key] = value;
    currentPage = 1;
    // Simpan posisi kursor SEBELUM render ulang (innerHTML replace bikin
    // elemen lama—termasuk fokusnya—hilang), lalu kembalikan lagi ke input
    // yang baru sesudahnya supaya user bisa lanjut ngetik/hapus tanpa klik
    // ulang tiap kali (sama pola kayak stokBarang.js/karyawan.js).
    const active = document.activeElement;
    const isSearchBox = key === 'q' && active && active.classList.contains('search-input');
    const caret = isSearchBox ? active.selectionStart : null;
    draw();
    if (isSearchBox) {
      const el = document.querySelector('.search-input');
      if (el) {
        el.focus();
        const pos = caret == null ? el.value.length : caret;
        el.setSelectionRange(pos, pos);
      }
    }
  }

  // render() (dipanggil router app.js tiap kali BUKA halaman ini) reset
  // filters/currentPage dulu SEBELUM gambar — soalnya filters itu variabel
  // modul di luar sini, kalau nggak di-reset bakal "nyangkut" abis pindah ke
  // Karyawan/Stok Barang/Antrean terus balik lagi ke sini. draw() (dipakai
  // applyFilter/goToPage buat update lokal) SENGAJA nggak reset apa-apa,
  // biar nggak nge-wipe filter yang baru aja diisi user.
  function render() {
    currentPage = 1;
    filters.q = '';
    filters.status = '';
    filters.date = '';
    draw();
  }

  function draw() {
    const app = document.getElementById('app');
    window.SPB.dbWhOut.list().then(function (rows) {
      const waitingCount = rows.filter(function (r) { return r.status === 'Draft'; }).length;
      const approvedCount = rows.filter(function (r) { return r.status === 'Approved'; }).length;
      const rejectedCount = rows.filter(function (r) { return r.status === 'Rejected'; }).length;
      const menungguStokCount = rows.filter(function (r) { return r.status === 'Menunggu Stok'; }).length;

      let filtered = rows.slice();
      if (filters.q) {
        const q = filters.q.toLowerCase();
        filtered = filtered.filter(function (r) {
          return (r.wh_out_ref || '').toLowerCase().indexOf(q) !== -1 ||
                 (r.employee_name || '').toLowerCase().indexOf(q) !== -1 ||
                 (r.department || '').toLowerCase().indexOf(q) !== -1;
        });
      }
      if (filters.status) filtered = filtered.filter(function (r) { return r.status === filters.status; });
      if (filters.date) {
        filtered = filtered.filter(function (r) {
          const raw = r.status === 'Draft' ? r.order_date : (r.arrival_date || r.created_at);
          if (!raw) return false;
          const ymd = String(raw).length <= 10 ? String(raw) : new Date(raw).toISOString().slice(0, 10);
          return ymd === filters.date;
        });
      }
      filtered = filtered.slice().sort(compareRows);

      const totalRows = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
      if (currentPage > totalPages) currentPage = totalPages;
      if (currentPage < 1) currentPage = 1;
      const pageStart = (currentPage - 1) * PAGE_SIZE;
      const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

      const tableRows = pageRows.map(function (r) {
        const itemsCount = r.items ? r.items.length : 0;
        // "Menunggu Stok" masih di jalur "belum kelar diproses" sama kayak
        // Draft (belum Approved/Rejected) — tombolnya sama, cuma labelnya
        // beda dikit biar jelas kenapa masih nyangkut.
        const draft = r.status === 'Draft' || r.status === 'Menunggu Stok';
        return '<tr class="row-click" onclick="location.hash=\'#/wh-out/' + r.id + '\'">' +
          '<td><p class="font-bold" style="color:var(--slate-800)">' + esc(r.wh_out_ref) + '</p>' +
          '<p style="font-size:0.75rem;color:var(--slate-400)">' + itemsCount + ' item</p></td>' +
          '<td><p style="font-weight:500;color:var(--slate-700)">' + esc(r.employee_name) + '</p>' +
          '<p style="font-size:0.75rem;color:var(--slate-400)">' + esc(r.department) + '</p></td>' +
          '<td style="font-size:0.875rem">' + dateCell(r) + '</td>' +
          '<td>' + statusBadgeWhOut(r.status) + '</td>' +
          '<td class="text-right"><a href="#/wh-out/' + r.id + '" class="btn ' + (draft ? 'btn-primary' : 'btn-dark') + ' btn-sm">' +
            '<i data-lucide="' + (draft ? 'package-check' : 'search-check') + '" class="icon-sm"></i>' +
            (r.status === 'Menunggu Stok' ? 'Cek Stok' : draft ? 'Proses' : 'Detail') + '</a></td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="5" class="empty-state">Tidak ada data.</td></tr>';

      app.innerHTML = window.SPB.ui.layout('wh-out',
        '<div class="page-head">' +
          '<div><h1 class="page-title">Dashboard WH/OUT</h1>' +
          '<p class="page-sub">Pengeluaran barang ATK — ditarik otomatis dari Odoo.</p></div>' +
        '</div>' +
        '<div class="grid-stats">' +
          statCard('truck', 'amber', 'Menunggu Diproses', waitingCount, 'dari Odoo') +
          statCard('shopping-cart', 'sky', 'Menunggu Stok', menungguStokCount, 'stok habis, diajukan PO') +
          statCard('badge-check', 'emerald', 'Approved', approvedCount, 'siap didistribusikan') +
          statCard('badge-x', 'red', 'Cancelled', rejectedCount, 'dibatalkan') +
        '</div>' +
        '<div class="table-card" id="table-card" style="margin-top:1.25rem">' +
          '<div class="table-head">' +
            '<h2 class="table-title"><i data-lucide="list-filter" class="icon-md"></i>Log Pengeluaran ATK</h2>' +
            '<div class="table-tools">' +
              '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari No WH/OUT / karyawan / departemen..." value="' + esc(filters.q) + '" oninput="SPB.whOut.applyFilter(\'q\', this.value)"></div>' +
              '<select class="select-input" onchange="SPB.whOut.applyFilter(\'status\', this.value)">' +
                '<option value="">Semua Status</option>' +
                '<option value="Draft"' + (filters.status === 'Draft' ? ' selected' : '') + '>Menunggu Diproses</option>' +
                '<option value="Menunggu Stok"' + (filters.status === 'Menunggu Stok' ? ' selected' : '') + '>Menunggu Stok</option>' +
                '<option value="Approved"' + (filters.status === 'Approved' ? ' selected' : '') + '>Approved</option>' +
                '<option value="Rejected"' + (filters.status === 'Rejected' ? ' selected' : '') + '>Cancelled</option>' +
              '</select>' +
              '<div class="date-filter-box"><i data-lucide="calendar" class="icon-sm"></i>' +
                '<input type="date" class="date-filter-input" value="' + esc(filters.date || '') + '" onchange="SPB.whOut.applyFilter(\'date\', this.value)">' +
                (filters.date ? '<button type="button" class="date-filter-clear" onclick="SPB.whOut.applyFilter(\'date\', \'\')" aria-label="Hapus filter tanggal"><i data-lucide="x" class="icon-sm"></i></button>' : '') +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
            '<thead><tr><th>No WH/OUT</th><th>Karyawan</th><th>Tanggal</th><th>Status</th><th class="text-right">Aksi</th></tr></thead>' +
            '<tbody>' + tableRows + '</tbody>' +
          '</table></div></div>' +
          paginationHtml(currentPage, totalPages, totalRows) +
        '</div>'
      );
      window.SPB.ui.afterRender();
    });
  }

  window.SPB = window.SPB || {};
  window.SPB.whOut = { render: render, applyFilter: applyFilter, goToPage: goToPage };
})();
