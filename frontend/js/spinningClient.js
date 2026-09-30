/* =========================================================
   SPB · spinningClient.js
   Lapisan data modul "Part Mesin" (khusus role 'spinning') — tabel mesin,
   part_mesin, permintaan_part_mesin. Lihat database/part_mesin_schema.sql.
   Pola sama dengan client lain di SPB (whOutClient.js dst): IIFE, fungsi
   async tipis di atas Supabase client, dilempar sebagai window.SPB.dbSpinning.
   ========================================================= */

(function () {
  'use strict';

  function sb() { return window.SPB.sb; }
  function throwIfError(error) { if (error) throw new Error(error.message || 'Terjadi kesalahan.'); }

  const dbSpinning = {
    /* ---------- Mesin ---------- */
    listMesin: async function () {
      const { data, error } = await sb().from('mesin').select('*').order('no_mesin', { ascending: true });
      throwIfError(error);
      return data || [];
    },
    createMesin: async function (payload) {
      const { data, error } = await sb().from('mesin').insert({
        no_mesin: payload.no_mesin, nama_mesin: payload.nama_mesin || null, keterangan: payload.keterangan || null,
        merk: payload.merk || null, kategori: payload.kategori || null, lokasi: payload.lokasi || null,
        jam_operasi: Number(payload.jam_operasi) || 0, interval_servis_jam: Number(payload.interval_servis_jam) || 20000,
        status: payload.status || 'Beroperasi', tahun: payload.tahun ? Number(payload.tahun) : null,
      }).select().single();
      throwIfError(error);
      return data;
    },
    updateMesin: async function (id, payload) {
      const { data, error } = await sb().from('mesin').update({
        no_mesin: payload.no_mesin, nama_mesin: payload.nama_mesin || null, keterangan: payload.keterangan || null,
        merk: payload.merk || null, kategori: payload.kategori || null, lokasi: payload.lokasi || null,
        jam_operasi: Number(payload.jam_operasi) || 0, interval_servis_jam: Number(payload.interval_servis_jam) || 20000,
        status: payload.status || 'Beroperasi', tahun: payload.tahun ? Number(payload.tahun) : null,
      }).eq('id', id).select().single();
      throwIfError(error);
      return data;
    },
    deleteMesin: async function (id) {
      const { error } = await sb().from('mesin').delete().eq('id', id);
      throwIfError(error);
    },

    /* ---------- Part Mesin (katalog, dengan hierarki parent_id) ---------- */
    listPart: async function () {
      const { data, error } = await sb().from('part_mesin').select('*').order('nama_part', { ascending: true });
      throwIfError(error);
      return data || [];
    },
    createPart: async function (payload) {
      const { data, error } = await sb().from('part_mesin').insert({
        parent_id: payload.parent_id || null,
        nama_part: payload.nama_part,
        category: payload.category || null,
        satuan: payload.satuan || null,
        internal_reference: payload.internal_reference || null,
        part_number: payload.part_number || null,
        catalog_number: payload.catalog_number || null,
        consumable: payload.consumable !== false,
        asal: payload.asal || null,
        stok: payload.stok || 0,
        harga: payload.harga || null,
        supplier_name: payload.supplier_name || null,
      }).select().single();
      throwIfError(error);
      return data;
    },

    /* ---------- Master Data: Supplier (Odoo) / Satuan / Karyawan (Mekanik) ---------- */
    // Supplier DITARIK dari Odoo (res.partner) — bukan diketik manual lagi.
    // termin_hari & status TETAP bisa diedit manual di SPB (lihat
    // updateSupplierMeta), Odoo nggak pernah menimpa dua kolom itu waktu sync
    // (lihat catatan di database/part_mesin_schema.sql & Edge Function-nya).
    listSupplier: async function () {
      const { data, error } = await sb().from('spinning_supplier').select('*').order('nama', { ascending: true });
      throwIfError(error);
      return data || [];
    },
    syncSuppliersFromOdoo: async function () {
      const CFG = window.SPB_CONFIG;
      const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-pull-suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({}),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || 'Gagal sinkron supplier dari Odoo.');
      return result;
    },
    updateSupplierMeta: async function (id, payload) {
      const patch = {};
      if (payload.termin_hari !== undefined) patch.termin_hari = Number(payload.termin_hari) || 0;
      if (payload.status !== undefined) patch.status = payload.status;
      const { error } = await sb().from('spinning_supplier').update(patch).eq('id', id);
      throwIfError(error);
    },
    // Dipakai popup "Ubah Supplier" (edit lengkap) — nama/telepon/email/kota/
    // alamat/npwp TETAP bisa diedit tapi TERTIMPA lagi kalau "Sync dari Odoo"
    // ditekan ulang (Odoo tetap sumber kebenarannya field itu). kode/kontak
    // (Nama PIC)/kategori_utama/rating/termin_hari/status AMAN, tidak pernah
    // disentuh sync (lihat odoo-pull-suppliers & part_mesin_schema.sql).
    updateSupplierDetail: async function (id, payload) {
      const { error } = await sb().from('spinning_supplier').update({
        kode: payload.kode || null,
        nama: payload.nama,
        kontak: payload.kontak || null,
        telepon: payload.telepon || null,
        email: payload.email || null,
        kota: payload.kota || null,
        alamat: payload.alamat || null,
        npwp: payload.npwp || null,
        kategori_utama: payload.kategori_utama || null,
        termin_hari: Number(payload.termin_hari) || 0,
        rating: payload.rating === '' || payload.rating == null ? null : Number(payload.rating),
        status: payload.status,
      }).eq('id', id);
      throwIfError(error);
    },
    // Aman dihapus — spinning_supplier_product punya on delete cascade
    // (ikut kehapus), spinning_po.supplier_id & permintaan_part_mesin.supplier_id
    // punya on delete set null (riwayat PO lama TETAP ada, cuma link ke
    // supplier-nya jadi kosong; nama supplier di dokumen lama sudah kesalin
    // manual ke kolom teks sendiri jadi nggak ikut hilang).
    deleteSupplier: async function (id) {
      const { error } = await sb().from('spinning_supplier').delete().eq('id', id);
      throwIfError(error);
    },
    listSupplierProducts: async function (supplierId) {
      const { data, error } = await sb().from('spinning_supplier_product').select('*').eq('supplier_id', supplierId).order('product_name', { ascending: true });
      throwIfError(error);
      return data || [];
    },
    // PO Part Mesin yang terkait 1 SKU (dicocokkan lewat part_mesin.internal_reference
    // = SKU Odoo) — dipakai popup detail pergerakan stok di halaman Inventory,
    // buat kasih tau "barang ini pernah/lagi di-PO ke supplier mana".
    listPoBySku: async function (sku) {
      if (!sku) return [];
      const { data: parts, error: eParts } = await sb().from('part_mesin').select('id').eq('internal_reference', sku);
      throwIfError(eParts);
      const partIds = (parts || []).map(function (p) { return p.id; });
      if (!partIds.length) return [];
      const { data: items, error: eItems } = await sb().from('spinning_po_item').select('*').in('part_id', partIds);
      throwIfError(eItems);
      if (!items.length) return [];
      const poIds = Array.from(new Set(items.map(function (it) { return it.po_id; })));
      const { data: pos, error: ePos } = await sb().from('spinning_po').select('*').in('id', poIds);
      throwIfError(ePos);
      const poById = {};
      (pos || []).forEach(function (po) { poById[po.id] = po; });
      return items.map(function (it) {
        const po = poById[it.po_id];
        return po ? {
          nomor: po.nomor, tanggal: po.tanggal, status: po.status, supplier_nama: po.supplier_nama,
          qty: it.qty, qty_diterima: it.qty_diterima, harga_satuan: it.harga_satuan,
        } : null;
      }).filter(Boolean);
    },
    // Satuan (Unit of Measure) TIDAK diketik manual lagi — dibaca langsung
    // dari satuan_odoo (sinkron dari Odoo uom.uom lewat Edge Function
    // odoo-pull-uom). Tabel spinning_satuan lama sudah tidak dipakai (boleh
    // dibiarkan kosong di DB), sama pola dengan Karyawan di bawah ini.
    listSatuanOdoo: async function () {
      const { data, error } = await sb().from('satuan_odoo').select('*').order('name', { ascending: true });
      throwIfError(error);
      return data || [];
    },
    // Satuan (uom.uom) DITARIK BARENG odoo-pull-stock (Edge Function yang
    // sama dipakai Stok Barang gudang) — bukan Edge Function terpisah, biar
    // nggak nambah-nambah function baru. Cukup panggil dbStokBarang.syncNow(),
    // tapi hasilnya juga sekalian nyegerin satuan_odoo — ini alias tipis
    // biar pemanggilnya (spinningMaster.js) tetap eksplisit soal maksudnya.
    syncSatuanFromOdoo: async function () {
      const result = await window.SPB.dbStokBarang.syncNow();
      return { ok: true, fetched: result.uomFetched || 0 };
    },
    // Edit/Hapus manual satuan_odoo — CATATAN: nama/category yang diedit di
    // sini bisa ketimpa lagi kalau "Sync dari Odoo" ditekan (upsert-nya
    // berdasarkan odoo_id, ambil versi terbaru dari Odoo). Dipakai buat
    // koreksi cepat/rapi-rapi tampilan, bukan sumber kebenaran permanen.
    updateSatuanOdoo: async function (id, payload) {
      const { error } = await sb().from('satuan_odoo').update({
        name: payload.name, category: payload.category || null,
      }).eq('id', id);
      throwIfError(error);
    },
    deleteSatuanOdoo: async function (id) {
      const { error } = await sb().from('satuan_odoo').delete().eq('id', id);
      throwIfError(error);
    },
    // Karyawan/mekanik Spinning TIDAK dikelola manual lagi — dibaca langsung
    // dari public.karyawan (sinkron Odoo lewat dbKaryawan.list(), difilter
    // divisi 'Spinning' di sisi caller). Tabel spinning_karyawan yang tadinya
    // dibuat buat ini sudah tidak dipakai (boleh dibiarkan kosong di DB).

    /* ---------- Permintaan Part Mesin ---------- */
    listPermintaan: async function () {
      const { data, error } = await sb().from('permintaan_part_mesin').select('*').order('created_at', { ascending: false });
      throwIfError(error);
      return data || [];
    },
    createPermintaan: async function (payload) {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      const { data, error } = await sb().from('permintaan_part_mesin').insert({
        jenis: payload.jenis, // 'gudang' | 'supplier'
        no_mesin: payload.no_mesin || null,
        nama_mekanik: payload.nama_mekanik,
        karyawan_id: payload.karyawan_id || null,
        part_id: payload.part_id || null,
        nama_part: payload.nama_part,
        supplier_id: payload.supplier_id || null,
        jumlah: payload.jumlah || 1,
        catatan: payload.catatan || null,
        requested_by: username,
      }).select().single();
      throwIfError(error);
      return data;
    },
    // Satu fungsi transisi status generik — daftar status valid ada di
    // constraint tabel (part_mesin_schema.sql). Otomatis isi jejak approve/
    // repair timestamps sesuai status tujuannya, biar caller (spinningPartMesin.js)
    // nggak perlu tau detail kolom mana yang harus diisi kapan.
    updateStatus: async function (id, status, extra) {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      const patch = { status: status };
      if (status === 'disetujui') { patch.approved_by = username; patch.approved_at = new Date().toISOString(); }
      if (status === 'repair_start') patch.repair_start_at = new Date().toISOString();
      if (status === 'repair_end') patch.repair_end_at = new Date().toISOString();
      // extra.catatan — dipakai halaman Penerimaan Barang buat nyatet No Surat
      // Jalan/keterangan pas barang fisik datang (status 'barang_datang'),
      // TIDAK ada kolom khusus di skema, numpang kolom catatan yang sudah ada.
      if (extra && extra.catatan) patch.catatan = extra.catatan;
      const { error } = await sb().from('permintaan_part_mesin').update(patch).eq('id', id);
      throwIfError(error);
    },
  };

  /* =========================================================
     Purchase Request & Purchase Order (jalur SUPPLIER, multi-item + harga)
     — lihat database/part_mesin_schema.sql. Terpisah total dari
     permintaan_part_mesin (yang tetap dipakai buat jalur GUDANG/WO).
     ========================================================= */
  async function nextDocNumber(table, prefix) {
    const now = new Date();
    const ym = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
    const { count, error } = await sb().from(table).select('id', { count: 'exact', head: true }).like('nomor', prefix + '/' + ym + '/%');
    throwIfError(error);
    return prefix + '/' + ym + '/' + String((count || 0) + 1).padStart(4, '0');
  }
  function groupItemsBy(rows, items, key) {
    const map = {};
    items.forEach(function (it) { (map[it[key]] = map[it[key]] || []).push(it); });
    rows.forEach(function (r) { r.items = map[r.id] || []; });
    return rows;
  }
  function calcPOTotals(items, diskonPersen, ppnPersen) {
    const subtotal = items.reduce(function (a, it) { return a + Number(it.qty) * Number(it.harga_satuan); }, 0);
    const diskon = Math.round(subtotal * Number(diskonPersen || 0) / 100);
    const dpp = subtotal - diskon;
    const ppn = Math.round(dpp * Number(ppnPersen || 0) / 100);
    return { subtotal: subtotal, diskon: diskon, ppn: ppn, total: dpp + ppn };
  }

  const dbSpinningPO = {
    /* ---------- Purchase Request ---------- */
    listPR: async function () {
      const [{ data: rows, error: e1 }, { data: items, error: e2 }] = await Promise.all([
        sb().from('spinning_pr').select('*').order('created_at', { ascending: false }),
        sb().from('spinning_pr_item').select('*'),
      ]);
      throwIfError(e1); throwIfError(e2);
      return groupItemsBy(rows || [], items || [], 'pr_id');
    },
    createPR: async function (payload) {
      const nomor = await nextDocNumber('spinning_pr', 'PR');
      const items = (payload.items || []).map(function (it) {
        return { part_id: it.part_id || null, nama_part: it.nama_part, satuan: it.satuan || null, qty: Number(it.qty) || 1, harga_satuan: Number(it.harga_satuan) || 0, subtotal: (Number(it.qty) || 1) * (Number(it.harga_satuan) || 0) };
      });
      const totalEstimasi = items.reduce(function (a, it) { return a + it.subtotal; }, 0);
      const { data: pr, error } = await sb().from('spinning_pr').insert({
        nomor: nomor, tanggal: payload.tanggal || new Date().toISOString().slice(0, 10),
        divisi_pemohon: payload.divisi_pemohon || null, pemohon_id: payload.pemohon_id || null, pemohon_nama: payload.pemohon_nama,
        mesin_id: payload.mesin_id || null, mesin_kode: payload.mesin_kode || null, mesin_nama: payload.mesin_nama || null,
        prioritas: payload.urgent ? 'Mendesak' : 'Normal', urgent: !!payload.urgent, jalur: payload.jalur || 'po_baru',
        keperluan: payload.keperluan || null, catatan: payload.catatan || null,
        total_estimasi: totalEstimasi,
      }).select().single();
      throwIfError(error);
      if (items.length) {
        const { error: eItems } = await sb().from('spinning_pr_item').insert(items.map(function (it) { return Object.assign({ pr_id: pr.id }, it); }));
        throwIfError(eItems);
      }
      return pr;
    },
    updatePR: async function (id, payload) {
      const items = (payload.items || []).map(function (it) {
        return { part_id: it.part_id || null, nama_part: it.nama_part, satuan: it.satuan || null, qty: Number(it.qty) || 1, harga_satuan: Number(it.harga_satuan) || 0, subtotal: (Number(it.qty) || 1) * (Number(it.harga_satuan) || 0) };
      });
      const totalEstimasi = items.reduce(function (a, it) { return a + it.subtotal; }, 0);
      const { error } = await sb().from('spinning_pr').update({
        divisi_pemohon: payload.divisi_pemohon || null, pemohon_id: payload.pemohon_id || null, pemohon_nama: payload.pemohon_nama,
        mesin_id: payload.mesin_id || null, mesin_kode: payload.mesin_kode || null, mesin_nama: payload.mesin_nama || null,
        prioritas: payload.urgent ? 'Mendesak' : 'Normal', urgent: !!payload.urgent, jalur: payload.jalur || 'po_baru',
        keperluan: payload.keperluan || null, catatan: payload.catatan || null,
        tanggal: payload.tanggal || undefined, total_estimasi: totalEstimasi,
      }).eq('id', id);
      throwIfError(error);
      const { error: eDel } = await sb().from('spinning_pr_item').delete().eq('pr_id', id);
      throwIfError(eDel);
      if (items.length) {
        const { error: eIns } = await sb().from('spinning_pr_item').insert(items.map(function (it) { return Object.assign({ pr_id: id }, it); }));
        throwIfError(eIns);
      }
    },
    approvePR: async function (id) {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      const { error } = await sb().from('spinning_pr').update({ status: 'disetujui', approved_by: username, approved_at: new Date().toISOString() }).eq('id', id);
      throwIfError(error);
    },
    rejectPR: async function (id, alasan) {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      const { error } = await sb().from('spinning_pr').update({ status: 'ditolak', alasan_reject: alasan || null, approved_by: username, approved_at: new Date().toISOString() }).eq('id', id);
      throwIfError(error);
    },
    deletePR: async function (id) {
      const { error } = await sb().from('spinning_pr').delete().eq('id', id);
      throwIfError(error);
    },

    /* ---------- Purchase Order ---------- */
    listPO: async function () {
      const [{ data: rows, error: e1 }, { data: items, error: e2 }] = await Promise.all([
        sb().from('spinning_po').select('*').order('created_at', { ascending: false }),
        sb().from('spinning_po_item').select('*'),
      ]);
      throwIfError(e1); throwIfError(e2);
      return groupItemsBy(rows || [], items || [], 'po_id');
    },
    createPO: async function (payload) {
      const nomor = await nextDocNumber('spinning_po', 'PO');
      const items = (payload.items || []).map(function (it) {
        return { part_id: it.part_id || null, nama_part: it.nama_part, satuan: it.satuan || null, qty: Number(it.qty) || 1, harga_satuan: Number(it.harga_satuan) || 0, subtotal: (Number(it.qty) || 1) * (Number(it.harga_satuan) || 0) };
      });
      const totals = calcPOTotals(items, payload.diskon_persen, payload.ppn_persen);
      const { data: po, error } = await sb().from('spinning_po').insert({
        nomor: nomor, tanggal: payload.tanggal || new Date().toISOString().slice(0, 10),
        supplier_id: payload.supplier_id || null, supplier_nama: payload.supplier_nama,
        pr_id: payload.pr_id || null, pr_nomor: payload.pr_nomor || null,
        subtotal: totals.subtotal, diskon_persen: Number(payload.diskon_persen) || 0, diskon: totals.diskon,
        ppn_persen: Number(payload.ppn_persen) || 0, ppn: totals.ppn, total: totals.total,
        termin_hari: Number(payload.termin_hari) || 30, tanggal_kirim_estimasi: payload.tanggal_kirim_estimasi || null,
        dibuat_oleh: payload.dibuat_oleh || null, catatan: payload.catatan || null,
      }).select().single();
      throwIfError(error);
      if (items.length) {
        const { error: eItems } = await sb().from('spinning_po_item').insert(items.map(function (it) { return Object.assign({ po_id: po.id }, it); }));
        throwIfError(eItems);
      }
      if (payload.pr_id) {
        const { error: ePr } = await sb().from('spinning_pr').update({ status: 'diproses_po', po_id: po.id }).eq('id', payload.pr_id);
        throwIfError(ePr);
      }
      return po;
    },
    updatePO: async function (id, payload) {
      const items = (payload.items || []).map(function (it) {
        return { part_id: it.part_id || null, nama_part: it.nama_part, satuan: it.satuan || null, qty: Number(it.qty) || 1, harga_satuan: Number(it.harga_satuan) || 0, subtotal: (Number(it.qty) || 1) * (Number(it.harga_satuan) || 0) };
      });
      const totals = calcPOTotals(items, payload.diskon_persen, payload.ppn_persen);
      const { error } = await sb().from('spinning_po').update({
        supplier_id: payload.supplier_id || null, supplier_nama: payload.supplier_nama,
        subtotal: totals.subtotal, diskon_persen: Number(payload.diskon_persen) || 0, diskon: totals.diskon,
        ppn_persen: Number(payload.ppn_persen) || 0, ppn: totals.ppn, total: totals.total,
        termin_hari: Number(payload.termin_hari) || 30, tanggal_kirim_estimasi: payload.tanggal_kirim_estimasi || null,
        catatan: payload.catatan || null,
      }).eq('id', id);
      throwIfError(error);
      const { error: eDel } = await sb().from('spinning_po_item').delete().eq('po_id', id);
      throwIfError(eDel);
      if (items.length) {
        const { error: eIns } = await sb().from('spinning_po_item').insert(items.map(function (it) { return Object.assign({ po_id: id }, it); }));
        throwIfError(eIns);
      }
    },
    updatePOStatus: async function (id, status) {
      const { error } = await sb().from('spinning_po').update({ status: status }).eq('id', id);
      throwIfError(error);
    },
    // Tarik PO dari Odoo lewat sheet tracking "Laporan Permintaan Sparepart"
    // (No Permintaan/Divisi/No PO) — numpang Edge Function
    // sheet-pull-employees (kirim {mode:'po'}), BUKAN Edge Function baru.
    // Sheet nentuin No PO mana yang relevan (Divisi Spinning + kolom No PO
    // sudah terisi), datanya sendiri ditarik dari Odoo purchase.order
    // (dicocokkan lewat field `name`). Dipanggil OTOMATIS tiap halaman PO
    // dibuka & juga tombol manual "Sync PO" (lihat spinningPurchase.js).
    // Baris hasil sync ditandai dibuat_oleh='Sync Odoo' (read-only di UI),
    // PO manual SPB sendiri tetap ada berdampingan.
    syncPoFromOdoo: async function () {
      const CFG = window.SPB_CONFIG;
      const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/sheet-pull-employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({ mode: 'po' }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || 'Gagal sinkron PO dari sheet + Odoo.');
      return result;
    },
    deletePO: async function (id, prId) {
      const { error } = await sb().from('spinning_po').delete().eq('id', id);
      throwIfError(error);
      if (prId) {
        const { error: ePr } = await sb().from('spinning_pr').update({ status: 'disetujui', po_id: null }).eq('id', prId);
        throwIfError(ePr);
      }
    },

    /* ---------- Penerimaan Barang (Receipt) — bisa bertahap per PO ---------- */
    listReceipts: async function (poId) {
      const [{ data: rows, error: e1 }, { data: items, error: e2 }] = await Promise.all([
        sb().from('spinning_receipt').select('*').eq('po_id', poId).order('created_at', { ascending: false }),
        sb().from('spinning_receipt_item').select('*'),
      ]);
      throwIfError(e1); throwIfError(e2);
      return groupItemsBy(rows || [], items || [], 'receipt_id');
    },
    createReceipt: async function (poId, payload) {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      const nomor = await nextDocNumber('spinning_receipt', 'GR');
      const { data: receipt, error } = await sb().from('spinning_receipt').insert({
        nomor: nomor, po_id: poId, tanggal: payload.tanggal || new Date().toISOString().slice(0, 10),
        diterima_oleh: payload.diterima_oleh || username, no_surat_jalan: payload.no_surat_jalan || null, catatan: payload.catatan || null,
      }).select().single();
      throwIfError(error);
      const items = (payload.items || []).filter(function (it) { return Number(it.qty_terima) > 0 || Number(it.qty_reject) > 0; });
      if (items.length) {
        const { error: eItems } = await sb().from('spinning_receipt_item').insert(items.map(function (it) {
          return { receipt_id: receipt.id, po_item_id: it.po_item_id, qty_terima: Number(it.qty_terima) || 0, qty_reject: Number(it.qty_reject) || 0 };
        }));
        throwIfError(eItems);
      }
      // Update qty_diterima per item PO, lalu simpulkan status PO (diterima kalau
      // semua item sudah penuh, dikirim_sebagian kalau baru sebagian).
      const { data: poItems, error: ePoItems } = await sb().from('spinning_po_item').select('*').eq('po_id', poId);
      throwIfError(ePoItems);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const poItem = poItems.find(function (p) { return p.id === it.po_item_id; });
        if (!poItem) continue;
        const newQty = Number(poItem.qty_diterima) + Number(it.qty_terima) - Number(it.qty_reject);
        const { error: eUpd } = await sb().from('spinning_po_item').update({ qty_diterima: newQty }).eq('id', poItem.id);
        throwIfError(eUpd);
        poItem.qty_diterima = newQty;
      }
      const semuaPenuh = poItems.every(function (p) { return Number(p.qty_diterima) >= Number(p.qty); });
      const adaYangMasuk = poItems.some(function (p) { return Number(p.qty_diterima) > 0; });
      const statusBaru = semuaPenuh ? 'diterima' : adaYangMasuk ? 'dikirim_sebagian' : undefined;
      if (statusBaru) {
        const { error: eStatus } = await sb().from('spinning_po').update({ status: statusBaru }).eq('id', poId);
        throwIfError(eStatus);
      }
      return receipt;
    },
    deleteReceipt: async function (id, poId) {
      const { data: items, error: eGet } = await sb().from('spinning_receipt_item').select('*').eq('receipt_id', id);
      throwIfError(eGet);
      const { data: poItems, error: ePoItems } = await sb().from('spinning_po_item').select('*').eq('po_id', poId);
      throwIfError(ePoItems);
      for (let i = 0; i < (items || []).length; i++) {
        const it = items[i];
        const poItem = poItems.find(function (p) { return p.id === it.po_item_id; });
        if (!poItem) continue;
        const newQty = Math.max(0, Number(poItem.qty_diterima) - Number(it.qty_terima) + Number(it.qty_reject));
        const { error: eUpd } = await sb().from('spinning_po_item').update({ qty_diterima: newQty }).eq('id', poItem.id);
        throwIfError(eUpd);
        poItem.qty_diterima = newQty;
      }
      const { error: eDel } = await sb().from('spinning_receipt').delete().eq('id', id);
      throwIfError(eDel);
      const adaYangMasuk = poItems.some(function (p) { return Number(p.qty_diterima) > 0; });
      const { error: eStatus } = await sb().from('spinning_po').update({ status: adaYangMasuk ? 'dikirim_sebagian' : 'menunggu_konfirmasi' }).eq('id', poId);
      throwIfError(eStatus);
    },
  };

  window.SPB = window.SPB || {};
  window.SPB.dbSpinning = dbSpinning;
  window.SPB.dbSpinningPO = dbSpinningPO;
})();
