/* =========================================================
   SPB · laporanDivisi.js
   Laporan khusus akun ADMIN DIVISI (#/laporan, tapi cabang beda dari
   laporan.js) — laporan.js isinya dashboard WH/IN (vendor) + WH/OUT
   (distribusi) yang GLOBAL/gudang-sentris, nggak relevan buat admin divisi
   yang cuma peduli "siapa dari divisiku yang sudah minta barang ke gudang,
   berapa banyak, kapan". Jadi bukan dashboard grafik — cukup TABEL MENTAH
   gaya spreadsheet/Excel, satu baris per barang yang diminta, biar gampang
   di-scan atau langsung diekspor buat rekap manual/atasan.
   ========================================================= */

(function () {
  'use strict';

  let allPesanan = [];
  let loading = true;
  let loadError = '';
  const filters = { q: '', dari: '', sampai: '' };

  function esc(s) { return window.esc(s); }

  function myDivisiLower() {
    const auth = window.SPB.auth;
    return ((auth && auth.currentDivisi && auth.currentDivisi()) || '').trim().toLowerCase();
  }

  async function load() {
    loading = true;
    loadError = '';
    render();
    try {
      const rows = await window.SPB.dbPesanan.listAll();
      const mine = myDivisiLower();
      allPesanan = rows.filter(function (p) { return (p.divisi || '').trim().toLowerCase() === mine; });
    } catch (err) {
      allPesanan = [];
      loadError = err.message || 'Gagal memuat laporan.';
    }
    loading = false;
    render();
  }

  const STATUS_LABEL = { waiting: 'Menunggu', processing: 'Diproses', ready: 'Siap Ambil', done: 'Selesai', cancelled: 'Dibatalkan' };

  // Satu baris per pesanan.items[] entry — bukan per pesanan — biar tiap
  // barang kelihatan qty & satuannya sendiri-sendiri, gampang di-total di Excel.
  function flattenRows(rows) {
    const out = [];
    rows.forEach(function (p) {
      const items = (p.items && p.items.length) ? p.items : [{ nama_barang: '(tanpa rincian barang)', qty: '', satuan: '' }];
      items.forEach(function (it) {
        out.push({
          tanggal: p.created_at,
          no_antrian: p.divisi_seq != null ? p.divisi_seq : p.queue_no,
          karyawan: p.karyawan_name || '-',
          sub_divisi: p.sub_divisi || '-',
          keperluan: p.keperluan || '-',
          nama_barang: it.nama_barang || '-',
          sku: it.sku || '-',
          qty: it.qty != null ? it.qty : '-',
          satuan: it.satuan || '',
          status: STATUS_LABEL[p.status] || p.status,
          urgent: !!p.is_urgent,
        });
      });
    });
    return out;
  }

  function applyFilters(rows) {
    let out = rows;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      out = out.filter(function (r) {
        return (r.karyawan || '').toLowerCase().indexOf(q) !== -1 ||
          (r.nama_barang || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    if (filters.dari) {
      const from = new Date(filters.dari + 'T00:00:00');
      out = out.filter(function (p) { return new Date(p.created_at) >= from; });
    }
    if (filters.sampai) {
      const to = new Date(filters.sampai + 'T23:59:59');
      out = out.filter(function (p) { return new Date(p.created_at) <= to; });
    }
    return out;
  }

  function fmtDateTime(v) {
    if (!v) return '-';
    const d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function applyFilter(key, value) { filters[key] = value; renderLocal(); }
  function renderLocal() { render(); }

  function exportExcel(flatRows) {
    if (!window.XLSX) {
      window.SPB.ui.toast('Gagal export', 'Library Excel belum termuat, coba refresh halaman.', 'error');
      return;
    }
    if (!flatRows.length) {
      window.SPB.ui.toast('Tidak ada data', 'Tidak ada data sesuai filter untuk diekspor.', 'error');
      return;
    }
    const data = flatRows.map(function (r, i) {
      return {
        No: i + 1,
        Tanggal: fmtDateTime(r.tanggal),
        'No. Antrian': r.no_antrian,
        Karyawan: r.karyawan,
        'Sub Divisi': r.sub_divisi,
        Keperluan: r.keperluan,
        'Nama Barang': r.nama_barang,
        SKU: r.sku,
        Qty: r.qty,
        Satuan: r.satuan,
        Status: r.status,
        Urgent: r.urgent ? 'Ya' : '',
      };
    });
    const ws = window.XLSX.utils.json_to_sheet(data);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Laporan Divisi');
    const auth = window.SPB.auth;
    const divisiName = (auth && auth.currentDivisi && auth.currentDivisi()) || 'Divisi';
    const fname = 'Laporan-' + divisiName.replace(/\s+/g, '') + '-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    window.XLSX.writeFile(wb, fname);
    window.SPB.ui.toast('Excel terunduh', fname, 'success');
  }

  function render() {
    const app = document.getElementById('app');
    const ui = window.SPB.ui;
    const auth = window.SPB.auth;
    const divisiName = (auth && auth.currentDivisi && auth.currentDivisi()) || '-';

    let body;
    if (loading) {
      body = '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat laporan...</div>';
    } else if (loadError) {
      body = '<div class="empty-state" style="color:var(--red-600)">' + esc(loadError) + '</div>';
    } else {
      const flat = applyFilters(flattenRows(allPesanan))
        .sort(function (a, b) { return new Date(b.tanggal) - new Date(a.tanggal); });

      const rowsHtml = flat.map(function (r, i) {
        return '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td style="white-space:nowrap">' + fmtDateTime(r.tanggal) + '</td>' +
          '<td>' + esc(String(r.no_antrian != null ? r.no_antrian : '-')) + (r.urgent ? ' <span class="badge badge-rejected">Urgent</span>' : '') + '</td>' +
          '<td>' + esc(r.karyawan) + '</td>' +
          '<td>' + esc(r.sub_divisi) + '</td>' +
          '<td>' + esc(r.nama_barang) + '</td>' +
          '<td>' + esc(String(r.qty)) + ' ' + esc(r.satuan) + '</td>' +
          '<td>' + esc(r.keperluan) + '</td>' +
          '<td>' + esc(r.status) + '</td>' +
        '</tr>';
      }).join('');

      body =
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>No</th><th>Tanggal</th><th>No. Antrian</th><th>Karyawan</th><th>Sub Divisi</th>' +
            '<th>Nama Barang</th><th>Qty</th><th>Keperluan</th><th>Status</th></tr></thead>' +
          '<tbody>' + (rowsHtml || '<tr><td colspan="9" class="empty-state">Tidak ada data.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
        '<p class="pagination-info" style="padding:0.75rem 1rem">' + flat.length + ' baris barang · ' + allPesanan.length + ' pesanan total</p>';

      window.SPB.__laporanDivisiExportCache = flat; // dibaca exportExcel() lewat tombol, hindari re-filter ganda
    }

    app.innerHTML = ui.layout('laporan',
      '<div class="page-head">' +
        '<div><h1 class="page-title">Laporan Permintaan — Divisi ' + esc(divisiName) + '</h1>' +
        '<p class="page-sub">Rekap siapa saja yang sudah meminta barang ke gudang dari divisimu — format tabel, siap diekspor ke Excel.</p></div>' +
        '<button type="button" class="btn btn-primary" onclick="SPB.laporanDivisi.exportExcel()">' +
          '<i data-lucide="file-down" class="icon-sm"></i>Export Excel</button>' +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="clipboard-list" class="icon-md"></i>Rincian Permintaan</h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari nama karyawan / barang..." value="' + esc(filters.q) + '" oninput="SPB.laporanDivisi.applyFilter(\'q\', this.value)"></div>' +
            '<input type="date" class="select-input" value="' + esc(filters.dari) + '" onchange="SPB.laporanDivisi.applyFilter(\'dari\', this.value)" title="Dari tanggal">' +
            '<input type="date" class="select-input" value="' + esc(filters.sampai) + '" onchange="SPB.laporanDivisi.applyFilter(\'sampai\', this.value)" title="Sampai tanggal">' +
          '</div>' +
        '</div>' +
        body +
      '</div>'
    );
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.laporanDivisi = {
    render: load,
    applyFilter: applyFilter,
    exportExcel: function () { exportExcel(window.SPB.__laporanDivisiExportCache || []); },
  };
})();
