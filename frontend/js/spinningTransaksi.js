/* =========================================================
   SPB · spinningTransaksi.js
   Grup "TRANSAKSI" role Spinning — jalur GUDANG saja: #/transaksi/pr-gudang
   dan #/transaksi/wo. Jalur SUPPLIER (Purchase Request/Purchase Order/
   Penerimaan Barang, multi-item + harga) sekarang di spinningPurchase.js
   dengan tabel sendiri (spinning_pr/spinning_po/spinning_receipt) — lihat
   database/part_mesin_schema.sql.

   - pr-gudang (Purchase Request ke Gudang): permintaan_part_mesin
     jenis='gudang', cuma tahap pengajuan/ACC (menunggu/disetujui/ditolak)
     — eksekusi fisiknya di tab wo.
   - wo (Data Work Order): permintaan jenis='gudang' yang SUDAH disetujui,
     nunjukkin progres eksekusi mekanik: diambil -> repair_start -> repair_end
     (completion, part sudah terpasang & mesin jalan lagi).
   ========================================================= */

(function () {
  'use strict';

  let tab = 'pr-gudang'; // 'pr-gudang' | 'wo'
  let statusFilter = 'semua';
  let trxSearch = '';
  let showForm = false;
  let loading = true;
  let loadError = '';
  let permintaan = [];
  let mesinList = [];
  let partList = [];
  let karyawanList = [];
  let submitting = false;

  function t(key) { return window.SPB.spinningI18n.t(key); }
  function esc(s) { return window.esc(s); }
  function isViewOnly() { return !!(window.SPB.auth && window.SPB.auth.isViewOnly && window.SPB.auth.isViewOnly()); }
  function fmtDateTime(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function partLabel(p) {
    const parent = p.parent_id ? partList.find(function (x) { return x.id === p.parent_id; }) : null;
    return (parent ? parent.nama_part + ' > ' : '') + p.nama_part;
  }

  function statusLabel(status) {
    const map = {
      menunggu: 'pm_status_menunggu', disetujui: 'pm_status_disetujui', ditolak: 'pm_status_ditolak',
      diambil: 'pm_status_diambil', repair_start: 'pm_status_repair_start', repair_end: 'pm_status_repair_end',
    };
    return map[status] ? t(map[status]) : status;
  }
  const STATUS_BADGE = {
    menunggu: 'badge-draft', disetujui: 'badge-inspection', ditolak: 'badge-rejected',
    diambil: 'badge-inspection', repair_start: 'badge-inspection', repair_end: 'badge-approved',
  };
  function statusNextLabel(status) {
    const map = {
      disetujui: 'pm_next_disetujui', diambil: 'pm_next_diambil', repair_start: 'pm_next_repair_start',
      repair_end: 'pm_next_repair_end',
    };
    return map[status] ? t(map[status]) : status;
  }
  const FLOW_WO = { disetujui: 'diambil', diambil: 'repair_start', repair_start: 'repair_end' };

  async function load() {
    loading = true;
    loadError = '';
    render();
    try {
      const [pRows, mRows, ptRows, allKaryawan] = await Promise.all([
        window.SPB.dbSpinning.listPermintaan(),
        window.SPB.dbSpinning.listMesin(),
        window.SPB.dbSpinning.listPart(),
        window.SPB.dbKaryawan.list(), // sinkron Odoo, difilter divisi Spinning
      ]);
      permintaan = pRows.filter(function (p) { return p.jenis === 'gudang'; });
      mesinList = mRows; partList = ptRows;
      karyawanList = allKaryawan.filter(function (k) { return ((k.department || '').split(' / ')[0] || '').trim().toLowerCase() === 'spinning'; });
    } catch (err) {
      loadError = err.message || 'Gagal memuat data.';
    }
    loading = false;
    render();
  }
  function renderLocal() { render(); }
  function setTab(tb) { tab = tb; statusFilter = 'semua'; trxSearch = ''; showForm = false; location.hash = '#/transaksi/' + tb; renderLocal(); }
  function setStatusFilter(f) { statusFilter = f; renderLocal(); }
  function setTrxSearch(v) { trxSearch = v; renderLocal(); }
  function matchSearch(p) {
    if (!trxSearch) return true;
    const q = trxSearch.toLowerCase();
    return (p.nama_part || '').toLowerCase().indexOf(q) !== -1 ||
      (p.no_mesin || '').toLowerCase().indexOf(q) !== -1 ||
      (p.nama_mekanik || '').toLowerCase().indexOf(q) !== -1;
  }
  function toggleForm() { showForm = !showForm; renderLocal(); }

  // Stat card accent-bar (reuse .po-stat-* yang sudah ada di style.css).
  function statCard(icon, accentVar, accentBgVar, label, value, sub) {
    return '<div class="po-stat-card" style="--po-accent:var(' + accentVar + ');--po-accent-bg:var(' + accentBgVar + ')">' +
      '<div class="po-stat-top"><span class="po-stat-label">' + esc(label) + '</span>' +
        '<div class="po-stat-icon"><i data-lucide="' + icon + '" class="icon-sm"></i></div></div>' +
      '<p class="po-stat-value">' + value + '</p>' +
      (sub ? '<p class="po-stat-sub">' + esc(sub) + '</p>' : '') +
    '</div>';
  }
  function statusFilterOptions(groups) {
    return '<select class="select-input" onchange="SPB.spinningTransaksi.setStatusFilter(this.value)">' +
      groups.map(function (g) { return '<option value="' + g.key + '"' + (statusFilter === g.key ? ' selected' : '') + '>' + g.label + '</option>'; }).join('') +
    '</select>';
  }

  /* ---------- Form buat baru PR ke Gudang ---------- */
  function formHtml() {
    return '<div class="table-card" style="margin-bottom:1.25rem">' +
      '<div class="table-head"><h2 class="table-title"><i data-lucide="clipboard-plus" class="icon-md"></i>' + t('pm_form_title') + '</h2></div>' +
      '<form onsubmit="event.preventDefault();SPB.spinningTransaksi.submitForm()" style="padding:1rem 1.25rem;display:grid;gap:0.9rem;max-width:560px">' +
        '<div>' +
          '<label class="field-label">' + t('pm_form_mesin') + '</label>' +
          '<input id="trx-no-mesin" class="input" list="trx-mesin-list" placeholder="e.g. RF-01" autocomplete="off">' +
          '<datalist id="trx-mesin-list">' + mesinList.map(function (m) { return '<option value="' + esc(m.no_mesin) + '">' + esc(m.nama_mesin || '') + '</option>'; }).join('') + '</datalist>' +
        '</div>' +
        '<div>' +
          '<label class="field-label">' + t('pm_form_mekanik') + '</label>' +
          '<select id="trx-karyawan" class="select">' +
            '<option value="">— ' + t('pm_form_pilih_part') + ' —</option>' +
            karyawanList.map(function (k) { return '<option value="' + k.id + '">' + esc(k.name) + '</option>'; }).join('') +
          '</select>' +
        '</div>' +
        '<div>' +
          '<label class="field-label">' + t('pm_form_part') + '</label>' +
          '<select id="trx-part" class="select" required>' +
            '<option value="" selected disabled>' + t('pm_form_pilih_part') + '</option>' +
            partList.map(function (p) { return '<option value="' + p.id + '">' + esc(partLabel(p)) + '</option>'; }).join('') +
          '</select>' +
        '</div>' +
        '<div>' +
          '<label class="field-label">' + t('pm_form_jumlah') + '</label>' +
          '<input id="trx-jumlah" type="number" min="1" step="1" class="input" value="1" required>' +
        '</div>' +
        '<div>' +
          '<label class="field-label">' + t('pm_form_catatan') + '</label>' +
          '<input id="trx-catatan" class="input">' +
        '</div>' +
        '<div style="display:flex;gap:0.5rem">' +
          '<button type="submit" class="btn btn-primary" ' + (submitting ? 'disabled' : '') + '>' +
            (submitting ? '<i data-lucide="loader-2" class="icon-sm spin"></i>' + t('pm_form_sending') : '<i data-lucide="send" class="icon-sm"></i>' + t('pm_form_submit')) +
          '</button>' +
          '<button type="button" class="btn btn-outline" onclick="SPB.spinningTransaksi.toggleForm()">Cancel</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  async function submitForm() {
    const noMesin = document.getElementById('trx-no-mesin').value.trim();
    const karyawanId = document.getElementById('trx-karyawan').value || null;
    const partId = document.getElementById('trx-part').value;
    const jumlah = Number(document.getElementById('trx-jumlah').value || 1);
    const catatan = document.getElementById('trx-catatan').value.trim();
    if (!partId) { window.SPB.ui.toast('Data belum lengkap', 'Pilih part dulu.', 'error'); return; }
    const part = partList.find(function (p) { return p.id === partId; });
    const karyawan = karyawanList.find(function (k) { return k.id === karyawanId; });

    submitting = true;
    renderLocal();
    try {
      await window.SPB.dbSpinning.createPermintaan({
        jenis: 'gudang', no_mesin: noMesin, nama_mekanik: karyawan ? karyawan.name : '-',
        part_id: partId, nama_part: part ? part.nama_part : '-',
        jumlah: jumlah, catatan: catatan,
      });
      window.SPB.ui.toast('OK', 'PR submitted.', 'success');
      submitting = false;
      showForm = false;
      await load();
    } catch (err) {
      submitting = false;
      window.SPB.ui.toast('Gagal', err.message, 'error');
      renderLocal();
    }
  }

  /* ---------- Aksi status ---------- */
  async function advance(id, nextStatus) {
    try {
      await window.SPB.dbSpinning.updateStatus(id, nextStatus);
      await load();
    } catch (err) {
      window.SPB.ui.toast('Gagal update status', err.message, 'error');
    }
  }
  async function reject(id) {
    try {
      await window.SPB.dbSpinning.updateStatus(id, 'ditolak');
      await load();
    } catch (err) {
      window.SPB.ui.toast('Gagal update status', err.message, 'error');
    }
  }

  /* ---------- Tab: PR ke Gudang (approval doang) ---------- */
  function rowPR(p) {
    const viewOnly = isViewOnly();
    const canApprove = p.status === 'menunggu';
    return '<tr>' +
      '<td>#' + p.no_antrian + '</td>' +
      '<td>' + fmtDateTime(p.created_at) + '</td>' +
      '<td>' + esc(p.no_mesin || '-') + '</td>' +
      '<td>' + esc(p.nama_mekanik) + '</td>' +
      '<td>' + esc(p.nama_part) + ' &times; ' + p.jumlah + '</td>' +
      '<td><span class="badge ' + (STATUS_BADGE[p.status] || 'badge-draft') + '">' + statusLabel(p.status) + '</span></td>' +
      '<td class="text-right">' +
        (!viewOnly && canApprove ? '<button type="button" class="btn btn-success btn-sm" onclick="SPB.spinningTransaksi.advance(\'' + p.id + '\',\'disetujui\')">' + statusNextLabel('disetujui') + '</button>' : '') +
        (!viewOnly && canApprove ? ' <button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningTransaksi.reject(\'' + p.id + '\')">' + t('pm_action_tolak') + '</button>' : '') +
      '</td>' +
    '</tr>';
  }
  function prHtml() {
    const all = permintaan;
    const searched = all.filter(matchSearch);
    const cMenunggu = all.filter(function (p) { return p.status === 'menunggu'; }).length;
    const cDisetujui = all.filter(function (p) { return p.status === 'disetujui'; }).length;
    const cDitolak = all.filter(function (p) { return p.status === 'ditolak'; }).length;
    const filtered = statusFilter === 'semua' ? searched : searched.filter(function (p) { return p.status === statusFilter; });
    const groups = [
      { key: 'semua', label: t('pm_filter_semua') + ' (' + all.length + ')' },
      { key: 'menunggu', label: t('pm_filter_menunggu') + ' (' + cMenunggu + ')' },
      { key: 'disetujui', label: t('pm_status_disetujui') + ' (' + cDisetujui + ')' },
      { key: 'ditolak', label: t('pm_status_ditolak') + ' (' + cDitolak + ')' },
    ];
    return '<div class="grid-stats">' +
        statCard('list', '--indigo-500', '--indigo-50', 'Total PR', all.length) +
        statCard('clock', '--amber-500', '--amber-50', t('pm_filter_menunggu'), cMenunggu) +
        statCard('check-circle-2', '--emerald-500', '--emerald-50', t('pm_status_disetujui'), cDisetujui) +
        statCard('x-circle', '--red-500', '--red-50', t('pm_status_ditolak'), cDitolak) +
      '</div>' +
      (isViewOnly() ? '' : (showForm ? formHtml() : '')) +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="clipboard-list" class="icon-md"></i>' + t('trx_pr_title') + '<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="' + t('pm_col_part') + ' / ' + t('pm_col_mesin') + '..." value="' + esc(trxSearch) + '" oninput="SPB.spinningTransaksi.setTrxSearch(this.value)"></div>' +
            statusFilterOptions(groups) +
            (isViewOnly() ? '' : '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningTransaksi.toggleForm()"><i data-lucide="plus" class="icon-sm"></i>' + t('trx_new') + '</button>') +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>' + t('pm_col_no') + '</th><th>' + t('pm_col_tanggal') + '</th><th>' + t('pm_col_mesin') + '</th><th>' + t('pm_col_mekanik') + '</th><th>' + t('pm_col_part') + '</th><th>' + t('pm_col_status') + '</th><th></th></tr></thead>' +
          '<tbody>' + (filtered.length ? filtered.map(rowPR).join('') : '<tr><td colspan="7" class="empty-state">' + t('pm_empty') + '</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>';
  }

  /* ---------- Tab: Data Work Order (eksekusi fisik, pasca-approve) ---------- */
  function statusGroupOfWO(p) {
    if (p.status === 'disetujui') return 'wo_open';
    if (p.status === 'diambil') return 'wo_progress';
    if (p.status === 'repair_start') return 'wo_progress';
    if (p.status === 'repair_end') return 'wo_done';
    return null;
  }
  function rowWO(p) {
    const next = FLOW_WO[p.status];
    const viewOnly = isViewOnly();
    return '<tr>' +
      '<td>#' + p.no_antrian + '</td>' +
      '<td>' + esc(p.no_mesin || '-') + '</td>' +
      '<td>' + esc(p.nama_mekanik) + '</td>' +
      '<td>' + esc(p.nama_part) + ' &times; ' + p.jumlah + '</td>' +
      '<td><span class="badge ' + (STATUS_BADGE[p.status] || 'badge-draft') + '">' + statusLabel(p.status) + '</span></td>' +
      '<td style="white-space:nowrap">' + fmtDateTime(p.repair_start_at) + '</td>' +
      '<td style="white-space:nowrap">' + fmtDateTime(p.repair_end_at) + '</td>' +
      '<td class="text-right">' +
        (!viewOnly && next ? '<button type="button" class="btn btn-success btn-sm" onclick="SPB.spinningTransaksi.advance(\'' + p.id + '\',\'' + next + '\')">' + statusNextLabel(next) + '</button>' : '') +
      '</td>' +
    '</tr>';
  }
  function woHtml() {
    const all = permintaan.filter(function (p) { return statusGroupOfWO(p); });
    const filtered = statusFilter === 'semua' ? all : all.filter(function (p) { return statusGroupOfWO(p) === statusFilter; });
    const groups = [
      { key: 'semua', label: t('pm_filter_semua'), icon: 'list' },
      { key: 'wo_open', label: t('pm_filter_wo_open'), icon: 'clock' },
      { key: 'wo_progress', label: t('pm_filter_wo_progress'), icon: 'loader-2' },
      { key: 'wo_done', label: t('pm_filter_wo_done'), icon: 'check-circle-2' },
    ];
    const pills = '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;padding:0.9rem 1.25rem 0">' +
      groups.map(function (g) {
        const count = g.key === 'semua' ? all.length : all.filter(function (p) { return statusGroupOfWO(p) === g.key; }).length;
        const active = statusFilter === g.key;
        return '<button type="button" class="btn btn-sm ' + (active ? 'btn-primary' : 'btn-outline') + '" onclick="SPB.spinningTransaksi.setStatusFilter(\'' + g.key + '\')">' +
          '<i data-lucide="' + g.icon + '" class="icon-sm"></i>' + g.label +
          '<span class="badge-count" style="position:static;margin-left:0.375rem">' + count + '</span></button>';
      }).join('') +
    '</div>';
    const cOpen = all.filter(function (p) { return statusGroupOfWO(p) === 'wo_open'; }).length;
    const cProgress = all.filter(function (p) { return statusGroupOfWO(p) === 'wo_progress'; }).length;
    const cDone = all.filter(function (p) { return statusGroupOfWO(p) === 'wo_done'; }).length;
    return '<div class="grid-stats">' +
        statCard('list', '--indigo-500', '--indigo-50', 'Total WO', all.length) +
        statCard('clock', '--amber-500', '--amber-50', t('pm_filter_wo_open'), cOpen) +
        statCard('loader-2', '--sky-500', '--sky-50', t('pm_filter_wo_progress'), cProgress) +
        statCard('check-circle-2', '--emerald-500', '--emerald-50', t('pm_filter_wo_done'), cDone) +
      '</div>' +
      '<div class="table-card">' +
      '<div class="table-head"><h2 class="table-title"><i data-lucide="wrench" class="icon-md"></i>' + t('trx_wo_title') + '</h2></div>' +
      pills +
      '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>' + t('pm_col_no') + '</th><th>' + t('pm_col_mesin') + '</th><th>' + t('pm_col_mekanik') + '</th><th>' + t('pm_col_part') + '</th><th>' + t('pm_col_status') + '</th><th>Start</th><th>End</th><th></th></tr></thead>' +
        '<tbody>' + (filtered.length ? filtered.map(rowWO).join('') : '<tr><td colspan="8" class="empty-state">' + t('pm_empty') + '</td></tr>') + '</tbody>' +
      '</table></div></div>' +
    '</div>';
  }

  function render() {
    const app = document.getElementById('app');
    const ui = window.SPB.ui;

    let body;
    if (loading) {
      body = '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> ...</div>';
    } else if (loadError) {
      body = '<div class="empty-state" style="color:var(--red-600)">' + esc(loadError) + '</div>';
    } else {
      body = tab === 'wo' ? woHtml() : prHtml();
    }

    const titleKey = tab === 'wo' ? 'trx_wo_title' : 'trx_pr_title';
    const subKey = tab === 'wo' ? 'trx_wo_sub' : 'trx_pr_sub';
    app.innerHTML = ui.layout('transaksi-' + tab,
      '<div class="page-head">' +
        '<div><h1 class="page-title">' + t(titleKey) + '</h1>' +
        '<p class="page-sub">' + t(subKey) + '</p></div>' +
      '</div>' +
      body
    );
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.spinningTransaksi = {
    render: function (initialTab) { if (initialTab) tab = initialTab; load(); },
    setTab: setTab, setStatusFilter: setStatusFilter, setTrxSearch: setTrxSearch, toggleForm: toggleForm, submitForm: submitForm,
    advance: advance, reject: reject,
  };
})();
