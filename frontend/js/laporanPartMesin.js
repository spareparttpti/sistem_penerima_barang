/* =========================================================
   SPB · laporanPartMesin.js
   Laporan Part Mesin (#/laporan-mesin) — TERPISAH dari Laporan ATK
   (laporanDivisi.js), sesuai catatan: "Laporan ATK & Mesin dipisah juga."
   Tabel mentah gaya spreadsheet dari permintaan_part_mesin, dengan filter
   per jenis/status/kategori/satuan/periode — mencakup semua jenis laporan
   yang dicatat (Category Part, Satuan Part, Laporan PO, Laporan Permintaan,
   Laporan Barang Datang/Keluar) lewat satu tabel + filter, bukan 6 halaman
   terpisah (lebih gampang dirawat, sama fleksibel).
   ========================================================= */

(function () {
  'use strict';

  let tab = 'used'; // 'used' | 'popr' | 'pemakaian'
  let rows = [];
  let partList = [];
  let loading = true;
  let loadError = '';
  const filters = { q: '', jenis: '', status: '', category: '', dari: '', sampai: '' };

  function setTab(tb) { tab = tb; location.hash = '#/laporan-mesin/' + tb; render(); }

  function esc(s) { return window.esc(s); }
  function fmtDateTime(v) {
    if (!v) return '-';
    const d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function statusLabel(status) {
    const t = window.SPB.spinningI18n.t;
    const map = {
      menunggu: 'pm_status_menunggu', disetujui: 'pm_status_disetujui', ditolak: 'pm_status_ditolak',
      diambil: 'pm_status_diambil', repair_start: 'pm_status_repair_start', repair_end: 'pm_status_repair_end',
      po_dibuat: 'pm_status_po_dibuat', barang_datang: 'pm_status_barang_datang',
    };
    return map[status] ? t(map[status]) : status;
  }
  const STATUS_KEYS = ['menunggu', 'disetujui', 'ditolak', 'diambil', 'repair_start', 'repair_end', 'po_dibuat', 'barang_datang'];

  async function load() {
    loading = true;
    loadError = '';
    render();
    try {
      const [p, pt] = await Promise.all([
        window.SPB.dbSpinning.listPermintaan(),
        window.SPB.dbSpinning.listPart(),
      ]);
      rows = p;
      partList = pt;
    } catch (err) {
      loadError = err.message || 'Gagal memuat laporan.';
    }
    loading = false;
    render();
  }
  function partById(id) { return partList.find(function (p) { return p.id === id; }); }
  function applyFilter(key, value) { filters[key] = value; render(); }

  function filteredRows() {
    return rows.filter(function (r) {
      if (filters.q) {
        const q = filters.q.toLowerCase();
        if ((r.nama_mekanik || '').toLowerCase().indexOf(q) === -1 && (r.nama_part || '').toLowerCase().indexOf(q) === -1) return false;
      }
      if (filters.jenis && r.jenis !== filters.jenis) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (filters.category) {
        const part = partById(r.part_id);
        if (!part || part.category !== filters.category) return false;
      }
      if (filters.dari && new Date(r.created_at) < new Date(filters.dari + 'T00:00:00')) return false;
      if (filters.sampai && new Date(r.created_at) > new Date(filters.sampai + 'T23:59:59')) return false;
      return true;
    }).sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  }

  function exportExcel() {
    if (!window.XLSX) { window.SPB.ui.toast('Gagal export', 'Library Excel belum termuat.', 'error'); return; }
    const list = filteredRows();
    if (!list.length) { window.SPB.ui.toast('Tidak ada data', 'Tidak ada data sesuai filter.', 'error'); return; }
    const data = list.map(function (r, i) {
      const part = partById(r.part_id);
      return {
        No: i + 1, Tanggal: fmtDateTime(r.created_at), 'No. Antrian': r.no_antrian,
        Jenis: r.jenis === 'supplier' ? 'Beli ke Supplier' : 'Ambil dari Gudang',
        'No. Mesin': r.no_mesin || '-', Mekanik: r.nama_mekanik, Part: r.nama_part,
        Category: part ? (part.category || '-') : '-', Satuan: part ? (part.satuan || '-') : '-',
        Jumlah: r.jumlah, Status: statusLabel(r.status),
        'Diajukan Oleh': r.requested_by || '-', 'Disetujui Oleh': r.approved_by || '-',
        'Start Repair': fmtDateTime(r.repair_start_at), 'End Repair': fmtDateTime(r.repair_end_at),
      };
    });
    const ws = window.XLSX.utils.json_to_sheet(data);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Laporan Part Mesin');
    window.XLSX.writeFile(wb, 'Laporan-PartMesin-' + new Date().toISOString().slice(0, 10) + '.xlsx');
    window.SPB.ui.toast('Excel terunduh', '', 'success');
  }

  // ---------- Tab: Sparepart Used — agregat pemakaian part (jenis gudang,
  // sudah completion/repair_end) per part, biar kelihatan part apa yang
  // paling sering habis dipakai. ----------
  function usedHtml() {
    const used = rows.filter(function (r) { return r.jenis === 'gudang' && r.status === 'repair_end'; });
    const byPart = {};
    used.forEach(function (r) {
      const key = r.nama_part;
      if (!byPart[key]) byPart[key] = { nama: r.nama_part, jumlah: 0, kali: 0 };
      byPart[key].jumlah += Number(r.jumlah || 0);
      byPart[key].kali += 1;
    });
    const list = Object.values(byPart).sort(function (a, b) { return b.jumlah - a.jumlah; });
    return '<div class="table-card">' +
      '<div class="table-head"><h2 class="table-title"><i data-lucide="package-check" class="icon-md"></i>' + window.SPB.spinningI18n.t('lap_tab_used') + '</h2></div>' +
      '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Part</th><th>Total Qty Terpakai</th><th>Jumlah Transaksi</th></tr></thead>' +
        '<tbody>' + (list.length ? list.map(function (r) {
          return '<tr><td>' + esc(r.nama) + '</td><td>' + r.jumlah + '</td><td>' + r.kali + '</td></tr>';
        }).join('') : '<tr><td colspan="3" class="empty-state">Tidak ada data.</td></tr>') + '</tbody>' +
      '</table></div></div>' +
    '</div>';
  }

  // ---------- Tab: Laporan Pemakaian per Mesin — agregat semua permintaan
  // (gudang & supplier) per no. mesin. ----------
  function pemakaianHtml() {
    const byMesin = {};
    rows.forEach(function (r) {
      const key = r.no_mesin || '(tanpa no. mesin)';
      if (!byMesin[key]) byMesin[key] = { mesin: key, jumlahPermintaan: 0, totalQty: 0, terakhir: null };
      byMesin[key].jumlahPermintaan += 1;
      byMesin[key].totalQty += Number(r.jumlah || 0);
      if (!byMesin[key].terakhir || new Date(r.created_at) > new Date(byMesin[key].terakhir)) byMesin[key].terakhir = r.created_at;
    });
    const list = Object.values(byMesin).sort(function (a, b) { return b.jumlahPermintaan - a.jumlahPermintaan; });
    return '<div class="table-card">' +
      '<div class="table-head"><h2 class="table-title"><i data-lucide="factory" class="icon-md"></i>' + window.SPB.spinningI18n.t('lap_tab_pemakaian') + '</h2></div>' +
      '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>No. Mesin</th><th>Jumlah Permintaan</th><th>Total Qty Part</th><th>Permintaan Terakhir</th></tr></thead>' +
        '<tbody>' + (list.length ? list.map(function (r) {
          return '<tr><td>' + esc(r.mesin) + '</td><td>' + r.jumlahPermintaan + '</td><td>' + r.totalQty + '</td><td>' + fmtDateTime(r.terakhir) + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="empty-state">Tidak ada data.</td></tr>') + '</tbody>' +
      '</table></div></div>' +
    '</div>';
  }

  function poprHtml() {
    const categories = Array.from(new Set(partList.map(function (p) { return p.category; }).filter(Boolean)));
    const list = filteredRows();
    const rowsHtml = list.map(function (r, i) {
      const part = partById(r.part_id);
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td style="white-space:nowrap">' + fmtDateTime(r.created_at) + '</td>' +
        '<td>#' + r.no_antrian + '</td>' +
        '<td><span class="tag ' + (r.jenis === 'supplier' ? 'tag-amber' : 'tag-emerald') + '">' + (r.jenis === 'supplier' ? 'Supplier' : 'Gudang') + '</span></td>' +
        '<td>' + esc(r.no_mesin || '-') + '</td>' +
        '<td>' + esc(r.nama_mekanik) + '</td>' +
        '<td>' + esc(r.nama_part) + '</td>' +
        '<td>' + esc(part ? (part.category || '-') : '-') + '</td>' +
        '<td>' + r.jumlah + ' ' + esc(part ? (part.satuan || '') : '') + '</td>' +
        '<td>' + esc(statusLabel(r.status)) + '</td>' +
        '<td style="white-space:nowrap">' + fmtDateTime(r.repair_start_at) + '</td>' +
        '<td style="white-space:nowrap">' + fmtDateTime(r.repair_end_at) + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="clipboard-list" class="icon-md"></i>' + window.SPB.spinningI18n.t('lap_tab_po_pr') + '</h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari mekanik / part..." value="' + esc(filters.q) + '" oninput="SPB.laporanPartMesin.applyFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.laporanPartMesin.applyFilter(\'jenis\', this.value)">' +
              '<option value="">Semua Jenis</option>' +
              '<option value="gudang"' + (filters.jenis === 'gudang' ? ' selected' : '') + '>Ambil dari Gudang</option>' +
              '<option value="supplier"' + (filters.jenis === 'supplier' ? ' selected' : '') + '>Beli ke Supplier</option>' +
            '</select>' +
            '<select class="select-input" onchange="SPB.laporanPartMesin.applyFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              STATUS_KEYS.map(function (s) { return '<option value="' + s + '"' + (filters.status === s ? ' selected' : '') + '>' + statusLabel(s) + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.laporanPartMesin.applyFilter(\'category\', this.value)">' +
              '<option value="">Semua Category</option>' +
              categories.map(function (c) { return '<option value="' + esc(c) + '"' + (filters.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
            '</select>' +
            '<input type="date" class="select-input" value="' + esc(filters.dari) + '" onchange="SPB.laporanPartMesin.applyFilter(\'dari\', this.value)">' +
            '<input type="date" class="select-input" value="' + esc(filters.sampai) + '" onchange="SPB.laporanPartMesin.applyFilter(\'sampai\', this.value)">' +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>No</th><th>Tanggal</th><th>Antrian</th><th>Jenis</th><th>No. Mesin</th><th>Mekanik</th><th>Part</th><th>Category</th><th>Jumlah</th><th>Status</th><th>Start Repair</th><th>End Repair</th></tr></thead>' +
          '<tbody>' + (rowsHtml || '<tr><td colspan="12" class="empty-state">Tidak ada data.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
        '<p class="pagination-info" style="padding:0.75rem 1rem">' + list.length + ' dari ' + rows.length + ' permintaan</p>' +
      '</div>';
  }

  function render() {
    const app = document.getElementById('app');
    const ui = window.SPB.ui;
    const t = window.SPB.spinningI18n.t;

    let body;
    if (loading) {
      body = '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>';
    } else if (loadError) {
      body = '<div class="empty-state" style="color:var(--red-600)">' + esc(loadError) + '</div>';
    } else {
      body = tab === 'used' ? usedHtml() : tab === 'pemakaian' ? pemakaianHtml() : poprHtml();
    }

    const pageTitle = tab === 'used' ? t('lap_tab_used') : tab === 'pemakaian' ? t('lap_tab_pemakaian') : t('lap_tab_po_pr');
    app.innerHTML = ui.layout('laporan-mesin-' + tab,
      '<div class="page-head">' +
        '<div><h1 class="page-title">' + pageTitle + '</h1>' +
        '<p class="page-sub">' + t('lap_sub') + '</p></div>' +
        (tab === 'popr' ? '<button type="button" class="btn btn-primary" onclick="SPB.laporanPartMesin.exportExcel()"><i data-lucide="file-down" class="icon-sm"></i>' + t('lap_export') + '</button>' : '') +
      '</div>' +
      body
    );
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.laporanPartMesin = {
    render: function (initialTab) { if (initialTab) tab = initialTab; load(); },
    applyFilter: applyFilter, exportExcel: exportExcel, setTab: setTab,
  };
})();
