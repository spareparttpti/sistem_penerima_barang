/* =========================================================
   SPB · spinningPurchase.js
   Jalur SUPPLIER role Spinning — Purchase Request -> Purchase Order ->
   Penerimaan Barang, MULTI-ITEM + harga/diskon/PPN (lihat
   database/part_mesin_schema.sql: spinning_pr(_item), spinning_po(_item),
   spinning_receipt(_item)). Layout/gaya & set aksi per status diadaptasi
   dari referensi HTML/CSS yang dikasih user — datanya dari Supabase kita
   sendiri, BUKAN dummy data.

   Routes: #/transaksi/pr (Purchase Request), #/transaksi/po (Purchase
   Order), #/transaksi/gr (Penerimaan Barang). Terpisah dari
   spinningTransaksi.js yang sekarang cuma nanganin jalur GUDANG (PR ke
   Gudang + Work Order, tabel permintaan_part_mesin).
   ========================================================= */

(function () {
  'use strict';

  let tab = 'pr'; // 'pr' | 'po' | 'gr'
  let loading = true;
  let loadError = '';
  let prList = [];
  let poList = [];
  let mesinList = [];
  let partList = [];
  let supplierList = [];
  let karyawanList = [];

  const prFilters = { q: '', status: '', jalur: '' };
  const poFilters = { q: '', status: '', supplier: '' };
  const grFilters = { q: '', status: '', supplier: '' };

  let showPRForm = false, prEditingId = null, prDraftItems = [];
  let showPOForm = false, poEditingId = null, poDraftItems = [], poFromPR = null;
  let grReceivingId = null;
  let editingPOStatusId = null;
  let detailPRId = null, detailPOId = null;

  function t(key) { return window.SPB.spinningI18n.t(key); }
  function esc(s) { return window.esc(s); }
  function isViewOnly() { return !!(window.SPB.auth && window.SPB.auth.isViewOnly && window.SPB.auth.isViewOnly()); }
  function rp(n) { return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID'); }
  function fmtDate(v) { if (!v) return '-'; return new Date(v).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }); }
  function fmtDateTime(v) { if (!v) return '-'; return new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return (parts[0].charAt(0) + (parts[1] ? parts[1].charAt(0) : '')).toUpperCase();
  }
  function subDivisiOf(k) { return ((k.department || '').split(' / ')[1] || '').trim(); }
  function partLabel(p) {
    const parent = p.parent_id ? partList.find(function (x) { return x.id === p.parent_id; }) : null;
    return (parent ? parent.nama_part + ' > ' : '') + p.nama_part;
  }
  function statCard(icon, accentVar, accentBgVar, label, value, sub) {
    return '<div class="po-stat-card" style="--po-accent:var(' + accentVar + ');--po-accent-bg:var(' + accentBgVar + ')">' +
      '<div class="po-stat-top"><span class="po-stat-label">' + esc(label) + '</span>' +
        '<div class="po-stat-icon"><i data-lucide="' + icon + '" class="icon-sm"></i></div></div>' +
      '<p class="po-stat-value">' + value + '</p>' +
      (sub ? '<p class="po-stat-sub">' + esc(sub) + '</p>' : '') +
    '</div>';
  }
  function avatarChip(name) {
    return '<div style="display:flex;align-items:center;gap:0.5rem">' +
      '<span style="display:inline-flex;align-items:center;justify-content:center;width:1.75rem;height:1.75rem;border-radius:9999px;background:var(--brand-600);color:#fff;font-size:0.6875rem;font-weight:700;flex-shrink:0">' + esc(initialsOf(name)) + '</span>' +
      '<span style="font-weight:600;font-size:0.8125rem">' + esc(name || '-') + '</span>' +
    '</div>';
  }

  async function load() {
    loading = true; loadError = '';
    render();
    try {
      const [prRows, poRows, mRows, ptRows, supRows, allKaryawan] = await Promise.all([
        window.SPB.dbSpinningPO.listPR(),
        window.SPB.dbSpinningPO.listPO(),
        window.SPB.dbSpinning.listMesin(),
        window.SPB.dbSpinning.listPart(),
        window.SPB.dbSpinning.listSupplier(),
        window.SPB.dbKaryawan.list(),
      ]);
      prList = prRows; poList = poRows; mesinList = mRows; partList = ptRows; supplierList = supRows;
      karyawanList = allKaryawan.filter(function (k) { return ((k.department || '').split(' / ')[0] || '').trim().toLowerCase() === 'spinning'; });
    } catch (err) {
      loadError = err.message || 'Gagal memuat data.';
    }
    loading = false;
    render();
    // Auto-tarik PO dari sheet+Odoo tiap buka tab PO — TIDAK di-await (biar
    // nggak nunggu Odoo buat nampilin data yang udah ada), gagal-diam kalau
    // secret Odoo belum lengkap (nggak ganggu user pakai fitur lain yang
    // nggak butuh integrasi ini). Tombol "Sync PO" manual di toolbar TETAP
    // ada (lihat syncPoFromOdooManual) buat trigger ulang + lihat hasil/
    // error-nya langsung lewat toast, dipakai pas lagi troubleshoot.
    if (tab === 'po') autoSyncPoFromOdoo();
  }
  let autoSyncing = false;
  async function autoSyncPoFromOdoo() {
    if (autoSyncing) return;
    autoSyncing = true;
    try {
      const res = await window.SPB.dbSpinningPO.syncPoFromOdoo();
      if (res.poSynced > 0) {
        await load();
      }
    } catch (err) {
      console.warn('Auto-sync PO dari Odoo gagal (dilewati, tidak ganggu tampilan):', err.message);
    }
    autoSyncing = false;
  }
  function renderLocal() { render(); }
  function setTab(tb) { tab = tb; showPRForm = false; showPOForm = false; grReceivingId = null; editingPOStatusId = null; detailPRId = null; detailPOId = null; location.hash = '#/transaksi/' + tb; renderLocal(); }

  /* =========================================================
     PURCHASE REQUEST
     ========================================================= */
  function prSetFilter(key, value) { prFilters[key] = value; renderLocal(); }
  function prResetFilter() { prFilters.q = ''; prFilters.status = ''; prFilters.jalur = ''; renderLocal(); }
  function prToggleDetail(id) { detailPRId = detailPRId === id ? null : id; renderLocal(); }

  function prNewItemRow() { return { part_id: '', nama_part: '', satuan: '', qty: 1, harga_satuan: 0 }; }
  function openPRForm(pr) {
    prEditingId = pr ? pr.id : null;
    prDraftItems = pr ? pr.items.map(function (it) { return Object.assign({}, it); }) : [prNewItemRow()];
    showPRForm = true;
    detailPRId = null;
    renderLocal();
  }
  function closePRForm() { showPRForm = false; prEditingId = null; renderLocal(); }
  // Nama Pemohon — custom typeahead (BUKAN <input list> bawaan browser,
  // popup-nya nggak bisa di-styling sama sekali jadi selalu putih terang,
  // nggak ikut tema gelap Spinning). VERSI PERTAMA (dicoba sebelumnya) lewat
  // renderLocal() tiap ketik/fokus — GAGAL, karena renderLocal() bikin ULANG
  // elemen <input>-nya dari nol tiap kali, terus kita panggil .focus() manual
  // buat balikin fokus, tapi .focus() ITU SENDIRI MEMICU event "focus" lagi
  // di elemen baru itu -> renderLocal() lagi -> elemen baru lagi -> .focus()
  // lagi -> ... LOOP TAK BERHENTI (persis penyebab modal "kedip-kedip" &
  // nggak bisa diketik). Makanya sekarang manipulasi DOM LANGSUNG (innerHTML
  // dropdown-nya doang), TANPA renderLocal() sama sekali — <input>-nya nggak
  // pernah dibongkar-pasang ulang waktu ketik/fokus, jadi nggak ada loop,
  // fokus & posisi kursor otomatis aman karena elemennya emang nggak diganti.
  function prPemohonFilter(value) {
    const box = document.getElementById('pr-pemohon-suggest');
    if (!box) return;
    const q = (value || '').trim().toLowerCase();
    const matches = (q ? karyawanList.filter(function (k) { return (k.name || '').toLowerCase().indexOf(q) !== -1; }) : karyawanList).slice(0, 8);
    if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = matches.map(function (k) {
      const nameSafe = esc(k.name).replace(/'/g, "\\'");
      return '<div onmousedown="SPB.spinningPurchase.prPemohonPick(\'' + nameSafe + '\')" style="padding:0.5rem 0.75rem;font-size:0.8125rem;cursor:pointer" onmouseover="this.style.background=\'var(--slate-100)\'" onmouseout="this.style.background=\'\'">' +
        esc(k.name) + (k.jabatan ? '<span style="color:var(--slate-400)"> — ' + esc(k.jabatan) + '</span>' : '') +
      '</div>';
    }).join('');
    box.style.display = 'block';
  }
  function prPemohonPick(name) {
    const input = document.getElementById('pr-pemohon');
    if (input) input.value = name;
    const box = document.getElementById('pr-pemohon-suggest');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  }
  function prPemohonHide() {
    // Delay biar klik saran (mousedown) sempat kejalan duluan sebelum
    // dropdown-nya ketutup akibat blur.
    setTimeout(function () {
      const box = document.getElementById('pr-pemohon-suggest');
      if (box) box.style.display = 'none';
    }, 150);
  }
  function prAddItem() { prDraftItems.push(prNewItemRow()); renderLocal(); }
  function prRemoveItem(idx) { prDraftItems.splice(idx, 1); if (!prDraftItems.length) prDraftItems.push(prNewItemRow()); renderLocal(); }
  function prSetItemField(idx, key, value) {
    const row = prDraftItems[idx];
    if (!row) return;
    if (key === 'part_id') {
      const part = partList.find(function (p) { return p.id === value; });
      row.part_id = value; row.nama_part = part ? part.nama_part : ''; row.satuan = part ? (part.satuan || '') : '';
      if (part && part.harga && !row.harga_satuan) row.harga_satuan = Number(part.harga);
    } else if (key === 'qty' || key === 'harga_satuan') {
      row[key] = Number(value) || 0;
    } else row[key] = value;
    renderLocal();
  }
  async function submitPRForm() {
    const divisi = document.getElementById('pr-divisi').value;
    const pemohonNama = document.getElementById('pr-pemohon').value.trim();
    const mesinId = document.getElementById('pr-mesin').value;
    const urgentVal = document.getElementById('pr-urgent').value;
    const jalur = document.getElementById('pr-jalur').value;
    const tanggal = document.getElementById('pr-tanggal').value;
    const keperluan = document.getElementById('pr-keperluan').value.trim();
    const catatan = document.getElementById('pr-catatan').value.trim();
    if (!divisi || !pemohonNama || !mesinId || !keperluan) { window.SPB.ui.toast('Data belum lengkap', 'Divisi, Pemohon, Mesin, dan Keperluan wajib diisi.', 'error'); return; }
    if (urgentVal === '') { window.SPB.ui.toast('Data belum lengkap', 'Pilih Urgent dulu (Ya/Tidak).', 'error'); return; }
    if (!jalur) { window.SPB.ui.toast('Data belum lengkap', 'Pilih Jalur Pengadaan dulu.', 'error'); return; }
    const urgent = urgentVal === '1';
    const items = prDraftItems.filter(function (it) { return it.part_id && Number(it.qty) > 0; });
    if (!items.length) { window.SPB.ui.toast('Item belum diisi', 'Tambahkan minimal satu part.', 'error'); return; }
    // Nama Pemohon sekarang kolom teks + datalist (ketik nama, muncul saran
    // dari karyawanList) — bukan dropdown lagi. Dicocokkan balik ke
    // karyawanList lewat NAMA (case-insensitive) buat dapetin pemohon_id-nya
    // kalau ketemu; kalau nggak ketemu persis (nama diketik manual/typo),
    // pemohon_id dibiarkan kosong, nama yang diketik tetap kesimpen apa
    // adanya di pemohon_nama.
    const pemohon = karyawanList.find(function (k) { return (k.name || '').toLowerCase() === pemohonNama.toLowerCase(); });
    const mesin = mesinList.find(function (m) { return m.id === mesinId; });
    const payload = {
      divisi_pemohon: divisi, pemohon_id: pemohon ? pemohon.id : null, pemohon_nama: pemohon ? pemohon.name : pemohonNama,
      mesin_id: mesinId, mesin_kode: mesin ? mesin.no_mesin : '-', mesin_nama: mesin ? mesin.nama_mesin : '-',
      urgent: urgent, jalur: jalur, tanggal: tanggal, keperluan: keperluan, catatan: catatan, items: items,
    };
    try {
      if (prEditingId) await window.SPB.dbSpinningPO.updatePR(prEditingId, payload);
      else await window.SPB.dbSpinningPO.createPR(payload);
      window.SPB.ui.toast('OK', prEditingId ? 'PR berhasil diperbarui.' : (jalur === 'order_gudang' ? 'PR berhasil dibuat dan dikirim ke Admin Gudang.' : 'PR berhasil dibuat.'), 'success');
      showPRForm = false; prEditingId = null;
      await load();
    } catch (err) {
      window.SPB.ui.toast('Gagal menyimpan PR', err.message, 'error');
    }
  }
  async function approvePR(id) {
    if (!confirm('Setujui PR ini? PR akan siap diterbitkan Purchase Order.')) return;
    try { await window.SPB.dbSpinningPO.approvePR(id); window.SPB.ui.toast('PR disetujui', '', 'success'); await load(); }
    catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  async function rejectPR(id) {
    const alasan = prompt('Alasan penolakan PR:');
    if (alasan === null) return;
    if (!alasan.trim()) { window.SPB.ui.toast('Alasan wajib diisi', '', 'error'); return; }
    try { await window.SPB.dbSpinningPO.rejectPR(id, alasan.trim()); window.SPB.ui.toast('PR ditolak', '', 'success'); await load(); }
    catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  async function deletePR(id) {
    if (!confirm('Hapus PR ini secara permanen?')) return;
    try { await window.SPB.dbSpinningPO.deletePR(id); window.SPB.ui.toast('PR dihapus', '', 'success'); await load(); }
    catch (err) { window.SPB.ui.toast('Gagal menghapus', err.message, 'error'); }
  }
  function buatPOFromPR(pr) {
    poFromPR = pr;
    poEditingId = null;
    poDraftItems = pr.items.map(function (it) { return Object.assign({}, it); });
    showPOForm = true;
    tab = 'po';
    location.hash = '#/transaksi/po';
    renderLocal();
  }

  function prItemRowsHtml() {
    return '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
      '<thead><tr><th>Part / Sparepart</th><th style="width:6rem">Qty</th><th style="width:9rem">Harga Satuan</th><th style="width:9rem" class="text-right">Subtotal</th><th style="width:2.5rem"></th></tr></thead>' +
      '<tbody>' + prDraftItems.map(function (it, idx) {
        return '<tr>' +
          '<td><select class="select" onchange="SPB.spinningPurchase.prSetItemField(' + idx + ',\'part_id\',this.value)">' +
            '<option value="">— Pilih part —</option>' +
            partList.map(function (p) { return '<option value="' + p.id + '"' + (it.part_id === p.id ? ' selected' : '') + '>' + esc(partLabel(p)) + '</option>'; }).join('') +
          '</select></td>' +
          '<td><input type="number" min="1" step="1" class="input" value="' + it.qty + '" oninput="SPB.spinningPurchase.prSetItemField(' + idx + ',\'qty\',this.value)"></td>' +
          '<td><input type="number" min="0" step="100" class="input" value="' + it.harga_satuan + '" oninput="SPB.spinningPurchase.prSetItemField(' + idx + ',\'harga_satuan\',this.value)"></td>' +
          '<td class="text-right" style="font-weight:700">' + rp(it.qty * it.harga_satuan) + '</td>' +
          '<td class="text-right"><button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.prRemoveItem(' + idx + ')"><i data-lucide="trash-2" class="icon-sm"></i></button></td>' +
        '</tr>';
      }).join('') + '</tbody>' +
      '<tfoot><tr><td colspan="3" class="text-right" style="font-weight:800">TOTAL</td><td class="text-right" style="font-weight:800">' + rp(prDraftItems.reduce(function (a, it) { return a + it.qty * it.harga_satuan; }, 0)) + '</td><td></td></tr></tfoot>' +
    '</table></div></div>';
  }
  function prFormHtml() {
    const editingRow = prEditingId ? prList.find(function (p) { return p.id === prEditingId; }) : null;
    const subDivisiOptions = Array.from(new Set(karyawanList.map(subDivisiOf).filter(Boolean))).sort();
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.spinningPurchase.closePRForm()">' +
      '<div class="modal slide-up modal-2xl" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.spinningPurchase.closePRForm()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="clipboard-plus" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>' + (prEditingId ? 'Ubah Purchase Request' : 'Buat Purchase Request Baru') + '</p>' +
        '<p class="modal-sub">Pilih "Order ke Gudang" kalau permintaan ini perlu diteruskan ke Admin Gudang, atau "Buat PO Baru" kalau langsung diproses jadi Purchase Order ke supplier.</p>' +
      '<div style="display:grid;gap:0.9rem;grid-template-columns:repeat(2,minmax(0,1fr))">' +
        '<div><label class="field-label">Divisi Pemohon *</label><select id="pr-divisi" class="select">' +
          '<option value="">— Pilih Divisi —</option>' +
          subDivisiOptions.map(function (d) { return '<option value="' + esc(d) + '"' + (editingRow && editingRow.divisi_pemohon === d ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('') +
        '</select></div>' +
        '<div style="position:relative">' +
          '<label class="field-label">Nama Pemohon *</label>' +
          '<input id="pr-pemohon" class="input" autocomplete="off" placeholder="Ketik nama..." value="' + esc(editingRow ? editingRow.pemohon_nama : '') + '" ' +
            'oninput="SPB.spinningPurchase.prPemohonFilter(this.value)" onfocus="SPB.spinningPurchase.prPemohonFilter(this.value)" onblur="SPB.spinningPurchase.prPemohonHide()">' +
          '<div id="pr-pemohon-suggest" style="display:none;position:absolute;left:0;right:0;top:100%;margin-top:0.25rem;background:var(--surface);border:1px solid var(--slate-200);border-radius:0.6rem;box-shadow:var(--shadow-md);max-height:12rem;overflow-y:auto;z-index:20"></div>' +
        '</div>' +
        '<div><label class="field-label">Mesin Terkait *</label><select id="pr-mesin" class="select">' +
          '<option value="">— Pilih Mesin —</option>' +
          mesinList.map(function (m) { return '<option value="' + m.id + '"' + (editingRow && editingRow.mesin_id === m.id ? ' selected' : '') + '>' + esc(m.no_mesin) + ' — ' + esc(m.nama_mesin || '') + '</option>'; }).join('') +
        '</select></div>' +
        '<div><label class="field-label">Urgent *</label><select id="pr-urgent" class="select">' +
          '<option value=""' + (!editingRow ? ' selected' : '') + ' disabled>— Pilih Urgent —</option>' +
          '<option value="0"' + (editingRow && !editingRow.urgent ? ' selected' : '') + '>Tidak</option>' +
          '<option value="1"' + (editingRow && editingRow.urgent ? ' selected' : '') + '>Ya</option>' +
        '</select></div>' +
        '<div><label class="field-label">Jalur Pengadaan *</label><select id="pr-jalur" class="select">' +
          '<option value=""' + (!editingRow ? ' selected' : '') + ' disabled>— Pilih Jalur —</option>' +
          '<option value="po_baru"' + (editingRow && editingRow.jalur === 'po_baru' ? ' selected' : '') + '>Buat PO Baru</option>' +
          '<option value="order_gudang"' + (editingRow && editingRow.jalur === 'order_gudang' ? ' selected' : '') + '>Order ke Gudang</option>' +
        '</select></div>' +
        '<div><label class="field-label">Tanggal Permintaan</label><input id="pr-tanggal" type="date" class="input" value="' + (editingRow ? editingRow.tanggal : new Date().toISOString().slice(0, 10)) + '"></div>' +
        '<div style="grid-column:1/-1"><label class="field-label">Keperluan / Justifikasi *</label><textarea id="pr-keperluan" class="textarea" rows="2">' + esc(editingRow ? editingRow.keperluan : '') + '</textarea></div>' +
        '<div style="grid-column:1/-1"><label class="field-label">Catatan Tambahan</label><textarea id="pr-catatan" class="textarea" rows="2">' + esc(editingRow ? editingRow.catatan : '') + '</textarea></div>' +
      '</div>' +
      '<div style="margin-top:1rem">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
          '<h3 style="font-size:0.875rem;font-weight:700;display:flex;align-items:center;gap:0.4rem"><i data-lucide="list-checks" class="icon-sm"></i>Daftar Item</h3>' +
          '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningPurchase.prAddItem()"><i data-lucide="plus" class="icon-sm"></i>Tambah Item</button>' +
        '</div>' +
        prItemRowsHtml() +
      '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" onclick="SPB.spinningPurchase.closePRForm()">Batal</button>' +
        '<button type="button" class="btn btn-primary" onclick="SPB.spinningPurchase.submitPRForm()"><i data-lucide="send" class="icon-sm"></i>' + (prEditingId ? 'Simpan Perubahan' : 'Kirim PR ke Admin Gudang') + '</button>' +
      '</div>' +
      '</div>' +
    '</div>';
  }
  function prDetailHtml(p) {
    return '<tr><td colspan="8" style="background:var(--slate-50);padding:0.75rem 1.25rem">' +
      '<div style="font-size:0.8125rem;color:var(--slate-600);margin-bottom:0.5rem"><b>Keperluan:</b> ' + esc(p.keperluan || '-') + '</div>' +
      (p.catatan ? '<div style="font-size:0.8125rem;color:var(--slate-600);margin-bottom:0.5rem"><b>Catatan:</b> ' + esc(p.catatan) + '</div>' : '') +
      (p.alasan_reject ? '<div style="font-size:0.8125rem;color:var(--red-600);margin-bottom:0.5rem"><b>Alasan Ditolak:</b> ' + esc(p.alasan_reject) + '</div>' : '') +
      '<table class="table"><thead><tr><th>Part</th><th>Qty</th><th>Harga Satuan</th><th class="text-right">Subtotal</th></tr></thead><tbody>' +
      p.items.map(function (it) { return '<tr><td>' + esc(it.nama_part) + '</td><td>' + it.qty + ' ' + esc(it.satuan || '') + '</td><td>' + rp(it.harga_satuan) + '</td><td class="text-right">' + rp(it.subtotal) + '</td></tr>'; }).join('') +
      '</tbody></table>' +
    '</td></tr>';
  }
  function prRowActions(p) {
    if (isViewOnly()) return '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.prToggleDetail(\'' + p.id + '\')"><i data-lucide="eye" class="icon-sm"></i></button>';
    let html = '<button type="button" class="btn btn-outline btn-sm" title="Detail" onclick="SPB.spinningPurchase.prToggleDetail(\'' + p.id + '\')"><i data-lucide="eye" class="icon-sm"></i></button> ';
    if (p.status === 'menunggu') {
      html += '<button type="button" class="btn btn-success btn-sm" title="Setujui" onclick="SPB.spinningPurchase.approvePR(\'' + p.id + '\')"><i data-lucide="check" class="icon-sm"></i></button> ' +
        '<button type="button" class="btn btn-danger btn-sm" title="Tolak" onclick="SPB.spinningPurchase.rejectPR(\'' + p.id + '\')"><i data-lucide="x" class="icon-sm"></i></button> ' +
        '<button type="button" class="btn btn-outline btn-sm" title="Ubah" onclick="SPB.spinningPurchase.openPRForm(SPB.spinningPurchase.findPR(\'' + p.id + '\'))"><i data-lucide="pencil" class="icon-sm"></i></button> ' +
        '<button type="button" class="btn btn-outline btn-sm" title="Hapus" onclick="SPB.spinningPurchase.deletePR(\'' + p.id + '\')"><i data-lucide="trash-2" class="icon-sm"></i></button>';
    } else if (p.status === 'disetujui' && !p.po_id) {
      html += '<button type="button" class="btn btn-primary btn-sm" title="Buat PO" onclick="SPB.spinningPurchase.buatPOFromPR(SPB.spinningPurchase.findPR(\'' + p.id + '\'))"><i data-lucide="shopping-cart" class="icon-sm"></i></button> ' +
        '<button type="button" class="btn btn-outline btn-sm" title="Hapus" onclick="SPB.spinningPurchase.deletePR(\'' + p.id + '\')"><i data-lucide="trash-2" class="icon-sm"></i></button>';
    } else if (p.status === 'ditolak') {
      html += '<button type="button" class="btn btn-outline btn-sm" title="Hapus" onclick="SPB.spinningPurchase.deletePR(\'' + p.id + '\')"><i data-lucide="trash-2" class="icon-sm"></i></button>';
    }
    return html;
  }
  function prRow(p) {
    const totalQty = p.items.reduce(function (a, it) { return a + Number(it.qty); }, 0);
    const partNames = p.items.slice(0, 2).map(function (it) { return it.nama_part; }).join(', ') + (p.items.length > 2 ? ' +' + (p.items.length - 2) : '');
    const statusMap = { menunggu: ['badge-draft', 'MENUNGGU APPROVAL'], disetujui: ['badge-inspection', p.po_id ? 'DIPROSES PO' : 'DISETUJUI'], ditolak: ['badge-rejected', 'DITOLAK'], diproses_po: ['badge-inspection', 'DIPROSES PO'], selesai: ['badge-approved', 'SELESAI'] };
    const st = statusMap[p.status] || ['badge-draft', p.status];
    // Baris "Buat PO Baru" ditandai merah (background halus) biar langsung
    // kelihatan mana yang butuh ditindaklanjuti jadi PO ke supplier — "Order
    // ke Gudang" tampil normal. Urgent (Ya) nambahin ikon warning di sebelah
    // nomor PR, independen dari jalur.
    const isPoBaru = p.jalur !== 'order_gudang';
    const jalurBadge = isPoBaru
      ? '<span class="badge badge-rejected">Buat PO Baru</span>'
      : '<span class="badge badge-approved">Order ke Gudang</span>';
    let rows = '<tr' + (isPoBaru ? ' style="background:rgba(239,68,68,0.08)"' : '') + '>' +
      '<td><div style="font-weight:700">' + esc(p.nomor) + (p.urgent ? ' <i data-lucide="triangle-alert" class="icon-sm" style="color:var(--red-600);vertical-align:-2px" title="Urgent"></i>' : '') + '</div><div style="font-size:0.75rem;color:var(--slate-400)">' + fmtDate(p.tanggal) + '</div></td>' +
      '<td>' + avatarChip(p.pemohon_nama) + '<div style="font-size:0.75rem;color:var(--slate-400);margin-left:2.25rem">' + esc(p.divisi_pemohon || '-') + '</div></td>' +
      '<td><div style="font-weight:600">' + esc(p.mesin_kode || '-') + '</div><div style="font-size:0.75rem;color:var(--slate-400)">' + esc(p.mesin_nama || '-') + '</div></td>' +
      '<td>' + jalurBadge + '</td>' +
      '<td><div>' + p.items.length + ' item &middot; ' + totalQty + ' qty</div><div style="font-size:0.75rem;color:var(--slate-400)">' + esc(partNames || '-') + '</div></td>' +
      '<td style="font-weight:700">' + rp(p.total_estimasi) + '</td>' +
      '<td><span class="badge ' + st[0] + '">' + st[1] + '</span></td>' +
      '<td class="text-right">' + prRowActions(p) + '</td>' +
    '</tr>';
    if (detailPRId === p.id) rows += prDetailHtml(p);
    return rows;
  }
  function prHtml() {
    const all = prList;
    const q = prFilters.q.toLowerCase();
    const cMenunggu = all.filter(function (p) { return p.status === 'menunggu'; }).length;
    const cDiproses = all.filter(function (p) { return p.status === 'disetujui' || p.status === 'diproses_po'; }).length;
    const cSelesai = all.filter(function (p) { return p.status === 'selesai'; }).length;
    const nilaiEstimasi = all.reduce(function (a, p) { return a + Number(p.total_estimasi); }, 0);
    const filtered = all.filter(function (p) {
      if (q && (p.nomor || '').toLowerCase().indexOf(q) === -1 && (p.pemohon_nama || '').toLowerCase().indexOf(q) === -1 &&
          (p.mesin_nama || '').toLowerCase().indexOf(q) === -1 && !p.items.some(function (it) { return (it.nama_part || '').toLowerCase().indexOf(q) !== -1; })) return false;
      if (prFilters.status && p.status !== prFilters.status) return false;
      if (prFilters.jalur && (p.jalur || 'po_baru') !== prFilters.jalur) return false;
      return true;
    });
    return '<div class="grid-stats">' +
        statCard('hourglass', '--violet-500, var(--indigo-500)', '--indigo-50', 'Menunggu Approval', cMenunggu, 'Perlu ditinjau Admin Gudang') +
        statCard('circle-check', '--sky-500', '--sky-50', 'Disetujui / Diproses PO', cDiproses, 'Siap diterbitkan PO') +
        statCard('flag', '--emerald-500', '--emerald-50', 'Selesai', cSelesai, '') +
        statCard('banknote', '--amber-500', '--amber-50', 'Nilai Estimasi', rp(nilaiEstimasi), all.length + ' dokumen PR') +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="clipboard-list" class="icon-md"></i>Purchase Request (PR)<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari nomor PR, pemohon, mesin, atau part..." value="' + esc(prFilters.q) + '" oninput="SPB.spinningPurchase.prSetFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningPurchase.prSetFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              ['menunggu', 'disetujui', 'ditolak', 'diproses_po', 'selesai'].map(function (s) { return '<option value="' + s + '"' + (prFilters.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningPurchase.prSetFilter(\'jalur\', this.value)">' +
              '<option value="">Semua Jalur</option>' +
              '<option value="po_baru"' + (prFilters.jalur === 'po_baru' ? ' selected' : '') + '>Buat PO Baru</option>' +
              '<option value="order_gudang"' + (prFilters.jalur === 'order_gudang' ? ' selected' : '') + '>Order ke Gudang</option>' +
            '</select>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.prResetFilter()"><i data-lucide="rotate-ccw" class="icon-sm"></i>Reset</button>' +
            (isViewOnly() ? '' : '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningPurchase.openPRForm(null)"><i data-lucide="plus" class="icon-sm"></i>PR Baru</button>') +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Nomor PR</th><th>Pemohon</th><th>Mesin Terkait</th><th>Jalur</th><th>Item</th><th>Estimasi</th><th>Status</th><th class="text-right">Aksi</th></tr></thead>' +
          '<tbody>' + (filtered.length ? filtered.map(prRow).join('') : '<tr><td colspan="8" class="empty-state">Belum ada Purchase Request.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>';
  }

  /* =========================================================
     PURCHASE ORDER
     ========================================================= */
  // Sama kayak autoSyncPoFromOdoo() (dipanggil otomatis tiap halaman PO
  // dibuka), bedanya ini dipicu manual dari tombol & kasih toast — dipakai
  // buat trigger ulang sambil lihat hasil/errornya langsung, tanpa perlu
  // buka console browser.
  async function syncPoFromOdooManual() {
    if (autoSyncing) return;
    autoSyncing = true;
    renderLocal();
    try {
      const res = await window.SPB.dbSpinningPO.syncPoFromOdoo();
      let msg = res.poSynced + ' dari ' + res.poFound + ' No PO (Divisi Spinning di sheet) berhasil ditarik dari Odoo.';
      if (res.notFoundInOdoo && res.notFoundInOdoo.length) msg += ' ' + res.notFoundInOdoo.length + ' No PO di sheet nggak ketemu di Odoo: ' + res.notFoundInOdoo.slice(0, 5).join(', ') + (res.notFoundInOdoo.length > 5 ? ', ...' : '') + '.';
      if (res.deleted) msg += ' ' + res.deleted + ' PO lama yang udah nggak valid ikut dihapus.';
      window.SPB.ui.toast('Sync PO selesai', msg, 'success');
      await load();
    } catch (err) {
      window.SPB.ui.toast('Gagal sync PO', err.message, 'error');
    }
    autoSyncing = false;
    renderLocal();
  }
  function poSetFilter(key, value) { poFilters[key] = value; renderLocal(); }
  function poResetFilter() { poFilters.q = ''; poFilters.status = ''; poFilters.supplier = ''; renderLocal(); }
  let detailPOReceipts = [];
  let detailPOLoading = false;
  async function openPODetail(id) {
    detailPOId = id;
    detailPOReceipts = [];
    detailPOLoading = true;
    renderLocal();
    try {
      detailPOReceipts = await window.SPB.dbSpinningPO.listReceipts(id);
    } catch (err) {
      window.SPB.ui.toast('Gagal memuat riwayat penerimaan', err.message, 'error');
    }
    detailPOLoading = false;
    renderLocal();
  }
  function closePODetail() { detailPOId = null; renderLocal(); }
  function poNewItemRow() { return { part_id: '', nama_part: '', satuan: '', qty: 1, harga_satuan: 0 }; }
  function openPOForm(po) {
    poEditingId = po ? po.id : null;
    poFromPR = null;
    poDraftItems = po ? po.items.map(function (it) { return Object.assign({}, it); }) : [poNewItemRow()];
    showPOForm = true;
    detailPOId = null;
    renderLocal();
  }
  function closePOForm() { showPOForm = false; poEditingId = null; poFromPR = null; renderLocal(); }
  function poAddItem() { poDraftItems.push(poNewItemRow()); renderLocal(); }
  function poRemoveItem(idx) { poDraftItems.splice(idx, 1); if (!poDraftItems.length) poDraftItems.push(poNewItemRow()); renderLocal(); }
  function poSetItemField(idx, key, value) {
    const row = poDraftItems[idx];
    if (!row) return;
    if (key === 'part_id') {
      const part = partList.find(function (p) { return p.id === value; });
      row.part_id = value; row.nama_part = part ? part.nama_part : ''; row.satuan = part ? (part.satuan || '') : '';
      if (part && part.harga && !row.harga_satuan) row.harga_satuan = Number(part.harga);
    } else if (key === 'qty' || key === 'harga_satuan') {
      row[key] = Number(value) || 0;
    } else row[key] = value;
    renderLocal();
  }
  function poComputeTotals() {
    const diskonPersen = Number((document.getElementById('po-diskon') || {}).value || 0);
    const ppnPersen = Number((document.getElementById('po-ppn') || {}).value != null ? (document.getElementById('po-ppn') || {}).value : 11);
    const subtotal = poDraftItems.reduce(function (a, it) { return a + it.qty * it.harga_satuan; }, 0);
    const diskon = Math.round(subtotal * diskonPersen / 100);
    const dpp = subtotal - diskon;
    const ppn = Math.round(dpp * ppnPersen / 100);
    return { subtotal: subtotal, diskon: diskon, ppn: ppn, total: dpp + ppn, diskonPersen: diskonPersen, ppnPersen: ppnPersen };
  }
  function poRecalc() { renderLocal(); }
  async function submitPOForm() {
    const supplierId = document.getElementById('po-supplier').value;
    if (!supplierId) { window.SPB.ui.toast('Data belum lengkap', 'Supplier wajib dipilih.', 'error'); return; }
    const supplier = supplierList.find(function (s) { return s.id === supplierId; });
    const items = poDraftItems.filter(function (it) { return it.part_id && Number(it.qty) > 0; });
    if (!items.length) { window.SPB.ui.toast('Item belum diisi', 'Tambahkan minimal satu item PO.', 'error'); return; }
    const payload = {
      supplier_id: supplierId, supplier_nama: supplier ? supplier.nama : '-',
      tanggal: document.getElementById('po-tanggal').value,
      termin_hari: document.getElementById('po-termin').value,
      diskon_persen: document.getElementById('po-diskon').value,
      ppn_persen: document.getElementById('po-ppn').value,
      dibuat_oleh: document.getElementById('po-dibuat-oleh').value.trim(),
      catatan: document.getElementById('po-catatan').value.trim(),
      tanggal_kirim_estimasi: document.getElementById('po-estimasi').value || null,
      items: items,
    };
    if (poFromPR) { payload.pr_id = poFromPR.id; payload.pr_nomor = poFromPR.nomor; }
    try {
      if (poEditingId) await window.SPB.dbSpinningPO.updatePO(poEditingId, payload);
      else await window.SPB.dbSpinningPO.createPO(payload);
      window.SPB.ui.toast('OK', poEditingId ? 'PO berhasil diperbarui.' : 'PO diterbitkan & di-routing ke antrean penerimaan.', 'success');
      showPOForm = false; poEditingId = null; poFromPR = null;
      await load();
    } catch (err) {
      window.SPB.ui.toast('Gagal menyimpan PO', err.message, 'error');
    }
  }
  function startChangeStatus(id) { editingPOStatusId = id; renderLocal(); }
  function cancelChangeStatus() { editingPOStatusId = null; renderLocal(); }
  async function confirmChangeStatus(id) {
    const val = document.getElementById('po-status-select-' + id).value;
    try { await window.SPB.dbSpinningPO.updatePOStatus(id, val); editingPOStatusId = null; window.SPB.ui.toast('Status PO diperbarui', '', 'success'); await load(); }
    catch (err) { window.SPB.ui.toast('Gagal', err.message, 'error'); }
  }
  async function deletePO(id, prId) {
    if (!confirm('Hapus PO ini? Riwayat penerimaan yang terkait ikut terhapus.')) return;
    try { await window.SPB.dbSpinningPO.deletePO(id, prId || null); window.SPB.ui.toast('PO dihapus', '', 'success'); await load(); }
    catch (err) { window.SPB.ui.toast('Gagal menghapus', err.message, 'error'); }
  }

  const PO_STATUS_LABEL = { menunggu_konfirmasi: 'MENUNGGU KONFIRMASI', dikonfirmasi: 'DIKONFIRMASI SUPPLIER', dikirim_sebagian: 'DIKIRIM SEBAGIAN', diterima: 'DITERIMA', dibatalkan: 'DIBATALKAN' };
  const PO_STATUS_BADGE = { menunggu_konfirmasi: 'badge-draft', dikonfirmasi: 'badge-inspection', dikirim_sebagian: 'badge-inspection', diterima: 'badge-approved', dibatalkan: 'badge-rejected' };

  function poItemRowsHtml() {
    const totals = poComputeTotals();
    return '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
      '<thead><tr><th>Part / Sparepart</th><th style="width:6rem">Qty</th><th style="width:9rem">Harga Satuan</th><th style="width:9rem" class="text-right">Subtotal</th><th style="width:2.5rem"></th></tr></thead>' +
      '<tbody>' + poDraftItems.map(function (it, idx) {
        return '<tr>' +
          '<td><select class="select" onchange="SPB.spinningPurchase.poSetItemField(' + idx + ',\'part_id\',this.value)">' +
            '<option value="">— Pilih part —</option>' +
            partList.map(function (p) { return '<option value="' + p.id + '"' + (it.part_id === p.id ? ' selected' : '') + '>' + esc(partLabel(p)) + '</option>'; }).join('') +
          '</select></td>' +
          '<td><input type="number" min="1" step="1" class="input" value="' + it.qty + '" oninput="SPB.spinningPurchase.poSetItemField(' + idx + ',\'qty\',this.value)"></td>' +
          '<td><input type="number" min="0" step="100" class="input" value="' + it.harga_satuan + '" oninput="SPB.spinningPurchase.poSetItemField(' + idx + ',\'harga_satuan\',this.value)"></td>' +
          '<td class="text-right" style="font-weight:700">' + rp(it.qty * it.harga_satuan) + '</td>' +
          '<td class="text-right"><button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.poRemoveItem(' + idx + ')"><i data-lucide="trash-2" class="icon-sm"></i></button></td>' +
        '</tr>';
      }).join('') + '</tbody>' +
      '<tfoot>' +
        '<tr><td colspan="3" class="text-right">Subtotal</td><td class="text-right">' + rp(totals.subtotal) + '</td><td></td></tr>' +
        '<tr><td colspan="3" class="text-right">Diskon (' + totals.diskonPersen + '%)</td><td class="text-right">− ' + rp(totals.diskon) + '</td><td></td></tr>' +
        '<tr><td colspan="3" class="text-right">PPN (' + totals.ppnPersen + '%)</td><td class="text-right">' + rp(totals.ppn) + '</td><td></td></tr>' +
        '<tr><td colspan="3" class="text-right" style="font-weight:800">TOTAL</td><td class="text-right" style="font-weight:800;color:var(--brand-600)">' + rp(totals.total) + '</td><td></td></tr>' +
      '</tfoot>' +
    '</table></div></div>';
  }
  function poFormHtml() {
    const editingRow = poEditingId ? poList.find(function (p) { return p.id === poEditingId; }) : null;
    const prOptions = prList.filter(function (p) { return p.status === 'disetujui' && !p.po_id; });
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.spinningPurchase.closePOForm()">' +
      '<div class="modal slide-up modal-2xl" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.spinningPurchase.closePOForm()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="file-text" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>' + (poEditingId ? 'Ubah Purchase Order' : 'Terbitkan Purchase Order') +
        (poFromPR ? ' <span class="badge badge-inspection" style="vertical-align:2px">dari PR ' + esc(poFromPR.nomor) + '</span>' : '') + '</p>' +
        '<p class="modal-sub">PO akan di-routing otomatis ke antrean penerimaan Admin Gudang.</p>' +
      '<div style="display:grid;gap:0.9rem;grid-template-columns:repeat(2,minmax(0,1fr))">' +
        '<div><label class="field-label">Supplier *</label><select id="po-supplier" class="select">' +
          '<option value="">— Pilih Supplier —</option>' +
          supplierList.map(function (s) { return '<option value="' + s.id + '"' + ((editingRow && editingRow.supplier_id === s.id) ? ' selected' : '') + '>' + esc(s.nama) + '</option>'; }).join('') +
        '</select></div>' +
        '<div><label class="field-label">Referensi PR (opsional)</label><select id="po-pr-ref" class="select" disabled>' +
          '<option>' + (poFromPR ? esc(poFromPR.nomor) + ' — ' + esc(poFromPR.divisi_pemohon || '') : 'Pengadaan rutin tanpa PR') + '</option>' +
        '</select></div>' +
        '<div><label class="field-label">Tanggal PO</label><input id="po-tanggal" type="date" class="input" value="' + (editingRow ? editingRow.tanggal : new Date().toISOString().slice(0, 10)) + '"></div>' +
        '<div><label class="field-label">Estimasi Tanggal Tiba</label><input id="po-estimasi" type="date" class="input" value="' + (editingRow ? (editingRow.tanggal_kirim_estimasi || '') : '') + '"></div>' +
        '<div><label class="field-label">Termin (hari)</label><input id="po-termin" type="number" min="0" class="input" value="' + (editingRow ? editingRow.termin_hari : 30) + '"></div>' +
        '<div><label class="field-label">Dibuat Oleh</label><input id="po-dibuat-oleh" class="input" placeholder="Nama staff purchasing" value="' + esc(editingRow ? (editingRow.dibuat_oleh || '') : '') + '"></div>' +
        '<div><label class="field-label">Diskon (%)</label><input id="po-diskon" type="number" min="0" step="0.1" class="input" value="' + (editingRow ? editingRow.diskon_persen : 0) + '" oninput="SPB.spinningPurchase.poRecalc()"></div>' +
        '<div><label class="field-label">PPN (%)</label><input id="po-ppn" type="number" min="0" step="0.1" class="input" value="' + (editingRow ? editingRow.ppn_persen : 11) + '" oninput="SPB.spinningPurchase.poRecalc()"></div>' +
        '<div style="grid-column:1/-1"><label class="field-label">Catatan / Instruksi</label><textarea id="po-catatan" class="textarea" rows="2" placeholder="Contoh: kirim lengkap, sertakan sertifikat material">' + esc(editingRow ? (editingRow.catatan || '') : '') + '</textarea></div>' +
      '</div>' +
      '<div style="margin-top:1rem">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
          '<h3 style="font-size:0.875rem;font-weight:700;display:flex;align-items:center;gap:0.4rem"><i data-lucide="list-checks" class="icon-sm"></i>Daftar Item</h3>' +
          '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningPurchase.poAddItem()"><i data-lucide="plus" class="icon-sm"></i>Tambah Item</button>' +
        '</div>' +
        poItemRowsHtml() +
      '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" onclick="SPB.spinningPurchase.closePOForm()">Batal</button>' +
        '<button type="button" class="btn btn-primary" onclick="SPB.spinningPurchase.submitPOForm()"><i data-lucide="send" class="icon-sm"></i>' + (poEditingId ? 'Simpan Perubahan' : 'Terbitkan PO') + '</button>' +
      '</div>' +
      '</div>' +
    '</div>';
  }
  function poDetailModalHtml() {
    if (!detailPOId) return '';
    const p = poList.find(function (x) { return x.id === detailPOId; });
    if (!p) return '';
    const totalQty = p.items.reduce(function (a, it) { return a + Number(it.qty); }, 0);
    const totalDiterima = p.items.reduce(function (a, it) { return a + Number(it.qty_diterima); }, 0);
    const pct = totalQty ? Math.round(totalDiterima / totalQty * 100) : 0;
    const infoRow = function (label, value) { return '<div><span style="color:var(--slate-400);font-size:0.75rem">' + label + '</span><div style="font-size:0.8125rem;font-weight:600">' + value + '</div></div>'; };
    // PO hasil sync Odoo nitip info Pemohon/Divisi/Sub Divisi/Bagian di
    // `catatan` sebagai baris "Label: nilai" (lihat syncPoFromOdoo di Edge
    // Function) — di-parse balik di sini biar tampil sebagai info
    // tersendiri di card "Informasi PO", bukan cuma teks bebas.
    const sheetInfo = {};
    let catatanSisa = p.catatan || '';
    if (p.catatan) {
      const lines = p.catatan.split('\n');
      const knownLabels = ['Pemohon', 'Divisi', 'Sub Divisi', 'Bagian'];
      const sisaLines = [];
      lines.forEach(function (line) {
        const idx = line.indexOf(': ');
        const label = idx > -1 ? line.slice(0, idx) : '';
        if (idx > -1 && knownLabels.indexOf(label) !== -1) sheetInfo[label] = line.slice(idx + 2);
        else sisaLines.push(line);
      });
      catatanSisa = sisaLines.join('\n').trim();
    }
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.spinningPurchase.closePODetail()">' +
      '<div class="modal slide-up modal-lg" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.spinningPurchase.closePODetail()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title"><i data-lucide="file-text" class="icon-sm" style="vertical-align:-2px;margin-right:0.35rem"></i>Detail PO/' + esc(p.nomor) + '</p>' +
        '<p class="modal-sub">' + esc(p.supplier_nama) + ' &middot; ' + fmtDate(p.tanggal) + ' &middot; Termin ' + p.termin_hari + ' hari</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.85rem;margin-top:0.75rem">' +
          '<div style="border:1px solid var(--slate-200);border-radius:0.5rem;padding:0.85rem">' +
            '<p style="font-weight:700;font-size:0.8125rem;margin-bottom:0.6rem"><i data-lucide="info" class="icon-sm" style="color:var(--amber-500);vertical-align:-2px"></i> Informasi PO</p>' +
            '<div style="display:grid;gap:0.6rem">' +
              infoRow('Status', '<span class="badge ' + (PO_STATUS_BADGE[p.status] || 'badge-draft') + '">' + (PO_STATUS_LABEL[p.status] || p.status) + '</span>') +
              infoRow('Referensi PR', p.pr_nomor ? esc(p.pr_nomor) : 'Pengadaan rutin') +
              (sheetInfo['Pemohon'] ? infoRow('Pemohon', esc(sheetInfo['Pemohon'])) : '') +
              (sheetInfo['Divisi'] || sheetInfo['Sub Divisi'] || sheetInfo['Bagian']
                ? infoRow('Divisi / Sub Divisi / Bagian', [sheetInfo['Divisi'], sheetInfo['Sub Divisi'], sheetInfo['Bagian']].filter(Boolean).map(esc).join(' / '))
                : '') +
              infoRow('Dibuat Oleh', esc(p.dibuat_oleh || '-')) +
              infoRow('Estimasi Tiba', fmtDate(p.tanggal_kirim_estimasi)) +
              infoRow('Progress Penerimaan', pct + '% &middot; ' + totalDiterima + '/' + totalQty) +
            '</div>' +
          '</div>' +
          '<div style="border:1px solid var(--slate-200);border-radius:0.5rem;padding:0.85rem">' +
            '<p style="font-weight:700;font-size:0.8125rem;margin-bottom:0.6rem"><i data-lucide="receipt" class="icon-sm" style="color:var(--red-500);vertical-align:-2px"></i> Rincian Biaya</p>' +
            '<div style="display:grid;gap:0.45rem;font-size:0.8125rem">' +
              '<div style="display:flex;justify-content:space-between"><span style="color:var(--slate-400)">Subtotal</span><span>' + rp(p.subtotal) + '</span></div>' +
              '<div style="display:flex;justify-content:space-between"><span style="color:var(--slate-400)">Diskon</span><span>&minus; ' + rp(p.diskon) + '</span></div>' +
              '<div style="display:flex;justify-content:space-between"><span style="color:var(--slate-400)">PPN</span><span>' + rp(p.ppn) + '</span></div>' +
              '<div style="display:flex;justify-content:space-between;font-weight:800;border-top:1px solid var(--slate-200);padding-top:0.45rem"><span>Total PO</span><span style="color:var(--brand-600)">' + rp(p.total) + '</span></div>' +
            '</div>' +
            (catatanSisa ? '<div style="margin-top:0.6rem;padding:0.5rem 0.6rem;border-radius:0.4rem;background:var(--brand-50,rgba(59,130,246,0.08));font-size:0.75rem">' + esc(catatanSisa) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div style="margin-top:0.85rem"><div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Nama Part</th><th class="text-right">Qty</th><th class="text-right">Harga</th><th class="text-right">Subtotal</th></tr></thead>' +
          '<tbody>' + p.items.map(function (it) {
            return '<tr><td>' + esc(it.nama_part) + '</td><td class="text-right">' + it.qty + ' ' + esc(it.satuan || '') + '</td><td class="text-right">' + rp(it.harga_satuan) + '</td><td class="text-right">' + rp(it.subtotal) + '</td></tr>';
          }).join('') + '</tbody>' +
        '</table></div></div></div>' +
        '<div style="margin-top:0.85rem">' +
          '<p style="font-weight:700;font-size:0.8125rem;margin-bottom:0.5rem"><i data-lucide="inbox" class="icon-sm" style="color:var(--brand-600);vertical-align:-2px"></i> Riwayat Penerimaan<span style="color:var(--slate-400);font-weight:400"> &middot; ' + detailPOReceipts.length + ' dokumen</span></p>' +
          (detailPOLoading ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>' :
          detailPOReceipts.length ? '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
            '<thead><tr><th>No. Dokumen</th><th>Tanggal</th><th>No. Surat Jalan</th><th>Diterima Oleh</th></tr></thead>' +
            '<tbody>' + detailPOReceipts.map(function (r) {
              return '<tr><td>' + esc(r.nomor) + '</td><td>' + fmtDate(r.tanggal) + '</td><td>' + esc(r.no_surat_jalan || '-') + '</td><td>' + esc(r.diterima_oleh || '-') + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div></div>' :
          '<div class="empty-state" style="padding:1.25rem 0">Belum ada penerimaan untuk PO ini.<div style="font-size:0.75rem;color:var(--slate-400);margin-top:0.25rem">Buka menu Penerimaan Barang untuk memposting barang masuk.</div></div>') +
        '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.spinningPurchase.closePODetail()">Tutup</button>' +
          '<button type="button" class="btn btn-primary" onclick="window.print()"><i data-lucide="printer" class="icon-sm"></i>Cetak</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function poRow(p) {
    const totalQty = p.items.reduce(function (a, it) { return a + Number(it.qty); }, 0);
    const totalDiterima = p.items.reduce(function (a, it) { return a + Number(it.qty_diterima); }, 0);
    const pct = totalQty ? Math.round(totalDiterima / totalQty * 100) : 0;
    const viewOnly = isViewOnly();
    const fromOdoo = p.dibuat_oleh === 'Sync Odoo';
    let rows = '<tr>' +
      '<td><div style="font-weight:700">' + esc(p.nomor) + (fromOdoo ? ' <span class="badge badge-draft" title="Ditarik dari Odoo, read-only">Odoo</span>' : '') + '</div><div style="font-size:0.75rem;color:var(--slate-400)">' + fmtDate(p.tanggal) + '</div></td>' +
      '<td><div style="font-weight:600">' + esc(p.supplier_nama) + '</div><div style="font-size:0.75rem;color:var(--slate-400)">termin ' + p.termin_hari + ' hari</div></td>' +
      '<td>' + (p.pr_nomor ? '<span class="badge badge-draft">' + esc(p.pr_nomor) + '</span>' : '<span style="font-size:0.75rem;color:var(--slate-400)">Pengadaan rutin</span>') + '</td>' +
      '<td>' + p.items.length + ' item<div style="font-size:0.75rem;color:var(--slate-400)">' + totalQty + ' qty</div></td>' +
      '<td style="font-weight:700">' + rp(p.total) + '<div style="font-size:0.75rem;color:var(--slate-400)">PPN ' + rp(p.ppn) + '</div></td>' +
      '<td style="min-width:8rem"><div class="progress-track"><div class="progress-bar" style="width:' + pct + '%"></div></div><div class="progress-meta">' + pct + '% &middot; ' + totalDiterima + '/' + totalQty + '</div></td>' +
      '<td>' + fmtDate(p.tanggal_kirim_estimasi) + '</td>' +
      '<td>' + (editingPOStatusId === p.id
        ? '<select id="po-status-select-' + p.id + '" class="select-input" style="height:auto">' + Object.keys(PO_STATUS_LABEL).map(function (s) { return '<option value="' + s + '"' + (p.status === s ? ' selected' : '') + '>' + PO_STATUS_LABEL[s] + '</option>'; }).join('') + '</select> ' +
          '<button type="button" class="btn btn-success btn-sm" onclick="SPB.spinningPurchase.confirmChangeStatus(\'' + p.id + '\')"><i data-lucide="check" class="icon-sm"></i></button> ' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.cancelChangeStatus()"><i data-lucide="x" class="icon-sm"></i></button>'
        : '<span class="badge ' + (PO_STATUS_BADGE[p.status] || 'badge-draft') + '">' + (PO_STATUS_LABEL[p.status] || p.status) + '</span>') + '</td>' +
      '<td class="text-right">' +
        '<button type="button" class="btn btn-outline btn-sm" title="Detail" onclick="SPB.spinningPurchase.openPODetail(\'' + p.id + '\')"><i data-lucide="eye" class="icon-sm"></i></button> ' +
        (!viewOnly && !fromOdoo ? '<button type="button" class="btn btn-outline btn-sm" title="Ubah Status" onclick="SPB.spinningPurchase.startChangeStatus(\'' + p.id + '\')"><i data-lucide="refresh-cw" class="icon-sm"></i></button> ' : '') +
        (!viewOnly && !fromOdoo && p.status !== 'diterima' && p.status !== 'dibatalkan' ? '<button type="button" class="btn btn-outline btn-sm" title="Ubah" onclick="SPB.spinningPurchase.openPOForm(SPB.spinningPurchase.findPO(\'' + p.id + '\'))"><i data-lucide="pencil" class="icon-sm"></i></button> ' : '') +
        (!viewOnly ? '<button type="button" class="btn btn-outline btn-sm" title="Hapus" onclick="SPB.spinningPurchase.deletePO(\'' + p.id + '\',\'' + (p.pr_id || '') + '\')"><i data-lucide="trash-2" class="icon-sm"></i></button>' : '') +
      '</td>' +
    '</tr>';
    return rows;
  }
  function poHtml() {
    const all = poList;
    const q = poFilters.q.toLowerCase();
    const cMenunggu = all.filter(function (p) { return p.status === 'menunggu_konfirmasi'; }).length;
    const cSebagian = all.filter(function (p) { return p.status === 'dikirim_sebagian'; }).length;
    const nilaiPO = all.reduce(function (a, p) { return a + Number(p.total); }, 0);
    const filtered = all.filter(function (p) {
      if (q && (p.nomor || '').toLowerCase().indexOf(q) === -1 && (p.supplier_nama || '').toLowerCase().indexOf(q) === -1 &&
          (p.pr_nomor || '').toLowerCase().indexOf(q) === -1 && !p.items.some(function (it) { return (it.nama_part || '').toLowerCase().indexOf(q) !== -1; })) return false;
      if (poFilters.status && p.status !== poFilters.status) return false;
      if (poFilters.supplier && p.supplier_id !== poFilters.supplier) return false;
      return true;
    });
    return '<div class="grid-stats">' +
        statCard('file-text', '--amber-500', '--amber-50', 'Total PO', all.length, all.filter(function (p) { return p.status === 'diterima'; }).length + ' sudah diterima') +
        statCard('send', '--violet-500, var(--indigo-500)', '--indigo-50', 'Menunggu Konfirmasi', cMenunggu, '') +
        statCard('truck', '--red-500', '--red-50', 'Dikirim Sebagian', cSebagian, 'Perlu penerimaan lanjutan') +
        statCard('banknote', '--emerald-500', '--emerald-50', 'Nilai PO', rp(nilaiPO), '') +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="file-text" class="icon-md"></i>Purchase Order (PO)<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari nomor PO, supplier, PR, atau part..." value="' + esc(poFilters.q) + '" oninput="SPB.spinningPurchase.poSetFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningPurchase.poSetFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              Object.keys(PO_STATUS_LABEL).map(function (s) { return '<option value="' + s + '"' + (poFilters.status === s ? ' selected' : '') + '>' + PO_STATUS_LABEL[s] + '</option>'; }).join('') +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningPurchase.poSetFilter(\'supplier\', this.value)">' +
              '<option value="">Semua Supplier</option>' +
              supplierList.map(function (s) { return '<option value="' + s.id + '"' + (poFilters.supplier === s.id ? ' selected' : '') + '>' + esc(s.nama) + '</option>'; }).join('') +
            '</select>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.poResetFilter()"><i data-lucide="rotate-ccw" class="icon-sm"></i>Reset</button>' +
            (isViewOnly() ? '' : '<button type="button" class="btn btn-outline btn-sm" ' + (autoSyncing ? 'disabled' : '') + ' onclick="SPB.spinningPurchase.syncPoFromOdooManual()" title="Tarik ulang PO dari Odoo">' +
              '<i data-lucide="' + (autoSyncing ? 'loader-2' : 'refresh-cw') + '" class="icon-sm' + (autoSyncing ? ' spin' : '') + '"></i>' + (autoSyncing ? 'Sinkron...' : 'Sync PO') + '</button>') +
            (isViewOnly() ? '' : '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningPurchase.openPOForm(null)"><i data-lucide="plus" class="icon-sm"></i>PO Baru</button>') +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Nomor PO</th><th>Supplier</th><th>Referensi PR</th><th>Item</th><th>Nilai PO</th><th>Penerimaan</th><th>Estimasi Tiba</th><th>Status</th><th class="text-right">Aksi</th></tr></thead>' +
          '<tbody>' + (filtered.length ? filtered.map(poRow).join('') : '<tr><td colspan="9" class="empty-state">Belum ada Purchase Order.</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>' + poDetailModalHtml();
  }

  /* =========================================================
     PENERIMAAN BARANG (Receipt) — per PO, bisa bertahap
     ========================================================= */
  function grSetFilter(key, value) { grFilters[key] = value; renderLocal(); }
  function grResetFilter() { grFilters.q = ''; grFilters.status = ''; grFilters.supplier = ''; renderLocal(); }
  function startTerima(id) { grReceivingId = id; renderLocal(); }
  function cancelTerima() { grReceivingId = null; renderLocal(); }
  async function confirmTerima(po) {
    const noSuratJalan = document.getElementById('gr-sj').value.trim();
    const catatan = document.getElementById('gr-catatan').value.trim();
    const items = po.items.map(function (it) {
      const sisa = Number(it.qty) - Number(it.qty_diterima);
      const qtyTerima = Number((document.getElementById('gr-qty-' + it.id) || {}).value || 0);
      const qtyReject = Number((document.getElementById('gr-reject-' + it.id) || {}).value || 0);
      return { po_item_id: it.id, qty_terima: Math.min(qtyTerima, sisa), qty_reject: qtyReject };
    }).filter(function (it) { return it.qty_terima > 0 || it.qty_reject > 0; });
    if (!items.length) { window.SPB.ui.toast('Qty kosong', 'Isi minimal satu qty terima.', 'error'); return; }
    try {
      await window.SPB.dbSpinningPO.createReceipt(po.id, { no_surat_jalan: noSuratJalan, catatan: catatan, items: items });
      grReceivingId = null;
      window.SPB.ui.toast('Barang diterima', 'Penerimaan berhasil dicatat.', 'success');
      await load();
    } catch (err) {
      window.SPB.ui.toast('Gagal', err.message, 'error');
    }
  }
  function grReceiveFormHtml(po) {
    return '<tr><td colspan="8">' +
      '<div style="padding:0.75rem 0">' +
        '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.6rem;margin-bottom:0.75rem">' +
          '<div><label class="field-label">No. Surat Jalan</label><input id="gr-sj" class="input" placeholder="SJ/1234/' + esc(po.supplier_nama) + '"></div>' +
          '<div><label class="field-label">Catatan</label><input id="gr-catatan" class="input"></div>' +
        '</div>' +
        '<table class="table"><thead><tr><th>Part</th><th>Qty PO</th><th>Sudah Diterima</th><th style="width:8rem">Qty Terima</th><th style="width:8rem">Reject</th></tr></thead><tbody>' +
        po.items.map(function (it) {
          const sisa = Math.max(0, Number(it.qty) - Number(it.qty_diterima));
          return '<tr><td>' + esc(it.nama_part) + '</td><td>' + it.qty + ' ' + esc(it.satuan || '') + '</td><td>' + it.qty_diterima + '</td>' +
            '<td><input id="gr-qty-' + it.id + '" type="number" min="0" max="' + sisa + '" step="1" class="input" value="' + sisa + '"></td>' +
            '<td><input id="gr-reject-' + it.id + '" type="number" min="0" step="1" class="input" value="0"></td></tr>';
        }).join('') + '</tbody></table>' +
        '<div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem">' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.cancelTerima()">Batal</button>' +
          '<button type="button" class="btn btn-success btn-sm" onclick="SPB.spinningPurchase.confirmTerima(SPB.spinningPurchase.findPO(\'' + po.id + '\'))"><i data-lucide="check" class="icon-sm"></i>Konfirmasi Diterima</button>' +
        '</div>' +
      '</div>' +
    '</td></tr>';
  }
  function grRow(p) {
    const viewOnly = isViewOnly();
    const fromOdoo = p.dibuat_oleh === 'Sync Odoo';
    const totalQty = p.items.reduce(function (a, it) { return a + Number(it.qty); }, 0);
    const totalDiterima = p.items.reduce(function (a, it) { return a + Number(it.qty_diterima); }, 0);
    const pct = totalQty ? Math.round(totalDiterima / totalQty * 100) : 0;
    let rows = '<tr>' +
      '<td><div style="font-weight:700">' + esc(p.nomor) + (fromOdoo ? ' <span class="badge badge-draft" title="Penerimaan ditarik otomatis dari WH IN Odoo">Odoo</span>' : '') + '</div><div style="font-size:0.75rem;color:var(--slate-400)">' + fmtDate(p.tanggal) + '</div></td>' +
      '<td><div style="font-weight:600">' + esc(p.supplier_nama) + '</div>' + (p.pr_nomor ? '<div style="font-size:0.75rem;color:var(--slate-400)">' + esc(p.pr_nomor) + '</div>' : '') + '</td>' +
      '<td>' + p.items.length + ' item<div style="font-size:0.75rem;color:var(--slate-400)">' + totalQty + ' qty</div></td>' +
      '<td style="min-width:8rem"><div class="progress-track"><div class="progress-bar" style="width:' + pct + '%"></div></div><div class="progress-meta">' + pct + '% diterima</div></td>' +
      '<td>' + rp(p.total) + '</td>' +
      '<td><span class="badge ' + (PO_STATUS_BADGE[p.status] || 'badge-draft') + '">' + (PO_STATUS_LABEL[p.status] || p.status) + '</span></td>' +
      '<td class="text-right">' + (!viewOnly && !fromOdoo && p.status !== 'diterima' && p.status !== 'dibatalkan' ? '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.spinningPurchase.startTerima(\'' + p.id + '\')"><i data-lucide="package-check" class="icon-sm"></i>Terima</button>' : (fromOdoo ? '<span style="font-size:0.75rem;color:var(--slate-400)">Otomatis dari Odoo</span>' : '')) + '</td>' +
    '</tr>';
    if (grReceivingId === p.id) rows += grReceiveFormHtml(p);
    return rows;
  }
  function grHtml() {
    // PO dari Odoo cuma masuk antrean Penerimaan Barang kalau BENERAN udah
    // ada WH IN-nya (minimal 1 item qty_diterima > 0, ikut kebawa dari
    // purchase.order.line.qty_received waktu sync) — PO yang masih 0%
    // (belum ada picking "done" sama sekali di Odoo) sengaja DISEMBUNYIKAN
    // dari sini, karena memang belum ada barang masuk yang bisa dicatat.
    // PO manual SPB sendiri tetap tampil seperti biasa (alur "Terima"-nya
    // beda, belum tentu ngikut qty_diterima Odoo).
    const antrean = poList.filter(function (p) {
      if (p.status === 'diterima' || p.status === 'dibatalkan') return false;
      if (p.dibuat_oleh === 'Sync Odoo') {
        return p.items.some(function (it) { return Number(it.qty_diterima) > 0; });
      }
      return true;
    });
    const q = grFilters.q.toLowerCase();
    const filtered = antrean.filter(function (p) {
      if (q && (p.nomor || '').toLowerCase().indexOf(q) === -1 && (p.supplier_nama || '').toLowerCase().indexOf(q) === -1) return false;
      if (grFilters.status && p.status !== grFilters.status) return false;
      if (grFilters.supplier && p.supplier_id !== grFilters.supplier) return false;
      return true;
    });
    const totalQtyDiterima = poList.reduce(function (a, p) { return a + p.items.reduce(function (b, it) { return b + Number(it.qty_diterima); }, 0); }, 0);
    return '<div class="grid-stats">' +
        statCard('inbox', '--sky-500', '--sky-50', 'PO Dalam Antrean', antrean.length, 'Siap diposting penerimaannya') +
        statCard('clock', '--amber-500', '--amber-50', 'Dikirim Sebagian', poList.filter(function (p) { return p.status === 'dikirim_sebagian'; }).length, 'Menunggu kekurangan item') +
        statCard('boxes', '--emerald-500', '--emerald-50', 'Total Qty Diterima', totalQtyDiterima, '') +
        statCard('clipboard-check', '--indigo-500', '--indigo-50', 'Total PO Selesai', poList.filter(function (p) { return p.status === 'diterima'; }).length, '') +
      '</div>' +
      '<div class="table-card">' +
        '<div class="table-head">' +
          '<h2 class="table-title"><i data-lucide="package-check" class="icon-md"></i>' + t('trx_gr_title') + '<span class="badge-count" style="position:static;margin-left:0.5rem">' + filtered.length + '</span></h2>' +
          '<div class="table-tools">' +
            '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input class="search-input" placeholder="Cari nomor PO, supplier..." value="' + esc(grFilters.q) + '" oninput="SPB.spinningPurchase.grSetFilter(\'q\', this.value)"></div>' +
            '<select class="select-input" onchange="SPB.spinningPurchase.grSetFilter(\'status\', this.value)">' +
              '<option value="">Semua Status</option>' +
              '<option value="menunggu_konfirmasi"' + (grFilters.status === 'menunggu_konfirmasi' ? ' selected' : '') + '>Menunggu Konfirmasi</option>' +
              '<option value="dikonfirmasi"' + (grFilters.status === 'dikonfirmasi' ? ' selected' : '') + '>Dikonfirmasi Supplier</option>' +
              '<option value="dikirim_sebagian"' + (grFilters.status === 'dikirim_sebagian' ? ' selected' : '') + '>Dikirim Sebagian</option>' +
            '</select>' +
            '<select class="select-input" onchange="SPB.spinningPurchase.grSetFilter(\'supplier\', this.value)">' +
              '<option value="">Semua Supplier</option>' +
              supplierList.map(function (s) { return '<option value="' + s.id + '"' + (grFilters.supplier === s.id ? ' selected' : '') + '>' + esc(s.nama) + '</option>'; }).join('') +
            '</select>' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.spinningPurchase.grResetFilter()"><i data-lucide="rotate-ccw" class="icon-sm"></i>Reset</button>' +
          '</div>' +
        '</div>' +
        '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Nomor PO</th><th>Supplier</th><th>Item</th><th>Penerimaan</th><th>Nilai PO</th><th>Status</th><th class="text-right">Aksi</th></tr></thead>' +
          '<tbody>' + (filtered.length ? filtered.map(grRow).join('') : '<tr><td colspan="7" class="empty-state">Tidak ada PO dalam antrean.</td></tr>') + '</tbody>' +
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
      body = tab === 'po' ? poHtml() : tab === 'gr' ? grHtml() : prHtml();
    }
    const titleMap = { pr: ['Purchase Request (PR)', 'Permintaan sparepart dari divisi mesin/teknisi. Setiap PR baru otomatis mengirim badge notifikasi ke Admin Gudang untuk proses persetujuan.'], po: ['Purchase Order (PO)', 'Penerbitan PO ke supplier. Setiap PO baru otomatis di-routing ke antrean penerimaan Admin Gudang beserta notifikasi.'], gr: [t('trx_gr_title'), t('trx_gr_sub')] };
    const title = titleMap[tab] || titleMap.pr;
    // Popup PR/PO HARUS ikut di dalam argumen ui.layout() (bukan ditempel di
    // luar/sesudahnya) — .spinning-shell (yang nentuin tema terang/gelap)
    // cuma bungkus konten yang DIKASIH ke ui.layout(), jadi kalau modal-nya
    // ditempel di luar situ, dia jatuh di luar .spinning-shell dan render-nya
    // selalu tema TERANG default, nggak ikut toggle gelap/terang Spinning.
    const modalHtml = (!isViewOnly() && showPRForm ? prFormHtml() : '') + (!isViewOnly() && showPOForm ? poFormHtml() : '');
    app.innerHTML = ui.layout('transaksi-' + tab,
      '<div class="page-head">' +
        '<div><h1 class="page-title">' + esc(title[0]) + '</h1>' +
        '<p class="page-sub">' + esc(title[1]) + '</p></div>' +
      '</div>' +
      body + modalHtml
    );
    ui.afterRender();
  }

  window.SPB = window.SPB || {};
  window.SPB.spinningPurchase = {
    render: function (initialTab) { if (initialTab) tab = initialTab; load(); },
    setTab: setTab,
    findPR: function (id) { return prList.find(function (p) { return p.id === id; }); },
    findPO: function (id) { return poList.find(function (p) { return p.id === id; }); },
    prSetFilter: prSetFilter, prResetFilter: prResetFilter, prToggleDetail: prToggleDetail,
    prPemohonFilter: prPemohonFilter, prPemohonPick: prPemohonPick, prPemohonHide: prPemohonHide,
    openPRForm: openPRForm, closePRForm: closePRForm, prAddItem: prAddItem, prRemoveItem: prRemoveItem, prSetItemField: prSetItemField, submitPRForm: submitPRForm,
    approvePR: approvePR, rejectPR: rejectPR, deletePR: deletePR, buatPOFromPR: buatPOFromPR,
    poSetFilter: poSetFilter, poResetFilter: poResetFilter, openPODetail: openPODetail, closePODetail: closePODetail,
    openPOForm: openPOForm, closePOForm: closePOForm, poAddItem: poAddItem, poRemoveItem: poRemoveItem, poSetItemField: poSetItemField, poRecalc: poRecalc, submitPOForm: submitPOForm,
    startChangeStatus: startChangeStatus, cancelChangeStatus: cancelChangeStatus, confirmChangeStatus: confirmChangeStatus, deletePO: deletePO,
    syncPoFromOdooManual: syncPoFromOdooManual,
    grSetFilter: grSetFilter, grResetFilter: grResetFilter, startTerima: startTerima, cancelTerima: cancelTerima, confirmTerima: confirmTerima,
  };
})();
