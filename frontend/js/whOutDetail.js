/* =========================================================
   SPB · whOutDetail.js
   Detail 1 WH/OUT: info + konfirmasi kedatangan + Approve/Reject (pola sama
   dengan detailQc.js), DITAMBAH kartu Distribusi yang muncul setelah Approved
   — di sinilah "15 pulpen buat siapa aja & berapa" dicatat, per item.
   ========================================================= */

(function () {
  'use strict';

  // Status 'Rejected' di DB (nilai enum lama, dipakai bareng WH/IN yang
  // makna aslinya beda) — di WH/OUT ini makna sebenarnya "Cancel", jadi
  // labelnya ditampilkan "Cancelled" di sini TANPA ngubah statusBadge()
  // global (app.js), biar WH/IN nggak ikut kena.
  function statusBadgeWhOut(status) {
    if (status === 'Rejected') return '<span class="badge badge-rejected"><span class="badge-dot"></span>Cancelled</span>';
    return window.SPB.ui.statusBadge(status);
  }

  let currentId = null;
  let qcModal = null;      // { action: 'Approved'|'Rejected', notes, sending }
  // { loading, vendors: [{id,name}], vendorName, items: [{sku,product_name,uom,qty}], sending }
  let poModal = null;
  let currentDetails = [];
  let currentRec = null;
  let currentPesananOrigin = null; // pesanan asal (portal) — sumber baca-aja "Distribusi ke Karyawan"
  let currentKaryawanByName = {}; // lookup nama (lowercase) -> data karyawan, buat divisi/sub divisi PENERIMA distribusi
  // Draft edit distribusi (admin koreksi punya operator) — null kalau lagi
  // nggak diedit. { [pesananItemId]: [{rowId, nama, qty, kondisi}, ...] }
  let distDraft = null;
  let distDraftSaving = false;
  let distRowSeq = 0;
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

    // dbWhOut.get(id) duluan (butuh daftar SKU-nya) — BARU abis itu stok
    // di-cek pakai listBySku() (cuma SKU yang dipakai WH/OUT ini, BUKAN
    // dbStokBarang.list() yang narik SELURUH katalog/ribuan baris cuma
    // buat cek habis/enggak beberapa item — itu yang bikin halaman ini
    // kerasa lama banget kebuka).
    return window.SPB.dbWhOut.get(id).then(function (rec) {
      if (!rec) {
        app.innerHTML = window.SPB.ui.layout('wh-out',
          '<div class="empty-state">Data tidak ditemukan.<br>' +
          '<a href="#/wh-out" class="btn btn-outline btn-sm">Kembali</a></div>');
        window.SPB.ui.afterRender();
        return;
      }
      const skus = (rec.items || []).map(function (d) { return d.sku; });
      return Promise.all([
        window.SPB.dbStokBarang.listBySku(skus).catch(function () { return []; }),
        window.SPB.dbRestock.listByPengeluaran(id).catch(function () { return []; }),
        window.SPB.dbKaryawan.list().catch(function () { return []; }),
      ]).then(function (res) {
        const stok = res[0];
        currentStokBySku = {};
        stok.forEach(function (s) { currentStokBySku[s.sku] = s; });
        currentRestock = res[1];
        // Buat tabel Distribusi ke Karyawan (distributionCardHtml) — divisi/
        // sub divisi PENERIMA (bukan pemesan) ditampilkan dari data karyawan
        // aslinya, kalau namanya ketemu di master (nama distribusi diketik
        // bebas sama operator pas pesan, jadi dicocokkan lowercase-trim).
        currentKaryawanByName = {};
        (res[2] || []).forEach(function (k) { currentKaryawanByName[(k.name || '').trim().toLowerCase()] = k; });
        // "Distribusi ke Karyawan" nggak diisi manual sama petugas gudang lagi
        // di sini — cukup dibaca READ-ONLY dari pesanan asalnya (kalau WH/OUT
        // ini dibuat otomatis dari portal pemesanan SPB, lihat pesananClient.js
        // getByWhOutRef & pesan.js fitur Distribusi di keranjang). Kalau nggak
        // ketemu (WH/OUT lama / manual dari Odoo langsung), tampil kosong.
        return window.SPB.dbPesanan.getByWhOutRef(rec.wh_out_ref).catch(function () { return null; })
          .then(function (pesananOrigin) { renderPage(rec, pesananOrigin); });
      });
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal memuat', err.message, 'error');
    });
  }

  /* Render ulang pakai data yang sudah ada di memori (currentRec/currentDetails/
     currentPesananOrigin) — TANPA fetch ulang ke server. Dipakai untuk buka/tutup
     modal, ubah state lokal (tombol sending), dll — supaya tidak ada flash
     "Memuat..." tiap kali cuma buka popup. render(id) (fetch network) cuma
     dipanggil setelah ada perubahan NYATA di server. */
  function rerenderLocal() { renderPage(currentRec, currentPesananOrigin); }

  function renderPage(rec, pesananOrigin) {
    const app = document.getElementById('app');
    const details = rec.items || [];
    currentDetails = details;
    currentPesananOrigin = pesananOrigin;
    currentRec = rec;
    const waiting = rec.status === 'Draft' || rec.status === 'Menunggu Stok';

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
          '<dt>Status</dt><dd>' + statusBadgeWhOut(rec.status) + '</dd>' +
          '<dt>Catatan</dt><dd style="grid-column:1/-1;font-weight:500">' + esc(rec.notes || '-') + '</dd>' +
        '</dl>' +
      '</div>';

    const itemRows = details.map(function (d) {
      const qty = waiting ? d.qty_demand : d.qty_actual;
      const dist = distForSku(d.sku);
      const distributed = dist.reduce(function (a, x) { return a + Number(x.qty); }, 0);
      const sisa = Number(qty || 0) - distributed;
      return '<tr>' +
        '<td style="font-weight:600;color:var(--slate-700)">' + esc(d.sku || '-') + '</td>' +
        '<td style="color:var(--slate-600)">' + esc(d.product_name || '-') + '</td>' +
        '<td style="font-weight:700">' + qty + ' <span style="font-weight:400;color:var(--slate-400)">' + esc(d.uom || '') + '</span></td>' +
        '<td>' + (dist.length
          ? '<span class="qty-cmp ' + (sisa === 0 ? 'ok' : sisa < 0 ? 'over' : 'short') + '">' +
            distributed + '/' + qty + (sisa > 0 ? ' · sisa ' + sisa : '') + '</span>'
          : '<span class="muted">-</span>') + '</td>' +
      '</tr>';
    }).join('');

    // Barang yang stoknya HABIS TOTAL *atau* CUMA KURANG (diminta lebih
    // banyak dari yang tersedia di Stok Barang, mis. minta 20 tapi cuma ada
    // 8) — dua-duanya diperlakukan sama: Approve diganti tombol "Ajukan
    // Pemesanan (PO)" (catatan internal, BUKAN nulis ke Odoo — belum ada
    // fitur PO beneran, cuma nandain "perlu di-PO-kan" biar petugas gudang
    // tau harus tindak lanjut, bukan diam-diam di-Approve padahal kurang).
    const habisItems = details.filter(function (d) {
      const stok = currentStokBySku[d.sku];
      // Dibandingin ke qty_on_hand (fisik total), BUKAN qty_available
      // (fisik dikurangi Direservasi) — soalnya Direservasi buat WH/OUT ini
      // SENDIRI udah otomatis kejadian pas pesanan masuk (lihat
      // odoo-create-wh-out), jadi kalau dipakai qty_available di sini bakal
      // ke-double-count: kekurangannya keitung dari demand DIKURANGI stok
      // yang sebenarnya udah "dijatah" buat pesanan ini sendiri, bukan
      // beneran kekurangan fisik. Kalau ada 15 fisik & yang diminta 20,
      // kurangnya 5 (20-15), BUKAN 20 (kalau qty_available-nya kebetulan 0
      // karena semua 15-nya udah kereservasi buat WH/OUT ini).
      const avail = stok ? Number(stok.qty_on_hand || 0) : 0;
      const demand = Number(d.qty_demand || d.qty_actual || 0);
      return !stok || avail <= 0 || avail < demand;
    });

    // Aksi/status utama WH/OUT ini — nempel kecil di pojok kanan atas kartu
    // Detail Item (bukan box gede terpisah di bawah kayak dulu): badge
    // Approved/Rejected pas udah selesai, atau tombol kecil pas masih perlu
    // ditindaklanjuti (Cek Ulang Stok / Ajukan PO / Approve).
    let itemsCardAction = '';
    let qcBlock = '';
    if (rec.status === 'Menunggu Stok') {
      itemsCardAction = '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.whOutDetail.recheckStock()" ' + (recheckingStock ? 'disabled' : '') + '>' +
        '<i data-lucide="refresh-cw" class="icon-sm"></i>' + (recheckingStock ? 'Mengecek...' : 'Cek Ulang Stok') + '</button>';
      qcBlock =
        '<div class="qc-actions">' +
          '<div class="alert-banner alert-banner-danger" style="margin-bottom:0">' +
            '<i data-lucide="clock" class="icon-md"></i>' +
            '<div><strong>Menunggu Restock</strong><br>' +
            currentRestock.map(function (r) { return esc(r.product_name || r.sku) + ' (kurang ' + r.qty_diminta + ')'; }).join(', ') +
            ' — diajukan ' + fmtDateTime(currentRestock[0] ? currentRestock[0].created_at : rec.updated_at) + '.</div>' +
          '</div>' +
          '<p class="qc-actions-label">Begitu stoknya udah dipesan/masuk lagi (kelihatan di Stok Barang), klik "Cek Ulang Stok" di pojok Detail Item buat lanjut Approve.</p>' +
        '</div>';
    } else if (waiting || rec.status === 'In Inspection') {
      if (habisItems.length) {
        itemsCardAction = '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.whOutDetail.openPOModal()">' +
          '<i data-lucide="shopping-cart" class="icon-sm"></i>Ajukan Pemesanan (PO)</button>';
        qcBlock =
          '<div class="qc-actions">' +
            '<div class="alert-banner alert-banner-danger" style="margin-bottom:0">' +
              '<i data-lucide="alert-triangle" class="icon-md"></i>' +
              '<div><strong>Stok kurang/habis</strong> — ' +
              habisItems.map(function (d) {
                const stok = currentStokBySku[d.sku];
                const avail = Math.max(0, stok ? Number(stok.qty_on_hand || 0) : 0);
                const demand = Number(d.qty_demand || d.qty_actual || 0);
                const kurang = Math.max(0, demand - avail);
                return esc(d.product_name || d.sku) + ' (diminta ' + demand + ', ada stok ' + avail + ', kurang ' + kurang + ')';
              }).join(', ') +
              ' — perlu di-PO-kan dulu sebelum bisa Approve. Approve nggak bisa dilanjutkan sebelum stoknya cukup.</div>' +
            '</div>' +
          '</div>';
      } else {
        // Reservasi sekarang otomatis kejadian begitu pesanan masuk dari
        // portal (lihat odoo-create-wh-out) — nggak perlu tombol manual lagi
        // di sini, Approve tinggal potong stok beneran.
        //
        // "Cancel" (status Rejected di DB, TETAP label "Cancel" di UI) — buat
        // ngebatalin WH/OUT yang nggak jadi diproses, SEKALIAN ngelepas
        // reservasinya di Odoo (action_cancel) biar Qty Fisik-nya balik
        // "bebas" lagi (nggak nyangkut ke-reserve selamanya cuma karena
        // nggak pernah di-Approve — lihat callOdooValidate 'cancel' di
        // whOutClient.js).
        itemsCardAction =
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.whOutDetail.openQcModal(\'Rejected\')" style="margin-right:0.5rem">' +
            '<i data-lucide="x-circle" class="icon-sm"></i>Cancel</button>' +
          '<button type="button" class="btn btn-success btn-sm" onclick="SPB.whOutDetail.openQcModal(\'Approved\')">' +
            '<i data-lucide="badge-check" class="icon-sm"></i>Approve Barang</button>';
      }
    } else if (rec.status === 'Approved' || rec.status === 'Rejected') {
      itemsCardAction = statusBadgeWhOut(rec.status);
    }

    const itemsCard =
      '<div class="detail-card" style="padding:0;overflow:hidden;height:100%;display:flex;flex-direction:column">' +
        '<div class="detail-card-title" style="padding:0.875rem 1.25rem;border-bottom:1px solid var(--slate-100);margin-bottom:0;justify-content:space-between;gap:0.75rem">' +
          '<span style="display:flex;align-items:center;gap:0.5rem;min-width:0">' +
            '<i data-lucide="package" class="icon-md"></i>' +
            '<span>Detail Item</span>' +
            (waiting ? '<span class="card-title-note" style="margin-left:0">qty sesuai permintaan Odoo</span>' : '') +
          '</span>' +
          '<span style="flex:none">' + itemsCardAction + '</span>' +
        '</div>' +
        '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>SKU</th><th>Nama</th><th>Qty</th><th>Distribusi</th></tr></thead>' +
          '<tbody>' + (itemRows || '<tr><td colspan="4" class="empty-state">Tidak ada item ATK di WH/OUT ini.</td></tr>') + '</tbody>' +
        '</table></div>' +
      '</div>';

    // Dulu cuma muncul abis status Approved (waktu itu petugas gudang yang
    // isi manual di sini, jadi nunggu approve dulu baru masuk akal ditampilin).
    // Sekarang datanya udah ada DUAN dari operator pesan di portal — jadi
    // tampilkan selalu, walaupun WH/OUT-nya masih Draft/belum di-approve.
    const distCard = distributionCardHtml();

    // Satu kolom aja (bukan 2-kolom kayak dulu) — tombol Approve sekarang
    // ditaruh DI BAWAH kartu-kartu info, bukan di kolom sebelah.
    app.innerHTML = window.SPB.ui.layout('wh-out',
      '<div class="detail-head">' +
        '<div class="detail-head-left">' +
          '<a href="#/wh-out" class="icon-btn" aria-label="Kembali"><i data-lucide="arrow-left" class="icon-md"></i></a>' +
          '<div><p class="detail-po">' + esc(rec.wh_out_ref) + '</p>' +
          '<p class="detail-receiver">' + (waiting ? 'menunggu kedatangan' : 'oleh ' + esc(rec.receiver_name)) + '</p></div>' +
        '</div>' +
        '<div class="detail-head-right" style="display:flex;align-items:center;gap:0.625rem">' +
          // Tombol print manual — buat coba-coba lihat preview cetaknya
          // kapan aja (nggak harus nunggu Approve beneran), lihat printNow().
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.whOutDetail.printNow()"><i data-lucide="printer" class="icon-sm"></i>Print</button>' +
          statusBadgeWhOut(rec.status) +
        '</div>' +
      '</div>' +
      '<div class="grid-detail">' +
        '<div class="detail-col">' + infoCard + '</div>' +
        '<div class="detail-col">' + itemsCard + '</div>' +
      '</div>' +
      (distCard ? '<div style="margin-top:1rem">' + distCard + '</div>' : '') +
      (qcBlock ? '<div style="margin-top:1rem">' + qcBlock + '</div>' : '') +
      (qcModal ? qcModalHtml(rec) : '') +
      (poModal ? poModalHtml() : '')
    );
    window.SPB.ui.afterRender();
    updatePrintArea(rec, details);
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
    // Label UI "Cancel" — status yang tersimpan di DB tetap 'Rejected' (nilai
    // enum yang udah ada), cuma teksnya diganti biar nggak kebaca aneh
    // ("Konfirmasi Rejected Barang").
    const actionLabel = ok ? 'Approve' : 'Cancel';
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.whOutDetail.closeQcModal()">' +
      '<div class="modal slide-up" role="dialog" aria-modal="true">' +
        '<p class="modal-title">Konfirmasi ' + actionLabel + ' Barang</p>' +
        '<p class="modal-sub">' + esc(rec.wh_out_ref) + ' · ' + esc(rec.employee_name) + '</p>' +
        (ok ? '' : '<p class="qc-actions-label" style="margin:-0.25rem 0 0.75rem">WH/OUT ini akan dibatalkan — reservasi stoknya di Odoo ikut dilepas (balik jadi Qty Fisik yang bebas lagi).</p>') +
        '<label class="field-label" for="wo-qc-receiver">Nama Petugas *</label>' +
        '<input type="text" id="wo-qc-receiver" class="input" placeholder="cth: Budi Santoso" value="' + esc(qcModal.receiver) + '">' +
        '<label class="field-label" for="wo-qc-notes" style="margin-top:0.75rem;display:block">Catatan (opsional)</label>' +
        '<textarea id="wo-qc-notes" class="textarea" rows="2" placeholder="cth: Barang sesuai, kondisi baik...">' + esc(qcModal.notes) + '</textarea>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-outline" onclick="SPB.whOutDetail.closeQcModal()" ' + (qcModal.sending ? 'disabled' : '') + '>Batal</button>' +
          '<button class="btn ' + (ok ? 'btn-success' : 'btn-danger') + '" onclick="SPB.whOutDetail.confirmQc()" ' + (qcModal.sending ? 'disabled' : '') + '>' +
            (qcModal.sending ? 'Menyimpan...' : actionLabel + ' Barang') +
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
    const action = qcModal.action;
    qcModal.sending = true;
    rerenderLocal();
    try {
      const rec = await window.SPB.dbWhOut.updateStatus(currentId, qcModal.action, qcModal.notes || undefined, receiver);
      qcModal = null;
      window.SPB.ui.toast('Status diperbarui', rec.wh_out_ref + ' → ' + (rec.status === 'Rejected' ? 'Cancelled' : rec.status) + '.', 'success');
      if (rec.odoo_sync && !rec.odoo_sync.ok) {
        window.SPB.ui.toast('Belum tersinkron ke Odoo',
          rec.odoo_sync.message + ' Data di SPB tetap tersimpan — cek Odoo secara manual kalau perlu.', 'error');
      } else if (rec.odoo_sync && rec.odoo_sync.reserveWarning) {
        window.SPB.ui.toast('Barang belum kereservasi di Odoo',
          rec.odoo_sync.reserveWarning, 'error');
      }
      if (rec.pesanan_sync_warning) {
        window.SPB.ui.toast('Tiket portal belum ke-update', rec.pesanan_sync_warning, 'error');
      }
      await render(currentId);
      // Approve Barang sekarang 2 kerjaan sekaligus: validate ke Odoo (di
      // atas, lewat updateStatus) + cetak otomatis di sini — nggak perlu
      // pencet tombol print terpisah lagi. Nunggu render(currentId) kelar
      // dulu (bukan cetak dari data lama) biar area cetaknya (.wh-out-print-
      // area, lihat printAreaHtml) udah ke-render pakai status/data terbaru.
      if (action === 'Approved') {
        setTimeout(function () { window.print(); }, 300);
      }
    } catch (err) {
      qcModal.sending = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal memperbarui', err.message, 'error');
    }
  }

  /* ---------- Ajukan Pemesanan (PO) — sekarang BENERAN bikin RFQ di Odoo ----------
     Dulu langsung catat qty kekurangan mentah-mentah sebagai "permintaan
     restock" doang (nggak nulis apa-apa ke Odoo). Sekarang: buka modal dulu
     — admin bisa EDIT jumlah yang mau dipesan (nggak harus sama persis
     dengan kekurangan asli) & WAJIB pilih vendor — baru submit bikin RFQ
     beneran di Odoo (odoo-create-po), sekalian nyatet permintaan restock-nya
     di Supabase (status langsung 'Dipesan', bukan 'Menunggu' lagi, karena
     PO-nya udah beneran jalan). */
  function kekuranganItems() {
    return currentDetails.map(function (d) {
      const stok = currentStokBySku[d.sku];
      const avail = stok ? Number(stok.qty_on_hand || 0) : 0;
      const demand = Number(d.qty_demand || d.qty_actual || 0);
      const kurang = demand - Math.max(0, avail);
      return kurang > 0 ? { detail_id: d.id, sku: d.sku, product_name: d.product_name, uom: d.uom, kurang: kurang } : null;
    }).filter(Boolean);
  }

  // Modal ini SEKARANG catatan internal doang — SENGAJA TIDAK nulis apa pun
  // ke Odoo (nggak ada action_confirm, nggak ada purchase.order dibikin di
  // sana). Vendor diketik bebas (bukan dropdown ambil dari Odoo lagi), biar
  // nggak keblok kalau vendornya belum sempat didaftarin di Odoo.
  function openPOModal() {
    const kurang = kekuranganItems();
    if (!kurang.length) return;
    poModal = {
      vendorName: '', deadlineDate: '',
      items: kurang.map(function (k) { return { detail_id: k.detail_id, sku: k.sku, product_name: k.product_name, uom: k.uom, qty_diminta: k.kurang, qty: k.kurang }; }),
      sending: false,
    };
    rerenderLocal();
  }
  function closePOModal() { poModal = null; rerenderLocal(); }
  function setPODeadline(value) { if (poModal) { poModal.deadlineDate = value; rerenderLocal(); } }
  function setPOItemQty(sku, value) {
    if (!poModal) return;
    const it = poModal.items.find(function (x) { return x.sku === sku; });
    if (it) it.qty = Math.max(0, Number(value) || 0);
    rerenderLocal();
  }
  function setPOVendorName(value) { if (poModal) { poModal.vendorName = value; rerenderLocal(); } }
  async function submitPO() {
    if (!poModal || poModal.sending) return;
    const vendorName = (poModal.vendorName || '').trim();
    if (!vendorName) { window.SPB.ui.toast('Vendor belum diisi', 'Tulis mau pesan ke vendor/toko mana.', 'error'); return; }
    const items = poModal.items.filter(function (it) { return it.qty > 0; });
    if (!items.length) { window.SPB.ui.toast('Jumlah kosong', 'Isi jumlah yang mau dipesan minimal 1 barang.', 'error'); return; }

    poModal.sending = true;
    rerenderLocal();
    try {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      await window.SPB.dbRestock.create(currentId, items.map(function (it) {
        return { detail_id: it.detail_id, sku: it.sku, product_name: it.product_name, qty_diminta: it.qty_diminta, qty_diajukan: it.qty, supplier_name: vendorName, deadline_date: poModal.deadlineDate || null };
      }), username);
      window.SPB.ui.toast('Diajukan', 'Permintaan restock dicatat ke ' + vendorName + ' — status WH/OUT ini jadi "Menunggu Stok".', 'success');
      poModal = null;
      render(currentId);
    } catch (err) {
      poModal.sending = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal mengajukan', err.message, 'error');
    }
  }

  function poModalHtml() {
    const totalDiminta = poModal.items.reduce(function (a, it) { return a + it.qty_diminta; }, 0);
    return '<div class="modal-backdrop" onclick="if(event.target===this && !' + poModal.sending + ')SPB.whOutDetail.closePOModal()">' +
      '<div class="modal slide-up modal-lg" role="dialog" aria-modal="true">' +
        '<p class="modal-title">Ajukan Pemesanan (PO)</p>' +
        '<p class="modal-sub">Catatan internal SPB — tandai barang ini perlu dipesan ke vendor, biar kelihatan di dashboard Purchase Order. Belum terhubung ke Odoo sama sekali.</p>' +
        '<div style="display:flex;gap:0.75rem;margin-top:0.75rem;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:12rem">' +
            '<label class="field-label" for="po-vendor-input" style="display:block">Pesan Ke (Vendor/Toko) *</label>' +
            '<input type="text" id="po-vendor-input" class="input" placeholder="Tulis nama vendor/toko..." autocomplete="off" ' +
              'value="' + esc(poModal.vendorName) + '" onchange="SPB.whOutDetail.setPOVendorName(this.value)">' +
          '</div>' +
          '<div style="flex:1;min-width:10rem">' +
            '<label class="field-label" for="po-deadline-input" style="display:block">Tanggal Dibutuhkan (opsional)</label>' +
            '<input type="date" id="po-deadline-input" class="input" value="' + esc(poModal.deadlineDate) + '" onchange="SPB.whOutDetail.setPODeadline(this.value)">' +
          '</div>' +
        '</div>' +
        '<p class="field-label" style="margin-top:1rem">Barang &amp; Jumlah</p>' +
        '<div class="table-wrap" style="margin-top:0.375rem"><table class="table">' +
          '<thead><tr><th>Nama Barang</th><th>Kurang</th><th>Jumlah Diajukan</th></tr></thead>' +
          '<tbody>' + poModal.items.map(function (it) {
            return '<tr>' +
              '<td>' + esc(it.product_name || it.sku) + '</td>' +
              '<td class="muted">' + it.qty_diminta + ' ' + esc(it.uom || '') + '</td>' +
              '<td><input type="number" min="0" class="input pesan-cart-qty" style="width:5.5rem" value="' + it.qty + '" onchange="SPB.whOutDetail.setPOItemQty(\'' + esc(it.sku) + '\', this.value)"></td>' +
            '</tr>';
          }).join('') + '</tbody>' +
        '</table></div>' +
        '<p class="card-title-note" style="margin-top:0.375rem">Total kekurangan asli: ' + totalDiminta + ' — boleh diajukan lebih/kurang dari itu.</p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-outline" onclick="SPB.whOutDetail.closePOModal()" ' + (poModal.sending ? 'disabled' : '') + '>Batal</button>' +
          '<button class="btn btn-primary" onclick="SPB.whOutDetail.submitPO()" ' + (poModal.sending ? 'disabled' : '') + '>' +
            (poModal.sending ? 'Menyimpan...' : 'Ajukan') +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
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
      const stok = await window.SPB.dbStokBarang.listBySku(currentDetails.map(function (d) { return d.sku; }));
      const stokBySku = {};
      stok.forEach(function (s) { stokBySku[s.sku] = s; });
      const stillShort = currentDetails.filter(function (d) {
        const s = stokBySku[d.sku];
        const avail = s ? Number(s.qty_on_hand || 0) : 0;
        const demand = Number(d.qty_demand || d.qty_actual || 0);
        return !s || avail <= 0 || avail < demand;
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

  // Info surat/company letterhead — TETAP (nggak ada di database, sama kayak
  // yang selalu tercetak di laporan pengiriman Odoo perusahaan ini).
  const COMPANY_NAME = 'PT. TRIPUTRA TEXTILE INDUSTRY';
  const COMPANY_ADDRESS = ['Jalan Raya Laswi No.8 Majalaya', 'Kabupaten Bandung JB', 'Indonesia'];
  const WAREHOUSE_NAME = 'GUDANG SPAREPART BESAR';

  // Sama persis kayak noteLines di odoo-create-wh-out/index.ts (bagian yang
  // ditulis ke field "note" Odoo) — dibangun ULANG di sini dari data yang
  // sama (rec + currentPesananOrigin), BUKAN dibaca balik dari Odoo (field
  // note-nya nggak disimpen ke pengeluaran_barang.notes, cuma numpang lewat
  // pas odoo-pull-wh-out jalan buat fallback nama karyawan doang).
  // Ringkas — Karyawan/Divisi/Jabatan SENGAJA nggak diulang lagi di sini
  // (udah ada di "Diajukan Oleh"/"Departemen" pas meta di atas), cukup daftar
  // distribusi per barang aja, 1 baris per barang (dipisah <br> di
  // printAreaHtml, bukan digabung 1 paragraf panjang) — biar nggak gampang
  // kepanjangan jadi 2 lembar kalau item-nya banyak (4-5 barang+).
  function buildOdooNoteLines(rec) {
    const lines = [];
    currentDetails.forEach(function (d) {
      const dist = distForSku(d.sku).filter(function (x) { return x && Number(x.qty) > 0; });
      if (!dist.length) return;
      const parts = dist.map(function (x) {
        const nama = (x.nama && x.nama.trim()) ? x.nama.trim() : 'Bersama Divisi';
        return nama + ' ' + x.qty + (d.uom ? d.uom : '') + (x.kondisi ? ' (' + x.kondisi + ')' : '');
      });
      lines.push('<b>' + esc(d.product_name || d.sku) + '</b>: ' + esc(parts.join(', ')));
    });
    return lines;
  }

  /* ---------- Area cetak (dipicu otomatis begitu Approve sukses) ----------
     Niru layout Delivery Order Odoo (yang dikasih contohnya): kop surat
     perusahaan, badge kuning "DELIVERIES ORDER", nomor WH/OUT merah, info
     Dibuat/Diajukan Oleh + tanggal, tabel item, Note, dan 2 kolom tanda
     tangan. Ukuran kertas B5 (lihat @page di style.css).

     Elemennya SENGAJA ditaruh LANGSUNG di document.body (lewat
     updatePrintArea() di bawah), BUKAN ikut nempel di app.innerHTML kayak
     kartu-kartu lain — soalnya app.innerHTML itu nested jauh di dalam
     .app-shell/.app-content yang punya height:100vh + overflow (buat
     sidebar/scroll halaman biasa). position:absolute di dalam situ kepotong
     sama overflow ancestor-nya pas di-print (hasilnya BLANK, ini yang
     kejadian pas pertama kali dicoba) — ditaruh langsung di <body> lolos
     dari masalah itu sama sekali. */
  function printAreaHtml(rec, details) {
    const rows = details.map(function (d, i) {
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>[' + esc(d.sku || '-') + '] ' + esc(d.product_name || '-') + '</td>' +
        '<td>' + esc(d.sku || '-') + '</td>' +
        '<td>' + Number(d.qty_actual != null ? d.qty_actual : d.qty_demand || 0).toFixed(2) + '</td>' +
        '<td>' + esc(d.uom || '') + '</td>' +
        '<td>' + esc(d.product_name || '-') + '</td>' +
      '</tr>';
    }).join('');
    const dateOnly = function (v) { return v ? new Date(v).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'; };

    return '<div class="wh-out-print-area">' +
      '<div class="wop-frame">' +
        '<div class="wop-head">' +
          '<div>' +
            '<span class="wop-badge">DELIVERIES ORDER</span>' +
            '<h2 class="wop-warehouse">' + esc(WAREHOUSE_NAME) + '</h2>' +
            '<p class="wop-ref">' + esc(rec.wh_out_ref) + '</p>' +
          '</div>' +
          '<div class="wop-company">' +
            '<p class="wop-company-name">' + esc(COMPANY_NAME) + '</p>' +
            COMPANY_ADDRESS.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') +
          '</div>' +
        '</div>' +
        '<div class="wop-meta">' +
          '<div>' +
            '<p><b>Dibuat Oleh</b> : ' + esc(rec.receiver_name || '-') + '</p>' +
            '<p><b>Diajukan Oleh</b> : ' + esc(rec.employee_name || '-') + '</p>' +
            '<p><b>Departemen</b>: ' + esc(rec.department || '-') + (rec.sub_divisi ? ' / ' + esc(rec.sub_divisi) : '') + '</p>' +
          '</div>' +
          '<div>' +
            '<p><b>Created On</b> : ' + dateOnly(rec.created_at) + '</p>' +
            '<p><b>Confirmation Date</b> : ' + dateOnly(rec.arrival_date || rec.created_at) + '</p>' +
          '</div>' +
        '</div>' +
        '<table class="wop-table">' +
          '<thead><tr><th>No</th><th>Description</th><th>Code</th><th>Demand</th><th>UOM</th><th>Keterangan</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '<div class="wop-note">' +
          '<p class="wop-note-title">Distribusi</p>' +
          '<p>' + (buildOdooNoteLines(rec).join('<br>') || '-') + '</p>' +
        '</div>' +
        '<div class="wop-sign">' +
          '<div><div class="wop-sign-line"></div><p>' + esc(rec.receiver_name || '-') + '</p></div>' +
          '<div><div class="wop-sign-line"></div><p>(&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;)</p></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  // Ditaruh di root#wh-out-print-root yang nempel LANGSUNG ke document.body
  // (dibikin sekali, dipakai ulang) — lihat alasan lengkapnya di komentar
  // printAreaHtml() di atas.
  function updatePrintArea(rec, details) {
    let root = document.getElementById('wh-out-print-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'wh-out-print-root';
      document.body.appendChild(root);
    }
    root.innerHTML = printAreaHtml(rec, details);
  }
  // Tombol "Print" manual di header — buat ngetes/preview layout cetaknya
  // kapan aja tanpa perlu approve beneran (Approve tetap otomatis
  // manggil window.print() sendiri juga, lihat confirmQc()).
  function printNow() {
    if (!currentRec) return;
    updatePrintArea(currentRec, currentDetails);
    window.print();
  }

  /* ---------- Kartu Distribusi (setelah Approved) ---------- */
  // Diisi PERTAMA KALI sama operator pas pesan di portal (lihat pesan.js —
  // fitur Distribusi ke Karyawan di Katalog), dibaca dari pesanan asalnya
  // (currentPesananOrigin, lihat pesananClient.js getByWhOutRef). Admin
  // gudang TETAP bisa koreksi dari sini kalau ternyata ada salah/perlu
  // disesuaikan (klik "Edit Distribusi") — nulis balik ke kolom
  // pesanan_item.distribusi yang sama, lewat updateItemDistribusi().
  function distForSku(sku) {
    if (!currentPesananOrigin || !sku) return [];
    const item = (currentPesananOrigin.items || []).find(function (it) { return it.sku === sku; });
    return (item && item.distribusi) || [];
  }

  // Distribusi 1 barang dibagi ke beberapa orang sekaligus — kalau jumlahnya
  // timpang banget antar penerima (mis. 1pcs vs 4pcs), langsung kasih warning
  // di sini juga, bukan cuma nunggu ketahuan belakangan di Laporan.
  function qtyGapLevel(gap) {
    if (gap >= 5) return { label: 'Selisih Besar', badge: 'badge-rejected' };
    if (gap >= 2) return { label: 'Selisih Cukup Besar', badge: 'badge-inspection' };
    return null;
  }

  // Format tabel spreadsheet (Nama/Divisi/Sub Divisi/Jenis Barang/Jumlah/
  // Status) — 1 baris per penerima per barang, bukan dikelompokkan per
  // barang kayak sebelumnya. Divisi/Sub Divisi yang ditampilkan itu punya
  // PEMESAN (currentRec.department/sub_divisi) — data distribusi sendiri
  // cuma nyimpen {nama, qty, kondisi} per penerima, nggak ada divisi
  // terpisah per penerima (semua distribusi 1 pesanan otomatis 1 divisi
  // yang sama, ikut pemesannya).
  function distributionCardHtml() {
    const flatRows = [];
    currentDetails.forEach(function (d) {
      const dist = distForSku(d.sku);
      if (!dist.length) return;
      const qtys = dist.map(function (x) { return Number(x.qty); });
      const maxQty = Math.max.apply(null, qtys);
      const minQty = Math.min.apply(null, qtys);
      const gapLevel = dist.length > 1 ? qtyGapLevel(maxQty - minQty) : null;
      dist.forEach(function (x) {
        const rowFlag = gapLevel && (Number(x.qty) === maxQty || Number(x.qty) === minQty) ? gapLevel : null;
        flatRows.push({ item: d, x: x, rowFlag: rowFlag });
      });
    });

    const tableRows = flatRows.map(function (r) {
      const x = r.x, d = r.item;
      const isShared = !x.nama || x.nama === 'Dipakai Bersama Divisi';
      const nameHtml = isShared
        ? '<i data-lucide="building-2" class="icon-sm" style="vertical-align:-2px;margin-right:0.25rem"></i>Dipakai Bersama Divisi'
        : esc(x.nama);
      // Divisi PENERIMA (bukan pemesan) — digabung Divisi/Sub Divisi/Bagian
      // jadi 1 kolom aja (mis. "UMUM / SPAREPART / ADMIN"), dicari dari
      // master karyawan by nama (nama distribusi diketik bebas sama operator
      // pas pesan, jadi bisa aja bukan orang yang sama dengan pemesannya,
      // kayak kasus WH/OUT dipesan Chandra tapi dibagikan ke Linda — divisi
      // Linda yang harus tampil, bukan divisi Chandra). Fallback ke divisi
      // pemesan kalau namanya nggak ketemu di master / mode "Dipakai Bersama
      // Divisi".
      const match = !isShared ? currentKaryawanByName[x.nama.trim().toLowerCase()] : null;
      const divisi = match
        ? [match.department, match.bagian].filter(Boolean).join(' / ')
        : [currentRec.department, currentRec.sub_divisi].filter(Boolean).join(' / ');
      return '<tr>' +
        '<td>' + nameHtml + '</td>' +
        '<td>' + esc(divisi || '-') + '</td>' +
        '<td>' + esc(d.product_name || d.sku) + '</td>' +
        '<td>' + x.qty + ' ' + esc(d.uom || '') + (r.rowFlag ? ' <span class="badge ' + r.rowFlag.badge + '" style="margin-left:0.25rem"><span class="badge-dot"></span>' + r.rowFlag.label + '</span>' : '') + '</td>' +
        '<td>' + (x.kondisi ? distStatusBadge(x.kondisi) : '<span class="muted">-</span>') + '</td>' +
      '</tr>';
    }).join('');

    if (distDraft) return distEditCardHtml();

    return '<div class="detail-card" style="padding:0;overflow:hidden">' +
      '<div class="detail-card-title" style="padding:0.875rem 1.25rem;border-bottom:1px solid var(--slate-100);margin-bottom:0;justify-content:space-between">' +
        '<span><i data-lucide="users" class="icon-md"></i>Distribusi ke Karyawan' +
        '<span class="card-title-note">diisi oleh ' + esc(currentRec.employee_name) + ' saat memesan di portal</span></span>' +
        (currentPesananOrigin ? '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.whOutDetail.openDistEdit()"><i data-lucide="pencil" class="icon-sm"></i>Edit Distribusi</button>' : '') +
      '</div>' +
      '<div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Nama</th><th>Divisi</th><th>Jenis Barang</th><th>Jumlah</th><th>Status</th></tr></thead>' +
        '<tbody>' + (tableRows || '<tr><td colspan="5" class="empty-state">Belum ada data distribusi dari pesanan asalnya.</td></tr>') + '</tbody>' +
      '</table></div>' +
    '</div>';
  }

  // ---------- Edit Distribusi (admin koreksi) ----------
  function openDistEdit() {
    if (!currentPesananOrigin) return;
    const itemsById = {};
    (currentPesananOrigin.items || []).forEach(function (it) {
      itemsById[it.id] = (it.distribusi || []).map(function (x) {
        return { rowId: 'd' + (++distRowSeq), nama: x.nama || '', qty: Number(x.qty) || 1, kondisi: x.kondisi || null };
      });
      if (!itemsById[it.id].length) {
        itemsById[it.id] = [{ rowId: 'd' + (++distRowSeq), nama: currentRec.employee_name || '', qty: Number(it.qty) || 1, kondisi: null }];
      }
    });
    distDraft = itemsById;
    rerenderLocal();
  }
  function closeDistEdit() { distDraft = null; rerenderLocal(); }
  function addDistDraftRow(itemId) {
    if (!distDraft || !distDraft[itemId]) return;
    distDraft[itemId].push({ rowId: 'd' + (++distRowSeq), nama: '', qty: 1, kondisi: null });
    rerenderLocal();
  }
  function removeDistDraftRow(itemId, rowId) {
    if (!distDraft || !distDraft[itemId] || distDraft[itemId].length <= 1) return;
    distDraft[itemId] = distDraft[itemId].filter(function (r) { return r.rowId !== rowId; });
    rerenderLocal();
  }
  function setDistDraftField(itemId, rowId, field, value) {
    if (!distDraft || !distDraft[itemId]) return;
    const row = distDraft[itemId].find(function (r) { return r.rowId === rowId; });
    if (!row) return;
    if (field === 'qty') row.qty = Math.max(0, Number(value) || 0);
    else if (field === 'kondisi') row.kondisi = (row.kondisi === value) ? null : value;
    else row[field] = value;
    rerenderLocal();
  }
  async function saveDistEdit() {
    if (!distDraft || distDraftSaving) return;
    distDraftSaving = true;
    rerenderLocal();
    try {
      const itemIds = Object.keys(distDraft);
      for (const itemId of itemIds) {
        const cleaned = distDraft[itemId]
          .filter(function (r) { return r.qty > 0; })
          .map(function (r) { return { nama: (r.nama || '').trim() || null, qty: r.qty, kondisi: r.kondisi || null }; });
        await window.SPB.dbPesanan.updateItemDistribusi(itemId, cleaned);
      }
      window.SPB.ui.toast('Distribusi diperbarui', '', 'success');
      distDraftSaving = false;
      distDraft = null;
      render(currentId);
    } catch (err) {
      distDraftSaving = false;
      rerenderLocal();
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
    }
  }
  function distEditCardHtml() {
    const karyawanOptions = Object.values(currentKaryawanByName).map(function (k) {
      return '<option value="' + esc(k.name) + '">';
    }).join('');
    const blocks = (currentPesananOrigin.items || []).map(function (it) {
      const rows = distDraft[it.id] || [];
      return '<div class="dist-form-block">' +
        '<p class="dist-item-title">' + esc(it.nama_barang || it.sku) + ' <span class="muted">(dipesan ' + it.qty + ' ' + esc(it.satuan || '') + ')</span></p>' +
        rows.map(function (r) {
          return '<div class="pesan-dist-row">' +
            '<input type="text" class="input" style="flex:1;min-width:0;font-size:0.8125rem;padding:0.4375rem 0.625rem" list="wo-dist-karyawan-list" placeholder="Nama penerima... (kosongkan = Dipakai Bersama Divisi)" ' +
              'value="' + esc(r.nama) + '" onchange="SPB.whOutDetail.setDistDraftField(\'' + it.id + '\', \'' + r.rowId + '\', \'nama\', this.value)">' +
            '<div class="pesan-kondisi-row" style="padding:0">' +
              DIST_STATUS_OPTIONS.map(function (k) {
                return '<label class="pesan-kondisi-chip' + (r.kondisi === k ? ' active' : '') + '">' +
                  '<input type="checkbox" ' + (r.kondisi === k ? 'checked' : '') + ' onchange="SPB.whOutDetail.setDistDraftField(\'' + it.id + '\', \'' + r.rowId + '\', \'kondisi\', \'' + k + '\')">' + k +
                '</label>';
              }).join('') +
            '</div>' +
            '<input type="number" min="0" class="input pesan-cart-qty" style="font-size:0.8125rem" value="' + r.qty + '" onchange="SPB.whOutDetail.setDistDraftField(\'' + it.id + '\', \'' + r.rowId + '\', \'qty\', this.value)">' +
            (rows.length > 1 ? '<button type="button" class="dist-row-del" onclick="SPB.whOutDetail.removeDistDraftRow(\'' + it.id + '\', \'' + r.rowId + '\')"><i data-lucide="x" class="icon-sm"></i></button>' : '') +
          '</div>';
        }).join('') +
        '<button type="button" class="pesan-dist-add" onclick="SPB.whOutDetail.addDistDraftRow(\'' + it.id + '\')"><i data-lucide="plus" class="icon-sm"></i>Bagi ke orang lain</button>' +
      '</div>';
    }).join('');

    return '<div class="detail-card">' +
      '<h2 class="detail-card-title"><i data-lucide="users" class="icon-md"></i>Edit Distribusi ke Karyawan</h2>' +
      '<datalist id="wo-dist-karyawan-list">' + karyawanOptions + '</datalist>' +
      blocks +
      '<div class="modal-actions" style="margin-top:0.75rem">' +
        '<button class="btn btn-outline" onclick="SPB.whOutDetail.closeDistEdit()" ' + (distDraftSaving ? 'disabled' : '') + '>Batal</button>' +
        '<button class="btn btn-primary" onclick="SPB.whOutDetail.saveDistEdit()" ' + (distDraftSaving ? 'disabled' : '') + '>' + (distDraftSaving ? 'Menyimpan...' : 'Simpan Perubahan') + '</button>' +
      '</div>' +
    '</div>';
  }

  window.SPB = window.SPB || {};
  window.SPB.whOutDetail = {
    render: render,
    openQcModal: openQcModal,
    closeQcModal: closeQcModal,
    confirmQc: confirmQc,
    openPOModal: openPOModal,
    closePOModal: closePOModal,
    setPOItemQty: setPOItemQty,
    setPOVendorName: setPOVendorName,
    setPODeadline: setPODeadline,
    submitPO: submitPO,
    recheckStock: recheckStock,
    printNow: printNow,
    openDistEdit: openDistEdit,
    closeDistEdit: closeDistEdit,
    addDistDraftRow: addDistDraftRow,
    removeDistDraftRow: removeDistDraftRow,
    setDistDraftField: setDistDraftField,
    saveDistEdit: saveDistEdit,
  };
})();
