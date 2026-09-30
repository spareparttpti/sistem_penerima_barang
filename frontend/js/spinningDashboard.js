/* =========================================================
   SPB · spinningDashboard.js
   Halaman landing role 'spinning' (#/spinning) — dashboard sendiri, TOTAL
   beda dari Dashboard Ringkasan gudang (overview.js). CUMA modul Part Mesin
   (ATK dicoret total dari scope Spinning — lihat percakapan terbaru), data
   dari tabel permintaan_part_mesin/mesin/part_mesin (spinningClient.js).

   Layout/gaya kartu-statistik & chart di bawah ini diadaptasi dari contoh
   dashboard yang dikasih user (referensi HTML/CSS terpisah) — HANYA pola
   UI & interaksinya yang dipakai (accent bar di atas stat card, area chart
   tren + donut proporsi, feed aktivitas), bukan konten/datanya. Warna tetap
   ikut identitas gold/navy Spinning yang sudah ada (token --brand- dan
   --slate- yang di-override di .spinning-shell), bukan oranye di referensi.
   ========================================================= */

(function () {
  'use strict';

  let loading = true;
  let loadError = '';
  let permintaanMesin = [];
  let partList = [];
  let stokList = [];
  let totalMesin = 0;
  let totalPart = 0;
  let chartFlow = null;
  let chartDonut = null;
  let chartTop = null;
  const SPINNING_STOK_CATEGORIES = ['Spinning', 'PLKUM', 'PLKEL'];

  function esc(s) { return window.esc(s); }
  function t(key) { return window.SPB.spinningI18n.t(key); }

  // Kartu statistik dengan accent bar di atas — reuse class .po-stat-* yang
  // sudah ada di style.css (dipakai halaman Purchase Order), bukan bikin
  // CSS baru, biar konsisten satu pola di seluruh app.
  function statCard(icon, accentVar, accentBgVar, label, value, sub) {
    return '<div class="po-stat-card" style="--po-accent:var(' + accentVar + ');--po-accent-bg:var(' + accentBgVar + ')">' +
      '<div class="po-stat-top"><span class="po-stat-label">' + esc(label) + '</span>' +
        '<div class="po-stat-icon"><i data-lucide="' + icon + '" class="icon-sm"></i></div></div>' +
      '<p class="po-stat-value">' + value + '</p>' +
      (sub ? '<p class="po-stat-sub">' + sub + '</p>' : '') +
    '</div>';
  }
  function fmtDateTime(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function load() {
    loading = true;
    loadError = '';
    render();
    try {
      const [permintaan, mesinRows, partRows, allStok] = await Promise.all([
        window.SPB.dbSpinning.listPermintaan(),
        window.SPB.dbSpinning.listMesin(),
        window.SPB.dbSpinning.listPart(),
        window.SPB.dbStokBarang.list(),
      ]);
      permintaanMesin = permintaan;
      partList = partRows;
      totalMesin = mesinRows.length;
      totalPart = partRows.length;
      stokList = allStok.filter(function (s) {
        const cat = (s.odoo_category || '').toLowerCase();
        return SPINNING_STOK_CATEGORIES.some(function (c) { return cat.indexOf(c.toLowerCase()) !== -1; });
      });
    } catch (err) {
      loadError = err.message || 'Gagal memuat dashboard.';
    }
    loading = false;
    render();
  }

  function feedRow(p) {
    const isSupplier = p.jenis === 'supplier';
    return '<div class="feed-item">' +
      '<div class="feed-ico' + (isSupplier ? ' out' : '') + '"><i data-lucide="' + (isSupplier ? 'truck' : 'wrench') + '" class="icon-sm"></i></div>' +
      '<div class="feed-body">' +
        '<strong>' + esc(p.nama_part || '-') + ' &times; ' + esc(p.jumlah) + '</strong>' +
        '<div class="feed-meta">' + esc((window.SPB.spinningI18n.getLang() === 'en' ? 'Machine ' : 'Mesin ') + (p.no_mesin || '-')) + ' &middot; ' + esc(p.status) + ' &middot; ' + fmtDateTime(p.created_at) + '</div>' +
      '</div>' +
    '</div>';
  }

  // Tren 6 bulan terakhir: jumlah permintaan jenis gudang vs supplier per bulan.
  function monthlySeries() {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: d.getFullYear() + '-' + d.getMonth(), label: d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' }), gudang: 0, supplier: 0 });
    }
    permintaanMesin.forEach(function (p) {
      const d = new Date(p.created_at);
      const key = d.getFullYear() + '-' + d.getMonth();
      const m = months.filter(function (x) { return x.key === key; })[0];
      if (!m) return;
      if (p.jenis === 'supplier') m.supplier++; else m.gudang++;
    });
    return months;
  }

  // Top 8 part paling banyak dipakai (jumlah kumulatif dari permintaan yang
  // sudah selesai/diambil) — dipasangkan sama harga master part kalau ada.
  function topUsedParts() {
    const byName = {};
    permintaanMesin.forEach(function (p) {
      if (p.status !== 'repair_end' && p.status !== 'diambil' && p.status !== 'masuk_inventory') return;
      const key = p.nama_part || '-';
      byName[key] = (byName[key] || 0) + Number(p.jumlah || 0);
    });
    return Object.keys(byName)
      .map(function (k) { return { nama: k, qty: byName[k] }; })
      .sort(function (a, b) { return b.qty - a.qty; })
      .slice(0, 8);
  }

  function drawCharts() {
    if (!window.Chart) return;
    const flowCanvas = document.getElementById('spin-chart-flow');
    const donutCanvas = document.getElementById('spin-chart-donut');
    const topCanvas = document.getElementById('spin-chart-top');
    if (chartFlow) { chartFlow.destroy(); chartFlow = null; }
    if (chartDonut) { chartDonut.destroy(); chartDonut = null; }
    if (chartTop) { chartTop.destroy(); chartTop = null; }
    if (topCanvas) {
      const top = topUsedParts();
      chartTop = new window.Chart(topCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: top.map(function (x) { return x.nama; }),
          datasets: [{ label: 'Qty Terpakai', data: top.map(function (x) { return x.qty; }), backgroundColor: 'rgba(193,154,46,0.55)', borderColor: '#c19a2e', borderWidth: 1.4, borderRadius: 5 }],
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });
    }
    if (!flowCanvas || !donutCanvas) return;

    const months = monthlySeries();
    chartFlow = new window.Chart(flowCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: months.map(function (m) { return m.label; }),
        datasets: [
          { label: t('pm_jenis_gudang') || 'Gudang', data: months.map(function (m) { return m.gudang; }), borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.14)', tension: 0.35, fill: true, borderWidth: 2.2, pointRadius: 3 },
          { label: t('pm_jenis_supplier') || 'Supplier', data: months.map(function (m) { return m.supplier; }), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.14)', tension: 0.35, fill: true, borderWidth: 2.2, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });

    const totalGudang = permintaanMesin.filter(function (p) { return p.jenis === 'gudang'; }).length;
    const totalSupplier = permintaanMesin.filter(function (p) { return p.jenis === 'supplier'; }).length;
    chartDonut = new window.Chart(donutCanvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: [t('pm_jenis_gudang') || 'Gudang', t('pm_jenis_supplier') || 'Supplier'],
        datasets: [{ data: [totalGudang, totalSupplier], backgroundColor: ['#0ea5e9', '#f59e0b'], borderColor: '#fff', borderWidth: 2 }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false } } },
    });
  }

  // Tiga kolom bawah dashboard, gaya sama seperti referensi ("Stok Kritis" /
  // "Antrean Penerimaan PO" / "Work Order Aktif") — datanya diambil dari
  // sumber SPB sendiri (stok_barang & permintaan_part_mesin), bukan mock data.
  function bottomThreeCols() {
    const stokKritis = stokList
      .filter(function (s) { return Number(s.qty_available || 0) <= 0; })
      .slice(0, 5);
    const antreanSupplier = permintaanMesin
      .filter(function (p) { return p.jenis === 'supplier' && ['disetujui', 'po_dibuat', 'barang_datang'].indexOf(p.status) !== -1; })
      .slice(0, 5);
    const woAktif = permintaanMesin
      .filter(function (p) { return p.jenis === 'gudang' && ['diambil', 'repair_start'].indexOf(p.status) !== -1; })
      .slice(0, 5);

    function miniCard(icon, title, linkHash, linkLabel, theadRow, rowsHtml, emptyText) {
      return '<div class="table-card">' +
        '<div class="table-head"><h2 class="table-title"><i data-lucide="' + icon + '" class="icon-md"></i>' + title + '</h2>' +
          '<a href="' + linkHash + '" class="btn btn-outline btn-sm">' + linkLabel + '</a></div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr>' + theadRow + '</tr></thead>' +
          '<tbody>' + (rowsHtml || '<tr><td colspan="2" class="empty-state">' + emptyText + '</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>';
    }

    return '<div class="grid-stats" style="grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));margin-top:0">' +
      miniCard('triangle-alert', 'Stok Kritis', '#/master-data/inventory', 'Lihat semua',
        '<th>Part</th><th>Stok</th>',
        stokKritis.map(function (s) {
          return '<tr><td><div style="font-weight:600">' + esc(s.sku) + '</div><div style="font-size:0.75rem;color:var(--slate-400)">' + esc(s.product_name) + '</div></td>' +
            '<td><span class="badge badge-rejected">' + s.qty_available + ' ' + esc(s.uom || '') + '</span></td></tr>';
        }).join(''), 'Semua stok aman') +
      miniCard('truck', 'Antrean Penerimaan PO', '#/transaksi/po', 'Buka',
        '<th>Part / Mesin</th><th>Status</th>',
        antreanSupplier.map(function (p) {
          return '<tr><td><div style="font-weight:600">' + esc(p.nama_part) + '</div><div style="font-size:0.75rem;color:var(--slate-400)">Mesin ' + esc(p.no_mesin || '-') + '</div></td>' +
            '<td><span class="badge badge-inspection">' + esc(p.status) + '</span></td></tr>';
        }).join(''), 'Tidak ada antrean') +
      miniCard('wrench', 'Work Order Aktif', '#/transaksi/wo', 'Buka',
        '<th>Part / Mesin</th><th>Status</th>',
        woAktif.map(function (p) {
          return '<tr><td><div style="font-weight:600">' + esc(p.nama_part) + '</div><div style="font-size:0.75rem;color:var(--slate-400)">Mesin ' + esc(p.no_mesin || '-') + '</div></td>' +
            '<td><span class="badge badge-approved">' + esc(p.status) + '</span></td></tr>';
        }).join(''), 'Tidak ada WO aktif') +
    '</div>';
  }

  function render() {
    const app = document.getElementById('app');
    const ui = window.SPB.ui;

    let body;
    if (loading) {
      body = '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>';
    } else if (loadError) {
      body = '<div class="empty-state" style="color:var(--red-600)">' + esc(loadError) + '</div>';
    } else {
      const mesinPending = permintaanMesin.filter(function (p) { return p.status === 'menunggu'; }).length;
      const sedangRepair = permintaanMesin.filter(function (p) { return p.status === 'diambil' || p.status === 'repair_start'; }).length;
      const menungguSupplier = permintaanMesin.filter(function (p) { return p.jenis === 'supplier' && (p.status === 'disetujui' || p.status === 'po_dibuat'); }).length;
      const now = new Date();
      const selesaiBulanIni = permintaanMesin.filter(function (p) {
        if (p.status !== 'repair_end' && p.status !== 'masuk_inventory') return false;
        const d = new Date(p.updated_at || p.created_at);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }).length;
      const bulanIniTotal = permintaanMesin.filter(function (p) {
        const d = new Date(p.created_at);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }).length;

      body =
        '<div class="spin-banner">' +
          '<i data-lucide="radio" class="icon-md"></i>' +
          '<span>Periode ' + now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }) + ' — ' +
            '<b>' + bulanIniTotal + '</b> permintaan diajukan &middot; ' +
            '<span class="spin-banner-ok">' + selesaiBulanIni + ' selesai</span> &middot; ' +
            '<span class="spin-banner-bad">' + mesinPending + ' menunggu approval</span></span>' +
        '</div>' +
        '<div class="grid-stats">' +
          statCard('cog', '--amber-500', '--amber-50', t('dash_stat_pending'), mesinPending, mesinPending + ' ' + t('dash_of_total') + ' ' + permintaanMesin.length + ' ' + t('dash_total')) +
          statCard('wrench', '--red-500', '--red-50', t('dash_stat_repair'), sedangRepair, '') +
          statCard('truck', '--sky-500', '--sky-50', t('dash_stat_supplier'), menungguSupplier, '') +
          statCard('check-circle-2', '--emerald-500', '--emerald-50', t('dash_stat_done_month'), selesaiBulanIni, '') +
        '</div>' +
        '<div class="grid-stats">' +
          statCard('layout-grid', '--indigo-500', '--indigo-50', t('dash_stat_mesin'), totalMesin, '') +
          statCard('boxes', '--indigo-500', '--indigo-50', t('dash_stat_part'), totalPart, '') +
        '</div>' +
        '<div class="chart-grid">' +
          '<div class="table-card">' +
            '<div class="table-head"><h2 class="table-title"><i data-lucide="trending-up" class="icon-md"></i>Tren Permintaan 6 Bulan</h2></div>' +
            '<div class="chart-box"><canvas id="spin-chart-flow"></canvas></div>' +
            '<div class="chart-legend-inline"><span><i style="background:#0ea5e9"></i>' + (t('pm_jenis_gudang') || 'Gudang') + '</span><span><i style="background:#f59e0b"></i>' + (t('pm_jenis_supplier') || 'Supplier') + '</span></div>' +
          '</div>' +
          '<div class="table-card">' +
            '<div class="table-head"><h2 class="table-title"><i data-lucide="pie-chart" class="icon-md"></i>Proporsi Jenis</h2></div>' +
            '<div class="chart-box sm"><canvas id="spin-chart-donut"></canvas></div>' +
            '<div class="chart-legend-inline"><span><i style="background:#0ea5e9"></i>' + (t('pm_jenis_gudang') || 'Gudang') + '</span><span><i style="background:#f59e0b"></i>' + (t('pm_jenis_supplier') || 'Supplier') + '</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="chart-grid" style="margin-top:1.25rem">' +
          '<div class="table-card">' +
            '<div class="table-head"><h2 class="table-title"><i data-lucide="flame" class="icon-md"></i>Part Paling Banyak Terpakai</h2><span class="badge-count" style="position:static">Top 8</span></div>' +
            '<div class="chart-box"><canvas id="spin-chart-top"></canvas></div>' +
          '</div>' +
          '<div class="table-card">' +
            '<div class="table-head"><h2 class="table-title"><i data-lucide="activity" class="icon-md"></i>' + t('dash_activity') + '</h2></div>' +
            '<div class="feed-list">' +
              (permintaanMesin.length
                ? permintaanMesin.slice(0, 8).map(feedRow).join('')
                : '<div class="empty-state">' + t('dash_empty') + '</div>') +
            '</div>' +
          '</div>' +
        '</div>' +
        bottomThreeCols();
    }

    app.innerHTML = ui.layout('spinning',
      '<div class="page-head">' +
        '<div><h1 class="page-title">' + t('dash_title') + '</h1>' +
        '<p class="page-sub">' + t('dash_sub') + '</p></div>' +
      '</div>' +
      body
    );
    ui.afterRender();
    if (!loading && !loadError) drawCharts();
  }

  window.SPB = window.SPB || {};
  window.SPB.spinningDashboard = { render: load };
})();
