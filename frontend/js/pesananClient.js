/* =========================================================
   SPB · pesananClient.js
   Lapisan data "Permintaan Barang" (portal pemesanan online per-divisi) —
   SATU Supabase project sama dengan SPB (Pilihan B), jadi cukup pakai
   window.SPB.sb yang sama, TIDAK perlu client Supabase kedua.

   Tabel: pesanan (header) + pesanan_item (isi), lihat
   database/pesanan_schema.sql. Katalog barang & data karyawan numpang ke
   stok_barang/karyawan yang udah ada (bukan tanggung jawab file ini).
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
    throw new Error('Permintaan Barang belum didukung di mode demo — set demoMode:false di config.js.');
  }

  const dbPesanan = {
    // Semua pesanan + item-nya sekalian (nested select, 1 round-trip) —
    // paginasi .range() WAJIB sama alasan yang sama kayak stok_barang/
    // karyawan: PostgREST batasin 1000 baris per request secara diam-diam.
    listAll: async function () {
      if (DEMO) noDemo();
      const PAGE = 1000;
      const all = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb()
          .from('pesanan')
          .select('*, items:pesanan_item(*)')
          .order('created_at', { ascending: false })
          .range(from, from + PAGE - 1);
        throwIfError(error);
        const page = data || [];
        all.push(...page);
        if (page.length < PAGE) break;
      }
      return all;
    },

    get: async function (id) {
      if (DEMO) noDemo();
      const { data, error } = await sb()
        .from('pesanan')
        .select('*, items:pesanan_item(*)')
        .eq('id', id)
        .maybeSingle();
      throwIfError(error);
      return data || null;
    },

    // Cari pesanan dari NOMOR ANTRIAN ("A-0001" atau "1" atau "0001") —
    // dipakai fitur "Cek Status Pesanan" di portal (device dipakai gantian
    // antar-karyawan, jadi setelah dapat nomor antrian orangnya nggak selalu
    // masih pegang link #/tiket/:id-nya lagi; nomor antrian jauh lebih
    // gampang diingat/ditulis manual ketimbang UUID).
    //
    // Nomornya sekarang divisi_seq (PER DIVISI, lihat pesanan_schema.sql) —
    // BUKAN unik secara global lagi (D-0001 & S-0001 sama-sama "1"), jadi
    // huruf depannya (inisial divisi) ikut dipakai buat mastiin yang ketemu
    // itu yang bener, bukan cuma nebak dari angkanya doang.
    getByQueueNo: async function (queueNoRaw) {
      if (DEMO) noDemo();
      const raw = String(queueNoRaw || '').trim();
      const m = raw.match(/^([A-Za-z])?\D*0*(\d+)/);
      if (!m || !m[2]) return null;
      const letter = m[1] ? m[1].toUpperCase() : null;
      const num = Number(m[2]);
      // divisi_seq: cocokin ke nomor per-divisi (cara baru). queue_no: jaga-
      // jaga buat pesanan lama sebelum migrasi divisi_seq sempat dijalanin
      // (baris lama yang belum ke-backfill) ATAU kalau SQL migrasinya sendiri
      // belum sempat dijalanin di database (kolomnya belum ada sama sekali —
      // query-nya bakal error "column ... does not exist", DITANGKAP di sini
      // biar nggak bikin seluruh fitur Cek Status gagal total, tinggal
      // fallback ke queue_no) — dicoba divisi_seq dulu, kalau nggak ketemu
      // satu pun (atau kolomnya belum ada) baru fallback ke queue_no.
      let rows = [];
      try {
        const res = await sb()
          .from('pesanan')
          .select('*, items:pesanan_item(*)')
          .eq('divisi_seq', num);
        throwIfError(res.error);
        rows = res.data || [];
      } catch (e) { /* kolom divisi_seq belum ada / query gagal — lanjut ke fallback queue_no di bawah */ }
      const matchByLetter = letter
        ? rows.find(function (r) { return ((r.divisi || '').trim().charAt(0).toUpperCase()) === letter; })
        : null;
      if (matchByLetter) return matchByLetter;
      if (!letter && rows.length === 1) return rows[0];
      if (rows.length) return rows[0]; // ambigu (huruf nggak cocok/nggak diisi, tapi ada beberapa match) — ambil yang pertama daripada kosong sama sekali

      const fallback = await sb()
        .from('pesanan')
        .select('*, items:pesanan_item(*)')
        .eq('queue_no', num)
        .maybeSingle();
      throwIfError(fallback.error);
      return fallback.data || null;
    },

    // Cari pesanan yang jadi asal 1 WH/OUT tertentu (dari kolom wh_out_ref
    // yang kesimpen pas sendToOdoo()) — dipakai whOutDetail.js buat nampilin
    // "Distribusi ke Karyawan" READ-ONLY dari data yang udah diisi operator
    // pas pesan di portal, bukan diisi ulang manual sama petugas gudang lagi.
    getByWhOutRef: async function (whOutRef) {
      if (DEMO || !whOutRef) return null;
      const { data, error } = await sb()
        .from('pesanan')
        .select('*, items:pesanan_item(*)')
        .eq('wh_out_ref', whOutRef)
        .maybeSingle();
      throwIfError(error);
      return data || null;
    },

    // Admin (WH/OUT) boleh KOREKSI distribusi yang diisi operator pas pesan
    // di portal (nambah/kurangin penerima, ubah qty/kondisi) — dipakai
    // tombol "Edit Distribusi" di whOutDetail.js. Nulis LANGSUNG ke kolom
    // distribusi (jsonb) punya 1 baris pesanan_item, BUKAN bikin tabel
    // relasi baru — sama pola kayak operator ngisi pertama kali.
    updateItemDistribusi: async function (itemId, distribusi) {
      if (DEMO) noDemo();
      const { error } = await sb().from('pesanan_item').update({ distribusi: distribusi }).eq('id', itemId);
      throwIfError(error);
    },

    // status: 'waiting' -> 'processing' -> 'ready' -> 'done'. Nge-cap
    // timestamp yang sesuai (processing_at/ready_at/done_at) otomatis di
    // sini, bukan tanggung jawab pemanggil.
    updateStatus: async function (id, status) {
      if (DEMO) noDemo();
      const payload = { status: status };
      if (status === 'processing') payload.processing_at = new Date().toISOString();
      if (status === 'ready') payload.ready_at = new Date().toISOString();
      if (status === 'done') payload.done_at = new Date().toISOString();
      const { data, error } = await sb()
        .from('pesanan').update(payload).eq('id', id).select().maybeSingle();
      throwIfError(error);
      return data;
    },

    /* items: [{ sku, nama_barang, qty, satuan }] — dipakai portal pemesanan
       (belum ada UI-nya, disiapkan duluan buat langkah selanjutnya). */
    create: async function (header, items) {
      if (DEMO) noDemo();
      const { data: pesanan, error } = await sb()
        .from('pesanan').insert(header).select().maybeSingle();
      throwIfError(error);
      if (items && items.length) {
        const payload = items.map(function (it) {
          return { pesanan_id: pesanan.id, sku: it.sku || null, nama_barang: it.nama_barang, qty: it.qty, satuan: it.satuan || null, distribusi: it.distribusi || null };
        });
        const { error: itemErr } = await sb().from('pesanan_item').insert(payload);
        throwIfError(itemErr);
      }
      return pesanan;
    },

    remove: async function (id) {
      if (DEMO) noDemo();
      const { error } = await sb().from('pesanan').delete().eq('id', id);
      throwIfError(error);
    },

    // Panggil Edge Function odoo-create-wh-out — bikin Delivery Order baru di
    // Odoo (status Draft doang, TANPA Validate/Mark as Todo) dari 1 pesanan.
    sendToOdoo: async function (pesananId) {
      const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-create-wh-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({ pesanan_id: pesananId }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || 'Gagal mengirim ke Odoo.');
      return result;
    },
  };

  window.SPB = window.SPB || {};
  window.SPB.dbPesanan = dbPesanan;
})();
