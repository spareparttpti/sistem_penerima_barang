/* =========================================================
   SPB · overview.js
   Dashboard Ringkasan — halaman landing terpisah di atas WH/IN & WH/OUT,
   meringkas kedua alur jadi satu pandangan: stat gabungan, tren masuk vs
   keluar 7 hari terakhir, log aktivitas gabungan, dan cuplikan Stok ATK.
   Read-only murni — semua data diambil dari db (WH/IN), dbWhOut (WH/OUT),
   dbStokBarang yang sudah ada, tidak ada query/tabel baru.
   ========================================================= */

(function () {
  'use strict';

  function statCard(icon, iconClass, label, value, sub) {
    return '<div class="stat-card">' +
      '<div><p class="stat-label">' + label + '</p>' +
      '<p class="stat-value">' + value + '</p>' +
      (sub ? '<p class="stat-sub">' + sub + '</p>' : '') + '</div>' +
      '<div class="stat-icon ' + iconClass + '"><i data-lucide="' + icon + '" class="icon-md"></i></div>' +
    '</div>';
  }
  function chartCard(icon, title, bodyHtml) {
    return '<div class="chart-card">' +
      '<p class="chart-title"><i data-lucide="' + icon + '" class="icon-md"></i>' + title + '</p>' +
      bodyHtml +
    '</div>';
  }
  function fmtDateTime(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function dayKey(v) {
    if (!v) return '';
    return String(v).length <= 10 ? String(v) : new Date(v).toISOString().slice(0, 10);
  }
  function dayLabel(key) {
    const d = new Date(key + 'T00:00:00');
    return d.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  /* Tren 7 hari terakhir: WH/IN dihitung dari arrival_date (barang benar-benar
     datang), WH/OUT dari arrival_date juga (tanggal diproses/approve) — biar
     apple-to-apple, dua-duanya "barang bergerak", bukan cuma "masuk sistem". */
  function trendChartHtml(inRows, outRows) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const inByDay = {};
    inRows.forEach(function (r) {
      if (r.status === 'Draft') return;
      const k = dayKey(r.arrival_date || r.created_at);
      if (k) inByDay[k] = (inByDay[k] || 0) + 1;
    });
    const outByDay = {};
    outRows.forEach(function (r) {
      if (r.status === 'Draft') return;
      const k = dayKey(r.arrival_date || r.created_at);
      if (k) outByDay[k] = (outByDay[k] || 0) + 1;
    });

    const maxTotal = Math.max(1, ...days.map(function (k) { return (inByDay[k] || 0) + (outByDay[k] || 0); }));
    const grandTotal = days.reduce(function (a, k) { return a + (inByDay[k] || 0) + (outByDay[k] || 0); }, 0);

    if (!grandTotal) {
      return chartCard('trending-up', 'Tren 7 Hari Terakhir (Masuk vs Keluar)',
        '<div class="empty-state" style="padding:2rem 0">Belum ada aktivitas 7 hari terakhir.</div>');
    }

    const rows = days.map(function (k) {
      const inV = inByDay[k] || 0;
      const outV = outByDay[k] || 0;
      const inPct = Math.round((inV / maxTotal) * 100);
      const outPct = Math.round((outV / maxTotal) * 100);
      return '<div class="hbar-row">' +
        '<div class="hbar-label">' + dayLabel(k) + '</div>' +
        '<div class="hbar-track" title="Masuk: ' + inV + ' · Keluar: ' + outV + '" style="display:flex;gap:2px">' +
          '<div class="hbar-fill" style="width:' + inPct + '%;background:var(--emerald-500)"></div>' +
          '<div class="hbar-fill" style="width:' + outPct + '%;background:var(--amber-500)"></div>' +
        '</div>' +
        '<div class="hbar-value">' + inV + '/' + outV + '</div>' +
      '</div>';
    }).join('');

    return chartCard('trending-up', 'Tren 7 Hari Terakhir (Masuk vs Keluar)',
      '<div class="hbar-chart">' + rows + '</div>' +
      '<p class="chart-foot">' +
        '<span style="color:var(--emerald-600)">● Masuk (WH/IN)</span> &nbsp; ' +
        '<span style="color:var(--amber-600)">● Keluar (WH/OUT)</span>' +
      '</p>');
  }

  function activityLogHtml(inRows, outRows) {
    const inItems = inRows.slice(0, 15).map(function (r) {
      return {
        type: 'in', ref: r.po_number, party: r.vendor_name, status: r.status,
        time: r.arrival_date || r.created_at, href: '#/penerimaan/' + r.id,
      };
    });
    const outItems = outRows.slice(0, 15).map(function (r) {
      return {
        type: 'out', ref: r.wh_out_ref, party: r.employee_name, status: r.status,
        time: r.arrival_date || r.created_at, href: '#/wh-out/' + r.id,
      };
    });
    const combined = inItems.concat(outItems)
      .filter(function (it) { return !!it.time; })
      .sort(function (a, b) { return new Date(b.time) - new Date(a.time); })
      .slice(0, 10);

    if (!combined.length) {
      return '<div class="empty-state" style="padding:2rem 0">Belum ada aktivitas.</div>';
    }

    const rows = combined.map(function (it) {
      const badge = it.type === 'in'
        ? '<span class="tag tag-emerald">WH/IN</span>'
        : '<span class="tag tag-amber">WH/OUT</span>';
      return '<a href="' + it.href + '" class="activity-row">' +
        badge +
        '<div class="activity-main">' +
          '<p class="activity-ref">' + esc(it.ref || '-') + '</p>' +
          '<p class="activity-party">' + esc(it.party || '-') + '</p>' +
        '</div>' +
        '<div class="activity-side">' +
          window.SPB.ui.statusBadge(it.status) +
          '<p class="activity-time">' + fmtDateTime(it.time) + '</p>' +
        '</div>' +
      '</a>';
    }).join('');

    return '<div class="activity-list">' + rows + '</div>';
  }

  /* Kartu "Perlu Perhatian" — beda dari stat card lain yang cuma angka netral,
     ini khusus nampung hal yang butuh TINDAKAN: barang di-Reject (perlu tindak
     lanjut ke vendor/karyawan) dan SKU ATK yang stoknya habis (perlu restock).
     Kalau semuanya nol/aman, tampilkan state "aman" biar jelas bukan kosong
     karena belum kehitung. */
  function perhatianHtml(inRows, outRows, stok) {
    const inRejected = inRows.filter(function (r) { return r.status === 'Rejected'; });
    const outRejected = outRows.filter(function (r) { return r.status === 'Rejected'; });
    const menungguStok = outRows.filter(function (r) { return r.status === 'Menunggu Stok'; });
    const stokHabis = stok.filter(function (r) { return Number(r.qty_available || 0) <= 0; });
    const totalIssue = inRejected.length + outRejected.length + menungguStok.length + stokHabis.length;

    if (!totalIssue) {
      return chartCard('shield-check', 'Perlu Perhatian',
        '<div class="empty-state" style="padding:1.5rem 0;color:var(--emerald-600)">' +
          '<i data-lucide="check-circle-2" class="icon-lg"></i><p style="margin-top:0.5rem">Semua aman — tidak ada barang Rejected atau stok habis.</p>' +
        '</div>');
    }

    const rows = [];
    if (menungguStok.length) {
      rows.push('<a href="#/wh-out" class="activity-row">' +
        '<span class="tag" style="background:var(--sky-50);color:var(--sky-600)">WH/OUT</span>' +
        '<div class="activity-main"><p class="activity-ref">' + menungguStok.length + ' WH/OUT Menunggu Restock</p>' +
        '<p class="activity-party">stoknya habis, sudah diajukan pemesanan (PO)</p></div></a>');
    }
    if (inRejected.length) {
      rows.push('<a href="#/" class="activity-row">' +
        '<span class="tag tag-emerald" style="background:var(--red-50);color:var(--red-600)">WH/IN</span>' +
        '<div class="activity-main"><p class="activity-ref">' + inRejected.length + ' barang Rejected</p>' +
        '<p class="activity-party">perlu tindak lanjut ke vendor</p></div></a>');
    }
    if (outRejected.length) {
      rows.push('<a href="#/wh-out" class="activity-row">' +
        '<span class="tag tag-amber" style="background:var(--red-50);color:var(--red-600)">WH/OUT</span>' +
        '<div class="activity-main"><p class="activity-ref">' + outRejected.length + ' barang Rejected</p>' +
        '<p class="activity-party">perlu tindak lanjut ke karyawan</p></div></a>');
    }
    if (stokHabis.length) {
      rows.push('<a href="#/stok-barang" class="activity-row">' +
        '<span class="tag" style="background:var(--red-50);color:var(--red-600)">STOK</span>' +
        '<div class="activity-main"><p class="activity-ref">' + stokHabis.length + ' SKU ATK habis</p>' +
        '<p class="activity-party">' + stokHabis.slice(0, 3).map(function (r) { return esc(r.sku); }).join(', ') +
          (stokHabis.length > 3 ? ', ...' : '') + ' — perlu restock</p></div></a>');
    }

    return chartCard('alert-triangle', 'Perlu Perhatian', '<div class="activity-list">' + rows.join('') + '</div>');
  }

  function stokRingkasHtml(stok) {
    const totalSku = stok.length;
    const habis = stok.filter(function (r) { return Number(r.qty_available || 0) <= 0; }).length;
    const totalQty = stok.reduce(function (a, r) { return a + Number(r.qty_on_hand || 0); }, 0);
    return chartCard('boxes', 'Ringkasan Stok ATK',
      // auto-fit (BUKAN repeat(3,1fr) tetap) — kartu ini kadang cuma setengah
      // lebar layar (sebelah "Perlu Perhatian" di grid-charts 2 kolom), jadi
      // 3 kolom kaku bikin kepotong/numpuk kalau ruangnya sempit. Dengan
      // auto-fit, otomatis turun jadi 2 atau 1 kolom sendiri sesuai ruang
      // yang beneran tersedia.
      '<div class="grid-stats" style="grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));margin:0">' +
        statCard('package', 'indigo', 'Jenis Barang', totalSku, '') +
        statCard('boxes', 'sky', 'Total Qty', totalQty, 'gabungan semua satuan') +
        statCard('alert-triangle', 'red', 'Stok Habis', habis, '') +
      '</div>' +
      '<p class="chart-foot"><a href="#/stok-barang">Lihat detail Stok Barang →</a></p>');
  }

  function render() {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>';

    Promise.all([
      window.SPB.db.list(),
      window.SPB.dbWhOut.list(),
      window.SPB.dbStokBarang.list().catch(function () { return []; }),
    ]).then(function (res) {
      const inRows = res[0] || [];
      const outRows = res[1] || [];
      const stok = res[2] || [];

      const inPending = inRows.filter(function (r) { return r.status === 'Draft'; }).length;
      const outPending = outRows.filter(function (r) { return r.status === 'Draft'; }).length;
      const inDone = inRows.filter(function (r) { return r.status !== 'Draft'; }).length;
      const outDone = outRows.filter(function (r) { return r.status !== 'Draft'; }).length;

      app.innerHTML = window.SPB.ui.layout('overview',
        '<div class="page-head">' +
          '<div><h1 class="page-title">Dashboard Ringkasan</h1>' +
          '<p class="page-sub">Gabungan WH/IN & WH/OUT — sekilas pandang tanpa perlu buka dua halaman terpisah.</p></div>' +
        '</div>' +
        '<div class="grid-stats">' +
          statCard('truck', 'amber', 'WH/IN Menunggu', inPending, 'perlu diproses') +
          statCard('package-check', 'emerald', 'WH/IN Selesai', inDone, 'sudah diproses') +
          statCard('boxes', 'sky', 'WH/OUT Menunggu', outPending, 'perlu diproses') +
          statCard('badge-check', 'indigo', 'WH/OUT Selesai', outDone, 'sudah diproses') +
        '</div>' +
        '<div class="grid-charts">' +
          perhatianHtml(inRows, outRows, stok) +
          stokRingkasHtml(stok) +
        '</div>' +
        '<div style="margin-top:1.25rem">' + trendChartHtml(inRows, outRows) + '</div>' +
        '<div class="chart-card" style="margin-top:1.25rem">' +
          '<p class="chart-title"><i data-lucide="history" class="icon-md"></i>Aktivitas Terbaru (WH/IN + WH/OUT)</p>' +
          activityLogHtml(inRows, outRows) +
        '</div>'
      );
      window.SPB.ui.afterRender();
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal memuat', err.message, 'error');
    });
  }

  window.SPB = window.SPB || {};
  window.SPB.overview = { render: render };
})();
