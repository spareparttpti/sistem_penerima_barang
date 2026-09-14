/* =========================================================
   SPB · whOutClient.js
   Lapisan data WH/OUT (ATK) — dipisah dari supabaseClient.js (WH/IN) supaya
   tidak menumpuk di satu file. Pola dasarnya (sb(), throwIfError()) sama
   dengan supabaseClient.js, tapi alur statusnya beda: WH/OUT itu barangnya
   sudah ada di stok (kayak kasir), jadi cuma Draft -> Approved/Rejected ->
   Distribusi, TANPA tahap "menunggu kedatangan" seperti WH/IN.

   Belum ada dukungan mode demo (localStorage) di sini — WH/OUT baru ada di
   produksi. Kalau demoMode aktif, semua fungsi ini melempar error yang jelas.
   ========================================================= */

(function () {
  'use strict';

  const CFG = window.SPB_CONFIG;
  const DEMO = CFG.demoMode;

  function sb() {
    const c = window.SPB && window.SPB.sb;
    if (!c) throw new Error('Supabase belum dikonfigurasi (isi SUPABASE_URL & SUPABASE_ANON_KEY di config.js).');
    return c;
  }
  function throwIfError(error) {
    if (error) throw new Error(error.message || String(error));
  }
  function noDemo() {
    throw new Error('WH/OUT belum didukung di mode demo — set demoMode:false di config.js.');
  }

  async function callOdooValidate(pickingId, action) {
    try {
      const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({ picking_id: pickingId, action: action }),
      });
      const result = await res.json();
      return result.ok ? { ok: true, reserveWarning: result.reserveWarning || null } : { ok: false, message: result.error || 'Gagal disinkronkan ke Odoo.' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }
  function confirmToOdoo(pickingId) { return callOdooValidate(pickingId, 'confirm'); }

  /* ---------- WH/OUT (pengeluaran_barang) ---------- */
  const dbWhOut = {
    list: async function () {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('pengeluaran_barang')
        .select('*, items:detail_pengeluaran(*)')
        .order('created_at', { ascending: false });
      throwIfError(error);
      return data || [];
    },

    get: async function (id) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('pengeluaran_barang')
        .select('*, items:detail_pengeluaran(*)')
        .eq('id', id)
        .maybeSingle();
      throwIfError(error);
      return data || null;
    },

    /* Validasi picking ke Odoo (potong stok beneran di sana). Best-effort:
       dipanggil setelah distribusi ke karyawan tuntas dicatat — hasil
       {ok, message} dikembalikan ke pemanggil buat ditampilkan sebagai
       toast, tidak pernah melempar error (data SPB sudah pasti aman
       terlepas dari berhasil/gagalnya langkah ini). */
    syncToOdoo: async function (id) {
      if (DEMO) return { ok: true };
      const rec = await dbWhOut.get(id);
      if (!rec || rec.source !== 'odoo' || !rec.odoo_picking_id) return { ok: true };
      return callOdooValidate(rec.odoo_picking_id, 'validate');
    },

    /* WH/OUT itu barangnya sudah ada di stok (bukan menunggu kedatangan
       vendor kayak WH/IN) — jadi begitu masuk dari Odoo (status Draft),
       admin langsung Approve/Reject di sini, tanpa tahap "barang datang"
       terpisah. .eq('status','Draft') mencegah dua admin sama-sama lolos
       memproses baris yang sama. */
    updateStatus: async function (id, status, notes, receiverName) {
      if (DEMO) noDemo();
      const payload = { status: status };
      if (notes !== undefined) payload.notes = notes;
      if (status === 'Approved' || status === 'Rejected') {
        payload.arrival_date = new Date().toISOString();
        payload.receiver_name = receiverName || null;
      }
      const { data, error } = await sb()
        .from('pengeluaran_barang')
        .update(payload)
        .eq('id', id)
        .eq('status', 'Draft')
        .select()
        .maybeSingle();
      throwIfError(error);
      if (!data) throw new Error('Data ini sudah diproses sebelumnya (atau tidak ditemukan).');

      // Approve barang -> "Mark as Todo" + reservasi (action_confirm +
      // action_assign) di Odoo (Draft -> Waiting/Ready). Belum potong stok
      // fisik — itu baru terjadi di syncToOdoo() setelah distribusi ke
      // karyawan tuntas. Tapi reserved_quantity DI ODOO sudah naik sekarang,
      // jadi tarik ulang stok otomatis (bukan nunggu tombol "Sync dari Odoo"
      // manual / cron 5 menit) supaya kolom "Direservasi" di Stok Barang
      // langsung update begitu Approve selesai. Best-effort — dipanggil
      // "fire and forget" (tanpa await), gagal di sini tidak menggagalkan
      // Approve-nya sendiri (nanti kesusul cron kalau kelewat).
      if (status === 'Approved' && data.source === 'odoo' && data.odoo_picking_id) {
        data.odoo_sync = await confirmToOdoo(data.odoo_picking_id);
        if (window.SPB.dbStokBarang && window.SPB.dbStokBarang.syncNow) {
          window.SPB.dbStokBarang.syncNow().catch(function () { /* diam-diam gagal juga gapapa — nanti kesusul cron */ });
        }
      }
      return data;
    },

    setFavorite: async function (id, value) {
      if (DEMO) noDemo();
      const { error } = await sb().from('pengeluaran_barang').update({ is_favorite: value }).eq('id', id);
      throwIfError(error);
    },

    /* Draft -> "Menunggu Stok" (barangnya habis, diajukan PO internal) dan
       sebaliknya ("Cek Ulang Stok" ternyata udah cukup lagi) -> balik Draft.
       Guard .eq('status', ...) sama pola dengan updateStatus() — cegah 2
       admin sama-sama lolos ubah baris yang sama pas race. */
    markMenungguStok: async function (id) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('pengeluaran_barang').update({ status: 'Menunggu Stok' }).eq('id', id).eq('status', 'Draft')
        .select().maybeSingle();
      throwIfError(error);
      if (!data) throw new Error('Data ini sudah diproses sebelumnya (atau tidak ditemukan).');
      return data;
    },
    revertToDraft: async function (id) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('pengeluaran_barang').update({ status: 'Draft' }).eq('id', id).eq('status', 'Menunggu Stok')
        .select().maybeSingle();
      throwIfError(error);
      if (!data) throw new Error('Data ini sudah diproses sebelumnya (atau tidak ditemukan).');
      return data;
    },
  };

  /* ---------- Permintaan Restock (catatan internal — BUKAN PO di Odoo) ----------
     Dipakai pas barang WH/OUT-nya Qty Fisik = 0 (habis) di Stok Barang. Cuma
     catatan buat admin gudang, tidak menulis apa pun ke Odoo. */
  const dbRestock = {
    listByPengeluaran: async function (pengeluaranId) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('permintaan_restock')
        .select('*')
        .eq('pengeluaran_id', pengeluaranId)
        .eq('status', 'Menunggu')
        .order('created_at', { ascending: true });
      throwIfError(error);
      return data || [];
    },

    /* items: [{ detail_id, sku, product_name, qty_diminta }] — diinsert
       sekaligus, terus status WH/OUT-nya diubah jadi "Menunggu Stok". */
    create: async function (pengeluaranId, items, createdBy) {
      if (DEMO) noDemo();
      if (!items.length) return [];
      const payload = items.map(function (it) {
        return {
          pengeluaran_id: pengeluaranId,
          detail_id: it.detail_id || null,
          sku: it.sku || null,
          product_name: it.product_name || null,
          qty_diminta: it.qty_diminta || 0,
          created_by: createdBy || null,
        };
      });
      const { data, error } = await sb().from('permintaan_restock').insert(payload).select();
      throwIfError(error);
      await dbWhOut.markMenungguStok(pengeluaranId);
      return data || [];
    },

    /* Dipanggil pas "Cek Ulang Stok" ternyata udah cukup lagi — tandai semua
       permintaan yang masih "Menunggu" buat WH/OUT ini jadi "Selesai". */
    resolveAll: async function (pengeluaranId) {
      if (DEMO) noDemo();
      const { error } = await sb()
        .from('permintaan_restock')
        .update({ status: 'Selesai', resolved_at: new Date().toISOString() })
        .eq('pengeluaran_id', pengeluaranId)
        .eq('status', 'Menunggu');
      throwIfError(error);
    },
  };

  /* ---------- Distribusi (siapa dapat berapa dari 1 item WH/OUT) ---------- */
  const dbDistribusi = {
    listByPengeluaran: async function (pengeluaranId) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('distribusi_pengeluaran')
        .select('*')
        .eq('pengeluaran_id', pengeluaranId)
        .order('created_at', { ascending: true });
      throwIfError(error);
      return data || [];
    },

    /* rows: [{ detail_id, karyawan_id, karyawan_name, department, qty, status }]
       — diinsert sekaligus dalam satu batch, bukan satu-satu, supaya submit
       form distribusi (banyak baris sekaligus) tetap 1 round-trip.
       status: 'Baru'|'Hilang'|'Tukar'|'Habis' — alasan kenapa barang ini
       dikasih ke orang itu (default 'Baru' kalau nggak diisi). */
    addBatch: async function (pengeluaranId, rows, createdBy) {
      if (DEMO) noDemo();
      if (!rows.length) return [];
      const payload = rows.map(function (r) {
        return {
          pengeluaran_id: pengeluaranId,
          detail_id: r.detail_id,
          karyawan_id: r.karyawan_id || null,
          karyawan_name: r.karyawan_name,
          department: r.department || null,
          qty: r.qty,
          status: r.status || 'Baru',
          is_shared: !!r.is_shared,
          created_by: createdBy || null,
        };
      });
      const { data, error } = await sb().from('distribusi_pengeluaran').insert(payload).select();
      throwIfError(error);
      return data || [];
    },

    remove: async function (id) {
      if (DEMO) noDemo();
      const { error } = await sb().from('distribusi_pengeluaran').delete().eq('id', id);
      throwIfError(error);
    },

    /* Tandai 1 baris distribusi (barang buat 1 karyawan) sebagai Hilang/Tukar
       — dipakai kalau belakangan ketahuan barangnya hilang atau ditukar,
       BUKAN saat pertama kali dicatat (defaultnya selalu 'Normal'). */
    updateStatus: async function (id, status) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('distribusi_pengeluaran').update({ status: status }).eq('id', id).select().maybeSingle();
      throwIfError(error);
      return data;
    },

    /* Catatan manual kenapa pemakaian barang ini naik/ada kejadian khusus —
       diisi admin/petugas, bebas kosong. */
    updateKeterangan: async function (id, keterangan) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('distribusi_pengeluaran').update({ keterangan: keterangan || null }).eq('id', id).select().maybeSingle();
      throwIfError(error);
      return data;
    },

    /* Semua baris distribusi lintas WH/OUT — dipakai Laporan (siapa ambil apa,
       kapan). Nested select ambil sekalian info WH/OUT & item terkait via FK
       yang sudah ada (pengeluaran_id -> pengeluaran_barang, detail_id ->
       detail_pengeluaran), jadi 1 round-trip aja, tidak perlu join manual. */
    listAll: async function () {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('distribusi_pengeluaran')
        .select('*, pengeluaran:pengeluaran_id(wh_out_ref, employee_name, department, receiver_name, arrival_date), detail:detail_id(product_name, sku, uom)')
        .order('created_at', { ascending: false });
      throwIfError(error);
      return data || [];
    },
  };

  /* ---------- Karyawan (master, ditarik dari Odoo) ---------- */
  const dbKaryawan = {
    // .range() wajib — Supabase/PostgREST batasin default 1000 baris per
    // request, dan jumlah karyawan bisa lebih dari itu (sama kasus yang
    // sempat kejadian di stok_barang: kepotong diam-diam tanpa error).
    // Sama optimasi dengan dbStokBarang.list() (stokBarangClient.js) — tanya
    // total dulu (count:'exact', head:true), baru semua halaman diminta
    // SEKALIGUS PARALEL, bukan satu-satu berurutan (yang kerasa lambat/macet
    // kalau karyawannya ribuan).
    list: async function () {
      if (DEMO) noDemo();
      const PAGE = 1000;
      const { count, error: countErr } = await sb()
        .from('karyawan')
        .select('*', { count: 'exact', head: true })
        .eq('active', true);
      throwIfError(countErr);
      const total = count || 0;
      if (!total) return [];

      const pageStarts = [];
      for (let from = 0; from < total; from += PAGE) pageStarts.push(from);
      const pages = await Promise.all(pageStarts.map(function (from) {
        return sb()
          .from('karyawan')
          .select('*')
          .eq('active', true)
          .order('name', { ascending: true })
          .range(from, from + PAGE - 1)
          .then(function (res) { throwIfError(res.error); return res.data || []; });
      }));
      return pages.reduce(function (all, page) { return all.concat(page); }, []);
    },

    /* Ganti total dari odoo-pull-employees ke sheet-pull-employees — sumber
       data karyawan sekarang Google Sheet (read-only, lihat catatan lengkap
       di supabase/functions/sheet-pull-employees/index.ts), bukan Odoo lagi.
       Nama fungsi client-nya (syncFromOdoo) sengaja DIBIARKAN sama biar
       nggak perlu ubah pemanggilnya di karyawan.js — cuma isinya yang ganti. */
    syncFromOdoo: async function () {
      const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/sheet-pull-employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({}),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || 'Gagal sinkron karyawan dari Google Sheet.');
      return result;
    },
  };

  window.SPB = window.SPB || {};
  window.SPB.dbWhOut = dbWhOut;
  window.SPB.dbDistribusi = dbDistribusi;
  window.SPB.dbRestock = dbRestock;
  window.SPB.dbKaryawan = dbKaryawan;
})();
