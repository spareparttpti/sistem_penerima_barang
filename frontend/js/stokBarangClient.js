/* =========================================================
   SPB · stokBarangClient.js
   Lapisan data Stok Barang (ATK) — read-only, cuma dibaca dari tabel
   stok_barang (diisi Edge Function odoo-pull-stock via cron). Ditambah
   syncNow() buat tombol "Sync dari Odoo" manual (sama pola dengan
   dbKaryawan.syncFromOdoo() di whOutClient.js).
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
    throw new Error('Stok Barang belum didukung di mode demo — set demoMode:false di config.js.');
  }

  const dbStokBarang = {
    // Supabase/PostgREST batasin default 1000 baris per request — sekarang
    // total stok_barang jauh di atas itu (semua produk, bukan cuma ATK),
    // jadi WAJIB diambil per halaman (.range()) sampai benar-benar habis,
    // bukan sekali select() doang (kalau tidak, sisanya kepotong diam-diam
    // tanpa error apapun — itu sebabnya sempat kelihatan cuma 15/25 SKU ATK
    // padahal database aslinya ratusan/ribuan baris).
    // Dulu ambil per halaman SATU-SATU BERURUTAN (nunggu halaman 1 kelar baru
    // minta halaman 2, dst) — makin banyak baris (sekarang semua produk, bukan
    // cuma ATK) makin lama, kerasa kayak macet padahal cuma antre round-trip.
    // Sekarang: tanya dulu total barisnya (count:'exact', head:true — nggak
    // ikut narik datanya, cuma angkanya), baru semua halaman diminta SEKALIGUS
    // PARALEL lewat Promise.all — jauh lebih cepat buat data banyak.
    list: async function () {
      if (DEMO) noDemo();
      const PAGE = 1000;
      const { count, error: countErr } = await sb()
        .from('stok_barang')
        .select('*', { count: 'exact', head: true });
      throwIfError(countErr);
      const total = count || 0;
      if (!total) return [];

      const pageStarts = [];
      for (let from = 0; from < total; from += PAGE) pageStarts.push(from);
      const pages = await Promise.all(pageStarts.map(function (from) {
        return sb()
          .from('stok_barang')
          .select('*')
          .order('product_name', { ascending: true })
          .order('sku', { ascending: true }) // urutan sekunder — biar paginasi stabil, tidak ada baris kelewat/dobel antar halaman kalau product_name-nya sama
          .range(from, from + PAGE - 1)
          .then(function (res) { throwIfError(res.error); return res.data || []; });
      }));
      return pages.reduce(function (all, page) { return all.concat(page); }, []);
    },

    syncNow: async function () {
      const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-pull-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({}),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || 'Gagal sinkron stok dari Odoo.');
      return result;
    },
  };

  window.SPB = window.SPB || {};
  window.SPB.dbStokBarang = dbStokBarang;
})();
