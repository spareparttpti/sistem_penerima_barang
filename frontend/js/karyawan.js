/* =========================================================
   SPB · karyawan.js
   Halaman Karyawan (admin-only) — daftar master karyawan yang ditarik dari
   Odoo (hr.employee), dipakai sebagai sumber autocomplete di form Distribusi
   WH/OUT. Sinkron manual lewat tombol (bukan cron 15 menit seperti WH/IN —
   data karyawan jarang berubah). Filter cari nama + departemen, pagination
   pola sama dengan whOut.js.
   ========================================================= */

(function () {
  'use strict';

  const PAGE_SIZE = 20;
  let currentPage = 1;
  let syncing = false;
  let lastAllRows = []; // snapshot terakhir dari server, dipakai filter lokal
  let everLoaded = false; // sudah pernah berhasil narik data di sesi ini?
  const filters = { q: '', divisi: '', subDivisi: '' };
  // Default CUMA tampilin yang aktif — karyawan yang namanya udah nggak ada
  // di sheet ditandai nonaktif (bukan dihapus, lihat sheet-pull-employees),
  // tapi kalau ikut ditampilin & ikut ngisi pilihan Divisi/Sub Divisi, jadi
  // banyak nilai lama/basi nongol di dropdown yang bikin filter kelihatan
  // "nggak match" sama data yang sebenarnya lagi dipakai sekarang.
  let showInactive = false;

  // department dari Odoo formatnya "DIVISI / SUB DIVISI / SUB-SUB DIVISI"
  // (mis. "SPINNING / TFO / REWINDING") — dipecah jadi 2 filter bertingkat
  // (Divisi dulu, baru Sub Divisi ikut nyesuain), bukan 1 dropdown gabungan.
  function divisiOf(k) { return ((k.department || '').split(' / ')[0] || '').trim(); }
  function subDivisiOf(k) { return ((k.department || '').split(' / ')[1] || '').trim(); }

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
        '" onclick="SPB.karyawan.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.karyawan.goToPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.karyawan.goToPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  function goToPage(page) { currentPage = page; renderLocal(); }

  // applyFilter TIDAK fetch ulang — cukup nyaring lastAllRows yang udah ada
  // di memori, sekalian jaga fokus & posisi kursor kotak cari biar nggak
  // perlu klik ulang tiap ketik (sama pola kayak stokBarang.js).
  function applyFilter(key, value) {
    filters[key] = value;
    // Ganti Divisi -> reset Sub Divisi (cascading: pilihan sub divisi lama
    // bisa aja nggak relevan lagi buat divisi yang baru dipilih).
    if (key === 'divisi') filters.subDivisi = '';
    currentPage = 1;
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
  function resetFilters() { filters.q = ''; filters.divisi = ''; filters.subDivisi = ''; currentPage = 1; renderLocal(); }
  function toggleShowInactive() {
    showInactive = !showInactive;
    filters.divisi = ''; filters.subDivisi = ''; // pilihan lama bisa aja nggak ada lagi di daftar yang baru
    currentPage = 1;
    renderLocal();
  }

  function divisiList(rows) {
    const set = {};
    rows.forEach(function (k) { const d = divisiOf(k); if (d) set[d] = true; });
    return Object.keys(set).sort();
  }
  // Sub divisi cuma dari baris yang divisi-nya cocok sama filter.divisi yang
  // lagi aktif (kalau belum pilih divisi, tampilin semua sub divisi yang ada).
  function subDivisiList(rows) {
    const set = {};
    rows.forEach(function (k) {
      if (filters.divisi && divisiOf(k) !== filters.divisi) return;
      const sd = subDivisiOf(k);
      if (sd) set[sd] = true;
    });
    return Object.keys(set).sort();
  }

  function render() {
    currentPage = 1;
    // Stale-while-revalidate: kalau sebelumnya (di sesi/tab ini) sudah pernah
    // berhasil narik data, langsung tampil pakai data lama itu TANPA spinner
    // (instan), sambil diam-diam ambil data terbaru di belakang layar dan
    // ganti begitu datang — jadi cuma kunjungan PERTAMA yang kelihatan
    // "Memuat...", bukan tiap kali pindah ke halaman ini.
    if (everLoaded) {
      buildAndShow(lastAllRows);
    } else {
      const app = document.getElementById('app');
      // Tetap pakai layout() (sidebar & header tetap kelihatan) — sebelumnya
      // ini nge-replace SELURUH #app termasuk sidebar, jadi tiap buka Karyawan
      // layar sempat blank total sebelum data datang.
      app.innerHTML = window.SPB.ui.layout('karyawan',
        '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>');
      window.SPB.ui.afterRender();
    }
    window.SPB.dbKaryawan.list().then(function (rows) {
      lastAllRows = rows;
      everLoaded = true;
      // Cek masih di halaman ini SEBELUM nulis ke #app — kalau user keburu
      // pindah halaman pas fetch ini masih jalan, jangan nimpa balik layar
      // yang sekarang lagi ditampilin (klik pindah halamannya jadi kayak
      // "tidak ngefek" kalau tidak dicek).
      if (location.hash.replace(/^#/, '') === '/karyawan') buildAndShow(rows);
    }).catch(function (err) {
      if (location.hash.replace(/^#/, '') === '/karyawan') window.SPB.ui.toast('Gagal memuat', err.message, 'error');
    });
  }

  function renderLocal() { buildAndShow(lastAllRows); }

  // Dipanggil diam-diam sekali begitu app.js selesai boot (BUKAN saat user
  // buka halaman ini) — supaya begitu user beneran klik menu "Karyawan",
  // data kemungkinan besar udah siap di memori dan render() langsung tampil
  // instan lewat jalur stale-while-revalidate di atas, tanpa "Memuat..." lagi.
  function prefetch() {
    if (everLoaded) return;
    window.SPB.dbKaryawan.list().then(function (rows) {
      lastAllRows = rows;
      everLoaded = true;
    }).catch(function () { /* diam-diam gagal juga gapapa — render() biasa yang nanggung kalau user beneran buka halamannya */ });
  }

  function buildAndShow(allRows) {
    const app = document.getElementById('app');
    // Nonaktif disaring DULUAN (sebelum dipakai buat isi dropdown Divisi/Sub
    // Divisi maupun tabel) — kalau nggak, nilai lama dari karyawan yang udah
    // resign/nggak ada lagi di sheet ikut nongol di pilihan filter.
    const baseRows = showInactive ? allRows : allRows.filter(function (k) { return k.active !== false; });
    const divisis = divisiList(baseRows);
    const subDivisis = subDivisiList(baseRows);

    let filtered = baseRows;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      filtered = filtered.filter(function (k) { return (k.name || '').toLowerCase().indexOf(q) !== -1; });
    }
    if (filters.divisi) {
      filtered = filtered.filter(function (k) { return divisiOf(k) === filters.divisi; });
    }
    if (filters.subDivisi) {
      filtered = filtered.filter(function (k) { return subDivisiOf(k) === filters.subDivisi; });
    }

    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const pageStart = (currentPage - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

    const tableRows = pageRows.map(function (k) {
      return '<tr><td style="font-weight:600">' + esc(k.name) +
        (k.active === false ? ' <span class="muted" style="font-weight:400;font-size:0.75rem">(nonaktif)</span>' : '') + '</td>' +
        '<td style="font-family:var(--font-mono, monospace);font-size:0.8125rem">' + esc(k.nip || '-') + '</td>' +
        '<td>' + esc(divisiOf(k) || '-') + '</td>' +
        '<td>' + esc(subDivisiOf(k) || '-') + '</td>' +
        '<td>' + esc(k.bagian || '-') + '</td>' +
        '<td>' + esc(k.jabatan || '-') + '</td>' +
        '<td>' + esc(k.shift || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="empty-state">Tidak ada data sesuai filter.</td></tr>';

    app.innerHTML = window.SPB.ui.layout('karyawan',
      '<div class="page-head">' +
        '<div><h1 class="page-title">Karyawan</h1>' +
        '<p class="page-sub">Master nama karyawan dari Google Sheet — dipakai buat form Distribusi WH/OUT & Permintaan Barang.</p></div>' +
        '<div class="page-head-actions">' +
          '<label style="display:flex;align-items:center;gap:0.375rem;font-size:0.8125rem;color:var(--slate-600);cursor:pointer;margin-right:0.5rem">' +
            '<input type="checkbox" ' + (showInactive ? 'checked' : '') + ' onchange="SPB.karyawan.toggleShowInactive()">Tampilkan nonaktif</label>' +
          '<button type="button" class="btn btn-primary" ' + (syncing ? 'disabled' : '') + ' onclick="SPB.karyawan.sync()">' +
            '<i data-lucide="' + (syncing ? 'loader-2' : 'refresh-cw') + '" class="icon-sm' + (syncing ? ' spin' : '') + '"></i>' +
            (syncing ? 'Sinkron...' : 'Sync dari Google Sheet') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="list-filter" class="icon-md"></i>Daftar Karyawan</h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
            '<input class="search-input" placeholder="Cari nama..." value="' + esc(filters.q) + '" oninput="SPB.karyawan.applyFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.karyawan.applyFilter(\'divisi\', this.value)">' +
              '<option value="">Semua Divisi</option>' +
              divisis.map(function (d) {
                return '<option value="' + esc(d) + '"' + (filters.divisi === d ? ' selected' : '') + '>' + esc(d) + '</option>';
              }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.karyawan.applyFilter(\'subDivisi\', this.value)">' +
              '<option value="">Semua Sub Divisi</option>' +
              subDivisis.map(function (d) {
                return '<option value="' + esc(d) + '"' + (filters.subDivisi === d ? ' selected' : '') + '>' + esc(d) + '</option>';
              }).join('') +
            '</select>' +
            (filters.q || filters.divisi || filters.subDivisi
              ? '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.karyawan.resetFilters()">' +
                '<i data-lucide="x" class="icon-sm"></i>Hapus Filter</button>'
              : '') +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Nama</th><th>NIP</th><th>Divisi</th><th>Sub Divisi</th><th>Bagian</th><th>Jabatan</th><th>Shift</th></tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
        '</table></div></div>' +
        paginationHtml(currentPage, totalPages, totalRows) +
      '</div>'
    );
    window.SPB.ui.afterRender();
  }

  function sync() {
    if (syncing) return;
    syncing = true;
    renderLocal();
    window.SPB.dbKaryawan.syncFromOdoo().then(function (res) {
      syncing = false;
      window.SPB.ui.toast('Sinkron selesai', res.upserted + ' karyawan diperbarui.', 'success');
      render();
    }).catch(function (err) {
      syncing = false;
      window.SPB.ui.toast('Sinkron gagal', err.message, 'error');
      renderLocal();
    });
  }

  window.SPB = window.SPB || {};
  window.SPB.karyawan = { render: render, applyFilter: applyFilter, resetFilters: resetFilters, toggleShowInactive: toggleShowInactive, goToPage: goToPage, sync: sync, prefetch: prefetch };
})();
