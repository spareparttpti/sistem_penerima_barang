/* =========================================================
   SPB · detailQc.js
   Halaman Detail & QC Approval:
   - informasi penerimaan, tabel item, bukti foto
   - tombol Approve / Reject
   - modal konfirmasi + preview payload webhook Teamly
   ========================================================= */

(function () {
  'use strict';

  function condBadge(cond) {
    const map = { Baik: 'cond-baik', Rusak: 'cond-rusak', Cacat: 'cond-cacat' };
    return '<span class="cond ' + (map[cond] || 'cond-baik') + '">' + esc(cond) + '</span>';
  }

  function fmtDate(v) {
    if (!v) return '<span class="muted">-</span>';
    const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(v) {
    const d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  /* Daftar item kosong pada penerimaan asal Odoo hampir selalu berarti satu hal:
     kolom Operations tidak ikut dicentang saat Export. Beri tahu cara membetulkannya,
     jangan cuma menulis "tidak ada item". */
  function emptyItemsHtml(rec) {
    if (rec.source !== 'odoo') {
      return '<div class="empty-state">Tidak ada item.</div>';
    }
    // Dua kemungkinan sumbernya sama-sama masih dipakai: sinkron otomatis
    // (odoo-pull, tiap 5 menit) DAN import CSV manual (tombol Import Odoo) —
    // pesannya digeneralisasi supaya benar untuk keduanya, bukan cuma
    // menuduh langkah Export CSV yang salah.
    return '<div class="empty-items">' +
      '<p class="empty-items-title"><i data-lucide="alert-triangle" class="icon-sm"></i>' +
        'Belum ada item untuk transfer ini</p>' +
      '<p>Kemungkinan penyebabnya:</p>' +
      '<ul class="empty-items-list">' +
        '<li>Transfer ini <b>di Odoo</b> memang belum diisi baris <b>Product/Operations</b>-nya ' +
          '(mis. baru dibuat, belum sempat ditambah barangnya) — kalau statusnya masih Draft, ' +
          'begitu diisi di Odoo, otomatis ikut terisi di sini lewat sinkron berikutnya (maks. 5 menit).</li>' +
        '<li><i>Kalau ini hasil import CSV manual:</i> kolom <b>Operations → Product</b> dan ' +
          '<b>Operations → Demand/Quantity</b> harus ditambahkan sendiri saat Export di Odoo — ' +
          'tidak otomatis ikut meski terlihat di layar.</li>' +
      '</ul>' +
    '</div>';
  }

  /* ---------- Surat Jalan (cetak) ----------
     Dokumen dirender ke elemen tersembunyi di <body>, lalu CSS @media print
     menyembunyikan aplikasi dan hanya menampilkan dokumen ini. Cara ini dipakai
     agar tidak membuka window baru — popup sering diblokir browser, dan hasil
     cetaknya jadi tidak bisa diandalkan di komputer gudang. */

  function suratJalanHtml(rec, details) {
    const C = (window.SPB_CONFIG && window.SPB_CONFIG.COMPANY) || {};
    const waiting = rec.status === 'Draft';

    const rows = details.map(function (d, i) {
      const sp = window.SPB.spareparts.find(function (s) { return s.id === d.sparepart_id; }) || {};
      const qty = waiting ? (d.qty_po || 0) : d.qty_received;
      return '<tr>' +
        '<td class="c">' + (i + 1) + '</td>' +
        '<td>' + esc(sp.sku || d.sku || '-') + '</td>' +
        '<td>' + esc(sp.name || d.product_name || '-') + '</td>' +
        '<td class="c">' + (d.qty_po || '-') + '</td>' +
        '<td class="c">' + qty + ' ' + esc(sp.unit || d.uom || '') + '</td>' +
        '<td class="c">' + esc(waiting ? '-' : (d.condition || '-')) + '</td>' +
      '</tr>';
    }).join('');

    // Baris kosong agar tabel tetap rapi & ada ruang tulis tangan saat dicetak
    const filler = new Array(Math.max(0, 5 - details.length)).fill(
      '<tr class="filler"><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>'
    ).join('');

    const totalQty = details.reduce(function (a, d) {
      return a + (waiting ? (d.qty_po || 0) : (d.qty_received || 0));
    }, 0);

    return '<div class="sj">' +
      '<div class="sj-head">' +
        '<div>' +
          '<p class="sj-company">' + esc(C.name || 'Perusahaan') + '</p>' +
          (C.address ? '<p class="sj-company-sub">' + esc(C.address) + '</p>' : '') +
          (C.phone ? '<p class="sj-company-sub">Telp. ' + esc(C.phone) + '</p>' : '') +
          (C.department ? '<p class="sj-company-sub">' + esc(C.department) + '</p>' : '') +
        '</div>' +
        '<div class="sj-title-box">' +
          '<p class="sj-title">SURAT JALAN</p>' +
          '<p class="sj-subtitle">Bukti Penerimaan Barang</p>' +
          '<p class="sj-no">No. ' + esc(rec.wh_in_ref || rec.po_number || '-') + '</p>' +
        '</div>' +
      '</div>' +

      '<table class="sj-meta"><tbody>' +
        '<tr><td class="k">Vendor / Pengirim</td><td class="v">' + esc(rec.vendor_name || '-') + '</td>' +
            '<td class="k">No PO</td><td class="v">' + esc(rec.po_number || '-') + '</td></tr>' +
        '<tr><td class="k">No WH/IN</td><td class="v">' + esc(rec.wh_in_ref || '-') + '</td>' +
            '<td class="k">Tgl Pemesanan</td><td class="v">' + fmtDatePlain(rec.order_date) + '</td></tr>' +
        '<tr><td class="k">Petugas Penerima</td><td class="v">' +
              esc(waiting ? '-' : (rec.receiver_name || '-')) + '</td>' +
            '<td class="k">Tgl Barang Datang</td><td class="v">' +
              (rec.arrival_date ? fmtDateTimePlain(rec.arrival_date) : '-') + '</td></tr>' +
        '<tr><td class="k">Status</td><td class="v">' + esc(rec.status) + '</td>' +
            '<td class="k">Dicetak</td><td class="v">' + fmtDateTimePlain(new Date().toISOString()) + '</td></tr>' +
      '</tbody></table>' +

      '<table class="sj-items">' +
        '<thead><tr>' +
          '<th style="width:6%">No</th><th style="width:18%">SKU</th><th>Nama Barang</th>' +
          '<th style="width:12%">Qty PO</th><th style="width:16%">Qty Diterima</th><th style="width:14%">Kondisi</th>' +
        '</tr></thead>' +
        '<tbody>' +
          (rows || '<tr><td colspan="6" class="c" style="padding:1.5rem 0;font-style:italic">' +
            'Rincian barang tidak tersedia — isi manual saat serah terima.</td></tr>') +
          filler +
        '</tbody>' +
        (details.length ? '<tfoot><tr><td colspan="4" class="r"><b>Total</b></td>' +
          '<td class="c"><b>' + totalQty + '</b></td><td></td></tr></tfoot>' : '') +
      '</table>' +

      '<div class="sj-notes"><b>Catatan:</b> ' + esc(rec.notes || '-') + '</div>' +

      '<div class="sj-sign">' +
        '<div class="sj-sign-box"><p class="sj-sign-role">Pengirim / Vendor</p>' +
          '<div class="sj-sign-space"></div><p class="sj-sign-name">( ' + esc(rec.vendor_name || '') + ' )</p></div>' +
        '<div class="sj-sign-box"><p class="sj-sign-role">Penerima / Gudang</p>' +
          '<div class="sj-sign-space"></div><p class="sj-sign-name">( ' +
          esc(waiting ? '.....................' : (rec.receiver_name || '')) + ' )</p></div>' +
        '<div class="sj-sign-box"><p class="sj-sign-role">Mengetahui</p>' +
          '<div class="sj-sign-space"></div><p class="sj-sign-name">( ..................... )</p></div>' +
      '</div>' +

      '<p class="sj-foot">Dokumen ini dicetak dari Sistem Penerimaan Barang Sparepart (SPB).</p>' +
    '</div>';
  }

  function fmtDatePlain(v) {
    if (!v) return '-';
    const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function fmtDateTimePlain(v) {
    const d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  /* Pengaturan cetak diterapkan LEWAT CSS sebelum window.print() dipanggil — dialog
     cetak bawaan browser tidak bisa diubah dari kode, jadi satu-satunya cara mengatur
     ukuran adalah menyiapkan halaman sumbernya sebelum dialog itu terbuka. Nilai
     terakhir diingat di localStorage supaya tidak perlu diatur ulang tiap cetak. */
  const PRINT_PREF_KEY = 'spb_print_pref_v1';
  const PAPER_SIZES = {
    A4: { label: 'A4 (210 × 297 mm)', size: 'A4' },
    A5: { label: 'A5 (148 × 210 mm)', size: 'A5' },
    F4: { label: 'F4 / Folio (215 × 330 mm)', size: '215mm 330mm' },
    Letter: { label: 'Letter (216 × 279 mm)', size: 'letter' },
  };

  function loadPrintPref() {
    try {
      const raw = localStorage.getItem(PRINT_PREF_KEY);
      const p = raw ? JSON.parse(raw) : null;
      if (p && PAPER_SIZES[p.paper]) return p;
    } catch (e) { /* abaikan, pakai default */ }
    return { paper: 'A4', orientation: 'portrait', scale: 100 };
  }

  function savePrintPref(p) {
    try { localStorage.setItem(PRINT_PREF_KEY, JSON.stringify(p)); } catch (e) { /* kuota penuh, lewati */ }
  }

  let printPref = loadPrintPref();

  function applyPrintPref() {
    let style = document.getElementById('print-pref-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'print-pref-style';
      document.head.appendChild(style);
    }
    const cfg = PAPER_SIZES[printPref.paper] || PAPER_SIZES.A4;
    const scale = Math.max(50, Math.min(150, parseInt(printPref.scale, 10) || 100)) / 100;
    style.textContent =
      '@media print { @page { size: ' + cfg.size + ' ' + printPref.orientation + '; } ' +
      '#print-root .sj { zoom: ' + scale + '; } }';
  }

  function printPanelHtml() {
    const p = printPref;
    return '<div class="print-panel">' +
      '<div class="print-panel-box">' +
        '<p class="print-panel-title"><i data-lucide="settings-2" class="icon-md"></i>Pengaturan Cetak</p>' +
        '<div class="print-panel-grid">' +
          '<div><label class="field-label" for="pp-paper">Ukuran Kertas</label>' +
          '<select id="pp-paper" class="select" onchange="SPB.detailQc.setPrintPref(\'paper\', this.value)">' +
            Object.keys(PAPER_SIZES).map(function (k) {
              return '<option value="' + k + '"' + (p.paper === k ? ' selected' : '') + '>' + PAPER_SIZES[k].label + '</option>';
            }).join('') +
          '</select></div>' +
          '<div><label class="field-label" for="pp-orient">Orientasi</label>' +
          '<select id="pp-orient" class="select" onchange="SPB.detailQc.setPrintPref(\'orientation\', this.value)">' +
            '<option value="portrait"' + (p.orientation === 'portrait' ? ' selected' : '') + '>Portrait (tegak)</option>' +
            '<option value="landscape"' + (p.orientation === 'landscape' ? ' selected' : '') + '>Landscape (rebah)</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="print-panel-scale">' +
          '<label class="field-label" for="pp-scale">Ukuran Tampilan — <span id="pp-scale-val">' + p.scale + '%</span></label>' +
          '<input type="range" id="pp-scale" min="50" max="150" step="5" value="' + p.scale + '" ' +
          'oninput="document.getElementById(\'pp-scale-val\').textContent=this.value+\'%\';SPB.detailQc.setPrintPref(\'scale\', this.value, true)">' +
          '<p class="print-panel-hint">Kecilkan kalau isi surat jalan terpotong ke halaman kedua; ' +
            'perbesar untuk tulisan lebih besar di kertas besar (mis. F4).</p>' +
        '</div>' +
        '<div class="print-panel-actions">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.detailQc.closePrintPanel()">Batal</button>' +
          '<button type="button" class="btn btn-primary" onclick="SPB.detailQc.confirmPrint()">' +
            '<i data-lucide="printer" class="icon-sm"></i>Cetak Sekarang</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function setPrintPref(key, value, skipRerender) {
    printPref = Object.assign({}, printPref, { [key]: value });
    savePrintPref(printPref);
    if (!skipRerender) openPrintPanel(); // paper/orientation ganti pratinjau ukuran kertas
  }

  function openPrintPanel() {
    let root = document.getElementById('print-panel-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'print-panel-root';
      document.body.appendChild(root);
    }
    root.innerHTML = printPanelHtml();
    window.SPB.ui.afterRender();
  }

  function closePrintPanel() {
    const root = document.getElementById('print-panel-root');
    if (root) root.innerHTML = '';
  }

  async function confirmPrint() {
    closePrintPanel();
    await printSuratJalan();
  }

  async function printSuratJalan() {
    const rec = await window.SPB.db.get(window.SPB.currentDetailId);
    if (!rec) {
      window.SPB.ui.toast('Gagal mencetak', 'Data penerimaan tidak ditemukan.', 'error');
      return;
    }

    let root = document.getElementById('print-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'print-root';
      document.body.appendChild(root);
    }
    root.innerHTML = suratJalanHtml(rec, rec.items || []);
    applyPrintPref();
    window.SPB.ui.afterRender();

    // Beri browser satu frame untuk melukis sebelum dialog cetak membekukan tampilan
    setTimeout(function () { window.print(); }, 60);
  }

  /* Status upload foto — sengaja di luar render(), supaya tidak hilang kalau
     komponen lain memicu render ulang saat upload sedang berjalan. */
  let photoState = { uploading: false };

  async function uploadPhoto(file) {
    if (!file) return;
    const id = window.SPB.currentDetailId;
    photoState = { uploading: true };
    render(id);
    try {
      const url = await window.SPB.db.uploadProof(file);
      await window.SPB.db.updatePhoto(id, url);
      window.SPB.ui.toast('Foto tersimpan', 'Bukti foto penerimaan berhasil diunggah.', 'success');
    } catch (err) {
      window.SPB.ui.toast('Upload gagal', err.message, 'error');
    } finally {
      photoState = { uploading: false };
      render(id);
    }
  }

  /* Tandai barang sudah datang → status jadi In Inspection (masuk antrean QC). */
  async function markArrived() {
    const btnEl = document.getElementById('arr-btn');
    // Panggilan ke odoo-validate di dalam db.markArrived() bikin proses ini
    // butuh waktu lebih lama dari sekadar simpan ke Supabase — tanpa guard ini,
    // klik berulang saat masih menunggu bisa memicu beberapa markArrived()
    // bersamaan (yang kedua dst ditolak DB, tapi tetap memunculkan toast error
    // yang membingungkan padahal klik pertama sebenarnya sudah berhasil).
    if (btnEl && btnEl.disabled) return;

    const dateEl = document.getElementById('arr-date');
    const timeEl = document.getElementById('arr-time');
    const recvEl = document.getElementById('arr-receiver');
    if (!dateEl) return;

    const receiver = (recvEl && recvEl.value || '').trim();
    if (!receiver) {
      window.SPB.ui.toast('Petugas belum diisi', 'Isi nama petugas yang menerima barang.', 'error');
      if (recvEl) recvEl.focus();
      return;
    }

    /* Nilai awal input diisi saat halaman dirender. Kalau petugas membuka halaman
       lalu menekan Done beberapa menit kemudian, nilai itu sudah kedaluwarsa —
       jadi waktu diambil ulang SEKARANG, kecuali field-nya memang diubah sendiri
       (mis. mencatat barang yang datang kemarin). */
    const now = new Date();
    const nowLocal = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    const dateDirty = (dateEl.dataset || {}).dirty === '1';
    const timeDirty = !!timeEl && (timeEl.dataset || {}).dirty === '1';

    const tgl = dateDirty ? dateEl.value : nowLocal.toISOString().slice(0, 10);
    const jam = timeDirty ? (timeEl.value || '00:00') : now.toTimeString().slice(0, 5);

    if (!tgl) {
      window.SPB.ui.toast('Tanggal belum diisi', 'Isi tanggal barang datang dulu.', 'error');
      return;
    }

    const iso = new Date(tgl + 'T' + jam + ':00').toISOString();
    if (isNaN(new Date(iso).getTime())) {
      window.SPB.ui.toast('Tanggal tidak valid', 'Periksa kembali tanggal dan jam.', 'error');
      return;
    }
    const id = window.SPB.currentDetailId;
    if (btnEl) btnEl.disabled = true;

    try {
      const rec = await window.SPB.db.markArrived(id, iso, receiver);

      // Notifikasi Teamly: barang tiba, minta pengecekan fisik
      try {
        const payload = window.SPB.teamly.buildTeamlyPayload({
          status: 'In Inspection',
          record: { id: id, po_number: rec.po_number, vendor_name: rec.vendor_name,
                    notes: 'Barang tiba di gudang (' + (rec.wh_in_ref || rec.po_number) + '), diterima ' + receiver },
          trigger: 'ui',
          triggerReason: 'Kedatangan dikonfirmasi — menunggu inspeksi fisik tim gudang',
        });
        await window.SPB.teamly.sendTeamlyNotification(payload);
      } catch (e) { /* notifikasi gagal tidak boleh membatalkan pencatatan */ }

      window.SPB.ui.toast('Barang ditandai datang',
        '#' + rec.po_number + ' masuk antrean inspeksi (In Inspection).', 'success');

      // Pencatatan di SPB sudah pasti berhasil di titik ini — validasi otomatis
      // ke Odoo cuma langkah tambahan, jadi kegagalannya ditampilkan sebagai
      // peringatan terpisah, bukan error yang menutupi keberhasilan di atas.
      if (rec.odoo_sync && !rec.odoo_sync.ok) {
        window.SPB.ui.toast('Belum tersinkron ke Odoo',
          rec.odoo_sync.message + ' Data di SPB tetap tersimpan — cek Odoo secara manual kalau perlu.', 'error');
      }

      render(id);
    } catch (err) {
      if (btnEl) btnEl.disabled = false;
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
    }
  }

  async function render(id) {
    const app = document.getElementById('app');
    const db = window.SPB.db;
    const ui = window.SPB.ui;
    window.SPB.currentDetailId = id;

    app.innerHTML = ui.layout('dashboard',
      '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat detail...</div>'
    );
    ui.afterRender();

    const rec = await db.get(id);
    if (!rec) {
      app.innerHTML = ui.layout('dashboard',
        '<div class="empty-state" style="padding:5rem 0">Data penerimaan tidak ditemukan.<br><br>' +
        '<a href="#/" class="btn btn-outline btn-sm"><i data-lucide="arrow-left" class="icon-sm"></i>Kembali ke Dashboard</a></div>'
      );
      ui.afterRender();
      return;
    }

    const details = rec.items || [];

    const waiting = rec.status === 'Draft';   // dari Odoo, barang belum datang
    // Sudah "Done" di Odoo (selesai/divalidasi di sana), tapi belum pernah
    // diproses lewat app ini — bukan lagi benar-benar "menunggu", jadi tidak
    // perlu form konfirmasi kedatangan.
    const closedInOdoo = waiting && rec.odoo_state === 'Done';
    // Sama seperti closedInOdoo, tapi untuk yang dibatalkan di Odoo — integrasi
    // tetap read-only, jadi Odoo tidak pernah ditulisi balik, cuma ditampilkan.
    const cancelledInOdoo = waiting && rec.odoo_state === 'Cancelled';

    const infoCard =
      '<div class="detail-card">' +
        '<h2 class="detail-card-title"><i data-lucide="info" class="icon-md"></i>Informasi Penerimaan</h2>' +
        '<dl class="dl-grid">' +
          '<dt>Vendor</dt><dd>' + esc(rec.vendor_name) + '</dd>' +
          (rec.wh_in_ref ? '<dt>No WH/IN</dt><dd>' + esc(rec.wh_in_ref) + '</dd>' : '') +
          '<dt>Petugas</dt><dd>' + (waiting ? '<span class="muted">belum diterima</span>' : esc(rec.receiver_name)) + '</dd>' +
          // Kapan baris ini masuk ke SPB — beda dari Tgl Pemesanan (tanggal
          // dijadwalkan di Odoo) maupun Tgl Barang Datang (dikonfirmasi manual).
          '<dt>Tgl Dibuat</dt><dd>' + fmtDateTime(rec.created_at) + '</dd>' +
          '<dt>Tgl Pemesanan</dt><dd>' + fmtDate(rec.order_date) + '</dd>' +
          '<dt>Tgl Barang Datang</dt><dd>' +
            (rec.arrival_date ? fmtDateTime(rec.arrival_date) : '<span class="muted">belum datang</span>') + '</dd>' +
          '<dt>Status</dt><dd>' + (cancelledInOdoo
            ? '<span class="badge badge-odoo-cancel"><span class="badge-dot"></span>Dibatalkan di Odoo</span>'
            : closedInOdoo
            ? '<span class="badge badge-odoo-done"><span class="badge-dot"></span>Selesai di Odoo</span>'
            : ui.statusBadge(rec.status)) + '</dd>' +
          '<dt>Catatan</dt><dd style="grid-column:1/-1;font-weight:500">' + esc(rec.notes || '-') + '</dd>' +
        '</dl>' +
      '</div>';

    const itemRows = details.map(function (d) {
      const sp = window.SPB.spareparts.find(function (s) { return s.id === d.sparepart_id; }) || {};
      // Item dari Odoo yang belum ada padanannya di master sparepart tetap
      // ditampilkan memakai nama/SKU asli dari Odoo, bukan tanda strip
      const sku = sp.sku || d.sku || '-';
      const nama = sp.name || d.product_name || '-';
      const unmatched = !sp.id && (d.product_name || d.sku);

      return '<tr>' +
        '<td style="font-weight:600;color:var(--slate-700)">' + esc(sku) + '</td>' +
        '<td style="color:var(--slate-600)">' + esc(nama) +
          (unmatched ? '<span class="tag-unmatched" title="Belum ada di master sparepart">belum terdaftar</span>' : '') + '</td>' +
        (waiting
          ? '<td style="font-weight:700">' + (d.qty_po || 0) +
            ' <span style="font-weight:400;color:var(--slate-400)">' + esc(d.uom || sp.unit || '') + '</span></td>'
          : '<td style="font-weight:700">' + d.qty_received +
            ' <span style="font-weight:400;color:var(--slate-400)">' + esc(sp.unit || '') + '</span>' +
            (d.qty_po ? '<span class="qty-cmp ' +
              (d.qty_received === d.qty_po ? 'ok' : d.qty_received < d.qty_po ? 'short' : 'over') + '">PO ' + d.qty_po + '</span>' : '') +
            '</td>') +
        '<td>' + (waiting ? '<span class="muted">-</span>' : condBadge(d.condition)) + '</td>' +
      '</tr>';
    }).join('');

    const itemsCard =
      '<div class="detail-card" style="padding:0;overflow:hidden">' +
        '<div class="detail-card-title" style="padding:0.875rem 1.25rem;border-bottom:1px solid var(--slate-100);margin-bottom:0">' +
          '<i data-lucide="package" class="icon-md"></i>Detail Item' +
          (waiting ? '<span class="card-title-note">qty sesuai PO Odoo</span>' : '') + '</div>' +
        '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>SKU</th><th>Nama</th><th>Qty</th><th>Kondisi</th></tr></thead>' +
          '<tbody>' + (itemRows || '<tr><td colspan="4">' + emptyItemsHtml(rec) + '</td></tr>') + '</tbody>' +
        '</table></div>' +
      '</div>';

    // Foto bisa ditambah/diganti kapan pun kecuali penerimaan masih Draft (barang
    // belum ada secara fisik, jadi belum ada apa pun yang bisa difoto).
    const canUploadPhoto = !waiting;
    let photoBlock;
    if (photoState.uploading) {
      photoBlock = '<div class="photo-empty"><i data-lucide="loader-2" class="icon-lg spin" ' +
        'style="margin-bottom:0.5rem;color:var(--brand-600)"></i>' +
        '<p style="font-size:0.875rem;font-weight:500">Mengunggah foto...</p></div>';
    } else if (rec.proof_image_url) {
      photoBlock = '<div class="photo-wrap">' +
        '<img src="' + rec.proof_image_url + '" class="photo-frame" alt="Bukti foto penerimaan">' +
        (canUploadPhoto
          ? '<button type="button" class="btn btn-outline btn-sm photo-replace-btn" ' +
            'onclick="document.getElementById(\'photo-input\').click()">' +
            '<i data-lucide="refresh-cw" class="icon-sm"></i>Ganti Foto</button>'
          : '') +
      '</div>';
    } else if (canUploadPhoto) {
      photoBlock = '<div class="photo-empty photo-empty-clickable" ' +
        'onclick="document.getElementById(\'photo-input\').click()">' +
        '<i data-lucide="camera" class="icon-xl" style="margin-bottom:0.5rem"></i>' +
        '<p style="font-size:0.875rem;font-weight:600">Belum ada foto bukti</p>' +
        '<p style="font-size:0.75rem;color:var(--slate-400)">Klik untuk unggah foto fisik barang</p>' +
      '</div>';
    } else {
      photoBlock = '<div class="photo-empty">' +
        '<i data-lucide="image-off" class="icon-xl" style="margin-bottom:0.5rem"></i>' +
        '<p style="font-size:0.875rem;font-weight:500">Tidak ada foto bukti</p>' +
        '<p style="font-size:0.75rem;color:var(--slate-400)">Bisa diunggah setelah barang datang</p>' +
      '</div>';
    }
    if (canUploadPhoto) {
      photoBlock += '<input type="file" id="photo-input" accept="image/*" class="hidden" ' +
        'onchange="SPB.detailQc.uploadPhoto(this.files[0])">';
    }

    let qcBlock;
    if (cancelledInOdoo) {
      qcBlock =
        '<div class="odoo-closed-card odoo-cancel-card">' +
          '<p class="odoo-closed-title"><i data-lucide="x-circle" class="icon-md"></i>Dibatalkan di Odoo</p>' +
          '<p class="odoo-closed-sub">Transfer ini sudah dibatalkan (<b>Cancelled</b>) di Odoo sebelum sempat ditandai ' +
          'datang lewat aplikasi ini. Tidak perlu konfirmasi kedatangan — kalau ini keliru, cek kembali di Odoo.</p>' +
        '</div>';
    } else if (closedInOdoo) {
      qcBlock =
        '<div class="odoo-closed-card">' +
          '<p class="odoo-closed-title"><i data-lucide="check-check" class="icon-md"></i>Sudah Selesai di Odoo</p>' +
          '<p class="odoo-closed-sub">Transfer ini sudah berstatus <b>Done</b> di Odoo (divalidasi/selesai di sana), ' +
          'tapi belum pernah ditandai datang lewat aplikasi ini. Tidak perlu konfirmasi kedatangan manual — ' +
          'kalau tetap ingin dicatat di sini (mis. untuk QC), hubungi admin untuk penyesuaian data.</p>' +
        '</div>';
    } else if (waiting) {
      // Barang belum datang → yang bisa dilakukan hanya menandai kedatangan.
      // Default tanggal = hari ini, karena umumnya diisi saat barang tiba.
      const today = new Date();  // hanya untuk nilai awal input
      const tgl = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const jam = today.toTimeString().slice(0, 5);

      qcBlock =
        '<div class="arrival-card">' +
          '<p class="arrival-title"><i data-lucide="truck" class="icon-md"></i>Konfirmasi Kedatangan Barang</p>' +
          '<p class="arrival-sub">Tekan Done saat barang tiba — tanggal &amp; jam otomatis memakai ' +
            'waktu penekanan. Ubah field di bawah hanya kalau barang datang di waktu lain.</p>' +
          '<div class="arrival-grid">' +
            // data-dirty menandai field yang diubah petugas; yang tidak diubah
            // diisi ulang dengan waktu saat tombol Done ditekan
            '<div><label class="field-label" for="arr-date">Tanggal Barang Datang *</label>' +
            '<input type="date" id="arr-date" class="input" value="' + tgl + '" max="' + tgl + '" ' +
            'data-dirty="0" oninput="this.dataset.dirty=\'1\'"></div>' +
            '<div><label class="field-label" for="arr-time">Jam</label>' +
            '<input type="time" id="arr-time" class="input" value="' + jam + '" ' +
            'data-dirty="0" oninput="this.dataset.dirty=\'1\'"></div>' +
            '<div class="arrival-full"><label class="field-label" for="arr-receiver">Nama Petugas Penerima *</label>' +
            '<input type="text" id="arr-receiver" class="input" placeholder="cth: Budi Santoso" ' +
            'value="' + esc(rec.receiver_name === '-' ? '' : rec.receiver_name || '') + '"></div>' +
          '</div>' +
          '<button id="arr-btn" class="btn btn-success arrival-btn" onclick="SPB.detailQc.markArrived()">' +
            '<i data-lucide="check-circle-2" class="icon-sm"></i>Done — Barang Sudah Datang</button>' +
        '</div>';
    } else if (rec.status === 'Approved' || rec.status === 'Rejected') {
      const ok = rec.status === 'Approved';
      qcBlock =
        '<div class="qc-result ' + (ok ? 'approved' : 'rejected') + '">' +
          '<i data-lucide="' + (ok ? 'badge-check' : 'badge-x') + '" class="icon-lg"></i>' +
          '<div><p class="qc-result-title">Barang ' + rec.status + '</p>' +
          '<p class="qc-result-sub">Status penerimaan telah diperbarui.</p></div>' +
        '</div>';
    } else {
      qcBlock =
        '<div class="qc-actions">' +
          '<p class="qc-actions-label">Tindakan QC / Admin</p>' +
          '<div class="qc-actions-grid">' +
            '<button class="btn btn-success" onclick="SPB.detailQc.openModal(\'Approved\')"><i data-lucide="badge-check" class="icon-sm"></i>Approve Barang</button>' +
            '<button class="btn btn-danger" onclick="SPB.detailQc.openModal(\'Rejected\')"><i data-lucide="badge-x" class="icon-sm"></i>Reject Barang</button>' +
          '</div>' +
        '</div>';
    }

    app.innerHTML = ui.layout('dashboard',
      '<div class="detail-head">' +
        '<div class="detail-head-left">' +
          '<a href="#/" class="icon-btn" aria-label="Kembali"><i data-lucide="arrow-left" class="icon-md"></i></a>' +
          '<div><p class="detail-po">#' + esc(rec.po_number) + '</p>' +
          '<p class="detail-receiver">' +
            (waiting
              ? esc(rec.wh_in_ref || 'menunggu kedatangan')
              : 'oleh ' + esc(rec.receiver_name)) + '</p></div>' +
        '</div>' +
        '<div class="detail-head-right">' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.detailQc.openPrintPanel()">' +
            '<i data-lucide="printer" class="icon-sm"></i>Cetak Surat Jalan</button>' +
          (cancelledInOdoo
            ? '<span class="badge badge-odoo-cancel"><span class="badge-dot"></span>Dibatalkan di Odoo</span>'
            : closedInOdoo
            ? '<span class="badge badge-odoo-done"><span class="badge-dot"></span>Selesai di Odoo</span>'
            : ui.statusBadge(rec.status)) +
        '</div>' +
      '</div>' +
      '<div class="grid-detail">' +
        '<div class="detail-col">' + infoCard + itemsCard + '</div>' +
        '<div class="detail-col">' +
          '<div><h2 class="detail-card-title" style="margin-bottom:0.5rem"><i data-lucide="camera" class="icon-md" style="color:var(--brand-600)"></i>Bukti Foto</h2>' + photoBlock + '</div>' +
          qcBlock +
        '</div>' +
      '</div>'
    );
    ui.afterRender();
  }

  /* ---------- Modal QC ---------- */
  let modalState = null; // { action, notes, sending }

  function openModal(action) {
    modalState = { action: action, notes: '', sending: false };
    renderModal();
  }

  function closeModal() {
    modalState = null;
    const el = document.getElementById('qc-modal-root');
    if (el) el.remove();
  }

  function renderModal() {
    let root = document.getElementById('qc-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'qc-modal-root';
      document.body.appendChild(root);
    }
    const action = modalState.action;
    const ok = action === 'Approved';
    const title = 'Konfirmasi ' + (ok ? 'Approve' : 'Reject') + ' Barang';

    window.SPB.db.list().then(function (rows) {
      const rec = rows.find(function (r) { return r.id === window.SPB.currentDetailId; }) || {};

      root.innerHTML =
        '<div class="modal-backdrop">' +
          '<div class="modal slide-up" role="dialog" aria-modal="true" aria-label="' + title + '">' +
            '<p class="modal-title">' + title + '</p>' +
            '<p class="modal-sub">#' + esc(rec.po_number || '-') + ' · ' + esc(rec.vendor_name || '-') + '</p>' +
            '<label class="field-label" for="qc-notes">Catatan QC (opsional)</label>' +
            '<textarea id="qc-notes" class="textarea" rows="2" placeholder="cth: Barang sesuai PO, kualitas baik...">' + esc(modalState.notes) + '</textarea>' +
            '<div class="modal-actions">' +
              '<button class="btn btn-outline" onclick="SPB.detailQc.closeModal()" ' + (modalState.sending ? 'disabled' : '') + '>Batal</button>' +
              '<button class="btn ' + (ok ? 'btn-success' : 'btn-danger') + '" onclick="SPB.detailQc.confirmAction()" ' + (modalState.sending ? 'disabled' : '') + '>' +
                '<i data-lucide="' + (ok ? 'badge-check' : 'badge-x') + '" class="icon-sm"></i>' +
                (modalState.sending ? 'Menyimpan...' : action + ' Barang') +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      window.SPB.ui.afterRender();
      // Pasang event backdrop click
      root.querySelector('.modal-backdrop').addEventListener('click', function (e) {
        if (e.target === this && !modalState.sending) closeModal();
      });
    });
  }

  async function confirmAction() {
    const notesEl = document.getElementById('qc-notes');
    if (notesEl) modalState.notes = notesEl.value;
    const action = modalState.action;
    const ok = action === 'Approved';
    modalState.sending = true;
    renderModal();

    try {
      const id = window.SPB.currentDetailId;
      const rec = await window.SPB.db.updateStatus(id, action, modalState.notes || undefined);

      // Pencatatan status SUDAH berhasil di baris di atas — notifikasi Teamly
      // di bawah ini cuma langkah tambahan, jadi dibungkus try/catch SENDIRI
      // (bukan ikut try besar) supaya kegagalannya (mis. TEAMLY_WEBHOOK_URL
      // masih placeholder) tidak salah dilaporkan sebagai "Approve gagal"
      // padahal datanya sudah tersimpan. Sama seperti pola di markArrived().
      try {
        const trigger = ok ? 'review' : 'db'; // Approval -> @Code Reviewer ; Rejected -> @Backend Architect
        const payload = window.SPB.teamly.buildTeamlyPayload({
          status: action,
          record: Object.assign({}, rec, { notes: modalState.notes || rec.notes }),
          trigger: trigger,
          triggerReason: ok
            ? 'Approval ditandai untuk verifikasi akhir oleh Code Reviewer'
            : 'Barang ditolak — perlu penyesuaian stok & tindak lanjut vendor',
        });
        await window.SPB.teamly.sendTeamlyNotification(payload);
      } catch (e) { /* notifikasi gagal tidak boleh membatalkan pencatatan */ }

      modalState = null;
      closeModal();
      window.SPB.ui.toast('Status diperbarui', '#' + rec.po_number + ' → ' + action + '.', 'success');
      render(id);
    } catch (err) {
      modalState.sending = false;
      renderModal();
      window.SPB.ui.toast('Gagal memperbarui', err.message, 'error');
    }
  }

  window.SPB = window.SPB || {};
  window.SPB.detailQc = {
    render: render,
    markArrived: markArrived,
    printSuratJalan: printSuratJalan,
    openPrintPanel: openPrintPanel,
    closePrintPanel: closePrintPanel,
    confirmPrint: confirmPrint,
    setPrintPref: setPrintPref,
    uploadPhoto: uploadPhoto,
    openModal: openModal,
    closeModal: closeModal,
    confirmAction: confirmAction,
  };
})();