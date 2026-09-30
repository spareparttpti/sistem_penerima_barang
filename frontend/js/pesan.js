/* =========================================================
   SPB · pesan.js
   Portal Permintaan Barang — sisi KARYAWAN, TANPA LOGIN sama sekali.
   Rute: #/pesan (pilih divisi dulu) atau #/pesan/NAMA_DIVISI (langsung ke
   form, divisinya udah ke-kunci) — dan #/tiket/:id (lihat status pesanan
   yang udah pernah dikirim, dari link/bookmark).

   Nggak pakai layout() SPB (itu buat admin, ada sidebar dsb) — halaman ini
   render shell-nya sendiri, sengaja polos & mobile-friendly.

   Sumber data (SEMUA numpang ke tabel SPB yang udah ada, lihat
   database/pesanan_schema.sql):
   - Autocomplete nama & divisi/sub-divisi/NIP/jabatan -> dbKaryawan.list()
   - Katalog barang -> dbStokBarang.list()
   - Simpan pesanan -> dbPesanan.create()

   ⚠️ PENYEDERHANAAN yang disadari (dibanding Program Pemesanan lama):
   - Mode "Titip ke Shift Lain" cuma nyatet NAMA penerima titipan
     (titip_ke_name) — belum ada tabel breakdown multi-penerima yang bisa
     diisi rinci pas order dibuat. Itu bisa ditambah belakangan kalau
     memang kepakai.
   - Laporan "permintaan berulang dalam waktu dekat" belum diport (ada di
     tab Laporan Program Pemesanan lama) — bisa disusulkan.
   ========================================================= */

(function () {
  'use strict';

  let step = 'pilih-divisi'; // 'pilih-divisi' | 'form' | 'katalog' | 'tiket'
  let divisiLocked = '';
  let divisiOptions = [];
  let karyawanAll = [];
  let stokAll = [];
  let masterLoaded = false;
  let masterError = '';

  let form = { nama: '', divisi: '', subDivisi: '', jabatan: '', nip: '', tujuan: '', mode: '', titipNama: '', catatan: '', urgent: false };
  // Dropdown custom (BUKAN <datalist> bawaan browser — nggak konsisten,
  // apalagi di HP) buat cari nama karyawan: ketik "a" -> semua nama yang ada
  // huruf "a"-nya nongol, ketik nama lengkap -> tinggal itu doang.
  let namaDropdownOpen = false;
  let titipDropdownOpen = false;
  let cart = []; // { sku, nama_barang, qty, satuan, tersedia }
  let catalogQ = '';
  // Jumlah barang per halaman katalog TIDAK di-hardcode — dihitung ulang
  // dari ukuran grid yang KELIHATAN di layar (lewat fitCatalogPageSize()),
  // supaya waktu di-zoom in/out kotaknya tetap keisi PAS 1 layar penuh (nggak
  // ada baris nanggung di bawah, dan nggak ada barang yang kepotong scroll)
  // — barang yang "harusnya" muncul tapi kelebihan otomatis geser ke halaman
  // berikutnya, begitu juga sebaliknya pas di-zoom out (kotak makin muat
  // banyak -> halaman berikutnya "ketarik" masuk ke halaman ini.
  let catalogPageSize = 24; // tebakan awal sebelum sempat diukur — langsung dikoreksi begitu grid pertama kali kegambar
  // Cuma dikoreksi (boleh geser halaman) SEKALI di kunjungan pertama ke
  // katalog — abis itu murni ngikutin resize/zoom aja (lihat fitCatalogPageSize).
  let catalogSizeSettled = false;
  let catalogPage = 1;
  let catalogCategory = 'semua'; // 'semua' | 'ATK' | 'Lainnya' — buat karyawan yang cuma butuh ATK biar nggak keder nyari di antara ribuan sparepart
  let catalogStock = 'semua'; // 'semua' | 'ada' | 'habis' — filter status stok, biar nggak nyasar milih barang yang ternyata kosong
  // Kalau karyawan nggak tahu nama pasti barangnya (nggak paham istilah
  // teknis sparepart) — tombol "Nggak ketemu di daftar?" buka form kecil ini,
  // isinya bebas (bukan pilih dari SKU), masuk ke keranjang sebagai item
  // khusus (sku: null) yang nanti dicocokkan manual sama petugas gudang.
  let customItemOpen = false;
  let customItemName = '';
  let customItemQty = 1;
  // "Cek Status Pesanan" — device-nya dipakai gantian antar-karyawan (dapet
  // nomor antrian, terus digantiin orang berikutnya buat pesan, HP-nya
  // bukan dipegang terus sama yang pesan pertama), jadi butuh cara balik
  // ngecek status pesanan LAMA tanpa perlu link #/tiket/:id (UUID panjang,
  // nggak kepegang lagi begitu pindah halaman) — cukup ketik nomor antrian
  // yang gampang diinget/dicatat manual ("A-0001").
  let cekStatusOpen = false;
  let cekQueueValue = '';
  let submitting = false;
  let submitError = '';

  let ticket = null;       // record pesanan (+ items) yang lagi ditampilin
  let ticketError = '';
  let shortageSending = false;
  let pollTimer = null;

  function divisiOfDept(d) { return ((d || '').split(' / ')[0] || '').trim(); }
  function subDivisiOfDept(d) { return ((d || '').split(' / ')[1] || '').trim(); }
  function jabatanFallback(d) { return ((d || '').split(' / ')[2] || '').trim(); }
  // Huruf depan nomor antrian ngikut inisial divisi (Denim -> D, Spinning ->
  // S, Umum -> U). Nomor urutnya (divisi_seq) sekarang PER DIVISI — reset ke
  // 0001 lagi tiap ganti divisi (D-0001, D-0002, ... lepas itu S-0001 mulai
  // dari 1 lagi, bukan nyambung dari nomor Denim) — diisi otomatis lewat
  // trigger Postgres (lihat database/pesanan_schema.sql), BUKAN dihitung di
  // sini, biar aman dari duplikat kalau 2 pesanan masuk hampir bersamaan.
  // Kalau nanti ada divisi baru yang inisialnya sama (jarang, tapi bisa),
  // tinggal tambah aturan khusus di sini.
  function queuePrefix(divisi) {
    const d = (divisi || '').trim();
    return d ? d.charAt(0).toUpperCase() : 'A';
  }
  function queueLabel(p) { return queuePrefix(p.divisi) + '-' + String(p.divisi_seq != null ? p.divisi_seq : p.queue_no).padStart(4, '0'); }
  function fmtDateTime(v) { return v ? new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'; }

  async function loadMaster() {
    if (masterLoaded) return;
    try {
      const [k, s] = await Promise.all([window.SPB.dbKaryawan.list(), window.SPB.dbStokBarang.list()]);
      karyawanAll = k;
      stokAll = s;
      const set = {};
      karyawanAll.forEach(function (kk) { const v = divisiOfDept(kk.department); if (v) set[v] = true; });
      divisiOptions = Object.keys(set).sort();
      masterLoaded = true;
    } catch (err) {
      masterError = err.message || 'Gagal memuat data.';
    }
  }

  // Refresh browser (F5) selalu bikin JS state ke-reset total (step, form
  // yang lagi diisi, isi keranjang) — sebelum ini bikin karyawan yang lagi
  // di tengah isi form/katalog tiba-tiba "dilempar" balik ke halaman pilih
  // divisi. Disimpan ke sessionStorage tiap draw() (kecuali step 'tiket',
  // itu udah difetch ulang dari ID di hash) dan dibaca lagi begitu render()
  // dipanggil ulang (baik dari load pertama MAUPUN dari refresh) — SELAMA
  // masih di divisi yang sama, biar buka link divisi lain tetap mulai bersih.
  const RESUME_KEY = 'spb_pesan_resume_v1';
  function saveResumeState() {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({
        divisiLocked: divisiLocked, step: step, form: form, cart: cart,
        catalogQ: catalogQ, catalogCategory: catalogCategory, catalogStock: catalogStock, catalogPage: catalogPage,
      }));
    } catch (e) { /* private mode dsb — biarin, fallback-nya cuma nggak bisa resume abis refresh */ }
  }
  function loadResumeState() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearResumeState() {
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) { /* abaikan */ }
  }

  /* ---------- Entry points (dipanggil dari app.js) ---------- */
  function render(divisi) {
    divisiLocked = divisi || '';
    const resume = loadResumeState();
    if (resume && resume.divisiLocked === divisiLocked && (resume.step === 'form' || resume.step === 'katalog')) {
      step = resume.step;
      form = resume.form || form;
      cart = resume.cart || [];
      catalogQ = resume.catalogQ || '';
      catalogCategory = resume.catalogCategory || 'semua';
      catalogStock = resume.catalogStock || 'semua';
      catalogPage = resume.catalogPage || 1;
    } else {
      step = divisiLocked ? 'form' : 'pilih-divisi';
      if (divisiLocked) { form.divisi = divisiLocked; }
    }
    ticket = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    draw();
    if (!masterLoaded) {
      loadMaster().then(draw);
    }
  }

  function renderTiket(id) {
    step = 'tiket';
    ticket = null;
    ticketError = '';
    draw();
    window.SPB.dbPesanan.get(id).then(function (rec) {
      if (!rec) { ticketError = 'Pesanan tidak ditemukan — mungkin link-nya salah atau sudah kedaluwarsa.'; draw(); return; }
      ticket = rec;
      draw();
      startPolling(id);
    }).catch(function (err) {
      ticketError = err.message;
      draw();
    });
  }

  function startPolling(id) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      const cur = location.hash.replace(/^#/, '');
      if (cur.indexOf('/tiket/') !== 0 && cur.indexOf('/pesan') !== 0) { clearInterval(pollTimer); pollTimer = null; return; }
      window.SPB.dbPesanan.get(id).then(function (rec) {
        if (rec) { ticket = rec; draw(); }
      }).catch(function () { /* diam-diam gagal juga gapapa, dicoba lagi tick berikutnya */ });
    }, 8000);
  }

  /* ---------- Navigasi antar step ---------- */
  // pickDivisi/backToDivisiPicker SEKARANG ikut ganti location.hash (dulu
  // nggak — cuma ubah state di memori), soalnya kalau URL-nya tetap "#/pesan"
  // polos (nggak kebawa nama divisinya), refresh browser bakal baca hash itu
  // lagi dari awal -> divisiLocked keitung kosong -> resume state yang
  // tersimpan buat divisi tertentu jadi "nggak cocok" -> dianggap nggak
  // valid -> balik ke halaman pilih divisi (persis bug yang dilaporkan).
  // Ganti hash ini bakal mancing hashchange -> app.js manggil render() lagi
  // sekali lagi — nggak masalah, toh hasilnya sama (resume udah tersimpan).
  // "Ganti Divisi" itu tindakan SENGAJA mulai ulang — form yang lagi diisi
  // (nama, keperluan, dst) & keranjang sengaja dikosongin lagi di sini
  // (bukan cuma pas submit berhasil), termasuk resume state-nya, biar nggak
  // "nyangkut" pas balik lagi ke form nanti (baik pilih divisi yang sama
  // ataupun beda).
  function resetFormAndCart() {
    form = { nama: '', divisi: '', subDivisi: '', jabatan: '', nip: '', tujuan: '', mode: '', titipNama: '', catatan: '', urgent: false };
    cart = [];
    clearResumeState();
    // Kotak "Cek Status Pesanan" juga ikut ditutup+dikosongin — kalau nggak,
    // abis cek status terus mulai pesanan baru, kotaknya masih kebuka
    // nyisain nomor antrian yang tadi diketik.
    cekStatusOpen = false;
    cekQueueValue = '';
  }
  function pickDivisi(v) { resetFormAndCart(); divisiLocked = v; form.divisi = v; step = 'form'; location.hash = '#/pesan/' + encodeURIComponent(v); draw(); }
  function backToDivisiPicker() { resetFormAndCart(); step = 'pilih-divisi'; location.hash = '#/pesan'; draw(); }
  function backToForm() { step = 'form'; draw(); }

  // draw() ngerender ULANG SELURUH halaman (innerHTML diganti total) — kalau
  // dipanggil langsung dari tiap keystroke (oninput), elemen <input>-nya
  // sendiri ikut kebuat ulang jadi elemen BARU, fokus & posisi kursor ilang
  // (harus klik ulang tiap mau lanjut ngetik). redrawKeepFocus() nyimpen
  // dulu elemen mana yang lagi fokus + posisi kursornya (dari atribut id),
  // render ulang, terus kembaliin fokus & kursornya ke elemen yang baru.
  function redrawKeepFocus() {
    const active = document.activeElement;
    const id = active && active.id;
    const isTextField = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    const caret = (id && isTextField && typeof active.selectionStart === 'number') ? active.selectionStart : null;
    draw();
    if (id) {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        if (caret != null && el.setSelectionRange) {
          const pos = Math.min(caret, el.value.length);
          try { el.setSelectionRange(pos, pos); } catch (e) { /* input type number dsb nolak setSelectionRange — abaikan */ }
        }
      }
    }
  }

  function setFormField(key, value) { form[key] = value; redrawKeepFocus(); }

  // Nama karyawan yang cocok sama teks yang lagi diketik — SUBSTRING match
  // (bukan cuma awalan), dibatasi divisi yang lagi dipilih (kalau ada),
  // dibatasi 8 hasil teratas biar dropdown-nya nggak kepanjangan.
  function karyawanMatches(query, divisiFilter) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const pool = divisiFilter
      ? karyawanAll.filter(function (k) { return divisiOfDept(k.department) === divisiFilter; })
      : karyawanAll;
    return pool.filter(function (k) { return k.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
  }
  function fillFromKaryawan(k) {
    form.divisi = divisiLocked || divisiOfDept(k.department);
    form.subDivisi = subDivisiOfDept(k.department);
    form.jabatan = k.jabatan || jabatanFallback(k.department);
    form.nip = k.nip || '';
  }

  // ---------------------------------------------------------------------
  // PENTING: field nama & titip TIDAK PERNAH memicu draw()/redrawKeepFocus()
  // lagi selagi diketik. Percobaan sebelumnya (redraw seluruh #app tiap
  // keystroke, walau fokus & kursor "dikembalikan" manual) tetap kepotong di
  // beberapa browser — begitu <input>-nya sendiri ikut kebuat ulang, kursor
  // ketik (caret blink)-nya ilang walau value-nya kelihatan bener. Makanya
  // sekarang inputnya dibiarkan DIAM (nggak pernah disentuh ulang oleh
  // draw()) — yang di-update cuma isi div dropdown & hint di bawahnya lewat
  // DOM langsung (innerHTML elemen lain, bukan punya si input).
  // ---------------------------------------------------------------------
  function namaDropdownHtml(query, divisiFilter, selectFnName) {
    // Dibatasi ke divisi yang lagi dikunci (kalau ada) — SEKARANG aman
    // dilakukan lagi karena sumber data karyawan udah ganti ke Google Sheet
    // "DATA INDEX" yang divisinya PERSIS sama teksnya (SPINNING/DENIM/UMUM)
    // kayak tombol pilih divisi di sini, beda dari dulu pas masih dari Odoo
    // yang teksnya nggak selalu cocok. Field "titip" tetap cari dari SEMUA
    // karyawan (divisiFilter dikirim '' dari situ) — orang yang dititipin
    // barang belum tentu 1 divisi sama.
    const matches = karyawanMatches(query, divisiFilter);
    if (!matches.length) return '<p class="pesan-autocomplete-empty">Nama nggak ketemu.</p>';
    return matches.map(function (k) {
      return '<button type="button" class="pesan-autocomplete-item" onmousedown="event.preventDefault();SPB.pesan.' + selectFnName + '(\'' + esc(k.name).replace(/'/g, "\\'") + '\')">' +
        '<span>' + esc(k.name) + '</span>' +
        (k.nip ? '<span class="pesan-autocomplete-nip">' + esc(k.nip) + '</span>' : '') +
        '</button>';
    }).join('');
  }
  function namaHintHtml() {
    return esc(form.jabatan || '-') + (form.nip ? ' · NIP ' + esc(form.nip) : '') + (form.subDivisi ? ' · ' + esc(form.subDivisi) : '');
  }
  function updateNamaDom() {
    const dd = document.getElementById('pesan-nama-dropdown');
    if (dd) {
      const show = namaDropdownOpen && form.nama;
      dd.hidden = !show;
      dd.innerHTML = show ? namaDropdownHtml(form.nama, divisiLocked, 'selectNama') : '';
    }
    const hint = document.getElementById('pesan-nama-hint');
    if (hint) {
      const show = !!(form.jabatan || form.nip);
      hint.hidden = !show;
      hint.innerHTML = show ? namaHintHtml() : '';
    }
  }
  function updateTitipDom() {
    const dd = document.getElementById('pesan-titip-dropdown');
    if (dd) {
      const show = titipDropdownOpen && form.titipNama;
      dd.hidden = !show;
      dd.innerHTML = show ? namaDropdownHtml(form.titipNama, '', 'selectTitip') : '';
    }
  }

  function onNamaInput(value) {
    form.nama = value;
    namaDropdownOpen = true;
    // Kalau kebetulan udah persis sama 1 nama di daftar (ketik lengkap atau
    // klik dari dropdown), langsung isi juga jabatan/NIP/sub-divisinya.
    const exact = karyawanAll.find(function (k) { return k.name.toLowerCase() === value.trim().toLowerCase(); });
    if (exact) fillFromKaryawan(exact);
    else { form.subDivisi = ''; form.jabatan = ''; form.nip = ''; if (!divisiLocked) form.divisi = ''; }
    updateNamaDom();
  }
  function openNamaDropdown() { namaDropdownOpen = true; updateNamaDom(); }
  function selectNama(name) {
    form.nama = name;
    namaDropdownOpen = false;
    const k = karyawanAll.find(function (kk) { return kk.name === name; });
    if (k) fillFromKaryawan(k);
    const input = document.getElementById('pesan-nama-input');
    if (input) input.value = name;
    updateNamaDom();
  }
  // Ditutup pakai jeda dikit (bukan langsung) — biar event klik di salah satu
  // baris dropdown sempat kejalan duluan sebelum dropdown-nya ilang (kalau
  // langsung ditutup pas blur, klik ke barisnya nggak akan pernah kena).
  function closeNamaDropdown() { setTimeout(function () { namaDropdownOpen = false; updateNamaDom(); }, 200); }

  function onTitipInput(value) { form.titipNama = value; titipDropdownOpen = true; updateTitipDom(); }
  function openTitipDropdown() { titipDropdownOpen = true; updateTitipDom(); }
  function selectTitip(name) {
    form.titipNama = name;
    titipDropdownOpen = false;
    const input = document.getElementById('pesan-titip-input');
    if (input) input.value = name;
    updateTitipDom();
  }
  function closeTitipDropdown() { setTimeout(function () { titipDropdownOpen = false; updateTitipDom(); }, 200); }

  function setMode(m) { form.mode = m; draw(); }
  function toggleUrgent() { form.urgent = !form.urgent; draw(); }

  function goToKatalog() {
    if (!form.nama.trim()) { window.SPB.ui.toast('Nama belum diisi', 'Ketik/pilih nama kamu dulu.', 'error'); return; }
    if (!form.tujuan) { window.SPB.ui.toast('Keperluan belum dipilih', 'Pilih dulu keperluannya.', 'error'); return; }
    if (!form.mode) { window.SPB.ui.toast('Jenis pemesanan belum dipilih', 'Pilih dulu Pesanan Umum atau Titip ke Shift Lain.', 'error'); return; }
    if (form.mode === 'titip' && !form.titipNama.trim()) { window.SPB.ui.toast('Nama penerima titipan belum diisi', '', 'error'); return; }
    step = 'katalog';
    catalogSizeSettled = false; // baru masuk katalog lagi — boleh dikoreksi sekali di sini
    draw();
  }

  function setCatalogQ(v) { catalogQ = v; catalogPage = 1; redrawKeepFocus(); }
  function goToCatalogPage(p) { catalogPage = p; draw(); }
  function setCatalogCategory(c) { catalogCategory = c; catalogPage = 1; draw(); }
  function setCatalogStock(v) { catalogStock = v; catalogPage = 1; draw(); }

  function toggleCustomItem() {
    customItemOpen = !customItemOpen;
    if (!customItemOpen) { customItemName = ''; customItemQty = 1; }
    draw();
  }
  function setCustomItemName(v) { customItemName = v; redrawKeepFocus(); }
  function setCustomItemQty(v) { customItemQty = Math.max(1, Number(v) || 1); redrawKeepFocus(); }
  function addCustomItem() {
    if (!customItemName.trim()) { window.SPB.ui.toast('Deskripsi belum diisi', 'Ceritakan barangnya kira-kira apa/buat apa.', 'error'); return; }
    // sku SENGAJA null — ini item "nggak yakin nama pastinya", nanti petugas
    // gudang yang mencocokkan manual pas proses pesanannya, bukan ditarik
    // otomatis dari stok_barang kayak item katalog biasa.
    cart.push({ cid: 'c' + (++cartSeq), sku: null, nama_barang: customItemName.trim() + ' (dari deskripsi karyawan)', satuan: '', tersedia: null, qty: customItemQty, distribusiMode: 'belum', distribusi: [] });
    customItemOpen = false;
    customItemName = '';
    customItemQty = 1;
    draw();
    window.SPB.ui.toast('Ditambahkan', 'Nanti petugas gudang yang bantu cocokkan barangnya.', 'success');
  }

  function toggleCekStatus() {
    cekStatusOpen = !cekStatusOpen;
    if (!cekStatusOpen) cekQueueValue = '';
    draw();
  }
  function setCekQueueValue(v) { cekQueueValue = v; redrawKeepFocus(); }
  async function submitCekStatus() {
    const q = cekQueueValue.trim();
    if (!q) { window.SPB.ui.toast('Nomor antrian belum diisi', 'Ketik nomor antrian kamu, mis. A-0001.', 'error'); return; }
    try {
      const rec = await window.SPB.dbPesanan.getByQueueNo(q);
      if (!rec) { window.SPB.ui.toast('Nggak ketemu', 'Nomor antrian "' + q + '" nggak ada — cek lagi penulisannya.', 'error'); return; }
      location.hash = '#/tiket/' + rec.id;
    } catch (err) {
      window.SPB.ui.toast('Gagal cek status', err.message, 'error');
    }
  }

  // Cart item butuh id sendiri (cid) yang beda dari sku — item "tulis
  // manual" (lihat addCustomItem) sku-nya SENGAJA null, jadi kalau
  // add/hapus/ubah qty masih dicocokkan lewat sku, dua item manual bakal
  // ketuker/nimpa satu sama lain.
  let cartSeq = 0;
  function addToCart(sku) {
    const item = stokAll.find(function (s) { return s.sku === sku; });
    if (!item) return;
    const existing = cart.find(function (c) { return c.sku === sku; });
    if (existing) { existing.qty += 1; }
    else cart.push({ cid: 'c' + (++cartSeq), sku: item.sku, nama_barang: item.product_name, satuan: item.uom, tersedia: Number(item.qty_available || 0), qty: 1, distribusiMode: 'belum', distribusi: [] });
    draw();
  }
  // Qty barang (by sku) yang lagi ada di keranjang — buat nampilin stepper
  // "− qty +" di kartu katalog (0 kalau belum ditambahkan sama sekali).
  function catalogQtyFor(sku) {
    const c = cart.find(function (x) { return x.sku === sku; });
    return c ? c.qty : 0;
  }
  // Tombol "-" di kartu katalog: kurangin 1, kalau nyampe 0 ya dihapus dari
  // keranjang sekalian (bukan nyisain baris qty 0 yang nggak ada gunanya).
  function decCatalogQty(sku) {
    const c = cart.find(function (x) { return x.sku === sku; });
    if (!c) return;
    if (c.qty <= 1) cart = cart.filter(function (x) { return x.cid !== c.cid; });
    else c.qty -= 1;
    draw();
  }
  function setCartQty(cid, qty) {
    const c = cart.find(function (x) { return x.cid === cid; });
    if (c) {
      c.qty = Math.max(1, Number(qty) || 1);
      // Belum dibagi ke siapa pun (masih 1 baris = pemesan sendiri) —
      // qty-nya ikut nyesuain otomatis. Udah kepecah ke beberapa penerima ->
      // dibiarin, biar pemesan yang atur ulang manual (jangan asal nimpa).
      if (c.distribusi && c.distribusi.length === 1) c.distribusi[0].qty = c.qty;
    }
    draw();
  }
  function removeFromCart(cid) { cart = cart.filter(function (c) { return c.cid !== cid; }); draw(); }

  // ---------------------------------------------------------------------
  // Distribusi ke Karyawan (per barang di keranjang) — dulu ini diisi
  // BELAKANGAN sama petugas gudang di WH/OUT (lihat whOutDetail.js, pola
  // dist-row/qtyGapLevel/dsb dipakai ulang di sini persis), sekarang
  // dipindah ke sini biar KARYAWAN YANG PESAN sendiri yang nentuin barangnya
  // buat siapa aja & kondisinya gimana (Habis/Tukar/Hilang/Baru) — SAAT
  // pesan, bukan nunggu barang beneran diambil.
  //
  // Default-nya SATU baris = pemesan sendiri, dapet semua qty-nya. Bisa
  // ditambah baris lain ("+ Bagi ke orang lain") buat mecah ke beberapa
  // penerima, masing-masing punya nama (autocomplete dari data karyawan
  // yang sama kayak field Nama Karyawan) + qty + kondisi sendiri-sendiri.
  // ---------------------------------------------------------------------
  const KONDISI_OPTIONS = ['Habis', 'Tukar', 'Hilang', 'Baru'];
  let distRowSeq = 0;
  function defaultDistribusiRow(qty) {
    return { id: 'd' + (++distRowSeq), nama: form.nama || '', qty: qty, kondisi: null, dropdownOpen: false };
  }
  // Gerbang keputusan distribusi (sama pola dengan whOutDetail.js) — jangan
  // langsung nampilin baris-baris distribusi begitu barang masuk keranjang,
  // tapi tanya dulu mau dibagi gimana:
  //   'belum'         -> 3 tombol keputusan, belum ada distribusi
  //   'tidak-dibagi'  -> 1 baris otomatis: nama = form.nama, qty = qty barang
  //   'bersama-divisi'-> 1 baris "Dipakai Bersama Divisi" (is_shared flag)
  //   'dibagi'        -> baris-baris editable (multi penerima), UI lama
  function setDistribusiMode(cid, mode) {
    const c = cart.find(function (x) { return x.cid === cid; });
    if (!c) return;
    c.distribusiMode = mode;
    if (mode === 'tidak-dibagi') {
      c.distribusi = [{ id: 'd' + (++distRowSeq), nama: form.nama || '', qty: c.qty, kondisi: null, dropdownOpen: false }];
    } else if (mode === 'bersama-divisi') {
      c.distribusi = [{ id: 'd' + (++distRowSeq), nama: '', qty: c.qty, kondisi: null, dropdownOpen: false, is_shared: true }];
    } else if (mode === 'dibagi') {
      c.distribusi = [{ id: 'd' + (++distRowSeq), nama: '', qty: c.qty, kondisi: null, dropdownOpen: false }];
    } else {
      c.distribusi = [];
    }
    draw();
  }
  function backToDistDecision(cid) {
    const c = cart.find(function (x) { return x.cid === cid; });
    if (!c) return;
    c.distribusiMode = 'belum';
    c.distribusi = [];
    draw();
  }
  function addDistribusiRow(cid) {
    const c = cart.find(function (x) { return x.cid === cid; });
    if (!c) return;
    c.distribusi.push({ id: 'd' + (++distRowSeq), nama: '', qty: 1, kondisi: null, dropdownOpen: false });
    draw();
  }
  function removeDistribusiRow(cid, rowId) {
    const c = cart.find(function (x) { return x.cid === cid; });
    if (!c || c.distribusi.length <= 1) return; // minimal 1 baris — nggak boleh nyisa 0
    c.distribusi = c.distribusi.filter(function (r) { return r.id !== rowId; });
    draw();
  }
  function setDistribusiQty(cid, rowId, qty) {
    const c = cart.find(function (x) { return x.cid === cid; });
    const r = c && c.distribusi.find(function (x) { return x.id === rowId; });
    if (r) r.qty = Math.max(1, Number(qty) || 1);
    draw();
  }
  function setDistribusiKondisi(cid, rowId, kondisi) {
    const c = cart.find(function (x) { return x.cid === cid; });
    const r = c && c.distribusi.find(function (x) { return x.id === rowId; });
    if (r) r.kondisi = (r.kondisi === kondisi) ? null : kondisi;
    draw();
  }
  // Input nama per baris distribusi — SEKARANG pola DOM-patch, SAMA PERSIS
  // kayak field Nama Karyawan utama (updateNamaDom/onNamaInput di atas),
  // BUKAN full redraw lagi. Full redraw (draw()/redrawKeepFocus()) ngeganti
  // innerHTML seluruh halaman, dan itu bikin <input> yang lagi difokus ikut
  // ke-destroy+dibikin ulang — biarpun fokusnya "dikembaliin" abis itu,
  // proses destroy-nya sendiri trigger blur ke browser, jadi kerasa kayak
  // "harus klik ulang" tiap ngetik. Sekarang input-nya SAMA SEKALI nggak
  // pernah disentuh draw() pas lagi ngetik — cuma div dropdown-nya doang
  // yang di-update langsung lewat DOM (innerHTML/hidden punya div itu).
  function distNamaDropdownHtml(cid, rowId, query) {
    const matches = karyawanMatches(query, divisiLocked);
    if (!matches.length) return '';
    return matches.map(function (k) {
      return '<button type="button" class="pesan-autocomplete-item" onmousedown="event.preventDefault();SPB.pesan.selectDistNama(\'' + cid + '\', \'' + rowId + '\', \'' + esc(k.name).replace(/'/g, "\\'") + '\')">' +
        '<span>' + esc(k.name) + '</span>' + (k.nip ? '<span class="pesan-autocomplete-nip">' + esc(k.nip) + '</span>' : '') + '</button>';
    }).join('');
  }
  function updateDistNamaDom(cid, rowId) {
    const c = cart.find(function (x) { return x.cid === cid; });
    const r = c && c.distribusi.find(function (x) { return x.id === rowId; });
    if (!r) return;
    const dd = document.getElementById('dist-dropdown-' + rowId);
    if (!dd) return;
    const show = !!(r.dropdownOpen && r.nama);
    dd.hidden = !show;
    dd.innerHTML = show ? distNamaDropdownHtml(cid, rowId, r.nama) : '';
  }
  function onDistNamaInput(cid, rowId, value) {
    const c = cart.find(function (x) { return x.cid === cid; });
    const r = c && c.distribusi.find(function (x) { return x.id === rowId; });
    if (!r) return;
    r.nama = value;
    r.dropdownOpen = true;
    updateDistNamaDom(cid, rowId);
  }
  function selectDistNama(cid, rowId, name) {
    const c = cart.find(function (x) { return x.cid === cid; });
    const r = c && c.distribusi.find(function (x) { return x.id === rowId; });
    if (!r) return;
    r.nama = name;
    r.dropdownOpen = false;
    const input = document.getElementById('dist-nama-' + rowId);
    if (input) input.value = name;
    updateDistNamaDom(cid, rowId);
  }
  function closeDistDropdown(cid, rowId) {
    setTimeout(function () {
      const c = cart.find(function (x) { return x.cid === cid; });
      const r = c && c.distribusi.find(function (x) { return x.id === rowId; });
      if (!r) return;
      r.dropdownOpen = false;
      updateDistNamaDom(cid, rowId);
    }, 150);
  }
  // Sama kayak qtyGapLevel() di whOutDetail.js — kalau pembagian antar
  // penerima timpang banget, langsung diwarning di sini juga.
  function qtyGapLevel(gap) {
    if (gap >= 5) return { label: 'Selisih Besar', badge: 'badge-rejected' };
    if (gap >= 2) return { label: 'Selisih Cukup Besar', badge: 'badge-inspection' };
    return null;
  }
  // 3 tombol keputusan versi KECIL — dipasang di samping nama barang di baris
  // keranjang (bukan blok gede di bawah), cuma ikon + tooltip lewat title="".
  function distDecisionButtonsHtml(c) {
    return '<div class="pesan-dist-mini">' +
      '<button type="button" class="pesan-dist-mini-btn" title="Tidak Dibagi — untuk ' + esc(form.nama || '(belum diisi)') + '" onclick="SPB.pesan.setDistribusiMode(\'' + c.cid + '\', \'tidak-dibagi\')">' +
        '<i data-lucide="user-check" class="icon-sm"></i><span>Barang Tidak Dibagi</span></button>' +
      '<button type="button" class="pesan-dist-mini-btn pesan-dist-mini-btn-primary" title="Bagikan ke Beberapa Karyawan" onclick="SPB.pesan.setDistribusiMode(\'' + c.cid + '\', \'dibagi\')">' +
        '<i data-lucide="share-2" class="icon-sm"></i><span>Distribusi Barang ke Karyawan</span></button>' +
      '<button type="button" class="pesan-dist-mini-btn" title="Dipakai Bersama 1 Divisi" onclick="SPB.pesan.setDistribusiMode(\'' + c.cid + '\', \'bersama-divisi\')">' +
        '<i data-lucide="building-2" class="icon-sm"></i><span>Dipakai untuk Bersama</span></button>' +
    '</div>';
  }
  function distribusiBlockHtml(c) {
    const mode = c.distribusiMode || 'belum';
    // Belum dipilih -> tombolnya udah dipasang kecil di samping nama barang
    // (lihat distDecisionButtonsHtml), jadi di sini nggak perlu render apa-apa.
    if (mode === 'belum') return '';
    // 'tidak-dibagi' & 'bersama-divisi' -> cuma 1 baris ringkas (kondisi +
    // ubah keputusan), nggak perlu input nama/qty per baris kayak mode 'dibagi'.
    if (mode === 'tidak-dibagi' || mode === 'bersama-divisi') {
      const r = (c.distribusi || [])[0] || { id: 'd0', kondisi: null };
      const label = mode === 'bersama-divisi'
        ? '<span><i data-lucide="building-2" class="icon-sm"></i> Dipakai Bersama Divisi</span>'
        : '<span><i data-lucide="user-check" class="icon-sm"></i> Untuk ' + esc(form.nama || '-') + '</span>';
      return '<div class="pesan-dist-block">' +
        '<p class="pesan-dist-label">Distribusi ke Karyawan</p>' +
        '<div class="pesan-dist-row">' +
          '<div style="flex:1;min-width:0;display:flex;align-items:center;gap:0.375rem;font-size:0.8125rem">' + label + '</div>' +
          '<div class="pesan-kondisi-row" style="padding:0">' +
            KONDISI_OPTIONS.map(function (k) {
              return '<label class="pesan-kondisi-chip' + (r.kondisi === k ? ' active' : '') + '">' +
                '<input type="checkbox" ' + (r.kondisi === k ? 'checked' : '') + ' onchange="SPB.pesan.setDistribusiKondisi(\'' + c.cid + '\', \'' + r.id + '\', \'' + k + '\')">' + k +
              '</label>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<button type="button" class="pesan-dist-add" onclick="SPB.pesan.backToDistDecision(\'' + c.cid + '\')"><i data-lucide="rotate-ccw" class="icon-sm"></i>Ubah keputusan</button>' +
      '</div>';
    }
    // mode === 'dibagi' -> UI lama, multi-baris editable.
    const dist = c.distribusi || [];
    const qtys = dist.map(function (r) { return Number(r.qty); });
    const maxQty = qtys.length ? Math.max.apply(null, qtys) : 0;
    const minQty = qtys.length ? Math.min.apply(null, qtys) : 0;
    const gap = maxQty - minQty;
    const gapLevel = dist.length > 1 ? qtyGapLevel(gap) : null;
    const warning = gapLevel
      ? '<div class="alert-banner alert-banner-danger" style="margin:0 0 0.625rem">' +
          '<i data-lucide="alert-triangle" class="icon-sm"></i>' +
          '<div>Pembagian ' + esc(c.nama_barang) + ' tidak rata — selisih qty antar penerima ' + gap + ' ' + esc(c.satuan || '') + ' (' + minQty + ' vs ' + maxQty + ').</div>' +
        '</div>'
      : '';
    const rowsHtml = dist.map(function (r) {
      const rowFlag = gapLevel && (Number(r.qty) === maxQty || Number(r.qty) === minQty)
        ? '<span class="badge ' + gapLevel.badge + '" style="margin-left:0.375rem"><span class="badge-dot"></span>' + gapLevel.label + '</span>' : '';
      const showDropdown = !!(r.dropdownOpen && r.nama);
      return '<div class="pesan-dist-row">' +
        '<div class="pesan-autocomplete-wrap" style="flex:1;min-width:0">' +
          '<input type="text" id="dist-nama-' + r.id + '" class="input" style="font-size:0.8125rem;padding:0.4375rem 0.625rem" placeholder="Nama penerima..." autocomplete="off" ' +
            'value="' + esc(r.nama) + '" oninput="SPB.pesan.onDistNamaInput(\'' + c.cid + '\', \'' + r.id + '\', this.value)" onblur="SPB.pesan.closeDistDropdown(\'' + c.cid + '\', \'' + r.id + '\')">' +
          // Div dropdown-nya SELALU ada di markup (bukan cuma dirender kalau
          // ada matches) — biar updateDistNamaDom() bisa getElementById-nya
          // konsisten kapan pun, nggak perlu nunggu full redraw dulu.
          '<div class="pesan-autocomplete-list" id="dist-dropdown-' + r.id + '"' + (showDropdown ? '' : ' hidden') + '>' +
            (showDropdown ? distNamaDropdownHtml(c.cid, r.id, r.nama) : '') +
          '</div>' +
        '</div>' +
        '<div class="pesan-kondisi-row" style="padding:0">' +
          KONDISI_OPTIONS.map(function (k) {
            return '<label class="pesan-kondisi-chip' + (r.kondisi === k ? ' active' : '') + '">' +
              '<input type="checkbox" ' + (r.kondisi === k ? 'checked' : '') + ' onchange="SPB.pesan.setDistribusiKondisi(\'' + c.cid + '\', \'' + r.id + '\', \'' + k + '\')">' + k +
            '</label>';
          }).join('') +
        '</div>' +
        rowFlag +
        '<input type="number" min="1" class="input pesan-cart-qty" style="font-size:0.8125rem" value="' + r.qty + '" onchange="SPB.pesan.setDistribusiQty(\'' + c.cid + '\', \'' + r.id + '\', this.value)">' +
        (dist.length > 1 ? '<button type="button" class="dist-row-del" onclick="SPB.pesan.removeDistribusiRow(\'' + c.cid + '\', \'' + r.id + '\')"><i data-lucide="x" class="icon-sm"></i></button>' : '') +
      '</div>';
    }).join('');
    return '<div class="pesan-dist-block">' +
      '<p class="pesan-dist-label">Distribusi ke Karyawan</p>' +
      warning + rowsHtml +
      '<div style="display:flex;gap:0.5rem;flex-wrap:wrap">' +
        '<button type="button" class="pesan-dist-add" onclick="SPB.pesan.addDistribusiRow(\'' + c.cid + '\')"><i data-lucide="plus" class="icon-sm"></i>Bagi ke orang lain</button>' +
        '<button type="button" class="pesan-dist-add" onclick="SPB.pesan.backToDistDecision(\'' + c.cid + '\')"><i data-lucide="rotate-ccw" class="icon-sm"></i>Ubah keputusan</button>' +
      '</div>' +
    '</div>';
  }

  async function submitOrder() {
    if (submitting) return;
    if (!cart.length) { window.SPB.ui.toast('Keranjang kosong', 'Pilih minimal 1 barang dulu.', 'error'); return; }
    submitting = true;
    submitError = '';
    draw();
    try {
      const header = {
        karyawan_name: form.nama.trim(),
        nip: form.nip || null,
        divisi: form.divisi || null,
        sub_divisi: form.subDivisi || null,
        jabatan: form.jabatan || null,
        tujuan: form.tujuan || null,
        mode: form.mode,
        titip_ke_name: form.mode === 'titip' ? form.titipNama.trim() : null,
        catatan: form.catatan || null,
        is_urgent: !!form.urgent,
        status: 'waiting',
      };
      // "distribusi" disimpen per-item (bukan kondisi tunggal lagi) — daftar
      // penerima + qty + kondisi masing-masing, hasil dari fitur "Distribusi
      // ke Karyawan" di keranjang.
      const items = cart.map(function (c) {
        return {
          sku: c.sku, nama_barang: c.nama_barang, qty: c.qty, satuan: c.satuan,
          distribusi: (c.distribusi || []).map(function (r) { return { nama: r.nama || null, qty: r.qty, kondisi: r.kondisi || null }; }),
        };
      });
      const created = await window.SPB.dbPesanan.create(header, items);
      submitting = false;
      cart = [];
      clearResumeState(); // pesanan udah kekirim — jangan sampe refresh di tiket malah "resume" balik ke form/keranjang lama
      location.hash = '#/tiket/' + created.id;

      // Otomatis kirim ke Odoo di belakang layar — TANPA di-await, karyawan
      // nggak perlu nunggu round-trip ke Odoo cuma buat lihat nomor
      // antriannya. Kalau gagal (mis. Odoo lagi down), bukan error yang
      // perlu ditunjukin ke karyawan — pesanan.wh_out_ref bakal tetap kosong,
      // admin masih bisa kirim manual lewat tombol "Kirim ke Odoo" di
      // dashboard (lihat permintaan.js) sebagai cadangan.
      window.SPB.dbPesanan.sendToOdoo(created.id).then(function (result) {
        if (result && result.wh_out_ref) {
          const CFG = window.SPB_CONFIG;
          // Sync balik odoo-pull-wh-out biar nomor WH/OUT-nya langsung
          // nongol di Log Pengeluaran SPB, nggak perlu nunggu cron.
          fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-pull-wh-out', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
            body: JSON.stringify({}),
          }).catch(function () { /* gagal sync balik gapapa, kejaring cron berikutnya */ });
          // odoo-create-wh-out sekarang langsung confirm+reserve (kayak
          // checkout Shopee — dikunci duluan walau belum potong stok) — tarik
          // ulang Stok Barang juga biar kolom "Direservasi" di dashboard
          // admin langsung update, nggak nunggu cron 5 menitan.
          fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-pull-stock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
            body: JSON.stringify({}),
          }).catch(function () { /* gagal sync balik gapapa, kejaring cron berikutnya */ });
        }
      }).catch(function (err) {
        console.error('Auto-kirim ke Odoo gagal (masih bisa dikirim manual dari dashboard admin):', err);
      });
    } catch (err) {
      submitting = false;
      submitError = err.message || 'Gagal mengirim permintaan.';
      draw();
    }
  }

  function newOrder() {
    resetFormAndCart(); // sekalian nutup+ngosongin kotak "Cek Status Pesanan" kalau lagi kebuka
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // "+ Pesanan Baru" dari tiket balik ke halaman "Pilih Divisi" (bukan
    // lanjut ke form divisi yang sama) — device dipakai gantian antar
    // karyawan dari divisi yang beda-beda, jadi lebih aman mulai dari awal
    // lagi daripada nebak divisi orang berikutnya sama kayak sebelumnya.
    render('');
    location.hash = '#/pesan';
  }

  async function submitShortage() {
    if (!ticket || shortageSending) return;
    const nama = document.getElementById('shortage-item') ? document.getElementById('shortage-item').value : '';
    const qty = document.getElementById('shortage-qty') ? document.getElementById('shortage-qty').value : '';
    if (!nama || !qty || Number(qty) <= 0) { window.SPB.ui.toast('Isi dulu', 'Pilih barang & jumlah yang kurang.', 'error'); return; }
    shortageSending = true; draw();
    try {
      const existing = (ticket.shortage_report && Array.isArray(ticket.shortage_report)) ? ticket.shortage_report : [];
      const updated = existing.concat([{ nama_barang: nama, qty: Number(qty), reported_at: new Date().toISOString() }]);
      await window.SPB.sb.from('pesanan').update({ shortage_report: updated }).eq('id', ticket.id);
      ticket.shortage_report = updated;
      window.SPB.ui.toast('Laporan terkirim', 'Petugas gudang akan meninjau laporan kekurangan barang ini.', 'success');
    } catch (err) {
      window.SPB.ui.toast('Gagal mengirim laporan', err.message, 'error');
    }
    shortageSending = false; draw();
  }

  /* ---------- Render ---------- */
  function topbarHtml(title) {
    // Khusus di step Katalog Barang — judul besar "Permintaan Barang
    // Sparepart" + ikon dihilangkan (udah kepakai di step-step sebelumnya,
    // di sini cuma makan tempat di atas grid barang yang butuh ruang), nama
    // PT & subjudulnya digedein sebagai gantinya biar tetap ada identitas
    // headernya tapi lebih ringkas.
    if (step === 'katalog') {
      return '<div class="pesan-topbar pesan-topbar-compact">' +
        '<div class="pesan-topbar-brand">' +
          '<p class="pesan-topbar-company">Sparepart PT Triputra Textile Industry</p>' +
          '<p class="pesan-topbar-sub">' + esc(title) + '</p>' +
        '</div>' +
      '</div>';
    }
    return '<div class="pesan-topbar">' +
      '<div class="pesan-topbar-brand">' +
        '<i data-lucide="package" class="icon-md"></i>' +
        '<p class="pesan-topbar-title">Permintaan Barang Sparepart</p>' +
        '<p class="pesan-topbar-company">Sparepart PT Triputra Textile Industry</p>' +
        '<p class="pesan-topbar-sub">' + esc(title) + '</p>' +
      '</div>' +
    '</div>';
  }

  function pilihDivisiHtml() {
    return topbarHtml('Pilih divisi kamu untuk mulai memesan') +
      '<div class="pesan-wrap pesan-wrap-divisi"><div class="pesan-card">' +
        '<h1 class="pesan-title">Pilih Divisi</h1>' +
        '<p class="pesan-sub">Klik divisi kamu supaya form-nya langsung sesuai.</p>' +
        (masterError ? '<div class="login-error"><i data-lucide="alert-circle" class="icon-sm"></i>' + esc(masterError) + '</div>' : '') +
        (!masterLoaded && !masterError
          ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat daftar divisi...</div>'
          : '<div class="pesan-divisi-grid">' +
              divisiOptions.map(function (v) {
                return '<button type="button" class="pesan-divisi-btn" onclick="SPB.pesan.pickDivisi(\'' + esc(v).replace(/'/g, "\\'") + '\')">' +
                  '<i data-lucide="building-2" class="icon-md"></i>' + esc(v) + '</button>';
              }).join('') +
            '</div>') +
        // Device dipakai gantian antar-karyawan — orang yang udah dapet
        // nomor antrian butuh cara balik ngecek statusnya lagi nanti tanpa
        // perlu link #/tiket/:id (nggak kepegang lagi begitu HP-nya
        // digantiin ke orang berikutnya buat pesan).
        (cekStatusOpen
          ? '<div class="pesan-custom-box pesan-cekstatus-box" style="margin-top:1.25rem">' +
              '<p class="pesan-custom-title" style="color:var(--brand-700)">Cek Status Pesanan</p>' +
              '<input type="text" id="pesan-cekqueue-input" class="input" placeholder="Nomor antrian, mis. A-0001" autocomplete="off" style="text-align:center" ' +
                'value="' + esc(cekQueueValue) + '" oninput="SPB.pesan.setCekQueueValue(this.value)" ' +
                'onkeydown="if(event.key===\'Enter\'){event.preventDefault();SPB.pesan.submitCekStatus();}">' +
              '<div class="pesan-cekstatus-actions">' +
                '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.pesan.toggleCekStatus()">Batal</button>' +
                '<button type="button" class="btn btn-primary btn-sm pesan-cekstatus-submit" onclick="SPB.pesan.submitCekStatus()"><i data-lucide="search" class="icon-sm"></i>Cek Status</button>' +
              '</div>' +
            '</div>'
          : '<button type="button" class="btn btn-outline pesan-cekstatus-btn" style="width:100%;margin-top:1.25rem" onclick="SPB.pesan.toggleCekStatus()">' +
              '<i data-lucide="clock" class="icon-md"></i>Sudah pernah pesan? Cek status pesananmu</button>') +
      '</div></div>';
  }

  function formHtml() {
    return topbarHtml((divisiLocked ? 'Divisi ' + divisiLocked : 'Semua Divisi') + ' — isi data pemesanan') +
      '<div class="pesan-wrap"><div class="pesan-card">' +
        (divisiLocked ? '<button type="button" class="pesan-back" onclick="SPB.pesan.backToDivisiPicker()"><i data-lucide="arrow-left" class="icon-sm"></i>Ganti Divisi</button>' : '') +
        '<h1 class="pesan-title pesan-title-lg pesan-title-center">Data Pemesanan</h1>' +
        '<label class="field-label" style="margin-top:1rem">Nama Karyawan *</label>' +
        '<div class="pesan-autocomplete-wrap">' +
          '<input type="text" id="pesan-nama-input" class="input" placeholder="Ketik nama kamu..." autocomplete="off" autocapitalize="off" ' +
            'value="' + esc(form.nama) + '" oninput="SPB.pesan.onNamaInput(this.value)" onfocus="SPB.pesan.openNamaDropdown()" onblur="SPB.pesan.closeNamaDropdown()">' +
          '<div class="pesan-autocomplete-list" id="pesan-nama-dropdown"' + (namaDropdownOpen && form.nama ? '' : ' hidden') + '>' +
            (namaDropdownOpen && form.nama ? namaDropdownHtml(form.nama, divisiLocked, 'selectNama') : '') +
          '</div>' +
        '</div>' +
        '<p class="pesan-hint" id="pesan-nama-hint"' + (form.jabatan || form.nip ? '' : ' hidden') + '>' + ((form.jabatan || form.nip) ? namaHintHtml() : '') + '</p>' +

        '<label class="field-label" style="margin-top:0.875rem">Keperluan *</label>' +
        '<select class="select-input" style="width:100%" onchange="SPB.pesan.setFormField(\'tujuan\', this.value)">' +
          '<option value="">-- Pilih Keperluan --</option>' +
          '<option value="Kebutuhan Kantor (ATK)"' + (form.tujuan === 'Kebutuhan Kantor (ATK)' ? ' selected' : '') + '>Kebutuhan Kantor (ATK)</option>' +
        '</select>' +

        // Urgent — pesanan ini otomatis dinaikkan ke atas antrean admin
        // (bukan cuma badge doang), jadi taruhnya di level Data Pemesanan
        // (sifatnya buat 1 PESANAN, bukan per-barang di keranjang).
        '<label class="pesan-urgent-toggle' + (form.urgent ? ' active' : '') + '" style="margin-top:0.875rem">' +
          '<input type="checkbox" ' + (form.urgent ? 'checked' : '') + ' onchange="SPB.pesan.toggleUrgent()">' +
          '<i data-lucide="zap" class="icon-sm"></i>' +
          '<span><b>Tandai Urgent</b></span>' +
        '</label>' +

        '<label class="field-label" style="margin-top:0.875rem">Jenis Pemesanan *</label>' +
        '<div class="pesan-mode-grid">' +
          '<label class="pesan-mode-opt' + (form.mode === 'umum' ? ' active' : '') + '"><input type="radio" name="pesan-mode" ' + (form.mode === 'umum' ? 'checked' : '') + ' onchange="SPB.pesan.setMode(\'umum\')">' +
            '<div><b>Pesanan Umum</b><p>Untuk kebutuhan sendiri</p></div></label>' +
          '<label class="pesan-mode-opt' + (form.mode === 'titip' ? ' active' : '') + '"><input type="radio" name="pesan-mode" ' + (form.mode === 'titip' ? 'checked' : '') + ' onchange="SPB.pesan.setMode(\'titip\')">' +
            '<div><b>Titip ke Shift Lain</b><p>Diambil &amp; dibagikan orang lain</p></div></label>' +
        '</div>' +
        (form.mode === 'titip'
          ? '<div class="pesan-autocomplete-wrap" style="margin-top:0.5rem">' +
              '<input type="text" id="pesan-titip-input" class="input" placeholder="Nama penerima titipan..." autocomplete="off" autocapitalize="off" ' +
                'value="' + esc(form.titipNama) + '" oninput="SPB.pesan.onTitipInput(this.value)" onfocus="SPB.pesan.openTitipDropdown()" onblur="SPB.pesan.closeTitipDropdown()">' +
              '<div class="pesan-autocomplete-list" id="pesan-titip-dropdown"' + (titipDropdownOpen && form.titipNama ? '' : ' hidden') + '>' +
                (titipDropdownOpen && form.titipNama ? namaDropdownHtml(form.titipNama, '', 'selectTitip') : '') +
              '</div>' +
            '</div>'
          : '') +

        '<label class="field-label" style="margin-top:0.875rem">Catatan (opsional)</label>' +
        '<textarea id="pesan-catatan-input" class="textarea" rows="2" placeholder="Keterangan tambahan..." oninput="SPB.pesan.setFormField(\'catatan\', this.value)">' + esc(form.catatan) + '</textarea>' +

        '<button type="button" class="btn btn-primary" style="width:100%;margin-top:1.25rem" onclick="SPB.pesan.goToKatalog()">' +
          '<i data-lucide="shopping-cart" class="icon-sm"></i>Lanjut ke Katalog Barang</button>' +
      '</div></div>';
  }

  // Pagination katalog — pola sama dengan karyawan.js/laporan.js, tapi
  // dipakai lokal aja di sini (nggak perlu diekspor ke window.SPB.pesan
  // selain goToCatalogPage-nya sendiri, yang sudah didefinisikan di atas).
  function catalogPaginationHtml(page, totalPages, totalRows) {
    if (totalRows === 0) return '';
    if (totalPages <= 1) return '<div class="pagination"><span class="pagination-info">' + totalRows + ' barang</span></div>';
    const pages = [];
    const add = function (p) { if (pages.indexOf(p) === -1) pages.push(p); };
    add(1); add(totalPages);
    for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) add(p);
    pages.sort(function (a, b) { return a - b; });
    let numbersHtml = '';
    let prev = 0;
    pages.forEach(function (p) {
      if (p - prev > 1) numbersHtml += '<span class="pagination-ellipsis">…</span>';
      numbersHtml += '<button type="button" class="pagination-num' + (p === page ? ' active' : '') +
        '" onclick="SPB.pesan.goToCatalogPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' barang · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.pesan.goToCatalogPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.pesan.goToCatalogPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  // Link WA petugas gudang — jaring pengaman terakhir buat karyawan yang
  // beneran buntu. Nomornya diisi admin di config.js (GUDANG_WA_NUMBER);
  // kalau belum diisi, baris ini nggak ditampilin sama sekali (daripada
  // nampilin tombol yang nggak jelas nyambung ke mana).
  function gudangWaHtml() {
    const raw = (window.SPB_CONFIG && window.SPB_CONFIG.GUDANG_WA_NUMBER) || '';
    let digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    if (digits.charAt(0) === '0') digits = '62' + digits.slice(1); // 08xxx -> 628xxx (format wa.me)
    return '<p class="pesan-help-contact">Masih bingung juga? ' +
      '<a href="https://wa.me/' + digits + '" target="_blank" rel="noopener">Hubungi petugas gudang</a> langsung.</p>';
  }

  function katalogHtml() {
    const q = catalogQ.toLowerCase();
    // SEMUA barang di stok_barang (ATK maupun sparepart lain) — nggak ada
    // filter kategori di sini, dbStokBarang.list() sendiri udah narik SEMUA
    // baris dari Odoo (lihat catatan di stokBarangClient.js). Dulu di-.slice(0,60)
    // biar "nggak kepanjangan" — sekarang diganti page navigation beneran
    // (pola sama kayak Karyawan/WH-OUT) biar semua barang tetap bisa dicari &
    // dijangkau, bukan cuma 60 pertama.
    const filtered = stokAll.filter(function (s) {
      const qtyAvail = Number(s.qty_available || 0);
      return (!q || (s.product_name || '').toLowerCase().indexOf(q) !== -1 || (s.sku || '').toLowerCase().indexOf(q) !== -1)
        && (catalogCategory === 'semua' || s.category === catalogCategory)
        && (catalogStock === 'semua' || (catalogStock === 'ada' ? qtyAvail > 0 : qtyAvail <= 0));
    });
    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / catalogPageSize));
    if (catalogPage > totalPages) catalogPage = totalPages;
    if (catalogPage < 1) catalogPage = 1;
    const pageStart = (catalogPage - 1) * catalogPageSize;
    const pageRows = filtered.slice(pageStart, pageStart + catalogPageSize);

    const cartTotalQty = cart.reduce(function (a, c) { return a + c.qty; }, 0);

    // Tab kategori ATK/Lainnya — bantu karyawan yang cuma butuh ATK biar
    // nggak keder nyari di antara ribuan sparepart mesin. Kategorinya dari
    // kolom stok_barang.category (udah ditentuin Edge Function odoo-pull-stock
    // dari prefiks SKU "ATK*").
    const catTabsHtml = ['semua', 'ATK', 'Lainnya'].map(function (c) {
      const label = c === 'semua' ? 'Semua Barang' : (c === 'ATK' ? 'ATK / Kantor' : 'Sparepart Mesin');
      return '<button type="button" class="pesan-cat-tab' + (catalogCategory === c ? ' active' : '') + '" onclick="SPB.pesan.setCatalogCategory(\'' + c + '\')">' + label + '</button>';
    }).join('');

    // Filter status stok — biar karyawan bisa langsung nyaring barang yang
    // BENERAN ada stoknya (nggak buang waktu milih yang ternyata kosong),
    // atau sebaliknya ngecek barang apa aja yang lagi habis. Dropdown
    // (bukan tab) biar nggak makan baris ekstra di layar.
    const stockOptionsHtml = [
      { v: 'semua', label: 'Semua Status Stok' },
      { v: 'ada', label: 'Stok Tersedia' },
      { v: 'habis', label: 'Stok Habis' },
    ].map(function (t) {
      return '<option value="' + t.v + '"' + (catalogStock === t.v ? ' selected' : '') + '>' + t.label + '</option>';
    }).join('');

    return topbarHtml('Pilih barang yang mau dipesan') +
      '<div class="pesan-wrap pesan-wrap-full"><div class="pesan-card">' +
        '<button type="button" class="pesan-back" onclick="SPB.pesan.backToForm()"><i data-lucide="arrow-left" class="icon-sm"></i>Kembali</button>' +
        '<div class="pesan-title-row">' +
          '<span class="pesan-title-badge pesan-title-badge-katalog"><i data-lucide="package-search" class="icon-md"></i></span>' +
          '<h1 class="pesan-title" style="margin-bottom:0">Katalog Barang</h1>' +
        '</div>' +
        '<div class="pesan-cat-tabs">' + catTabsHtml + '</div>' +
        '<div class="pesan-catalog-filters">' +
          '<input type="text" id="pesan-catalog-search" class="input" placeholder="Cari barang..." autocomplete="off" value="' + esc(catalogQ) + '" oninput="SPB.pesan.setCatalogQ(this.value)">' +
          '<select class="select-input" onchange="SPB.pesan.setCatalogStock(this.value)">' + stockOptionsHtml + '</select>' +
        '</div>' +

        // Jaring pengaman buat karyawan yang nggak paham istilah teknis
        // sparepart / gak nemu barangnya di daftar — bisa nulis bebas pakai
        // kata-katanya sendiri, nanti dicocokkan manual sama petugas gudang.
        (customItemOpen
          ? '<div class="pesan-custom-box">' +
              '<p class="pesan-custom-title">Ceritakan barangnya (nggak perlu nama teknis)</p>' +
              '<textarea id="pesan-custom-name" class="textarea" rows="2" placeholder="Misal: baut kecil warna hitam buat mesin jahit, atau tinta printer warna hitam..." oninput="SPB.pesan.setCustomItemName(this.value)">' + esc(customItemName) + '</textarea>' +
              '<div style="display:flex;gap:0.5rem;margin-top:0.5rem;align-items:center">' +
                '<input type="number" min="1" id="pesan-custom-qty" class="input" style="width:5rem" value="' + customItemQty + '" onchange="SPB.pesan.setCustomItemQty(this.value)">' +
                '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.pesan.toggleCustomItem()">Batal</button>' +
                '<button type="button" class="btn btn-primary btn-sm" onclick="SPB.pesan.addCustomItem()"><i data-lucide="plus" class="icon-sm"></i>Tambah ke Keranjang</button>' +
              '</div>' +
            '</div>'
          : '<button type="button" class="pesan-custom-trigger" onclick="SPB.pesan.toggleCustomItem()"><i data-lucide="help-circle" class="icon-sm"></i>Nggak ketemu barangnya / nggak tahu nama pastinya? Tulis manual</button>') +

        // Dulu langsung nampilin "Barang tidak ditemukan" kalau pageRows
        // kosong, TERMASUK pas data barangnya (stokAll) sendiri masih dalam
        // proses dimuat dari server (mis. baru masuk katalog lewat resume
        // abis refresh) — bikin kesannya kayak "kategori ini beneran kosong"
        // padahal cuma lagi nunggu fetch selesai. Sekarang dibedain jelas.
        (!masterLoaded && !masterError
          ? '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat katalog barang...</div>'
          : masterError
            ? '<div class="login-error"><i data-lucide="alert-circle" class="icon-sm"></i>' + esc(masterError) + '</div>'
            : '<div class="pesan-catalog-grid">' +
          (pageRows.length ? pageRows.map(function (s) {
            const qty = Number(s.qty_available || 0);
            const habis = qty <= 0;
            const skuEsc = esc(s.sku).replace(/'/g, "\\'");
            const inCart = catalogQtyFor(s.sku);
            return '<div class="pesan-catalog-item' + (habis ? ' disabled' : '') + '">' +
              '<span class="pesan-stock-badge' + (habis ? ' out' : '') + '">' +
                '<i data-lucide="' + (habis ? 'x-circle' : 'check-circle-2') + '" class="icon-sm"></i>' +
                (habis ? 'Stok Habis' : 'Tersedia · ' + qty + ' ' + esc(s.uom || '')) +
              '</span>' +
              '<p class="pesan-catalog-name">' + esc(s.product_name) + '</p>' +
              '<p class="pesan-catalog-sku">' + esc(s.sku) + '</p>' +
              // Stepper "− qty +" (bukan tombol "+ Tambah" lagi) — nempel di
              // bawah tiap kartu (margin-top:auto di CSS) biar tetap sejajar
              // satu baris sama kartu lain walau panjang nama barangnya beda-beda.
              '<div class="pesan-catalog-stepper">' +
                '<button type="button" class="pesan-step-btn" ' + (inCart <= 0 ? 'disabled' : '') + ' onclick="SPB.pesan.decCatalogQty(\'' + skuEsc + '\')" aria-label="Kurangi"><i data-lucide="minus" class="icon-sm"></i></button>' +
                '<span class="pesan-step-qty' + (inCart > 0 ? ' active' : '') + '">' + inCart + '</span>' +
                '<button type="button" class="pesan-step-btn" ' + (habis ? 'disabled' : '') + ' onclick="SPB.pesan.addToCart(\'' + skuEsc + '\')" aria-label="Tambah"><i data-lucide="plus" class="icon-sm"></i></button>' +
              '</div>' +
            '</div>';
          }).join('') : '<div class="empty-state">Barang tidak ditemukan. Coba kata kunci lain, atau tulis manual di atas.</div>') +
        '</div>') +
        catalogPaginationHtml(catalogPage, totalPages, totalRows) +

        '<div class="pesan-cart-title-row">' +
          '<span class="pesan-title-badge pesan-title-badge-cart"><i data-lucide="shopping-basket" class="icon-sm"></i></span>' +
          '<h2 class="pesan-cart-title" style="margin-bottom:0">Keranjang (' + cartTotalQty + ' item)</h2>' +
        '</div>' +
        (cart.length
          ? '<div class="pesan-cart-list">' + cart.map(function (c) {
              return '<div class="pesan-cart-row-wrap">' +
                '<div class="pesan-cart-row">' +
                  '<span class="pesan-cart-name">' + esc(c.nama_barang) + '</span>' +
                  ((c.distribusiMode || 'belum') === 'belum' ? distDecisionButtonsHtml(c) : '') +
                  '<input type="number" min="1" class="input pesan-cart-qty" value="' + c.qty + '" onchange="SPB.pesan.setCartQty(\'' + c.cid + '\', this.value)">' +
                  '<span class="muted" style="font-size:0.75rem">' + esc(c.satuan || '') + '</span>' +
                  '<button type="button" class="dist-row-del" onclick="SPB.pesan.removeFromCart(\'' + c.cid + '\')"><i data-lucide="x" class="icon-sm"></i></button>' +
                '</div>' +
                distribusiBlockHtml(c) +
              '</div>';
            }).join('') + '</div>'
          : '<p class="muted" style="font-size:0.875rem">Keranjang masih kosong.</p>') +

        gudangWaHtml() +

        (submitError ? '<div class="login-error" style="margin-top:0.75rem"><i data-lucide="alert-circle" class="icon-sm"></i>' + esc(submitError) + '</div>' : '') +
        '<button type="button" class="btn btn-primary" style="width:100%;margin-top:1rem" ' + (submitting || !cart.length ? 'disabled' : '') + ' onclick="SPB.pesan.submitOrder()">' +
          (submitting ? '<i data-lucide="loader-2" class="icon-sm spin"></i>Mengirim...' : '<i data-lucide="send" class="icon-sm"></i>Kirim Permintaan') +
        '</button>' +
      '</div></div>';
  }

  const TICKET_STEPS = ['waiting', 'processing', 'ready', 'done'];
  const TICKET_STEP_LABEL = { waiting: 'Menunggu', processing: 'Diproses', ready: 'Siap Ambil', done: 'Selesai' };

  function tiketHtml() {
    if (ticketError) {
      return topbarHtml('Status Pesanan') + '<div class="pesan-wrap"><div class="pesan-card">' +
        '<div class="empty-state">' + esc(ticketError) + '</div>' +
        '<a href="#/pesan" class="btn btn-outline" style="width:100%;margin-top:1rem">Buat Pesanan Baru</a>' +
      '</div></div>';
    }
    if (!ticket) {
      return topbarHtml('Status Pesanan') + '<div class="pesan-wrap"><div class="pesan-card">' +
        '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>' +
      '</div></div>';
    }
    // WH/OUT (dibuat otomatis dari pesanan ini, lihat odoo-create-wh-out)
    // bisa aja dibatalkan admin dari halaman WH/OUT (whOutClient.js nyamain
    // status ini ke sini juga) — kalau kejadian, JANGAN tampilin step
    // progress "Menunggu -> Diproses -> ..." lagi (nggak relevan lagi,
    // pesanannya nggak bakal lanjut), ganti sama banner "Dibatalkan" + siapa
    // petugas yang mbatalin, biar karyawan yang lihat tiketnya jelas nggak
    // perlu nunggu lebih lama.
    const isCancelled = ticket.status === 'cancelled';
    const stepIdx = TICKET_STEPS.indexOf(ticket.status);
    const stepsHtml = isCancelled
      ? '<div class="alert-banner alert-banner-danger" style="margin:0">' +
          '<i data-lucide="ban" class="icon-md"></i>' +
          '<div><strong>Pesanan Dibatalkan</strong><br>' +
          'oleh ' + esc(ticket.cancelled_by || 'petugas gudang') +
          (ticket.cancelled_at ? ' · ' + fmtDateTime(ticket.cancelled_at) : '') + '</div>' +
        '</div>'
      : TICKET_STEPS.map(function (s, i) {
          return '<div class="pesan-step' + (i <= stepIdx ? ' active' : '') + '"><div class="pesan-step-dot"></div><p>' + TICKET_STEP_LABEL[s] + '</p></div>' +
            (i < TICKET_STEPS.length - 1 ? '<div class="pesan-step-line' + (i < stepIdx ? ' active' : '') + '"></div>' : '');
        }).join('');
    // Tabel beneran (kolom Nama Barang / SKU / Jumlah) — bukan baris-baris
    // biasa lagi, biar gampang dibaca sekilas kalau barangnya banyak, mirip
    // rekap Excel.
    const itemsHtml = (ticket.items || []).length
      ? '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Nama Barang</th><th>SKU</th><th>Jumlah</th></tr></thead>' +
          '<tbody>' + (ticket.items || []).map(function (it) {
            return '<tr><td>' + esc(it.nama_barang) + '</td>' +
              '<td style="font-family:var(--font-mono, monospace);font-size:0.8125rem">' + esc(it.sku || '-') + '</td>' +
              '<td>' + it.qty + ' ' + esc(it.satuan || '') + '</td></tr>';
          }).join('') + '</tbody>' +
        '</table></div>'
      : '<p class="muted">-</p>';

    return topbarHtml('Status Pesanan') + '<div class="pesan-wrap"><div class="pesan-card" id="pesan-tiket-print-area">' +
      '<div style="text-align:center;padding:1.25rem 0 1.5rem;border-bottom:1px dashed var(--slate-200);margin-bottom:1.25rem">' +
        '<p class="muted" style="text-transform:uppercase;font-size:0.8125rem;letter-spacing:0.08em;font-weight:700">Nomor Antrian</p>' +
        '<p style="font-size:clamp(3rem, 6vw, 4.5rem);font-weight:900;color:var(--brand-600);letter-spacing:-0.02em;line-height:1.1;margin-top:0.25rem">' + esc(queueLabel(ticket)) + '</p>' +
        (ticket.is_urgent ? '<span class="pesan-urgent-badge"><i data-lucide="zap" class="icon-sm"></i>URGENT</span>' : '') +
      '</div>' +
      '<div class="pesan-steps pesan-print-hide">' + stepsHtml + '</div>' +
      '<dl class="dl-grid" style="margin-top:1.25rem">' +
        '<dt>Nama</dt><dd>' + esc(ticket.karyawan_name) + '</dd>' +
        '<dt>Divisi</dt><dd>' + esc(ticket.divisi || '-') + (ticket.sub_divisi ? ' / ' + esc(ticket.sub_divisi) : '') + '</dd>' +
        '<dt>Keperluan</dt><dd>' + esc(ticket.tujuan || '-') + '</dd>' +
        '<dt>Waktu</dt><dd>' + fmtDateTime(ticket.created_at) + '</dd>' +
      '</dl>' +
      '<h2 class="pesan-cart-title" style="margin-top:1.25rem">Item Dipesan</h2>' + itemsHtml +
      '<button type="button" class="btn btn-outline pesan-print-hide" style="width:100%;margin-top:1.25rem" onclick="window.print()">' +
        '<i data-lucide="printer" class="icon-sm"></i>Cetak Nomor Antrian</button>' +
      (ticket.status === 'ready' || ticket.status === 'done'
        ? '<div class="pesan-shortage-box pesan-print-hide">' +
            '<p class="pesan-shortage-title">Barang yang diterima kurang?</p>' +
            '<select id="shortage-item" class="select-input" style="width:100%">' +
              '<option value="" selected disabled>-- Pilih Barang --</option>' +
              (ticket.items || []).map(function (it) { return '<option value="' + esc(it.nama_barang) + '">' + esc(it.nama_barang) + '</option>'; }).join('') +
            '</select>' +
            '<input type="number" id="shortage-qty" class="input" placeholder="Kurang berapa" min="1" style="margin-top:0.5rem">' +
            '<button type="button" class="btn btn-danger" style="width:100%;margin-top:0.5rem" ' + (shortageSending ? 'disabled' : '') + ' onclick="SPB.pesan.submitShortage()">Kirim Laporan</button>' +
            ((ticket.shortage_report || []).length ? '<p class="chart-foot" style="margin-top:0.5rem">Sudah dilaporkan: ' + (ticket.shortage_report || []).map(function (r) { return esc(r.nama_barang) + ' (' + r.qty + ')'; }).join(', ') + '</p>' : '') +
          '</div>'
        : '') +
      // href SENGAJA statis "#/pesan" (BUKAN ikut divisiLocked kayak dulu) —
      // dulu hrefnya "#/pesan/UMUM" (dihitung pas render, sebelum diklik),
      // dan begitu diklik, browser tetap NAVIGASI ke href asli itu SETELAH
      // onclick selesai (nimpa balik hash yang udah diset manual di
      // newOrder() ke "#/pesan/UMUM" lagi) — itu sebabnya "+ Pesanan Baru"
      // kerasa nggak ngefek, tetap ke form divisi yang sama, bukan ke Pilih
      // Divisi. href statis "#/pesan" nggak punya masalah itu lagi.
      '<a href="#/pesan" onclick="SPB.pesan.newOrder()" class="btn btn-outline pesan-print-hide" style="width:100%;margin-top:1.25rem">+ Pesanan Baru</a>' +
    '</div></div>';
  }

  function draw() {
    const app = document.getElementById('app');
    let html;
    if (step === 'pilih-divisi') html = pilihDivisiHtml();
    else if (step === 'form') html = formHtml();
    else if (step === 'katalog') html = katalogHtml();
    else html = tiketHtml();
    // Tombol ganti tema — SATU tempat aja di sini (bukan diulang di tiap
    // step/topbarHtml), biar selalu ada di semua step & nggak dobel. Pakai
    // toggleTheme/getTheme yang SAMA dari app.js (window.SPB), jadi
    // preferensinya nyambung sama dashboard admin (localStorage 1 browser).
    const themeBtn = '<button type="button" data-theme-toggle class="pesan-theme-toggle pesan-print-hide" onclick="SPB.toggleTheme()" aria-label="Ganti tema terang/gelap" title="Ganti tema terang/gelap">' +
      '<i data-lucide="' + (window.SPB.getTheme && window.SPB.getTheme() === 'dark' ? 'sun' : 'moon') + '" class="icon-sm"></i></button>';
    app.innerHTML = '<div class="pesan-page">' + themeBtn + html + footerHtml() + '</div>';
    window.SPB.ui.afterRender();
    if (step === 'katalog') {
      requestAnimationFrame(function () {
        fitCatalogPageSize(!catalogSizeSettled);
        catalogSizeSettled = true;
      });
    }
    if (step === 'form' || step === 'katalog') saveResumeState();
  }

  // Ngukur berapa barang yang BENERAN muat di grid yang kelihatan (kolom x
  // baris), dari ukuran kartu barang yang udah kegambar — bukan angka
  // hardcode. Dipanggil abis tiap render katalog DAN tiap window di-resize
  // (browser zoom in/out juga munculin event 'resize', karena lebar viewport
  // dalam CSS-px berubah). Kalau hasil hitungannya beda dari yang dipakai
  // sekarang, redraw ulang dengan halaman yang disesuaikan (biar barang yang
  // "kelebihan" pindah ke halaman berikutnya, atau sebaliknya waktu di-zoom
  // out kotaknya jadi muat lebih banyak, barang dari halaman berikutnya
  // "ketarik" masuk ke halaman ini).
  // adjustPage=true -> boleh geser catalogPage & redraw kalau ukurannya
  // berubah (dipakai buat kejadian ZOOM/resize beneran, di situ kita MEMANG
  // mau nyesuain ulang biar tetap pas 1 layar). adjustPage=false -> cuma
  // update catalogPageSize buat referensi kalkulasi berikutnya, TANPA geser
  // halaman/redraw — dipakai abis draw() BIASA (mis. pindah halaman manual),
  // soalnya tinggi kartu barang beda-beda (nama pendek vs panjang) bikin
  // hasil ukur beda dikit antar halaman — kalau ini ikut geser catalogPage,
  // klik halaman 3 bisa "ketarik balik" ke halaman 2 gara-gara pengukuran
  // ulang doang, bukan beneran resize/zoom (bug yang sempat kejadian).
  function fitCatalogPageSize(adjustPage) {
    if (step !== 'katalog') return;
    const grid = document.querySelector('.pesan-catalog-grid');
    const item = grid && grid.querySelector('.pesan-catalog-item');
    if (!grid || !item) return; // nggak ada barang buat diukur (misal hasil cari kosong) — biarin apa adanya
    const gridRect = grid.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (!gridRect.width || !itemRect.width || !itemRect.height) return;
    const styles = window.getComputedStyle(grid);
    const colGap = parseFloat(styles.columnGap || styles.gap) || 12;
    const cols = Math.max(1, Math.floor((gridRect.width + colGap) / (itemRect.width + colGap)));
    // Baris DIKUNCI 4 di semua halaman (bukan ngitung dari sisa tinggi layar
    // lagi) — biar nggak ada halaman yang keliatan 4 baris terus halaman lain
    // 5 baris cuma gara-gara sisa ruang kosong di bawah beda dikit. Kalau
    // sisa layar nggak cukup buat 4 baris penuh, biarin aja scroll dikit ke
    // bawah, daripada jumlah barisnya beda-beda antar halaman.
    const rows = 4;
    const newSize = cols * rows;
    if (newSize <= 0 || newSize === catalogPageSize) return;
    if (!adjustPage) { catalogPageSize = newSize; return; } // update diem-diem, jangan geser halaman
    // Geser halaman biar barang pertama yang kelihatan sekarang tetap kira-kira
    // di posisi yang sama (bukan tiba-tiba loncat balik ke halaman 1 tiap resize).
    const firstIndexShown = (catalogPage - 1) * catalogPageSize;
    catalogPageSize = newSize;
    catalogPage = Math.floor(firstIndexShown / catalogPageSize) + 1;
    draw();
  }
  let catalogFitResizeQueued = false;
  window.addEventListener('resize', function () {
    if (catalogFitResizeQueued) return;
    catalogFitResizeQueued = true;
    setTimeout(function () { catalogFitResizeQueued = false; fitCatalogPageSize(true); }, 150);
  });

  function footerHtml() {
    return '<footer class="pesan-footer">' +
      '<p>PT Triputra Textile Industry X Sinaran Denim · Bandung, Jawa Barat</p>' +
      '<p>by Program Triputra</p>' +
    '</footer>';
  }

  window.SPB = window.SPB || {};
  window.SPB.pesan = {
    render: render,
    renderTiket: renderTiket,
    pickDivisi: pickDivisi,
    backToDivisiPicker: backToDivisiPicker,
    backToForm: backToForm,
    setFormField: setFormField,
    onNamaInput: onNamaInput,
    openNamaDropdown: openNamaDropdown,
    selectNama: selectNama,
    closeNamaDropdown: closeNamaDropdown,
    onTitipInput: onTitipInput,
    openTitipDropdown: openTitipDropdown,
    selectTitip: selectTitip,
    closeTitipDropdown: closeTitipDropdown,
    setMode: setMode,
    toggleUrgent: toggleUrgent,
    goToKatalog: goToKatalog,
    setCatalogQ: setCatalogQ,
    goToCatalogPage: goToCatalogPage,
    setCatalogCategory: setCatalogCategory,
    setCatalogStock: setCatalogStock,
    toggleCustomItem: toggleCustomItem,
    setCustomItemName: setCustomItemName,
    setCustomItemQty: setCustomItemQty,
    addCustomItem: addCustomItem,
    toggleCekStatus: toggleCekStatus,
    setCekQueueValue: setCekQueueValue,
    submitCekStatus: submitCekStatus,
    addToCart: addToCart,
    decCatalogQty: decCatalogQty,
    setCartQty: setCartQty,
    setDistribusiMode: setDistribusiMode,
    backToDistDecision: backToDistDecision,
    addDistribusiRow: addDistribusiRow,
    removeDistribusiRow: removeDistribusiRow,
    setDistribusiQty: setDistribusiQty,
    setDistribusiKondisi: setDistribusiKondisi,
    onDistNamaInput: onDistNamaInput,
    selectDistNama: selectDistNama,
    closeDistDropdown: closeDistDropdown,
    removeFromCart: removeFromCart,
    submitOrder: submitOrder,
    newOrder: newOrder,
    submitShortage: submitShortage,
  };
})();
