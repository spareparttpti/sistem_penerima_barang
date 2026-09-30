/* =========================================================
   SPB · spinningMesin.js
   "Data Mesin" (#/data-mesin) — Master Data mesin produksi Spinning versi
   lengkap (Kode/Nama/Merk/Kategori/Lokasi/Jam Operasi/Status/Tahun), beda
   dari daftar mesin sederhana di dalam tab "Category Part Mesin"
   (spinningMaster.js categoryHtml) yang cuma No Mesin + Nama buat dropdown
   PR. Data-nya SAMA (tabel public.mesin), cuma di sini kolomnya lebih
   lengkap sesuai referensi UI yang dikasih user.
   ========================================================= */

(function () {
  'use strict';

  let mesinList = [];
  let loading = true;
  let loadError = '';
  const filters = { q: '', kategori: '', status: '' };
  let page = 1;
  let pageSize = 10;
  let editingId = null; // null = form ketutup, 'new' = tambah, uuid = edit

  function esc(s) { return window.esc(s); }
  function isViewOnly() { return !!(window.SPB.auth && window.SPB.auth.isViewOnly && window.SPB.auth.isViewOnly()); }

  async function load() {
    loading = true; loadError = '';
    render();
    try {
      mesinList = await window.SPB.dbSpinning.listMesin();
    } catch (err) {
      loadError = err.message || 'Gagal memuat data mesin.';
    }
    loading = false;
    render();
  }
  function renderLocal() { render(); }

  function applyFilter(key, value) { filters[key] = value; page = 1; renderLocal(); }
  function resetFilter() { filters.q = ''; filters.kategori = ''; filters.status = ''; page = 1; renderLocal(); }
  function setPage(p) { page = p; renderLocal(); }
  function setPageSize(v) { pageSize = Number(v); page = 1; renderLocal(); }

  function pctJamOperasi(m) {
    const interval = Number(m.interval_servis_jam) || 0;
    if (!interval) return 0;
    return Math.min(100, Math.round(Number(m.jam_operasi || 0) / interval * 100));
  }
  function barColor(pct) {
    if (pct >= 90) return 'var(--red-500)';
    if (pct >= 60) return 'var(--amber-500)';
    return 'var(--emerald-500)';
  }
  const STATUS_BADGE = { 'Beroperasi': 'badge-approved', 'Perlu Perawatan': 'badge-inspection', 'Rusak': 'badge-rejected', 'Nonaktif': 'badge-draft' };

  function openForm(id) { editingId = id || 'new'; renderLocal(); }
  function closeForm() { editingId = null; renderLocal(); }
  async function submitForm() {
    const noMesin = document.getElementById('ms-kode').value.trim();
    const namaMesin = document.getElementById('ms-nama').value.trim();
    if (!noMesin || !namaMesin) { window.SPB.ui.toast('Data belum lengkap', 'Kode & Nama Mesin wajib diisi.', 'error'); return; }
    const payload = {
      no_mesin: noMesin,
      nama_mesin: namaMesin,
      merk: document.getElementById('ms-merk').value.trim(),
      kategori: document.getElementById('ms-kategori').value,
      lokasi: document.getElementById('ms-lokasi').value.trim(),
      jam_operasi: document.getElementById('ms-jam').value,
      interval_servis_jam: document.getElementById('ms-interval').value,
      status: document.getElementById('ms-status').value,
      tahun: document.getElementById('ms-tahun').value,
      keterangan: document.getElementById('ms-keterangan').value.trim(),
    };
    try {
      if (editingId && editingId !== 'new') await window.SPB.dbSpinning.updateMesin(editingId, payload);
      else await window.SPB.dbSpinning.createMesin(payload);
      window.SPB.ui.toast('Tersimpan', noMesin, 'success');
      editingId = null;
      await load();
    } catch (err) {
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
    }
  }
  async function deleteMesin(id, nama) {
    const ok = await window.SPB.ui.confirm('Hapus mesin "' + nama + '"? Riwayat PR yang pernah pakai mesin ini tetap ada (cuma nama-nya kesalin, bukan terhubung langsung).', { title: 'Hapus Mesin', danger: true, okText: 'Hapus' });
    if (!ok) return;
    try {
      await window.SPB.dbSpinning.deleteMesin(id);
      window.SPB.ui.toast('Mesin dihapus', nama, 'success');
      await load();
    } catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }

  function formModalHtml() {
    if (!editingId) return '';
    const m = editingId !== 'new' ? mesinList.find(function (x) { return x.id === editingId; }) : null;
    const isNew = editingId === 'new';
    const field = function (label, id, value, opts) {
      opts = opts || {};
      return '<div><label class="field-label">' + label + '</label><input id="' + id + '" class="input" type="' + (opts.type || 'text') + '" value="' + esc(value == null ? '' : value) + '" placeholder="' + (opts.placeholder || '') + '"></div>';
    };
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.spinningMesin.closeForm()">' +
      '<div class="modal slide-up modal-lg" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.spinningMesin.closeForm()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="cog" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>' + (isNew ? 'Tambah Mesin' : 'Ubah Mesin') + '</p>' +
        '<p class="modal-sub">Data mesin/equipment beserta jam operasi & interval servis.</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.85rem;margin-top:0.5rem">' +
          field('Kode Mesin *', 'ms-kode', m ? m.no_mesin : '', { placeholder: 'mis. MC-CNC-01' }) +
          field('Nama Mesin *', 'ms-nama', m ? m.nama_mesin : '') +
          field('Merk / Model', 'ms-merk', m ? m.merk : '') +
          '<div><label class="field-label">Kategori</label><select id="ms-kategori" class="select">' +
            ['', 'Produksi', 'Utilitas', 'Material Handling'].map(function (c) { return '<option value="' + c + '"' + ((m ? m.kategori : '') === c ? ' selected' : '') + '>' + (c || '— Pilih —') + '</option>'; }).join('') +
          '</select></div>' +
          field('Lokasi', 'ms-lokasi', m ? m.lokasi : '', { placeholder: 'mis. Lini A - Bay 1' }) +
          field('Tahun (opsional)', 'ms-tahun', m ? m.tahun : '', { type: 'number' }) +
          field('Jam Operasi (opsional)', 'ms-jam', m ? m.jam_operasi : '', { type: 'number' }) +
          field('Interval Servis, jam (opsional)', 'ms-interval', m ? m.interval_servis_jam : '', { type: 'number' }) +
          '<div><label class="field-label">Status</label><select id="ms-status" class="select">' +
            Object.keys(STATUS_BADGE).map(function (s) { return '<option value="' + s + '"' + ((m ? m.status : 'Beroperasi') === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
          '</select></div>' +
          '<div style="grid-column:1/-1"><label class="field-label">Keterangan</label><textarea id="ms-keterangan" class="textarea" rows="2">' + esc(m ? (m.keterangan || '') : '') + '</textarea></div>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.spinningMesin.closeForm()">Batal</button>' +
          '<button type="button" class="btn btn-primary" onclick="SPB.spinningMesin.submitForm()"><i data-lucide="save" class="icon-sm"></i>Simpan</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function exportCsv(rows) {
    const headers = ['Kode', 'Mesin', 'Merk', 'Kategori', 'Lokasi', 'Jam Operasi', 'Interval Servis (jam)', 'Status', 'Tahun'];
    const escCsv = function (v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.join(',')].concat(rows.map(function (m) {
      return [m.no_mesin, m.nama_mesin, m.merk || '', m.kategori || '', m.lokasi || '', m.jam_operasi, m.interval_servis_jam, m.status, m.tahun || ''].map(escCsv).join(',');
    }));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'Data-Mesin-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function genericPaginationHtml(pageNo, totalPages, totalRows) {
    if (totalRows === 0) return '';
    const pages = [];
    const add = function (p) { if (pages.indexOf(p) === -1) pages.push(p); };
    add(1); add(totalPages);
    for (let p = pageNo - 1; p <= pageNo + 1; p++) if (p > 1 && p < totalPages) add(p);
    pages.sort(function (a, b) { return a - b; });
    let numbersHtml = ''; let prev = 0;
    pages.forEach(function (p) {
      if (p - prev > 1) numbersHtml += '<span class="pagination-ellipsis">…</span>';
      numbersHtml += '<button type="button" class="pagination-num' + (p === pageNo ? ' active' : '') + '" onclick="SPB.spinningMesin.setPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data &middot; halaman ' + pageNo + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (pageNo <= 1 ? 'disabled' : '') + ' onclick="SPB.spinningMesin.setPage(' + (pageNo - 1) + ')"><i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (pageNo >= totalPages ? 'disabled' : '') + ' onclick="SPB.spinningMesin.setPage(' + (pageNo + 1) + ')"><i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  function mesinRowHtml(m) {
    const viewOnly = isViewOnly();
    const pct = pctJamOperasi(m);
    return '<tr>' +
      '<td style="font-weight:700">' + esc(m.no_mesin) + '</td>' +
      '<td><div style="font-weight:600">' + esc(m.nama_mesin || '-') + '</div>' + (m.merk ? '<div style="font-size:0.75rem;color:var(--slate-400)">' + esc(m.merk) + '</div>' : '') + '</td>' +
      '<td>' + (m.kategori ? '<span class="badge badge-draft">' + esc(m.kategori) + '</span>' : '-') + '</td>' +
      '<td style="font-size:0.8125rem;color:var(--slate-500)">' + (m.lokasi ? '<i data-lucide="map-pin" class="icon-sm" style="width:0.7rem;height:0.7rem;vertical-align:-1px"></i> ' + esc(m.lokasi) : '-') + '</td>' +
      '<td style="min-width:9rem">' +
        '<div style="font-size:0.8125rem;font-weight:600">' + Number(m.jam_operasi || 0).toLocaleString('id-ID') + ' jam</div>' +
        '<div class="progress-track"><div class="progress-bar" style="width:' + pct + '%;background:' + barColor(pct) + '"></div></div>' +
        '<div class="progress-meta">' + pct + '%</div>' +
      '</td>' +
      '<td><span class="badge ' + (STATUS_BADGE[m.status] || 'badge-draft') + '">' + esc((m.status || '-').toUpperCase()) + '</span></td>' +
      '<td>' + esc(m.tahun || '-') + '</td>' +
      (viewOnly ? '' : '<td class="text-right"><div style="display:flex;gap:0.3rem;justify-content:flex-end">' +
        '<button type="button" class="btn btn-outline btn-sm" title="Ubah" onclick="SPB.spinningMesin.openForm(\'' + m.id + '\')"><i data-lucide="pencil" class="icon-sm"></i></button>' +
        '<button type="button" class="btn btn-outline btn-sm" title="Hapus" onclick="SPB.spinningMesin.deleteMesin(\'' + m.id + '\', \'' + esc(m.no_mesin).replace(/'/g, "\\'") + '\')"><i data-lucide="trash-2" class="icon-sm" style="color:var(--red-600)"></i></button>' +
      '</div></td>') +
    '</tr>';
  }

  function mesinHtml() {
    const viewOnly = isViewOnly();
    const q = filters.q.toLowerCase();
    const kategoriOptions = Array.from(new Set(mesinList.map(function (m) { return m.kategori; }).filter(Boolean))).sort();
    const filtered = mesinList.filter(function (m) {
      if (q && (m.no_mesin || '').toLowerCase().indexOf(q) === -1 && (m.nama_mesin || '').toLowerCase().indexOf(q) === -1 &&
          (m.merk || '').toLowerCase().indexOf(q) === -1 && (m.lokasi || '').toLowerCase().indexOf(q) === -1) return false;
      if (filters.kategori && m.kategori !== filters.kategori) return false;
      if (filters.status && m.status !== filters.status) return false;
      return true;
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const pageStart = (page - 1) * pageSize;
    const pageRows = filtered.slice(pageStart, pageStart + pageSize);

    return '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="cog" class="icon-md"></i>Data Mesin Produksi<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari kode mesin, nama, merk, lokasi..." value="' + esc(filters.q) + '" oninput="SPB.spinningMesin.applyFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningMesin.applyFilter(\'kategori\', this.value)">' +
              '<option value="">Semua Kategori</option>' +
              kategoriOptions.map(function (c) { return '<option value="' + esc(c) + '"' + (filters.kategori === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMesin.applyFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              Object.keys(STATUS_BADGE).map(function (s) { return '<option value="' + s + '"' + (filters.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningMesin.setPageSize(this.value)" title="Data per halaman">' +
              [5, 10, 15, 20, 50].map(function (n) { return '<option value="' + n + '"' + (pageSize === n ? ' selected' : '') + '>' + n + ' / halaman</option>'; }).join('') +
            '</select>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMesin.resetFilter()"><i data-lucide="rotate-ccw" class="icon-sm"></i>Reset</button>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningMesin.exportCsvCurrent()"><i data-lucide="file-down" class="icon-sm"></i>Ekspor CSV</button>' +
            (viewOnly ? '' : '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningMesin.openForm(null)"><i data-lucide="plus" class="icon-sm"></i>Tambah Mesin</button>') +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Kode</th><th>Mesin</th><th>Kategori</th><th>Lokasi</th><th>Jam Operasi</th><th>Status</th><th>Tahun</th>' + (viewOnly ? '' : '<th class="text-right">Aksi</th>') + '</tr></thead>' +
          '<tbody>' + (pageRows.length ? pageRows.map(mesinRowHtml).join('') : '<tr><td colspan="' + (viewOnly ? 7 : 8) + '" class="empty-state">Belum ada data mesin.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
        genericPaginationHtml(page, totalPages, filtered.length) +
      '</div>' + formModalHtml();
  }

  function exportCsvCurrent() {
    const q = filters.q.toLowerCase();
    const filtered = mesinList.filter(function (m) {
      if (q && (m.no_mesin || '').toLowerCase().indexOf(q) === -1 && (m.nama_mesin || '').toLowerCase().indexOf(q) === -1 &&
          (m.merk || '').toLowerCase().indexOf(q) === -1 && (m.lokasi || '').toLowerCase().indexOf(q) === -1) return false;
      if (filters.kategori && m.kategori !== filters.kategori) return false;
      if (filters.status && m.status !== filters.status) return false;
      return true;
    });
    if (!filtered.length) { window.SPB.ui.toast('Tidak ada data', 'Tidak ada data sesuai filter.', 'error'); return; }
    exportCsv(filtered);
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
      body = mesinHtml();
    }
    app.innerHTML = ui.layout('data-mesin',
      '<div class="page-head">' +
        '<div><h1 class="page-title">Data Mesin Produksi</h1>' +
        '<p class="page-sub">Daftar mesin/equipment beserta jam operasi, lokasi, dan interval servis sebagai dasar penjadwalan perawatan.</p></div>' +
      '</div>' +
      body
    );
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.spinningMesin = {
    render: load,
    applyFilter: applyFilter, resetFilter: resetFilter, setPage: setPage, setPageSize: setPageSize,
    openForm: openForm, closeForm: closeForm, submitForm: submitForm, deleteMesin: deleteMesin,
    exportCsvCurrent: exportCsvCurrent,
  };
})();
