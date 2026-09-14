/* =========================================================
   SPB · permintaan.js
   Halaman admin "Permintaan Barang" (#/permintaan) — sisi ADMIN dari portal
   pemesanan online per-divisi (Pilihan B: digabung ke SPB, 1 Supabase).
   3 sub-tab: Live Antrean, Riwayat Keluar, Laporan — porting dari
   tab-antrean/tab-riwayat/tab-laporan di Program Pemesanan lama, disesuaikan
   ke pola SPB (layout(), statCard, pagination, dst).

   BELUM termasuk portal pemesanan sisi karyawan (tanpa login, pilih divisi,
   isi form) — itu langkah berikutnya. File ini cuma sisi admin yang lihat &
   proses semua pesanan.
   ========================================================= */

(function () {
  'use strict';

  const PAGE_SIZE = 15;
  let tab = 'antrean'; // 'antrean' | 'riwayat' | 'laporan'
  let currentPage = 1;
  let allPesanan = [];
  let everLoaded = false;
  const filters = { q: '', divisi: '', status: '' };
  const laporanState = { preset: 'bulan-ini', dari: '', sampai: '', view: 'produk' };

  // Popup detail (klik baris antrean) — id pesanan yang lagi dibuka, plus
  // status kirim-ke-Odoo (dipisah dari `sending` biar nggak nge-disable
  // tombol lain yang nggak lagi diproses).
  let detailId = null;
  let sendingToOdoo = false;

  const STATUS_LABEL = { waiting: 'Menunggu', processing: 'Diproses', ready: 'Siap Ambil', done: 'Selesai' };
  const STATUS_BADGE = { waiting: 'badge-draft', processing: 'badge-inspection', ready: 'badge-odoo-done', done: 'badge-approved' };
  const STATUS_NEXT = { waiting: 'processing', processing: 'ready', ready: 'done' };
  const STATUS_NEXT_LABEL = { waiting: 'Proses', processing: 'Siap Ambil', ready: 'Selesaikan' };

  function statusBadgeHtml(status) {
    return '<span class="badge ' + (STATUS_BADGE[status] || 'badge-draft') + '"><span class="badge-dot"></span>' + (STATUS_LABEL[status] || status) + '</span>';
  }
  function statCard(icon, iconClass, label, value, sub) {
    return '<div class="stat-card">' +
      '<div><p class="stat-label">' + label + '</p>' +
      '<p class="stat-value">' + value + '</p>' +
      (sub ? '<p class="stat-sub">' + sub + '</p>' : '') + '</div>' +
      '<div class="stat-icon ' + iconClass + '"><i data-lucide="' + icon + '" class="icon-md"></i></div>' +
    '</div>';
  }
  function fmtDateTime(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDate(v) {
    if (!v) return '-';
    return new Date(v).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function itemsQty(p) { return (p.items || []).reduce(function (a, it) { return a + Number(it.qty || 0); }, 0); }
  // Langsung tampil poin-poin (satu barang per baris) — nggak perlu diklik
  // buat lihat, biar petugas gudang langsung kebaca sekilas.
  function itemsCellHtml(p) {
    const items = p.items || [];
    if (!items.length) return '<span class="muted">-</span>';
    return '<ul class="pesan-items-list">' +
      items.map(function (it) { return '<li>' + esc(it.nama_barang) + ' <span class="muted">(' + it.qty + (it.satuan ? ' ' + esc(it.satuan) : '') + ')</span></li>'; }).join('') +
    '</ul>';
  }
  /* ---------- Popup detail pesanan (klik baris) ---------- */
  function openDetail(id) { detailId = id; renderDetailModal(); }
  function closeDetail() { detailId = null; renderDetailModal(); }

  function renderDetailModal() {
    let root = document.getElementById('permintaan-detail-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'permintaan-detail-modal-root';
      document.body.appendChild(root);
    }
    if (!detailId) { root.innerHTML = ''; return; }
    const p = allPesanan.find(function (x) { return x.id === detailId; });
    if (!p) { root.innerHTML = ''; detailId = null; return; }

    const items = p.items || [];
    const itemsRows = items.length
      ? items.map(function (it) {
          return '<tr><td>' + esc(it.nama_barang) + '</td>' +
            '<td style="font-family:var(--font-mono, monospace);font-size:0.8125rem">' + esc(it.sku || '-') + '</td>' +
            '<td>' + it.qty + ' ' + esc(it.satuan || '') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="3" class="empty-state">Tidak ada item.</td></tr>';

    root.innerHTML =
      '<div class="modal-backdrop">' +
        '<div class="modal slide-up" role="dialog" aria-modal="true" aria-label="Detail Pesanan" style="max-width:36rem">' +
          '<p class="modal-title">' + esc(queueLabel(p)) + (p.is_urgent ? ' <span class="badge-urgent"><i data-lucide="zap" class="icon-sm"></i>URGENT</span>' : '') + '</p>' +
          '<p class="modal-sub">' + fmtDateTime(p.created_at) + '</p>' +
          '<dl class="dl-grid" style="margin-top:1rem">' +
            '<dt>Nama</dt><dd>' + esc(p.karyawan_name) + '</dd>' +
            '<dt>NIP</dt><dd>' + esc(p.nip || '-') + '</dd>' +
            '<dt>Divisi</dt><dd>' + esc(p.divisi || '-') + (p.sub_divisi ? ' / ' + esc(p.sub_divisi) : '') + '</dd>' +
            '<dt>Jabatan</dt><dd>' + esc(p.jabatan || '-') + '</dd>' +
            '<dt>Keperluan</dt><dd>' + esc(p.tujuan || '-') + '</dd>' +
            '<dt>Jenis Pemesanan</dt><dd>' + (p.mode === 'titip' ? 'Titip ke ' + esc(p.titip_ke_name || '-') : 'Pesanan Umum') + '</dd>' +
            '<dt>Catatan</dt><dd>' + esc(p.catatan || '-') + '</dd>' +
            '<dt>Status</dt><dd>' + statusBadgeHtml(p.status) + '</dd>' +
            '<dt>WH/OUT</dt><dd>' + (p.wh_out_ref ? '<b style="color:var(--brand-700)">' + esc(p.wh_out_ref) + '</b>' : '<span class="muted">Belum dikirim</span>') + '</dd>' +
          '</dl>' +
          '<h2 class="pesan-cart-title" style="margin-top:1.25rem">Item Dipesan</h2>' +
          '<div class="table-wrap"><table class="table">' +
            '<thead><tr><th>Nama Barang</th><th>SKU</th><th>Jumlah</th></tr></thead>' +
            '<tbody>' + itemsRows + '</tbody>' +
          '</table></div>' +
          '<div class="modal-actions" style="margin-top:1.25rem">' +
            '<button type="button" class="btn btn-outline" onclick="SPB.permintaan.closeDetail()">Tutup</button>' +
            (p.wh_out_ref
              ? '<button type="button" class="btn btn-outline" disabled><i data-lucide="check" class="icon-sm"></i>Sudah Dikirim</button>'
              : '<button type="button" class="btn btn-primary" ' + (sendingToOdoo ? 'disabled' : '') + ' onclick="SPB.permintaan.sendToOdoo(\'' + p.id + '\')">' +
                (sendingToOdoo ? '<i data-lucide="loader-2" class="icon-sm spin"></i>Mengirim...' : '<i data-lucide="send" class="icon-sm"></i>Kirim ke Odoo') +
                '</button>') +
          '</div>' +
        '</div>' +
      '</div>';
    window.SPB.ui.afterRender();
    root.querySelector('.modal-backdrop').addEventListener('click', function (e) {
      if (e.target === this && !sendingToOdoo) closeDetail();
    });
  }

  // Kirim 1 pesanan jadi Delivery Order (Draft) di Odoo — TANPA Validate/Mark
  // as Todo, cuma create() polos (lihat odoo-create-wh-out). Setelah berhasil,
  // trigger sync odoo-pull-wh-out biar nomor WH/OUT-nya "narik balik" masuk
  // ke Log Pengeluaran SPB lewat jalur yang udah ada (bukan insert manual).
  async function sendToOdoo(id) {
    if (sendingToOdoo) return;
    sendingToOdoo = true;
    renderDetailModal();
    try {
      const result = await window.SPB.dbPesanan.sendToOdoo(id);
      if (result.warnings && result.warnings.length) {
        window.SPB.ui.toast('Terkirim dengan catatan', result.warnings.join(' '), 'info');
      } else {
        window.SPB.ui.toast('Terkirim ke Odoo', 'Delivery Order ' + result.wh_out_ref + ' dibuat (status Draft).', 'success');
      }
      const rows = await window.SPB.dbPesanan.listAll();
      allPesanan = rows;
      sendingToOdoo = false;
      renderDetailModal();
      renderLocal();
      // Sync odoo-pull-wh-out biar WH/OUT barusan langsung nongol di Log
      // Pengeluaran — dipanggil langsung (nggak ada wrapper client, function
      // ini biasanya murni jalan lewat cron), gagal pun nggak fatal, tinggal
      // kejaring jadwal cron berikutnya.
      const CFG = window.SPB_CONFIG;
      fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-pull-wh-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({}),
      }).catch(function () { /* diam-diam gagal juga gapapa, kejaring cron berikutnya */ });
    } catch (err) {
      sendingToOdoo = false;
      window.SPB.ui.toast('Gagal mengirim ke Odoo', err.message, 'error');
      renderDetailModal();
    }
  }

  // Huruf depan ngikut inisial divisi (sama pola kayak pesan.js) — Denim ->
  // D, Spinning -> S, Umum -> U. Nomor urutnya tetap 1 deret global.
  function queueLabel(p) {
    const d = (p.divisi || '').trim();
    return (d ? d.charAt(0).toUpperCase() : 'A') + '-' + String(p.queue_no).padStart(4, '0');
  }

  function paginationHtml(page, totalPages, totalRows) {
    if (totalRows === 0) return '';
    if (totalPages <= 1) return '<div class="pagination"><span class="pagination-info">' + totalRows + ' data</span></div>';
    const pages = [];
    const add = function (p) { if (pages.indexOf(p) === -1) pages.push(p); };
    add(1); add(totalPages);
    for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) add(p);
    pages.sort(function (a, b) { return a - b; });
    let numbersHtml = '', prev = 0;
    pages.forEach(function (p) {
      if (p - prev > 1) numbersHtml += '<span class="pagination-ellipsis">…</span>';
      numbersHtml += '<button type="button" class="pagination-num' + (p === page ? ' active' : '') + '" onclick="SPB.permintaan.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination"><span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') + ' onclick="SPB.permintaan.goToPage(' + (page - 1) + ')"><i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') + ' onclick="SPB.permintaan.goToPage(' + (page + 1) + ')"><i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div></div>';
  }
  function paginate(rows) {
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    return { pageRows: rows.slice(start, start + PAGE_SIZE), totalPages: totalPages, totalRows: rows.length };
  }

  /* ---------- Render utama ---------- */
  function render() {
    // Setiap kali BENERAN masuk ulang ke halaman ini (dari menu sidebar lain,
    // bukan cuma ganti tab di dalam halaman ini sendiri) — balik ke tab &
    // view default ("Live Antrean" / "Semua"), bukan "nyangkut" di tab/view
    // terakhir yang lagi dibuka pas kabur ke halaman lain.
    tab = 'antrean';
    laporanState.view = 'semua';
    currentPage = 1;
    ensurePolling();
    if (everLoaded) {
      buildAndShow(allPesanan);
      fetchQuiet();
    } else {
      const app = document.getElementById('app');
      app.innerHTML = window.SPB.ui.layout('permintaan',
        '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>');
      window.SPB.ui.afterRender();
      fetchQuiet();
    }
  }
  function fetchQuiet() {
    window.SPB.dbPesanan.listAll().then(function (rows) {
      if (location.hash.replace(/^#/, '') !== '/permintaan') return; // udah pindah halaman — abaikan hasil telat
      allPesanan = rows;
      everLoaded = true;
      buildAndShow(rows);
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal memuat', err.message, 'error');
    });
  }
  function renderLocal() { buildAndShow(allPesanan); }

  // Auto-refresh diam-diam tiap 15 detik SELAMA masih di halaman ini — biar
  // "Live" beneran, karyawan yang lagi pesan dari portal langsung kelihatan
  // tanpa admin perlu refresh manual.
  let pollTimer = null;
  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (location.hash.replace(/^#/, '') !== '/permintaan') { clearInterval(pollTimer); pollTimer = null; return; }
      fetchQuiet();
    }, 15000);
  }

  function setTab(t) { tab = t; currentPage = 1; renderLocal(); }
  function goToPage(p) { currentPage = p; renderLocal(); }
  function applyFilter(key, value) { filters[key] = value; currentPage = 1; renderLocal(); }

  async function advanceStatus(id, nextStatus) {
    try {
      await window.SPB.dbPesanan.updateStatus(id, nextStatus);
      const found = allPesanan.find(function (p) { return p.id === id; }) || {};
      window.SPB.ui.toast('Status diperbarui', queueLabel(found) + ' → ' + STATUS_LABEL[nextStatus] + '.', 'success');
      const rows = await window.SPB.dbPesanan.listAll();
      allPesanan = rows;
      renderLocal();
    } catch (err) {
      window.SPB.ui.toast('Gagal memperbarui', err.message, 'error');
    }
  }

  function divisiOptionsFrom(rows) {
    const set = {};
    rows.forEach(function (p) { if (p.divisi) set[p.divisi] = true; });
    return Object.keys(set).sort();
  }

  /* ---------- Tab: Live Antrean ---------- */
  function antreanHtml(rows) {
    const active = rows.filter(function (p) { return p.status !== 'done'; });
    const divisiOptions = divisiOptionsFrom(rows);

    let filtered = active;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      filtered = filtered.filter(function (p) { return (p.karyawan_name || '').toLowerCase().indexOf(q) !== -1; });
    }
    if (filters.divisi) filtered = filtered.filter(function (p) { return p.divisi === filters.divisi; });
    if (filters.status) filtered = filtered.filter(function (p) { return p.status === filters.status; });
    // Urgent DULUAN (bukan cuma badge) baru FIFO di antara sesama kelompok
    // urgent/non-urgent — pesanan urgent beneran lompat ke atas antrean,
    // petugas gudang nggak perlu scroll cari-cari sendiri.
    filtered = filtered.slice().sort(function (a, b) {
      if (!!b.is_urgent !== !!a.is_urgent) return (b.is_urgent ? 1 : 0) - (a.is_urgent ? 1 : 0);
      return new Date(a.created_at) - new Date(b.created_at);
    });

    const { pageRows, totalPages, totalRows } = paginate(filtered);
    const rowsHtml = pageRows.map(function (p) {
      const next = STATUS_NEXT[p.status];
      // Klik di mana pun di baris (kecuali tombol Proses) buka popup detail —
      // event.stopPropagation() di tombol aksi biar nggak ke-double-trigger.
      return '<tr class="row-clickable' + (p.is_urgent ? ' row-urgent' : '') + '" onclick="SPB.permintaan.openDetail(\'' + p.id + '\')">' +
        '<td style="font-weight:700;color:var(--brand-600)">' + esc(queueLabel(p)) +
          (p.is_urgent ? ' <span class="badge-urgent"><i data-lucide="zap" class="icon-sm"></i>URGENT</span>' : '') + '</td>' +
        '<td><p style="font-weight:600">' + esc(p.karyawan_name) + '</p>' +
          '<p class="muted" style="font-size:0.75rem">' + esc(p.divisi || '-') + (p.sub_divisi ? ' / ' + esc(p.sub_divisi) : '') + '</p></td>' +
        '<td style="font-size:0.8125rem">' + esc(p.tujuan || '-') + '</td>' +
        '<td style="font-size:0.8125rem;max-width:16rem">' + itemsCellHtml(p) + '</td>' +
        '<td style="font-size:0.8125rem">' + fmtDateTime(p.created_at) + '</td>' +
        '<td>' + statusBadgeHtml(p.status) + '</td>' +
        '<td class="text-right">' + (next
          ? '<button type="button" class="btn btn-primary btn-sm" onclick="event.stopPropagation();SPB.permintaan.advanceStatus(\'' + p.id + '\',\'' + next + '\')">' + STATUS_NEXT_LABEL[p.status] + '</button>'
          : '<span class="muted">-</span>') + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="7" class="empty-state">Tidak ada antrean.</td></tr>';

    return '<div class="table-card">' +
      '<div class="table-head">' +
        '<h2 class="table-title"><i data-lucide="clock" class="icon-md"></i>Live Antrean Permintaan</h2>' +
        '<div class="table-tools">' +
          '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
            '<input class="search-input" placeholder="Cari nama karyawan..." value="' + esc(filters.q) + '" oninput="SPB.permintaan.applyFilter(\'q\', this.value)"></div>' +
          '<select class="select-input" onchange="SPB.permintaan.applyFilter(\'divisi\', this.value)">' +
            '<option value="">Semua Divisi</option>' +
            divisiOptions.map(function (v) { return '<option value="' + esc(v) + '"' + (filters.divisi === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
          '</select>' +
          '<select class="select-input" onchange="SPB.permintaan.applyFilter(\'status\', this.value)">' +
            '<option value="">Semua Status</option>' +
            Object.keys(STATUS_LABEL).filter(function (s) { return s !== 'done'; }).map(function (s) {
              return '<option value="' + s + '"' + (filters.status === s ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="table-wrap"><table class="table">' +
        '<thead><tr><th>No. Antrian</th><th>Karyawan</th><th>Keperluan</th><th>Item</th><th>Waktu</th><th>Status</th><th></th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table></div>' +
      paginationHtml(currentPage, totalPages, totalRows) +
    '</div>';
  }

  /* ---------- Tab: Riwayat Keluar ---------- */
  function riwayatHtml(rows) {
    const done = rows.filter(function (p) { return p.status === 'done'; });
    // Flatten per item — 1 baris = 1 barang dari 1 pesanan selesai, sama pola
    // dengan "Semua Distribusi" di Laporan WH/OUT SPB.
    const flat = [];
    done.forEach(function (p) {
      (p.items || []).forEach(function (it) {
        flat.push({ tanggal: p.done_at || p.created_at, nama: it.nama_barang, qty: it.qty, satuan: it.satuan, karyawan: p.karyawan_name, divisi: p.divisi });
      });
    });
    flat.sort(function (a, b) { return new Date(b.tanggal) - new Date(a.tanggal); });

    const { pageRows, totalPages, totalRows } = paginate(flat);
    const rowsHtml = pageRows.map(function (it) {
      return '<tr><td>' + fmtDate(it.tanggal) + '</td>' +
        '<td style="font-size:0.8125rem">' + new Date(it.tanggal).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + '</td>' +
        '<td style="font-weight:600">' + esc(it.nama) + '</td>' +
        '<td>' + it.qty + ' ' + esc(it.satuan || '') + '</td>' +
        '<td>' + esc(it.karyawan) + '</td>' +
        '<td style="font-size:0.8125rem;color:var(--slate-500)">' + esc(it.divisi || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty-state">Belum ada barang keluar.</td></tr>';

    return '<div class="table-card">' +
      '<div class="table-head"><h2 class="table-title"><i data-lucide="history" class="icon-md"></i>Riwayat Barang Keluar</h2></div>' +
      '<div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Tanggal</th><th>Waktu</th><th>Nama Barang</th><th>Qty Keluar</th><th>Karyawan</th><th>Divisi</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table></div>' +
      paginationHtml(currentPage, totalPages, totalRows) +
    '</div>';
  }

  /* ---------- Tab: Laporan ---------- */
  function laporanRangeDates() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let dari = null, sampai = new Date();
    const p = laporanState.preset;
    if (p === 'hari-ini') { dari = new Date(today); }
    else if (p === 'kemarin') { dari = new Date(today); dari.setDate(dari.getDate() - 1); sampai = new Date(dari); sampai.setHours(23, 59, 59, 999); }
    else if (p === '7-hari') { dari = new Date(today); dari.setDate(dari.getDate() - 6); }
    else if (p === '30-hari') { dari = new Date(today); dari.setDate(dari.getDate() - 29); }
    else if (p === 'bulan-ini') { dari = new Date(today.getFullYear(), today.getMonth(), 1); }
    else if (p === 'bulan-lalu') { dari = new Date(today.getFullYear(), today.getMonth() - 1, 1); sampai = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59); }
    else if (p === 'tahun-ini') { dari = new Date(today.getFullYear(), 0, 1); }
    else if (p === 'semua') { dari = null; }
    else if (p === 'kustom') { dari = laporanState.dari ? new Date(laporanState.dari) : null; sampai = laporanState.sampai ? new Date(laporanState.sampai + 'T23:59:59') : sampai; }
    return { dari: dari, sampai: sampai };
  }
  function setLaporanPreset(v) { laporanState.preset = v; renderLocal(); }
  function setLaporanCustom(key, v) { laporanState[key] = v; laporanState.preset = 'kustom'; renderLocal(); }
  function setLaporanView(v) { laporanState.view = v; currentPage = 1; renderLocal(); }

  function rankBarsHtml(agg) {
    const max = Math.max(1, agg.reduce(function (m, a) { return Math.max(m, a.value); }, 0));
    return '<div class="hbar-chart">' + agg.map(function (a) {
      const pct = Math.max(4, Math.round((a.value / max) * 100));
      return '<div class="hbar-row">' +
        '<div class="hbar-label" title="' + esc(a.key) + '">' + esc(a.key) + '</div>' +
        '<div class="hbar-track"><div class="hbar-fill" style="width:' + pct + '%;background:var(--brand-500)"></div></div>' +
        '<div class="hbar-value">' + a.value + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function laporanHtml(rows) {
    const { dari, sampai } = laporanRangeDates();
    const inRange = rows.filter(function (p) {
      const t = new Date(p.created_at);
      if (dari && t < dari) return false;
      if (sampai && t > sampai) return false;
      return true;
    });
    const totalPesanan = inRange.length;
    const karyawanSet = {}; inRange.forEach(function (p) { karyawanSet[p.karyawan_name] = true; });
    const divisiCount = {}; inRange.forEach(function (p) { if (p.divisi) divisiCount[p.divisi] = (divisiCount[p.divisi] || 0) + 1; });
    const divisiTop = Object.keys(divisiCount).sort(function (a, b) { return divisiCount[b] - divisiCount[a]; })[0] || '-';
    const perluDitinjau = inRange.filter(function (p) { return p.shortage_report; }).length;

    const produkAgg = {};
    inRange.forEach(function (p) { (p.items || []).forEach(function (it) {
      produkAgg[it.nama_barang] = (produkAgg[it.nama_barang] || 0) + Number(it.qty || 0);
    }); });
    const produkList = Object.keys(produkAgg).map(function (k) { return { key: k, value: produkAgg[k] }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 12);

    const orangAgg = {};
    inRange.forEach(function (p) { orangAgg[p.karyawan_name] = (orangAgg[p.karyawan_name] || 0) + 1; });
    const orangList = Object.keys(orangAgg).map(function (k) { return { key: k, value: orangAgg[k] }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 12);

    const divisiList = Object.keys(divisiCount).map(function (k) { return { key: k, value: divisiCount[k] }; }).sort(function (a, b) { return b.value - a.value; });

    // View "tabel" — rekap gaya Excel/Google Sheets, 1 baris per ITEM barang
    // (bukan per pesanan), kolomnya banyak, bisa di-scroll ke samping kalau
    // kelebaran (pakai .table-wrap yang udah ada, sama kayak tabel lain di
    // app ini) — bukan file export, tetap tampilan di layar.
    let tableSectionHtml = '';
    if (laporanState.view === 'tabel') {
      const flatRows = [];
      inRange.forEach(function (p) {
        (p.items && p.items.length ? p.items : [null]).forEach(function (it) {
          flatRows.push({ p: p, it: it });
        });
      });
      flatRows.sort(function (a, b) { return new Date(b.p.created_at) - new Date(a.p.created_at); });
      const { pageRows, totalPages, totalRows } = paginate(flatRows);
      const bodyHtml = pageRows.map(function (r) {
        const p = r.p, it = r.it;
        return '<tr>' +
          '<td style="font-size:0.8125rem">' + fmtDateTime(p.created_at) + '</td>' +
          '<td>' + esc(p.karyawan_name) + '</td>' +
          '<td style="font-family:var(--font-mono, monospace);font-size:0.8125rem">' + esc(p.nip || '-') + '</td>' +
          '<td>' + esc(p.divisi || '-') + '</td>' +
          '<td>' + esc(p.sub_divisi || '-') + '</td>' +
          '<td>' + esc(p.jabatan || '-') + '</td>' +
          '<td>' + esc(p.tujuan || '-') + '</td>' +
          '<td>' + esc(it ? it.nama_barang : '-') + '</td>' +
          '<td style="font-family:var(--font-mono, monospace);font-size:0.8125rem">' + esc(it ? (it.sku || '-') : '-') + '</td>' +
          '<td>' + (it ? it.qty : '-') + '</td>' +
          '<td>' + esc(it ? (it.satuan || '-') : '-') + '</td>' +
          '<td>' + statusBadgeHtml(p.status) + '</td>' +
          '<td>' + (p.is_urgent ? '<span class="badge-urgent"><i data-lucide="zap" class="icon-sm"></i>URGENT</span>' : '-') + '</td>' +
          '<td>' + esc(p.wh_out_ref || '-') + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan="14" class="empty-state">Tidak ada data sesuai periode.</td></tr>';

      tableSectionHtml = '<div class="table-card" style="margin-top:1rem">' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr>' +
            ['Tanggal', 'Nama', 'NIP', 'Divisi', 'Sub Divisi', 'Jabatan', 'Keperluan', 'Nama Barang', 'SKU', 'Qty', 'Satuan', 'Status', 'Urgent', 'WH/OUT']
              .map(function (h) { return '<th>' + h + '</th>'; }).join('') +
          '</tr></thead>' +
          '<tbody>' + bodyHtml + '</tbody>' +
        '</table></div></div>' +
        paginationHtml(currentPage, totalPages, totalRows) +
      '</div>';
    }

    let sectionHtml;
    if (laporanState.view === 'tabel') {
      sectionHtml = tableSectionHtml;
    } else if (laporanState.view === 'produk') {
      sectionHtml = '<div class="chart-card"><p class="chart-title"><i data-lucide="package" class="icon-md"></i>Barang Paling Sering Dipesan</p>' +
        (produkList.length ? rankBarsHtml(produkList) : '<div class="empty-state">Belum ada data.</div>') + '</div>';
    } else if (laporanState.view === 'orang') {
      sectionHtml = '<div class="chart-card"><p class="chart-title"><i data-lucide="users" class="icon-md"></i>Frekuensi Pemesanan per Karyawan</p>' +
        (orangList.length ? rankBarsHtml(orangList) : '<div class="empty-state">Belum ada data.</div>') + '</div>';
    } else if (laporanState.view === 'divisi') {
      sectionHtml = '<div class="chart-card"><p class="chart-title"><i data-lucide="building-2" class="icon-md"></i>Total Pesanan per Divisi</p>' +
        (divisiList.length ? rankBarsHtml(divisiList) : '<div class="empty-state">Belum ada data.</div>') + '</div>';
    } else {
      sectionHtml =
        '<div class="chart-card"><p class="chart-title"><i data-lucide="package" class="icon-md"></i>Barang Paling Sering Dipesan</p>' +
          (produkList.length ? rankBarsHtml(produkList) : '<div class="empty-state">Belum ada data.</div>') + '</div>' +
        '<div class="chart-card" style="margin-top:1rem"><p class="chart-title"><i data-lucide="users" class="icon-md"></i>Frekuensi per Karyawan</p>' +
          (orangList.length ? rankBarsHtml(orangList) : '<div class="empty-state">Belum ada data.</div>') + '</div>' +
        '<div class="chart-card" style="margin-top:1rem"><p class="chart-title"><i data-lucide="building-2" class="icon-md"></i>Total per Divisi</p>' +
          (divisiList.length ? rankBarsHtml(divisiList) : '<div class="empty-state">Belum ada data.</div>') + '</div>';
    }

    return '<div class="report-filters">' +
        '<div class="report-view-tabs">' +
          ['semua', 'produk', 'orang', 'divisi', 'tabel'].map(function (v) {
            const labelMap = { semua: 'Semua', produk: 'Per Produk', orang: 'Per Orang', divisi: 'Per Divisi', tabel: 'Tabel Lengkap' };
            return '<button type="button" class="report-tab' + (laporanState.view === v ? ' active' : '') + '" onclick="SPB.permintaan.setLaporanView(\'' + v + '\')">' + labelMap[v] + '</button>';
          }).join('') +
        '</div>' +
        '<div class="report-filter-fields">' +
          '<div><label class="field-label">Periode</label>' +
          '<select class="select-input" onchange="SPB.permintaan.setLaporanPreset(this.value)">' +
            ['hari-ini', 'kemarin', '7-hari', '30-hari', 'bulan-ini', 'bulan-lalu', 'tahun-ini', 'semua', 'kustom'].map(function (v) {
              const labelMap = { 'hari-ini': 'Hari Ini', 'kemarin': 'Kemarin', '7-hari': '7 Hari Terakhir', '30-hari': '30 Hari Terakhir', 'bulan-ini': 'Bulan Ini', 'bulan-lalu': 'Bulan Lalu', 'tahun-ini': 'Tahun Ini', 'semua': 'Semua Waktu', 'kustom': 'Kustom' };
              return '<option value="' + v + '"' + (laporanState.preset === v ? ' selected' : '') + '>' + labelMap[v] + '</option>';
            }).join('') +
          '</select></div>' +
          (laporanState.preset === 'kustom'
            ? '<div><label class="field-label">Dari</label><input type="date" class="input" value="' + esc(laporanState.dari) + '" onchange="SPB.permintaan.setLaporanCustom(\'dari\', this.value)"></div>' +
              '<div><label class="field-label">Sampai</label><input type="date" class="input" value="' + esc(laporanState.sampai) + '" onchange="SPB.permintaan.setLaporanCustom(\'sampai\', this.value)"></div>'
            : '') +
        '</div>' +
      '</div>' +
      '<div class="grid-stats" style="grid-template-columns:repeat(4,1fr)">' +
        statCard('list-checks', 'sky', 'Total Pesanan', totalPesanan, 'sesuai periode') +
        statCard('users', 'emerald', 'Karyawan Aktif Pesan', Object.keys(karyawanSet).length, '') +
        statCard('building-2', 'indigo', 'Divisi Teraktif', esc(divisiTop), '') +
        statCard('alert-triangle', 'amber', 'Perlu Ditinjau', perluDitinjau, 'ada laporan kurang') +
      '</div>' +
      sectionHtml;
  }

  /* ---------- Render gabungan ---------- */
  function buildAndShow(rows) {
    const app = document.getElementById('app');
    const active = rows.filter(function (p) { return p.status !== 'done'; });
    const waitingCount = rows.filter(function (p) { return p.status === 'waiting'; }).length;
    const doneToday = rows.filter(function (p) {
      if (p.status !== 'done' || !p.done_at) return false;
      const d = new Date(p.done_at), today = new Date();
      return d.toDateString() === today.toDateString();
    }).length;

    const tabsHtml = '<div class="report-view-tabs" style="margin-bottom:1.25rem">' +
      '<button type="button" class="report-tab' + (tab === 'antrean' ? ' active' : '') + '" onclick="SPB.permintaan.setTab(\'antrean\')">' +
        '<i data-lucide="clock" class="icon-sm"></i>Live Antrean<span class="badge-count" style="position:static;margin-left:0.375rem;background:var(--brand-600)">' + active.length + '</span></button>' +
      '<button type="button" class="report-tab' + (tab === 'riwayat' ? ' active' : '') + '" onclick="SPB.permintaan.setTab(\'riwayat\')">' +
        '<i data-lucide="history" class="icon-sm"></i>Riwayat Keluar</button>' +
      '<button type="button" class="report-tab' + (tab === 'laporan' ? ' active' : '') + '" onclick="SPB.permintaan.setTab(\'laporan\')">' +
        '<i data-lucide="file-bar-chart" class="icon-sm"></i>Laporan</button>' +
    '</div>';

    const body = tab === 'antrean' ? antreanHtml(rows) : tab === 'riwayat' ? riwayatHtml(rows) : laporanHtml(rows);

    app.innerHTML = window.SPB.ui.layout('permintaan',
      '<div class="page-head">' +
        '<div><h1 class="page-title">Permintaan Barang</h1>' +
        '<p class="page-sub">Portal pemesanan online per-divisi — terpisah dari alur Penerimaan/Pengeluaran Odoo.</p></div>' +
      '</div>' +
      (tab === 'laporan' ? '' :
        '<div class="grid-stats">' +
          statCard('clock', 'amber', 'Menunggu', waitingCount, 'antrean aktif') +
          statCard('list-checks', 'sky', 'Total Aktif', active.length, 'belum selesai') +
          statCard('badge-check', 'emerald', 'Selesai Hari Ini', doneToday, '') +
        '</div>') +
      tabsHtml +
      body
    );
    window.SPB.ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.permintaan = {
    render: render,
    setTab: setTab,
    goToPage: goToPage,
    applyFilter: applyFilter,
    advanceStatus: advanceStatus,
    openDetail: openDetail,
    closeDetail: closeDetail,
    sendToOdoo: sendToOdoo,
    setLaporanPreset: setLaporanPreset,
    setLaporanCustom: setLaporanCustom,
    setLaporanView: setLaporanView,
  };
})();
