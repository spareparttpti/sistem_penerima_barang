/**
 * Edge Function: odoo-pull-stock
 *
 * Tarik snapshot stok ATK dari Odoo (stock.quant di lokasi gudang "WH/Stok")
 * buat dashboard "Stok Barang" — read-only, tidak ada tulis balik ke Odoo
 * sama sekali (mirip odoo-pull & odoo-pull-wh-out).
 *
 * Cuma produk dengan SKU (default_code) diawali "ATK" (case-insensitive) yang
 * disimpan ke stok_barang, sesuai pola yang sama dipakai di odoo-pull-wh-out.
 *
 * SEKALIAN update harga (list_price) SEMUA sparepart (bukan cuma ATK) ke
 * tabel spareparts — dipakai kolom "Harga" di laporan ringkas WH/IN. Cuma
 * UPDATE SKU yang SUDAH ADA di master spareparts, TIDAK bikin baris baru.
 *
 * SEKALIAN JUGA tarik Unit of Measure (uom.uom) ke tabel satuan_odoo, dipakai
 * halaman "Master Satuan" role Spinning — digabung ke sini (bukan Edge
 * Function terpisah) biar nggak nambah-nambah function baru terus.
 *
 * MODE LAIN: kalau body request-nya berisi { sku }, function ini TIDAK jalanin
 * sync massal di atas — malah balik jalur khusus buat tarik riwayat pergerakan
 * (stock.move.line, state='done') SATU SKU itu ON-DEMAND, dipakai popup detail
 * "Riwayat Pergerakan" di halaman Inventory/Stok Gudang (Spinning). Digabung
 * ke function yang sama (bukan Edge Function terpisah) — sama alasan di atas.
 *
 * Deploy: supabase functions deploy odoo-pull-stock
 * (pakai secrets ODOO_* yang SAMA dengan odoo-pull — tidak perlu diisi ulang)
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function env(key: string): string {
  return (Deno.env.get(key) ?? "").trim();
}
const ODOO_URL = env("ODOO_URL");
const ODOO_DB = env("ODOO_DB");
const ODOO_USER = env("ODOO_USER");
const ODOO_PASSWORD = env("ODOO_PASSWORD");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function odooStr(v: unknown): string {
  return v == null || v === false ? "" : String(v);
}
function m2oName(v: unknown): string {
  if (Array.isArray(v)) return odooStr(v[1]);
  return odooStr(v);
}
function m2oId(v: unknown): number | null {
  if (Array.isArray(v)) return Number(v[0]);
  return null;
}

const ODOO_TIMEOUT_MS = 25000;
async function jsonRpc(service: string, method: string, args: unknown[]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ODOO_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${ODOO_URL.replace(/\/$/, "")}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`Tidak ada balasan dari Odoo dalam ${ODOO_TIMEOUT_MS / 1000} detik.`);
    throw new Error(`Gagal menghubungi Odoo: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Odoo JSON-RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Odoo: ${body.error?.data?.message ?? body.error.message}`);
  return body.result;
}
async function login(): Promise<number> {
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
    throw new Error("Secret ODOO_URL/ODOO_DB/ODOO_USER/ODOO_PASSWORD belum lengkap.");
  }
  const uid = await jsonRpc("common", "login", [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
  if (!uid || typeof uid !== "number") throw new Error("Login Odoo gagal — cek email & password.");
  return uid;
}
async function rpc(uid: number, model: string, method: string, args: unknown[], kwargs: unknown = {}) {
  return jsonRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs]);
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Cari lokasi internal yang nama lengkapnya mengandung "WH/Stok" (sama lokasi
// yang dipakai sebagai Source Location di WH/OUT) — bisa lebih dari 1 kalau
// ada sub-lokasi di bawahnya, semuanya ikut dihitung.
async function resolveStockLocationIds(uid: number): Promise<number[]> {
  const locations = await rpc(uid, "stock.location", "search_read", [
    [["complete_name", "ilike", "WH/Stok"], ["usage", "=", "internal"]],
  ], { fields: ["id", "complete_name"] }) as { id: number }[];
  if (!locations.length) {
    throw new Error('Lokasi gudang "WH/Stok" tidak ditemukan di Odoo (stock.location, usage=internal).');
  }
  return locations.map((l) => l.id);
}

async function fetchStock(uid: number, locationIds: number[]) {
  // Tarik SEMUA produk yang punya SKU (default_code) — bukan cuma ATK lagi.
  // Kategorinya ditentukan belakangan per SKU (ATK vs Lainnya), dipakai buat
  // toggle "Barang ATK" / "Semua Barang" di halaman Stok Barang.
  // "order: id asc" WAJIB ada — tanpa urutan eksplisit, paginasi banyak
  // halaman (ribuan produk / 500 per halaman) bisa dapat urutan yang TIDAK
  // stabil antar panggilan, bikin sebagian produk "lompat"/kelewat di antara
  // 2 halaman. Dulu aman karena cuma 1 halaman (77 produk ATK, langsung
  // habis), sekarang wajib eksplisit karena butuh puluhan halaman.
  // context: {active_test:false} — ikutkan juga produk yang di-archive/
  // nonaktif di Odoo (defaultnya search_read cuma nampilin yang aktif).
  const products: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await rpc(uid, "product.product", "search_read", [
      [["default_code", "!=", false]],
    ], {
      // incoming_qty — field bawaan Odoo (product.product), jumlah barang
      // yang lagi "di jalan" dari Purchase Order yang udah confirm tapi
      // belum diterima (Incoming Shipments belum Done). Ini nge-cover
      // SEMUA warehouse/lokasi (bukan cuma WH/Stok kayak quant di bawah),
      // tapi cukup buat kebutuhan sekarang — sekadar kasih tau "lagi ada
      // yang dipesan/otw" di kolom Incoming, BELUM ada fitur PO SPB sendiri.
      // categ_id — Odoo balikin display_name-nya SUDAH berupa path lengkap
      // ("Induk / Anak / Cucu", termasuk "... / Spinning / PLKUM" dst) lewat
      // name_get bawaan product.category, jadi cukup ambil field ini doang,
      // TANPA perlu query product.category terpisah buat susun pathnya manual.
      fields: ["default_code", "name", "uom_id", "list_price", "incoming_qty", "categ_id"],
      limit: 500, offset, order: "id asc",
      context: { active_test: false },
    });
    products.push(...(page as Record<string, unknown>[]));
    if (page.length < 500) break;
  }
  if (!products.length) return { rows: [], priceBySku: new Map<string, number>() };
  const productById: Record<number, Record<string, unknown>> = {};
  for (const p of products) productById[p.id as number] = p;
  const productIds = products.map((p) => p.id as number);

  const quants: Record<string, unknown>[] = [];
  for (const chunk of chunks(productIds, 500)) {
    const page = await rpc(uid, "stock.quant", "search_read", [
      [["location_id", "in", locationIds], ["product_id", "in", chunk]],
    ], { fields: ["product_id", "quantity", "reserved_quantity", "location_id"] });
    quants.push(...(page as Record<string, unknown>[]));
  }

  // Jumlahkan per produk (bisa ada beberapa baris quant per produk kalau lebih
  // dari 1 lokasi/lot cocok filter di atas).
  const bySku: Record<string, {
    sku: string; product_name: string; uom: string; category: "ATK" | "Lainnya"; odoo_category: string;
    qty_on_hand: number; qty_reserved: number; odoo_product_id: number; location_name: string; sales_price: number;
    qty_incoming: number;
  }> = {};
  const locationNameById: Record<number, string> = {};

  for (const q of quants) {
    const pid = m2oId(q.product_id);
    if (pid == null) continue;
    const p = productById[pid];
    if (!p) continue;
    const sku = odooStr(p.default_code);
    if (!sku) continue;

    const locId = m2oId(q.location_id);
    const locName = m2oName(q.location_id);
    if (locId != null) locationNameById[locId] = locName;

    const existing = bySku[sku];
    const qty = Number(q.quantity ?? 0);
    const reserved = Number(q.reserved_quantity ?? 0);
    if (existing) {
      existing.qty_on_hand += qty;
      existing.qty_reserved += reserved;
    } else {
      bySku[sku] = {
        sku,
        product_name: odooStr(p.name),
        uom: m2oName(p.uom_id) || "Pcs",
        category: sku.toUpperCase().startsWith("ATK") ? "ATK" : "Lainnya",
        odoo_category: m2oName(p.categ_id),
        qty_on_hand: qty,
        qty_reserved: reserved,
        odoo_product_id: pid,
        location_name: locName,
        sales_price: Number(p.list_price ?? 0),
        qty_incoming: Number(p.incoming_qty ?? 0),
      };
    }
  }

  // Barang yang SAMA SEKALI belum punya baris stock.quant di WH/Stok (belum
  // pernah gerak stoknya di lokasi itu, atau memang stoknya 0) TIDAK ikut
  // kepick di loop `quants` di atas — padahal itu tetap barang yang sah di
  // katalog Odoo, cuma qty-nya 0 di lokasi ini. Ditambahkan manual di sini
  // (qty 0) supaya daftar Stok Barang selalu LENGKAP sesuai master produk
  // Odoo, bukan cuma yang kebetulan punya histori stok.
  //
  // Dulu ini CUMA dilakuin buat kategori ATK (kategori "Lainnya" sengaja
  // dilewatin biar "nggak meledak jadi ribuan baris qty-0") — tapi itu bikin
  // barang non-ATK yang stoknya 0 (mis. "TISSUE" [PU008]) hilang sama sekali
  // dari SPB, padahal fitur filter "Stok Habis" di Katalog Permintaan Barang
  // justru DIRANCANG buat nampilin barang stok 0 kayak gitu. Sekarang berlaku
  // buat SEMUA kategori — "meledak jadi ribuan baris" itu sendiri bukan
  // masalah (toh memang segitu jumlah SKU asli di Odoo), yang penting datanya
  // lengkap & akurat.
  for (const p of products) {
    const sku = odooStr(p.default_code);
    if (!sku) continue;
    if (bySku[sku]) continue;
    bySku[sku] = {
      sku,
      product_name: odooStr(p.name),
      uom: m2oName(p.uom_id) || "Pcs",
      category: sku.toUpperCase().startsWith("ATK") ? "ATK" : "Lainnya",
      odoo_category: m2oName(p.categ_id),
      qty_on_hand: 0,
      qty_reserved: 0,
      odoo_product_id: p.id as number,
      location_name: "",
      sales_price: Number(p.list_price ?? 0),
      qty_incoming: Number(p.incoming_qty ?? 0),
    };
  }

  // list_price SEMUA produk sudah ikut ke-ambil di query product.product di
  // atas — dipakai LANGSUNG buat priceBySku, TIDAK perlu tarik ulang seluruh
  // katalog dari Odoo untuk kedua kalinya (sebelumnya ada fetchAllPrices()
  // terpisah yang re-paginate SEMUA produk lagi dari nol — mubazir, dan bikin
  // total beban kerja function ini 2x lipat, lebih gampang kena timeout/hasil
  // nggak stabil di katalog besar).
  const priceBySku = new Map<string, number>();
  for (const p of products) {
    const sku = odooStr(p.default_code).trim();
    if (sku) priceBySku.set(sku.toLowerCase(), Number(p.list_price ?? 0));
  }

  return { rows: Object.values(bySku), priceBySku };
}

async function upsertStock(rows: Awaited<ReturnType<typeof fetchStock>>["rows"]) {
  const errors: string[] = [];
  if (!rows.length) return { errors };

  const payload = rows.map((r) => ({
    sku: r.sku,
    product_name: r.product_name || "-",
    uom: r.uom || "Pcs",
    category: r.category,
    odoo_category: r.odoo_category || null,
    qty_on_hand: r.qty_on_hand,
    qty_reserved: r.qty_reserved,
    qty_available: r.qty_on_hand - r.qty_reserved,
    qty_incoming: r.qty_incoming || 0,
    sales_price: r.sales_price || 0,
    location_name: r.location_name || null,
    odoo_product_id: r.odoo_product_id,
    updated_at: new Date().toISOString(),
  }));

  for (const chunk of chunks(payload, 200)) {
    const { error } = await supabase.from("stok_barang").upsert(chunk, { onConflict: "sku" });
    if (error) errors.push(`upsert stok (${chunk.length} baris): ${error.message}`);
  }
  return { errors };
}

// Update harga di master spareparts (dipakai kolom "Harga" laporan ringkas
// WH/IN) — priceBySku sudah dibangun sekalian di fetchStock(), tidak perlu
// panggilan Odoo tambahan. Cuma UPDATE SKU yang SUDAH ADA di spareparts,
// tidak pernah bikin baris baru (spareparts dikelola proses lain).
async function updateSparepartPrices(priceBySku: Map<string, number>) {
  const errors: string[] = [];
  const { data, error } = await supabase.from("spareparts").select("id, sku");
  if (error) { errors.push(`baca spareparts: ${error.message}`); return { pricesUpdated: 0, errors }; }

  const rows = (data ?? []) as { id: string; sku: string }[];
  const toUpdate = rows
    .map((r) => ({ id: r.id, price: priceBySku.get((r.sku || "").toLowerCase()) }))
    .filter((r): r is { id: string; price: number } => r.price != null);

  let pricesUpdated = 0;
  for (const chunk of chunks(toUpdate, 200)) {
    const results = await Promise.all(chunk.map((r) =>
      supabase.from("spareparts").update({ sales_price: r.price }).eq("id", r.id)
    ));
    for (const res of results) {
      if (res.error) errors.push(`update harga sparepart: ${res.error.message}`);
      else pricesUpdated++;
    }
  }
  return { pricesUpdated, errors };
}

// Unit of Measure (uom.uom) — dipakai halaman "Master Satuan" role Spinning.
// Digabung ke function ini (bukan Edge Function terpisah) karena sama-sama
// "tarik master data produk dari Odoo", satu jalan sekali panggil sekalian.
async function fetchAndUpsertUom(uid: number) {
  const errors: string[] = [];
  // context: {active_test:false} — ikutkan satuan yang di-archive juga, biar
  // status Aktif/Nonaktif di tabel kita ikut akurat.
  const units = await rpc(uid, "uom.uom", "search_read", [[]], {
    fields: ["name", "category_id", "uom_type", "active"],
    context: { active_test: false },
  }) as Record<string, unknown>[];

  const payload = units.map((u) => ({
    odoo_id: u.id as number,
    name: odooStr(u.name),
    category: m2oName(u.category_id),
    uom_type: odooStr(u.uom_type),
    active: !!u.active,
    updated_at: new Date().toISOString(),
  }));

  for (const chunk of chunks(payload, 200)) {
    const { error } = await supabase.from("satuan_odoo").upsert(chunk, { onConflict: "odoo_id" });
    if (error) errors.push(`upsert satuan (${chunk.length} baris): ${error.message}`);
  }
  return { fetched: payload.length, errors };
}

// Riwayat pergerakan (WH IN/WH OUT) SATU SKU, ON-DEMAND — dipanggil dari
// popup "Riwayat Pergerakan" di halaman Inventory (Spinning), BUKAN sync
// massal seperti fungsi lain di file ini. Tidak disimpan ke tabel Supabase
// (bisa ribuan baris per produk kalau ditarik semua) — cuma dibalikin
// langsung ke client, dibatasi 100 baris terakhir.
//
// "Masuk" (WH IN) = location tujuan ADA di WH/Stok, asalnya BUKAN dari situ.
// "Keluar" (WH OUT) = location asal ADA di WH/Stok, tujuannya BUKAN situ.
// Mutasi internal sesama WH/Stok (mis. antar rak) DILEWATI.
async function fetchStockMoves(uid: number, sku: string) {
  const products = await rpc(uid, "product.product", "search_read", [
    [["default_code", "=", sku]],
  ], { fields: ["id", "product_tmpl_id"], limit: 1, context: { active_test: false } }) as Record<string, unknown>[];
  if (!products.length) return { moves: [] as unknown[] };
  const productId = products[0].id as number;
  const productTmplId = m2oId(products[0].product_tmpl_id);

  const stockLocationIds = new Set(await resolveStockLocationIds(uid));

  // "qty_done" cuma ada di Odoo <=16 — Odoo 17+ ganti nama field itu jadi
  // "quantity" di stock.move.line. Field yang dipakai versi Odoo-nya nggak
  // diketahui dari sini, jadi dicoba "quantity" dulu (versi lebih baru),
  // fallback ke "qty_done" kalau field itu yang ternyata tidak ada.
  let lines: Record<string, unknown>[];
  let qtyField: "quantity" | "qty_done" = "quantity";
  try {
    lines = await rpc(uid, "stock.move.line", "search_read", [
      [["product_id", "=", productId], ["state", "=", "done"]],
    ], {
      fields: ["date", "quantity", "location_id", "location_dest_id", "picking_id", "reference"],
      order: "date desc",
      limit: 100,
    }) as Record<string, unknown>[];
  } catch {
    qtyField = "qty_done";
    lines = await rpc(uid, "stock.move.line", "search_read", [
      [["product_id", "=", productId], ["state", "=", "done"]],
    ], {
      fields: ["date", "qty_done", "location_id", "location_dest_id", "picking_id", "reference"],
      order: "date desc",
      limit: 100,
    }) as Record<string, unknown>[];
  }

  // Nama vendor/operator ("Dari" waktu WH IN, "Ke" waktu WH OUT) diambil dari
  // partner_id di stock.picking (dokumen induk move-nya) — field itu TIDAK
  // ada di stock.move.line, jadi ditarik terpisah per picking_id yang muncul.
  const pickingIds = Array.from(new Set(
    lines.map((l) => m2oId(l.picking_id)).filter((x): x is number => x != null)
  ));
  const partnerNameByPickingId = new Map<number, string>();
  if (pickingIds.length) {
    const pickings = await rpc(uid, "stock.picking", "search_read", [
      [["id", "in", pickingIds]],
    ], { fields: ["partner_id"] }) as Record<string, unknown>[];
    for (const p of pickings) {
      const name = m2oName(p.partner_id);
      if (name) partnerNameByPickingId.set(p.id as number, name);
    }
  }

  // Fallback kalau picking-nya sendiri nggak punya partner (mis. inventory
  // adjustment manual, bukan penerimaan riil dari PO) — cocokkan ke vendor
  // UTAMA produk ini di Odoo (product.supplierinfo, diurutkan `sequence`,
  // ambil yang pertama = vendor prioritas Odoo buat produk itu). Ini BUKAN
  // vendor asli pergerakan itu (Odoo sendiri nggak nyimpen itu buat baris
  // adjustment), makanya ditandai `supplierIsDefault:true` biar UI bisa
  // kasih keterangan jujur "vendor utama produk", bukan seolah-olah data
  // riil movement itu.
  let mainSupplierName: string | null = null;
  const needsFallback = lines.some((l) => {
    const pickingId = m2oId(l.picking_id);
    return pickingId == null || !partnerNameByPickingId.get(pickingId);
  });
  if (needsFallback) {
    // Vendor Pricelist bisa didaftarkan di level varian (product_id) ATAU
    // level template (product_tmpl_id) — dicek dua-duanya (OR), diurutkan
    // `sequence` (urutan prioritas vendor versi Odoo), ambil yang teratas.
    const domain: unknown[] = productTmplId != null
      ? ["|", ["product_id", "=", productId], ["product_tmpl_id", "=", productTmplId]]
      : [["product_id", "=", productId]];
    const supplierInfos = await rpc(uid, "product.supplierinfo", "search_read", [
      domain,
    ], { fields: ["partner_id"], order: "sequence asc", limit: 1 }) as Record<string, unknown>[];
    if (supplierInfos.length) mainSupplierName = m2oName(supplierInfos[0].partner_id) || null;
  }

  const moves = lines.map((l) => {
    const fromId = m2oId(l.location_id);
    const toId = m2oId(l.location_dest_id);
    const fromInStock = fromId != null && stockLocationIds.has(fromId);
    const toInStock = toId != null && stockLocationIds.has(toId);
    let arah: "masuk" | "keluar" | null = null;
    if (toInStock && !fromInStock) arah = "masuk";
    else if (fromInStock && !toInStock) arah = "keluar";
    if (!arah) return null; // mutasi internal sesama WH/Stok, dilewati
    const pickingId = m2oId(l.picking_id);
    // Vendor (masuk) / operator (keluar) dari partner_id picking-nya —
    // ditaruh di field TERPISAH (`partner`), BUKAN dicampur ke lokasi_asal/
    // lokasi_tujuan, biar dua-duanya ("lokasi Odoo" dan "nama vendor/
    // operator") tetap kebaca bareng di popup.
    const realPartner = pickingId != null ? (partnerNameByPickingId.get(pickingId) || null) : null;
    // Fallback vendor utama HANYA buat arah "masuk" (nggak relevan buat WH
    // OUT/operator) & cuma kalau memang nggak ada partner riil di picking-nya.
    const partnerName = realPartner || (arah === "masuk" ? mainSupplierName : null);
    return {
      arah,
      tanggal: odooStr(l.date), // format Odoo: "YYYY-MM-DD HH:MM:SS" (UTC)
      qty: Number(l[qtyField] ?? 0),
      picking: m2oName(l.picking_id) || odooStr(l.reference) || "-",
      partner: partnerName,
      supplierIsDefault: !realPartner && !!partnerName,
      lokasi_asal: m2oName(l.location_id),
      lokasi_tujuan: m2oName(l.location_dest_id),
    };
  }).filter((x) => !!x);

  return { moves };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // Mode "riwayat pergerakan 1 SKU" — dipicu kalau body-nya punya { sku }.
    const body = req.method === "POST" ? await req.json().catch(() => ({} as { sku?: string })) : {};
    if (body && body.sku) {
      const uid = await login();
      const { moves } = await fetchStockMoves(uid, body.sku);
      return json({ ok: true, moves, errors: [] });
    }

    const uid = await login();
    const locationIds = await resolveStockLocationIds(uid);
    const { rows, priceBySku } = await fetchStock(uid, locationIds);
    const result = await upsertStock(rows);
    const priceResult = await updateSparepartPrices(priceBySku);
    const uomResult = await fetchAndUpsertUom(uid);

    return json({
      ok: true, fetched: rows.length, ...result,
      pricesUpdated: priceResult.pricesUpdated,
      uomFetched: uomResult.fetched,
      errors: [...result.errors, ...priceResult.errors, ...uomResult.errors],
    });
  } catch (err) {
    console.error("odoo-pull-stock:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
