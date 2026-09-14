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
      fields: ["default_code", "name", "uom_id", "list_price"],
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
    sku: string; product_name: string; uom: string; category: "ATK" | "Lainnya";
    qty_on_hand: number; qty_reserved: number; odoo_product_id: number; location_name: string; sales_price: number;
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
        qty_on_hand: qty,
        qty_reserved: reserved,
        odoo_product_id: pid,
        location_name: locName,
        sales_price: Number(p.list_price ?? 0),
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
      qty_on_hand: 0,
      qty_reserved: 0,
      odoo_product_id: p.id as number,
      location_name: "",
      sales_price: Number(p.list_price ?? 0),
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
    qty_on_hand: r.qty_on_hand,
    qty_reserved: r.qty_reserved,
    qty_available: r.qty_on_hand - r.qty_reserved,
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const uid = await login();
    const locationIds = await resolveStockLocationIds(uid);
    const { rows, priceBySku } = await fetchStock(uid, locationIds);
    const result = await upsertStock(rows);
    const priceResult = await updateSparepartPrices(priceBySku);

    return json({
      ok: true, fetched: rows.length, ...result,
      pricesUpdated: priceResult.pricesUpdated,
      errors: [...result.errors, ...priceResult.errors],
    });
  } catch (err) {
    console.error("odoo-pull-stock:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
