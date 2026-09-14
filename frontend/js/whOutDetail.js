/* =========================================================
   SPB · whOutDetail.js
   Detail 1 WH/OUT: info + konfirmasi kedatangan + Approve/Reject (pola sama
   dengan detailQc.js), DITAMBAH kartu Distribusi yang muncul setelah Approved
   — di sinilah "15 pulpen buat siapa aja & berapa" dicatat, per item.
   ========================================================= */

(function () {
  'use strict';

  let currentId = null;
  let qcModal = null;      // { action: 'Approved'|'Rejected', notes, sending }
  let distModal = null;    // { karyawan: [], newRows: [], sending }
  // Snapshot item & distribusi terbaru — dipakai addDraftRow() buat validasi
  // sisa qty tanpa nunggu round-trip fetch ulang tiap kali nambah 1 baris.
  let currentDetails = [];
  let currentDistribusi = [];
  let currentRec = null;
  let notSharing = false; // spinner tombol "Tidak Dibagi" saat diproses
  let shareModal = null;  // { divisi: '', options: [], loading: true, sending: false } — "Dipakai Bersama 1 Divisi"
  let currentStokBySku = {}; // snapshot Stok Barang terakhir, dipakai cek "habis" & tombol Ajukan PO
  let currentRestock = [];   // baris permintaan_restock (status 'Menunggu') buat WH/OUT ini
  let requestingRestock = false; // spinner tombol "Ajukan Pemesanan (PO)"
  let recheckingStock = false;   // spinner tombol "Cek Ulang Stok"

  // status distribusi: alasan kenapa barang ini dikasih ke orang itu.
  const DIST_STATUS_OPTIONS = ['Baru', 'Hilang', 'Tukar', 'Habis'];
  const DIST_STATUS_BADGE = { Baru: 'badge-approved', Hilang: 'badge-rejected', Tukar: 'badge-inspection', Habis: 'badge-draft' };
  function distStatusBadge(status) {
    const s = status || 'Baru';
    return '<span class="badge ' + (DIST_STATUS_BADGE[s] || 'badge-draft') + '" style="margin-left:0.375rem"><span class="badge-dot"></span>' + esc(s) + '</span>';
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

  /* ---------- Render halaman utama ---------- */
  function render(id) {
    currentId = id;
    const app = document.getElementById('app');
    // Tetap pakai layout() (sidebar & header tetap kelihatan) — sebelumnya
    // ini nge-replace SELURUH #app termasuk sidebar, sama bug yang udah
    // dibenerin di Stok Barang/Karyawan/Laporan tapi kelewat di sini.
    app.innerHTML = window.SPB.ui.layout('wh-out',
      '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>');
    window.SPB.ui.afterRender();

    return Promise.all([
      window.SPB.dbWhOut.get(id),
      window.SPB.dbDistribusi.listByPengeluaran(id),
      window.SPB.dbStokBarang.list().catch(function () { return []; }),
      window.SPB.dbRestock.listByPengeluaran(id).catch(function () { return []; }),
    ]).then(function (res) {
      const rec = res[0];
      const distribusi = res[1];
      const stok = res[2];
      currentStokBySku = {};
      stok.forEach(function (s) { currentStokBySku[s.sku] = s; });
      currentRestock = res[3];
      if (!rec) {
        app.innerHTML = window.SPB.ui.layout('wh-out',
          '<div class="empty-state">Data tidak ditemukan.<br>' +
          '<a href="#/wh-out" class="btn btn-outline btn-sm">Kembali</a></div>');
        window.SPB.ui.afterRender();
        return;
      }
      renderPage(rec, distribusi);
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal memuat', err.message, 'error');
    });
  }

  function distByDetail(distribusi, detailId) {
    return distribusi.filter(function (d) { return d.detail_id === detailId; });
  }

  /* Render ulang pakai data yang sudah ada di memori (currentRec/currentDetails/
     currentDistribusi) — TANPA fetch ulang ke server. Dipakai untuk buka/tutup
     modal, ubah state lokal (draft rows, tombol sending), dll — supaya tidak
     ada flash "Memuat..." tiap kali cuma buka popup. render(id) (fetch network)
     cuma dipanggil setelah ada perubahan NYATA di server. */
  function rerenderLocal() { renderPage(currentRec, currentDistribusi); }

  function renderPage(rec, distribusi) {
    const app = document.getElementById('app');
    const details = rec.items || [];
    currentDetails = details;
    currentDistribusi = distribusi;
    currentRec = rec;
    const waiting = rec.status === 'Draft' || rec.status === 'Menunggu Stok';
    const canDistribute = rec.status === 'Approved';

    const infoCard =
      '<div class="detail-card">' +
        '<h2 class="detail-card-title"><i data-lucide="info" class="icon-md"></i>Informasi Pengeluaran</h2>' +
        '<dl class="dl-grid">' +
          '<dt>Karyawan</dt><dd>' + esc(rec.employee_name) + '</dd>' +
          '<dt>Departemen</dt><dd>' + esc(rec.department) + '</dd>' +
          '<dt>Sub Divisi</dt><dd>' + esc(rec.sub_divisi) + '</dd>' +
          (rec.wh_out_ref ? '<dt>No WH/OUT</dt><dd>' + esc(rec.wh_out_ref) + '</dd>' : '') +
          '<dt>Petugas</dt><dd>' + (waiting ? '<span class="muted">belum diproses</span>' : esc(rec.receiver_name)) + '</dd>' +
          '<dt>Tgl Dibuat</dt><dd>' + fmtDateTime(rec.created_at) + '</dd>' +
          '<dt>Tgl Pemesanan</dt><dd>' + fmtDate(rec.order_date) + '</dd>' +
          '<dt>Tgl Diproses</dt><dd>' + (rec.arrival_date ? fmtDateTime(rec.arrival_date) : '<span class="muted">belum diproses</span>') + '</dd>' +
          '<dt>Status</dt><dd>' + window.SPB.ui.statusBadge(rec.status) + '</dd>' +
          '<dt>Catatan</dt><dd style="grid-column:1/-1;font-weight:500">' + esc(rec.notes || '-') + '</dd>' +
        '</dl>' +
      '</div>';

    const itemRows = details.map(function (d) {
      const qty = waiting ? d.qty_demand : d.qty_actual;
      const dist = distByDetail(distribusi, d.id);
      const distributed = dist.reduce(function (a, x) { return a + Number(x.qty); }, 0);
      const sisa = Number(qty || 0) - distributed;
      return '<tr>' +
        '<td style="font-weight:600;color:var(--slate-700)">' + esc(d.sku || '-') + '</td>' +
        '<td style="color:var(--slate-600)">' + esc(d.product_name || '-') + '</td>' +
        '<td style="font-weight:700">' + qty + ' <span style="font-weight:400;color:var(--slate-400)">' + esc(d.uom || '') + '</span></td>' +
        '<td>' + (canDistribute || distributed > 0
          ? '<span class="qty-cmp ' + (sisa === 0 ? 'ok' : sisa < 0 ? 'over' : 'short') + '">' +
            distributed + '/' + qty + (sisa > 0 ? ' · sisa ' + sisa : '') + '</span>'
          : '<span class="muted">-</span>') + '</td>' +
      '</tr>';
    }).join('');

    const itemsCard =
      '<div class="detail-card" style="padding:0;overflow:hidden">' +
        '<div class="detail-card-title" style="padding:0.875rem 1.25rem;border-bottom:1px solid var(--slate-100);margin-bottom:0">' +
          '<i data-lucide="package" class="icon-md"></i>Detail Item' +
          (waiting ? '<span class="card-title-note">qty sesuai permintaan Odoo</span>' : '') + '</div>' +
        '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>SKU</th><th>Nama</th><th>Qty</th><th>Distribusi</th></tr></thead>' +
          '<tbody>' + (itemRows || '<tr><td colspan="4" class="empty-state">Tidak ada item ATK di WH/OUT ini.</td></tr>') + '</tbody>' +
        '</table></div>' +
      '</div>';

    // Barang yang Qty Fisik-nya 0 di Stok Barang ("habis") — Approve diganti
    // tombol "Ajukan Pemesanan (PO)" (catatan internal, BUKAN nulis ke Odoo).
    const habisItems = details.filter(function (d) {
      const stok = currentStokBySku[d.sku];
      return !stok || Number(stok.qty_on_hand || 0) <= 0;
    });

    let qcBlock;
    if (rec.status === 'Menunggu Stok') {
      qcBlock =
        '<div class="qc-actions">' +
          '<div class="alert-banner alert-banner-danger" style="margin-bottom:0.875rem">' +
            '<i data-lucide="clock" class="icon-md"></i>' +
            '<div><strong>Menunggu Restock</strong><br>' +
            currentRestock.map(function (r) { return esc(r.product_name || r.sku) + ' (kurang ' + r.qty_diminta + ')'; }).join(', ') +
            ' — diajukan ' + fmtDateTime(currentRestock[0] ? currentRestock[0].created_at : rec.updated_at) + '.</div>' +
          '</div>' +
          '<p class="qc-actions-label">Begitu stoknya udah dipesan/masuk lagi (kelihatan di Stok Barang), klik cek ulang buat lanjut Approve.</p>' +
          '<div class="qc-actions-grid">' +
            '<button class="btn btn-primary" onclick="SPB.whOutDetail.recheckStock()" ' + (recheckingStock ? 'disabled' : '') + '>' +
              '<i data-lucide="refresh-cw" class="icon-sm"></i>' + (recheckingStock ? 'Mengecek...' : 'Cek Ulang Stok') + '</button>' +
            '<button class="btn btn-danger" onclick="SPB.whOutDetail.openQcModal(\'Rejected\')"><i data-lucide="badge-x" class="icon-sm"></i>Reject Barang</button>' +
          '</div>' +
        '</div>';
    } else if (waiting || rec.status === 'In Inspection') {
      qcBlock = habisItems.length
        ? '<div class="qc-actions">' +
            '<div class="alert-banner alert-banner-danger" style="margin-bottom:0.875rem">' +
              '<i data-lucide="alert-triangle" class="icon-md"></i>' +
              '<div><strong>Stok kurang/habis</strong> — ' +
              habisItems.map(function (d) { return esc(d.product_name || d.sku); }).join(', ') +
              ' nggak tersedia di Stok Barang. Approve nggak bisa dilanjutkan sebelum stoknya ada.</div>' +
            '</div>' +
            '<div class="qc-actions-grid">' +
              '<button class="btn btn-primary" onclick="SPB.whOutDetail.requestRestock()" ' + (requestingRestock ? 'disabled' : '') + '>' +
                '<i data-lucide="shopping-cart" class="icon-sm"></i>' + (requestingRestock ? 'Menyimpan...' : 'Ajukan Pemesanan (PO)') + '</button>' +
              '<button class="btn btn-danger" onclick="SPB.whOutDetail.openQcModal(\'Rejected\')"><i data-lucide="badge-x" class="icon-sm"></i>Reject Barang</button>' +
            '</div>' +
          '</div>'
        : '<div class="qc-actions">' +
            '<p class="qc-actions-label">Barang ini sudah tersedia di stok — Approve untuk lanjut ke distribusi, atau Reject kalau tidak sesuai.</p>' +
            '<div class="qc-actions-grid">' +
              '<button class="btn btn-success" onclick="SPB.whOutDetail.openQcModal(\'Approved\')"><i data-lucide="badge-check" class="icon-sm"></i>Approve Barang</button>' +
              '<button class="btn btn-danger" onclick="SPB.whOutDetail.openQcModal(\'Rejected\')"><i data-lucide="badge-x" class="icon-sm"></i>Reject Barang</button>' +
            '</div>' +
          '</div>';
    } else if (rec.status === 'Approved' || rec.status === 'Rejected') {
      const ok = rec.status === 'Approved';
      qcBlock =
        '<div class="qc-result ' + (ok ? 'approved' : 'rejected') + '">' +
          '<i data-lucide="' + (ok ? 'badge-check' : 'badge-x') + '" class="icon-lg"></i>' +
          '<div><p class="qc-result-title">Barang ' + rec.status + '</p>' +
          '<p class="qc-result-sub">Status pengeluaran telah diperbarui.</p></div>' +
        '</div>';
    }

    const distCard = canDistribute ? distributionCardHtml(details, distribusi) : '';

    app.innerHTML = window.SPB.ui.layout('wh-out',
      '<div class="detail-head">' +
        '<div class="detail-head-left">' +
          '<a href="#/wh-out" class="icon-btn" aria-label="Kembali"><i data-lucide="arrow-left" class="icon-md"></i></a>' +
          '<div><p class="detail-po">' + esc(rec.wh_out_ref) + '</p>' +
          '<p class="detail-receiver">' + (waiting ? 'menunggu kedatangan' : 'oleh ' + esc(rec.receiver_name)) + '</p></div>' +
        '</div>' +
        '<div class="detail-head-right">' + window.SPB.ui.statusBadge(rec.status) + '</div>' +
      '</div>' +
      '<div class="grid-detail">' +
        '<div class="detail-col">' + infoCard + itemsCard + distCard + '</div>' +
        '<div class="detail-col">' + qcBlock + '</div>' +
      '</div>' +
      (qcModal ? qcModalHtml(rec) : '') +
      (distModal ? distModalHtml(details, distribusi) : '') +
      (shareModal ? shareModalHtml() : '')
    );
    window.SPB.ui.afterRender();
  }

  /* ---------- Modal Approve/Reject ---------- */
  function openQcModal(action) {
    const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || '';
    qcModal = { action: action, notes: '', receiver: username, sending: false };
    rerenderLocal();
  }
  function closeQcModal() { qcModal = null; rerenderLocal(); }

  function qcModalHtml(rec) {
    const ok = qcModal.action === 'Approved';
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.whOutDetail.closeQcModal()">' +
      '<div class="modal slide-up" role="dialog" aria-modal="true">' +
        '<p class="modal-title">Konfirmasi ' + qcModal.action + ' Barang</p>' +
        '<p class="modal-sub">' + esc(rec.wh_out_ref) + ' · ' + esc(rec.employee_name) + '</p>' +
        '<label class="field-label" for="wo-qc-receiver">Nama Petugas *</label>' +
        '<input type="text" id="wo-qc-receiver" class="input" placeholder="cth: Budi Santoso" value="' + esc(qcModal.receiver) + '">' +
        '<label class="field-label" for="wo-qc-notes" style="margin-top:0.75rem;display:block">Catatan (opsional)</label>' +
        '<textarea id="wo-qc-notes" class="textarea" rows="2" placeholder="cth: Barang sesuai, kondisi baik...">' + esc(qcModal.notes) + '</textarea>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-outline" onclick="SPB.whOutDetail.closeQcModal()" ' + (qcModal.sending ? 'disabled' : '') + '>Batal</button>' +
          '<button class="btn ' + (ok ? 'btn-success' : 'btn-danger') + '" onclick="SPB.whOutDetail.confirmQc()" ' + (qcModal.sending ? 'disabled' : '') + '>' +
            (qcModal.sending ? 'Menyimpan...' : qcModal.action + ' Barang') +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  async function confirmQc() {
    const notesEl = document.getElementById('wo-qc-notes');
    const receiverEl = document.getElementById('wo-qc-receiver');
    if (notesEl) qcModal.notes = notesEl.value;
    if (receiverEl) qcModal.receiver = receiverEl.value;
    const receiver = (qcModal.receiver || '').trim();
    if (!receiver) {
      window.SPB.ui.toast('Petugas belum diisi', 'Isi nama petugas.', 'error');
      if (receiverEl) receiverEl.focus();
      return;
    }
    qcModal.sending = true;
    rerenderLocal();
    try {
      const rec = await window.SPB.dbWhOut.updateStatus(currentId, qcModal.action, qcModal.notes || undefined, receiver);
      qcModal = null;
      window.SPB.ui.toast('Status diperbarui', rec.wh_out_ref + ' → ' + rec.status + '.', 'success');
      if (rec.odoo_sync && !rec.odoo_sync.ok) {
        window.SPB.ui.toast('Belum tersinkron ke Odoo',
          rec.odoo_sync.message + ' Data di SPB tetap tersimpan — cek Odoo secara manual kalau perlu.', 'error');
      } else if (rec.odoo_sync && rec.odoo_sync.reserveWarning) {
        window.SPB.ui.toast('Barang belum kereservasi di Odoo',
          rec.odoo_sync.reserveWarning, 'error');
      }
      render(currentId);
    } catch (err) {
      qcModal.sending = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal memperbarui', err.message, 'error');
    }
  }

  /* ---------- Ajukan Pemesanan (PO) — catatan internal, BUKAN ke Odoo ---------- */
  async function requestRestock() {
    if (requestingRestock) return;
    const items = currentDetails
      .filter(function (d) {
        const stok = currentStokBySku[d.sku];
        return !stok || Number(stok.qty_on_hand || 0) <= 0;
      })
      .map(function (d) {
        return { detail_id: d.id, sku: d.sku, product_name: d.product_name, qty_diminta: Number(d.qty_demand || 0) };
      });
    if (!items.length) return;

    requestingRestock = true;
    rerenderLocal();
    try {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      await window.SPB.dbRestock.create(currentId, items, username);
      window.SPB.ui.toast('Diajukan', 'Permintaan restock dicatat — status WH/OUT ini jadi "Menunggu Stok".', 'success');
      requestingRestock = false;
      render(currentId);
    } catch (err) {
      requestingRestock = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal mengajukan', err.message, 'error');
    }
  }

  // "Cek Ulang Stok" — narik ulang Stok Barang, kalau SEMUA item WH/OUT ini
  // udah cukup lagi (Qty Fisik > 0), balikin status ke Draft & tandai
  // permintaan restock-nya selesai. Kalau masih ada yang kurang, kasih tau
  // apa aja yang masih belum cukup, status tetap "Menunggu Stok".
  async function recheckStock() {
    if (recheckingStock) return;
    recheckingStock = true;
    rerenderLocal();
    try {
      const stok = await window.SPB.dbStokBarang.list();
      const stokBySku = {};
      stok.forEach(function (s) { stokBySku[s.sku] = s; });
      const stillShort = currentDetails.filter(function (d) {
        const s = stokBySku[d.sku];
        return !s || Number(s.qty_on_hand || 0) <= 0;
      });
      if (stillShort.length) {
        window.SPB.ui.toast('Masih kurang', stillShort.map(function (d) { return d.product_name || d.sku; }).join(', ') + ' masih belum tersedia di Stok Barang.', 'error');
        recheckingStock = false;
        rerenderLocal();
        return;
      }
      await window.SPB.dbRestock.resolveAll(currentId);
      await window.SPB.dbWhOut.revertToDraft(currentId);
      window.SPB.ui.toast('Stok sudah cukup', 'WH/OUT ini balik ke Draft — silakan lanjut Approve.', 'success');
      recheckingStock = false;
      render(currentId);
    } catch (err) {
      recheckingStock = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal mengecek', err.message, 'error');
    }
  }

  /* ---------- Kartu Distribusi (setelah Approved) ---------- */
  // Total qty yang BELUM dicatat ke siapa pun, dijumlah dari semua item —
  // dipakai buat nentuin masih perlu ditawari "Tidak Dibagi"/"Bagikan" atau
  // enggak (kalau sudah 0, semua item sudah tuntas dicatat).
  function totalUndistributed(details, distribusi) {
    return details.reduce(function (a, d) {
      const distributed = distByDetail(distribusi, d.id).reduce(function (x, r) { return x + Number(r.qty); }, 0);
      return a + Math.max(0, Number(d.qty_actual || 0) - distributed);
    }, 0);
  }

  // Distribusi 1 barang dibagi ke beberapa orang sekaligus — kalau jumlahnya
  // timpang banget antar penerima (mis. 1pcs vs 4pcs), langsung kasih warning
  // di sini juga, bukan cuma nunggu ketahuan belakangan di Laporan.
  function qtyGapLevel(gap) {
    if (gap >= 5) return { label: 'Selisih Besar', badge: 'badge-rejected' };
    if (gap >= 2) return { label: 'Selisih Cukup Besar', badge: 'badge-inspection' };
    return null;
  }

  function distributionCardHtml(details, distribusi) {
    const rows = details.map(function (d) {
      const dist = distByDetail(distribusi, d.id);
      if (!dist.length) return '';
      const qtys = dist.map(function (x) { return Number(x.qty); });
      const maxQty = Math.max.apply(null, qtys);
      const minQty = Math.min.apply(null, qtys);
      const gap = maxQty - minQty;
      const gapLevel = dist.length > 1 ? qtyGapLevel(gap) : null;
      const warning = gapLevel
        ? '<div class="alert-banner alert-banner-danger" style="margin:0 0 0.625rem">' +
            '<i data-lucide="alert-triangle" class="icon-sm"></i>' +
            '<div>Pembagian ' + esc(d.product_name || d.sku) + ' tidak rata — selisih qty antar penerima ' + gap + ' ' + esc(d.uom || '') + ' (' + minQty + ' vs ' + maxQty + ').</div>' +
          '</div>'
        : '';
      return '<div class="dist-item-block">' +
        '<p class="dist-item-title">' + esc(d.product_name || d.sku) + '</p>' +
        warning +
        dist.map(function (x) {
          const rowFlag = gapLevel && (Number(x.qty) === maxQty || Number(x.qty) === minQty)
            ? '<span class="badge ' + gapLevel.badge + '" style="margin-left:0.375rem"><span class="badge-dot"></span>' + gapLevel.label + '</span>' : '';
          const nameHtml = x.is_shared
            ? '<i data-lucide="building-2" class="icon-sm" style="vertical-align:-2px;margin-right:0.25rem"></i>Dipakai Bersama Divisi'
            : esc(x.karyawan_name);
          return '<div class="dist-row"><span>' + nameHtml +
            (x.department ? ' <span class="muted">· ' + esc(x.department) + '</span>' : '') +
            distStatusBadge(x.status) + rowFlag + '</span>' +
            '<span class="dist-row-qty">' + x.qty + ' ' + esc(d.uom || '') +
            '<button type="button" class="dist-row-del" onclick="SPB.whOutDetail.removeDistRow(\'' + x.id + '\')" aria-label="Hapus"><i data-lucide="x" class="icon-sm"></i></button></span></div>';
        }).join('') +
      '</div>';
    }).join('');

    const sisa = totalUndistributed(details, distribusi);
    // Belum ada keputusan sharing/tidak sama sekali -> tawarkan dua pilihan
    // sekaligus. Sudah ada sebagian tercatat (mis. baru sebagian dibagikan) ->
    // cukup tombol "Bagikan" buat lanjutin sisanya, "Tidak Dibagi" nggak masuk
    // akal lagi di titik itu.
    // 3 pilihan begitu belum ada keputusan sama sekali: "1 orang" (Tidak
    // Dibagi — buat penerima WH/OUT itu sendiri), "Dibagi ke beberapa orang"
    // (buka modal Distribusi), atau "Dipakai Bersama 1 Divisi" (bukan milik
    // 1 orang tertentu, mis. lem/isolasi dipakai rame-rame). Sudah ada
    // sebagian tercatat -> cukup tombol "Bagikan" buat lanjutin sisanya.
    const actions = sisa <= 0 ? '' :
      (!distribusi.length
        ? '<div class="dist-decision">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.whOutDetail.markNotShared()" ' + (notSharing ? 'disabled' : '') + '>' +
            '<i data-lucide="user-check" class="icon-sm"></i>' + (notSharing ? 'Menyimpan...' : 'Tidak Dibagi — untuk ' + esc(currentRec.employee_name)) + '</button>' +
          '<button type="button" class="btn btn-primary" onclick="SPB.whOutDetail.openDistModal()">' +
            '<i data-lucide="share-2" class="icon-sm"></i>Bagikan ke Beberapa Karyawan</button>' +
          '<button type="button" class="btn btn-outline" onclick="SPB.whOutDetail.openShareModal()">' +
            '<i data-lucide="building-2" class="icon-sm"></i>Dipakai Bersama 1 Divisi</button>' +
        '</div>'
        : '<button type="button" class="btn btn-primary" style="margin-top:0.875rem;width:100%" onclick="SPB.whOutDetail.openDistModal()">' +
          '<i data-lucide="share-2" class="icon-sm"></i>Lanjutkan Bagikan Sisa (' + sisa + ')</button>');

    return '<div class="detail-card">' +
      '<h2 class="detail-card-title"><i data-lucide="users" class="icon-md"></i>Distribusi ke Karyawan</h2>' +
      '<p class="card-title-note" style="margin:-0.5rem 0 0.75rem">Barang ini diambil oleh <b>' + esc(currentRec.employee_name) + '</b> — tentukan dibagi ke orang lain atau tidak.</p>' +
      (rows || '<p class="muted" style="font-size:0.875rem">Belum ada distribusi dicatat.</p>') +
      actions +
    '</div>';
  }

  function divisiOf(k) { return ((k.department || '').split(' / ')[0] || '').trim(); }

  function shareModalHtml() {
    if (!shareModal) return '';
    const options = shareModal.options || [];
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.whOutDetail.closeShareModal()">' +
      '<div class="modal slide-up" role="dialog" aria-modal="true">' +
        '<p class="modal-title">Dipakai Bersama 1 Divisi</p>' +
        '<p class="modal-sub">Bukan buat 1 orang tertentu — barang ini dipakai rame-rame sama 1 Divisi (mis. lem, isolasi).</p>' +
        (shareModal.loading
          ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat divisi...</div>'
          : '<select class="select-input" style="width:100%;margin-top:0.75rem" onchange="SPB.whOutDetail.setShareDivisi(this.value)">' +
              '<option value="">-- Pilih Divisi --</option>' +
              options.map(function (v) { return '<option value="' + esc(v) + '"' + (shareModal.divisi === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
            '</select>') +
        '<div class="modal-actions">' +
          '<button class="btn btn-outline" onclick="SPB.whOutDetail.closeShareModal()" ' + (shareModal.sending ? 'disabled' : '') + '>Batal</button>' +
          '<button class="btn btn-primary" onclick="SPB.whOutDetail.confirmShareDivisi()" ' +
            (shareModal.sending || shareModal.loading || !shareModal.divisi ? 'disabled' : '') + '>' +
            (shareModal.sending ? 'Menyimpan...' : 'Simpan') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function openShareModal() {
    shareModal = { divisi: '', options: [], loading: true, sending: false };
    rerenderLocal();
    window.SPB.dbKaryawan.list().then(function (list) {
      if (!shareModal) return; // ditutup sebelum data selesai dimuat
      const set = {};
      list.forEach(function (k) { const v = divisiOf(k); if (v) set[v] = true; });
      // Divisi si penerima WH/OUT sendiri (kalau ada) didahulukan biar cepet
      // dipilih — kasus paling umum: barang dipakai bareng divisi sendiri.
      const own = ((currentRec && currentRec.department) || '').split(' / ')[0].trim();
      shareModal.options = Object.keys(set).sort();
      shareModal.loading = false;
      if (own && set[own]) shareModal.divisi = own;
      rerenderLocal();
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal memuat divisi', err.message, 'error');
      closeShareModal();
    });
  }
  function closeShareModal() { shareModal = null; rerenderLocal(); }
  function setShareDivisi(v) { if (shareModal) { shareModal.divisi = v; rerenderLocal(); } }

  async function confirmShareDivisi() {
    if (!shareModal || shareModal.sending || !shareModal.divisi) return;
    const divisi = shareModal.divisi;
    const sisaRows = currentDetails
      .map(function (d) {
        const distributed = distByDetail(currentDistribusi, d.id).reduce(function (a, r) { return a + Number(r.qty); }, 0);
        const sisa = Number(d.qty_actual || 0) - distributed;
        return sisa > 0 ? { detail_id: d.id, karyawan_name: 'Dipakai Bersama Divisi', department: divisi, qty: sisa, is_shared: true } : null;
      })
      .filter(Boolean);
    if (!sisaRows.length) { closeShareModal(); return; }

    shareModal.sending = true;
    rerenderLocal();
    try {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      await window.SPB.dbDistribusi.addBatch(currentId, sisaRows, username);
      window.SPB.ui.toast('Dicatat', 'Barang dicatat dipakai bersama Divisi ' + divisi + '.', 'success');
      shareModal = null;
      render(currentId).then(syncOdooIfFullyDistributed);
    } catch (err) {
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
      shareModal.sending = false;
      rerenderLocal();
    }
  }

  async function markNotShared() {
    if (notSharing) return;
    const sisaRows = currentDetails
      .map(function (d) {
        const distributed = distByDetail(currentDistribusi, d.id).reduce(function (a, r) { return a + Number(r.qty); }, 0);
        const sisa = Number(d.qty_actual || 0) - distributed;
        return sisa > 0 ? { detail_id: d.id, karyawan_name: currentRec.employee_name, department: currentRec.department, qty: sisa } : null;
      })
      .filter(Boolean);
    if (!sisaRows.length) return;

    notSharing = true;
    rerenderLocal();
    try {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      await window.SPB.dbDistribusi.addBatch(currentId, sisaRows, username);
      window.SPB.ui.toast('Dicatat', 'Semua barang dicatat untuk ' + currentRec.employee_name + '.', 'success');
      notSharing = false;
      render(currentId).then(syncOdooIfFullyDistributed);
    } catch (err) {
      notSharing = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
    }
  }

  /* Baru validate ke Odoo (potong stok beneran) setelah SEMUA qty di WH/OUT
     ini tuntas ditentukan mau untuk siapa saja — bukan pas barang datang.
     Dipanggil setelah render(currentId) supaya currentDetails/currentDistribusi
     sudah data terbaru dari server. */
  function syncOdooIfFullyDistributed() {
    if (totalUndistributed(currentDetails, currentDistribusi) > 0) return;
    window.SPB.dbWhOut.syncToOdoo(currentId).then(function (result) {
      if (!result.ok) {
        window.SPB.ui.toast('Belum tersinkron ke Odoo',
          result.message + ' Data di SPB tetap tersimpan — cek Odoo secara manual kalau perlu.', 'error');
      }
    });
  }

  async function removeDistRow(id) {
    try {
      await window.SPB.dbDistribusi.remove(id);
      window.SPB.ui.toast('Baris dihapus', '', 'success');
      // Ambil ulang data terbaru diam-diam (TANPA app.innerHTML di-blank kayak
      // render() biasa) — begitu datang langsung renderPage() pakai data baru,
      // jadi tidak ada flash "Memuat..." cuma buat hapus 1 baris distribusi.
      const [rec, distribusi] = await Promise.all([
        window.SPB.dbWhOut.get(currentId),
        window.SPB.dbDistribusi.listByPengeluaran(currentId),
      ]);
      if (rec) renderPage(rec, distribusi);
    } catch (err) {
      window.SPB.ui.toast('Gagal menghapus', err.message, 'error');
    }
  }

  /* ---------- Modal Distribusi ---------- */
  function openDistModal() {
    distModal = { karyawan: [], newRows: [], sending: false, loading: true };
    rerenderLocal();
    window.SPB.dbKaryawan.list().then(function (list) {
      if (!distModal) return; // ditutup sebelum data selesai dimuat
      distModal.karyawan = list;
      distModal.loading = false;
      rerenderLocal();
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal memuat karyawan', err.message, 'error');
      distModal.loading = false;
      rerenderLocal();
    });
  }
  function closeDistModal() { distModal = null; rerenderLocal(); }

  function sisaForDetail(detail, distribusi) {
    const already = distByDetail(distribusi, detail.id).reduce(function (a, x) { return a + Number(x.qty); }, 0);
    const draftQty = distModal.newRows
      .filter(function (r) { return r.detail_id === detail.id; })
      .reduce(function (a, r) { return a + Number(r.qty); }, 0);
    return Number(detail.qty_actual || 0) - already - draftQty;
  }

  function distModalHtml(details, distribusi) {
    const karyawanOptions = distModal.karyawan.map(function (k) {
      return '<option value="' + esc(k.name) + '" data-dept="' + esc(k.department || '') + '">';
    }).join('');

    const itemBlocks = details.map(function (d) {
      const sisa = sisaForDetail(d, distribusi);
      const draftRows = distModal.newRows
        .map(function (r, i) { return { r: r, i: i }; })
        .filter(function (x) { return x.r.detail_id === d.id; });

      return '<div class="dist-form-block">' +
        '<p class="dist-item-title">' + esc(d.product_name || d.sku) +
          ' <span class="dist-sisa ' + (sisa === 0 ? 'ok' : 'warn') + '">sisa ' + sisa + ' ' + esc(d.uom || '') + '</span></p>' +
        draftRows.map(function (x) {
          return '<div class="dist-row"><span>' + esc(x.r.karyawan_name) + distStatusBadge(x.r.status) + '</span>' +
            '<span class="dist-row-qty">' + x.r.qty +
            '<button type="button" class="dist-row-del" onclick="SPB.whOutDetail.removeDraftRow(' + x.i + ')" aria-label="Hapus"><i data-lucide="x" class="icon-sm"></i></button></span></div>';
        }).join('') +
        (sisa > 0 ? '<div class="dist-add-row">' +
          '<input type="text" class="input" list="wo-karyawan-list" placeholder="Cari nama karyawan..." id="dist-name-' + d.id + '">' +
          '<input type="number" class="input dist-qty-input" min="1" max="' + sisa + '" value="' + sisa + '" id="dist-qty-' + d.id + '">' +
          '<select class="select-input" id="dist-status-' + d.id + '">' +
            '<option value="" disabled selected>-- Pilih Status --</option>' +
            DIST_STATUS_OPTIONS.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') +
          '</select>' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.whOutDetail.addDraftRow(\'' + d.id + '\')">' +
            '<i data-lucide="plus" class="icon-sm"></i>Tambah</button>' +
        '</div>' : '') +
      '</div>';
    }).join('');

    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.whOutDetail.closeDistModal()">' +
      '<div class="modal slide-up modal-lg" role="dialog" aria-modal="true">' +
        '<p class="modal-title">Distribusi ke Karyawan</p>' +
        '<p class="modal-sub">Tentukan barang ini untuk siapa saja &amp; berapa jumlahnya per orang.</p>' +
        '<datalist id="wo-karyawan-list">' + karyawanOptions + '</datalist>' +
        (distModal.loading
          ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat karyawan...</div>'
          : itemBlocks || '<p class="muted">Tidak ada item.</p>') +
        '<div class="modal-actions">' +
          '<button class="btn btn-outline" onclick="SPB.whOutDetail.closeDistModal()" ' + (distModal.sending ? 'disabled' : '') + '>Batal</button>' +
          '<button class="btn btn-primary" onclick="SPB.whOutDetail.submitDistribution()" ' +
            (distModal.sending || !distModal.newRows.length ? 'disabled' : '') + '>' +
            (distModal.sending ? 'Menyimpan...' : 'Simpan Distribusi (' + distModal.newRows.length + ')') +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function addDraftRow(detailId) {
    const nameEl = document.getElementById('dist-name-' + detailId);
    const qtyEl = document.getElementById('dist-qty-' + detailId);
    const statusEl = document.getElementById('dist-status-' + detailId);
    const name = (nameEl && nameEl.value || '').trim();
    const qty = Number(qtyEl && qtyEl.value || 0);
    const status = (statusEl && statusEl.value) || '';
    if (!name) { window.SPB.ui.toast('Nama belum diisi', 'Pilih/ketik nama karyawan.', 'error'); return; }
    if (!qty || qty <= 0) { window.SPB.ui.toast('Qty tidak valid', 'Isi jumlah lebih dari 0.', 'error'); return; }
    if (!status) { window.SPB.ui.toast('Status belum dipilih', 'Pilih status: Baru, Hilang, Tukar, atau Habis.', 'error'); return; }

    const detail = currentDetails.find(function (d) { return d.id === detailId; });
    const sisa = detail ? sisaForDetail(detail, currentDistribusi) : qty;
    if (qty > sisa) { window.SPB.ui.toast('Qty melebihi sisa', 'Sisa yang belum didistribusikan cuma ' + sisa + '.', 'error'); return; }

    const match = distModal.karyawan.find(function (k) { return k.name.toLowerCase() === name.toLowerCase(); });
    distModal.newRows.push({
      detail_id: detailId,
      karyawan_id: match ? match.id : null,
      karyawan_name: name,
      department: match ? match.department : null,
      qty: qty,
      status: status,
    });
    rerenderLocal();
  }
  function removeDraftRow(index) { distModal.newRows.splice(index, 1); rerenderLocal(); }

  async function submitDistribution() {
    if (!distModal.newRows.length) return;
    distModal.sending = true;
    rerenderLocal();
    try {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      await window.SPB.dbDistribusi.addBatch(currentId, distModal.newRows, username);
      window.SPB.ui.toast('Distribusi tersimpan', distModal.newRows.length + ' baris dicatat.', 'success');
      distModal = null;
      render(currentId).then(syncOdooIfFullyDistributed);
    } catch (err) {
      distModal.sending = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
    }
  }

  window.SPB = window.SPB || {};
  window.SPB.whOutDetail = {
    render: render,
    openQcModal: openQcModal,
    closeQcModal: closeQcModal,
    confirmQc: confirmQc,
    openDistModal: openDistModal,
    closeDistModal: closeDistModal,
    markNotShared: markNotShared,
    addDraftRow: addDraftRow,
    removeDraftRow: removeDraftRow,
    removeDistRow: removeDistRow,
    submitDistribution: submitDistribution,
    openShareModal: openShareModal,
    closeShareModal: closeShareModal,
    setShareDivisi: setShareDivisi,
    confirmShareDivisi: confirmShareDivisi,
    requestRestock: requestRestock,
    recheckStock: recheckStock,
  };
})();
