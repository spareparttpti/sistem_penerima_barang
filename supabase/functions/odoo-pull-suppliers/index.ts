/**
 * Edge Function: odoo-pull-suppliers
 *
 * Tarik daftar Supplier (res.partner, supplier_rank > 0) + Vendor Pricelist
 * per supplier (product.supplierinfo — sama data yang muncul di Odoo pada
 * menu Purchase > Products > Vendor Pricelists) ke tabel spinning_supplier
 * & spinning_supplier_product. Read-only dari sisi SPB, dipakai halaman
 * Master Data > Supplier role Spinning (spinningMaster.js).
 *
 * FILTER PRODUK (bukan filter supplier): cuma product.supplierinfo yang
 * product-nya masuk category path mengandung kata "Spinning" ATAU "Umum"
 * (case-insensitive, mis. "All / Sparepart / Mekanik / Spinning / Winding")
 * yang ditarik. Supplier yang di-upsert HANYA supplier yang punya minimal 1
 * produk lolos filter itu — supplier yang cuma jualan produk divisi lain
 * (mis. Weaving doang) sengaja TIDAK ikut masuk ke SPB Spinning.
 *
 * CATATAN: field email/phone/city/vat/nama SELALU ditimpa dari Odoo tiap
 * sync (sumber kebenarannya Odoo). Field termin_hari & status SENGAJA
 * TIDAK PERNAH disentuh di sini — itu dikelola manual di SPB sendiri,
 * karena Odoo tidak punya kolom "termin dalam hari" yang bersih untuk
 * ditarik apa adanya.
 *
 * Deploy: supabase functions deploy odoo-pull-suppliers
 * (pakai secrets ODOO_* yang SAMA dengan odoo-pull-stock — tidak perlu diisi ulang)
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

// Category path (categ_id display_name, mis. "All / Sparepart / Mekanik /
// Spinning / Winding") dianggap lolos kalau mengandung kata "Spinning" atau
// "Umum" di salah satu segmennya, case-insensitive.
const CATEGORY_ALLOW = /spinning|umum/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const uid = await login();
    const errors: string[] = [];

    // ---- 1) Vendor Pricelist (product.supplierinfo) — TARIK SEMUA dulu
    // (belum difilter supplier), baru difilter berdasarkan category produknya
    // di bawah. Sama data yang muncul di menu Odoo "Vendor Pricelists". ----
    const supplierInfos = await rpc(uid, "product.supplierinfo", "search_read", [[]], {
      fields: ["partner_id", "product_tmpl_id", "product_name", "product_code", "price", "currency_id", "min_qty", "delay"],
    }) as Record<string, unknown>[];

    if (!supplierInfos.length) return json({ ok: true, fetched: 0, productsUpserted: 0, errors: [] });

    // Ambil category tiap product_tmpl_id yang muncul, sekali query batch.
    const tmplIds = Array.from(new Set(
      supplierInfos.map((s) => m2oId(s.product_tmpl_id)).filter((x): x is number => x != null)
    ));
    const categoryByTmplId = new Map<number, string>();
    // product_name & product_code di product.supplierinfo itu field override
    // yang di Odoo SERING dibiarkan kosong (baru kepakai kalau memang diisi
    // manual di baris Vendor Pricelist) — nama & SKU produk yang SEBENARNYA
    // ada di product.template (name/default_code), jadi diambil sekalian di
    // sini buat dipakai sebagai fallback kalau field supplierinfo-nya kosong.
    const nameByTmplId = new Map<number, string>();
    const skuByTmplId = new Map<number, string>();
    for (const chunk of chunks(tmplIds, 500)) {
      const page = await rpc(uid, "product.template", "search_read", [
        [["id", "in", chunk]],
      ], { fields: ["categ_id", "name", "default_code"] }) as Record<string, unknown>[];
      for (const t of page) {
        categoryByTmplId.set(t.id as number, m2oName(t.categ_id));
        nameByTmplId.set(t.id as number, odooStr(t.name));
        skuByTmplId.set(t.id as number, odooStr(t.default_code));
      }
    }

    // Filter: cuma supplierinfo yang category produknya lolos CATEGORY_ALLOW.
    const filteredInfos = supplierInfos.filter((s) => {
      const tmplId = m2oId(s.product_tmpl_id);
      const category = tmplId != null ? categoryByTmplId.get(tmplId) : "";
      return !!category && CATEGORY_ALLOW.test(category);
    });

    if (!filteredInfos.length) return json({ ok: true, fetched: 0, productsUpserted: 0, errors: [] });

    // ---- 2) Supplier (res.partner) — HANYA yang punya >=1 produk lolos filter. ----
    const partnerIds = Array.from(new Set(
      filteredInfos.map((s) => m2oId(s.partner_id)).filter((x): x is number => x != null)
    ));
    const partners = await rpc(uid, "res.partner", "search_read", [
      [["id", "in", partnerIds]],
    ], {
      fields: ["name", "email", "phone", "city", "vat"],
      context: { active_test: false },
    }) as Record<string, unknown>[];

    // Upsert cuma kolom yang SUMBERNYA Odoo — termin_hari/status/kontak/
    // kategori_utama/rating/kode TIDAK ikut dikirim, biar nilai yang sudah
    // diedit manual di SPB (lewat popup "Ubah Supplier") tidak ketimpa tiap
    // kali sync (lihat catatan di database/part_mesin_schema.sql). nama/
    // telepon/email/kota/alamat/npwp TETAP ditimpa Odoo tiap sync (itu
    // datanya SUMBER KEBENARANNYA Odoo, bukan field yang SPB kelola sendiri).
    const supplierPayload = partners.map((p) => ({
      odoo_partner_id: p.id as number,
      nama: odooStr(p.name) || "-",
      telepon: odooStr(p.phone) || null,
      alamat: odooStr(p.city) || null,
      email: odooStr(p.email) || null,
      npwp: odooStr(p.vat) || null,
      kota: odooStr(p.city) || null,
    }));
    for (const chunk of chunks(supplierPayload, 200)) {
      const { error } = await supabase.from("spinning_supplier").upsert(chunk, { onConflict: "odoo_partner_id" });
      if (error) errors.push(`upsert supplier (${chunk.length} baris): ${error.message}`);
    }

    // Ambil ulang id internal SPB per odoo_partner_id (buat FK product di bawah).
    const { data: supplierRows, error: eSup } = await supabase
      .from("spinning_supplier").select("id, odoo_partner_id").not("odoo_partner_id", "is", null);
    if (eSup) errors.push(`baca ulang supplier: ${eSup.message}`);
    const supplierIdByOdoo = new Map<number, string>();
    (supplierRows || []).forEach((r) => supplierIdByOdoo.set(r.odoo_partner_id as number, r.id as string));

    const productPayload = filteredInfos.map((s) => {
      const partnerId = m2oId(s.partner_id);
      const supplierId = partnerId != null ? supplierIdByOdoo.get(partnerId) : null;
      if (!supplierId) return null;
      const tmplId = m2oId(s.product_tmpl_id);
      const tmplName = tmplId != null ? nameByTmplId.get(tmplId) : "";
      const tmplSku = tmplId != null ? skuByTmplId.get(tmplId) : "";
      return {
        supplier_id: supplierId,
        odoo_supplierinfo_id: s.id as number,
        sku: odooStr(s.product_code) || tmplSku || null,
        product_name: odooStr(s.product_name) || tmplName || "-",
        price: Number(s.price ?? 0),
        currency: m2oName(s.currency_id) || null,
        min_qty: Number(s.min_qty ?? 0),
        delay_hari: s.delay != null && s.delay !== false ? Number(s.delay) : null,
      };
    }).filter((x): x is NonNullable<typeof x> => !!x);

    for (const chunk of chunks(productPayload, 200)) {
      const { error } = await supabase.from("spinning_supplier_product").upsert(chunk, { onConflict: "odoo_supplierinfo_id" });
      if (error) errors.push(`upsert supplier product (${chunk.length} baris): ${error.message}`);
    }

    return json({ ok: true, fetched: partners.length, productsUpserted: productPayload.length, errors });
  } catch (err) {
    console.error("odoo-pull-suppliers:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
