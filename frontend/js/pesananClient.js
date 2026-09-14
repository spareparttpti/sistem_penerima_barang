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
    getByQueueNo: async function (queueNoRaw) {
      if (DEMO) noDemo();
      const digits = String(queueNoRaw || '').replace(/\D/g, '').replace(/^0+/, '');
      if (!digits) return null;
      const { data, error } = await sb()
        .from('pesanan')
        .select('*, items:pesanan_item(*)')
        .eq('queue_no', Number(digits))
        .maybeSingle();
      throwIfError(error);
      return data || null;
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
          return { pesanan_id: pesanan.id, sku: it.sku || null, nama_barang: it.nama_barang, qty: it.qty, satuan: it.satuan || null };
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
