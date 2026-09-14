/**
 * Edge Function: odoo-create-wh-out
 *
 * KEBALIKAN dari odoo-pull-wh-out — bukan menarik, tapi BIKIN Delivery Order
 * (stock.picking) baru di Odoo dari 1 pesanan Permintaan Barang di SPB.
 * Dipanggil dari tombol "Kirim ke Odoo" di dashboard admin (permintaan.js).
 *
 * SENGAJA cuma create() polos — TIDAK manggil action_confirm/button_validate
 * (beda dari odoo-validate). Hasilnya kepencet status Draft doang di Odoo,
 * PERSIS kayak baru "Save", belum "Mark as Todo" ataupun "Validate" — sesuai
 * permintaan: biar petugas gudang yang lanjutin manual dari situ.
 *
 * Alur:
 *  1. Ambil 1 pesanan (+ item-nya) dari Supabase by id.
 *  2. Resolve field custom Employee/Department di stock.picking (caranya
 *     SAMA PERSIS kayak odoo-pull-wh-out — fields_get by label, bukan
 *     hardcode technical name).
 *  3. Cari record hr.employee di Odoo dari nama karyawan (best-effort — nama
 *     karyawan sekarang sumbernya Google Sheet, BUKAN Odoo lagi, jadi kalau
 *     nggak ketemu / beda dikit, field Employee & Department di Odoo bakal
 *     dikosongkan aja, bukan bikin gagal seluruh proses).
 *  4. Cari picking_type_id "GUDANG SPAREPART BESAR: Delivery Orders" (dari
 *     warehouse_id + code=outgoing), ambil default_location_src_id/dest_id-nya.
 *  5. Cari product_id per item lewat SKU (skip item yang sku-nya null — item
 *     "tulis manual" tanpa SKU nggak bisa dipetakan ke produk Odoo beneran,
 *     dilaporkan balik biar petugas tambahin manual di Odoo).
 *  6. create() stock.picking + stock.move sekaligus (field move_ids_without_package/
 *     move_lines tergantung versi Odoo — dicoba move_ids_without_package dulu,
 *     fallback move_lines kalau field pertama nggak ada).
 *  7. Simpan wh_out_ref (nama picking yang baru dibuat, mis. "WH/OUT/01302")
 *     balik ke tabel pesanan — dashboard admin baca ini biar nggak dikirim dobel.
 *
 * "Divisi Pemakaian" SENGAJA TIDAK diisi — field itu bukan field standar
 * Odoo (nggak ketemu lewat fields_get/ir.model.fields sama sekali, kemungkinan
 * dirender non-standar), jadi nggak bisa ditulis lewat API. Dikosongkan di
 * Odoo, petugas gudang yang isi manual kalau perlu.
 *
 * Deploy: supabase functions deploy odoo-create-wh-out
 * (pakai secrets ODOO_* yang SAMA dengan odoo-pull-wh-out)
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const FIELD_LABELS = {
  employee: ["Employee"],
  department: ["Department"],
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function env(key: string): string {
  return (Deno.env.get(key) ?? "").trim();
}
const ODOO_URL = env("ODOO_URL");
const ODOO_DB = env("ODOO_DB");
const ODOO_USER = env("ODOO_USER");
const ODOO_PASSWORD = env("ODOO_PASSWORD");

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

const ODOO_TIMEOUT_MS = 20000;
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

async function resolveFieldByLabel(
  model: string,
  fieldMeta: Record<string, { string?: string }>,
  key: keyof typeof FIELD_LABELS,
): Promise<string | null> {
  const candidates = FIELD_LABELS[key].map((s) => s.toLowerCase());
  for (const [technicalName, info] of Object.entries(fieldMeta)) {
    const label = (info.string || "").trim().toLowerCase();
    if (candidates.includes(label)) return technicalName;
  }
  for (const [technicalName, info] of Object.entries(fieldMeta)) {
    const label = (info.string || "").trim().toLowerCase();
    if (!label) continue;
    if (candidates.some((c) => label.includes(c) || c.includes(label))) return technicalName;
  }
  return null; // best-effort — dibiarin null kalau nggak ketemu, bukan bikin gagal
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { pesanan_id } = await req.json();
    if (!pesanan_id) throw new Error("pesanan_id wajib diisi.");

    const { data: pesanan, error: pErr } = await supabase
      .from("pesanan").select("*, items:pesanan_item(*)").eq("id", pesanan_id).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!pesanan) throw new Error("Pesanan tidak ditemukan.");
    if (pesanan.wh_out_ref) {
      return json({ ok: true, already_sent: true, wh_out_ref: pesanan.wh_out_ref, warnings: [] });
    }

    const warnings: string[] = [];
    const uid = await login();

    // ---------- Resolve custom field Employee/Department ----------
    const fieldMeta = await rpc(uid, "stock.picking", "fields_get", [], { attributes: ["string"] }) as
      Record<string, { string?: string }>;
    const employeeField = await resolveFieldByLabel("stock.picking", fieldMeta, "employee");
    const departmentField = await resolveFieldByLabel("stock.picking", fieldMeta, "department");

    // ---------- Cari karyawan di Odoo (best-effort by nama) ----------
    const pickingData: Record<string, unknown> = {};
    if (employeeField && pesanan.karyawan_name) {
      const emp = await rpc(uid, "hr.employee", "search_read", [
        [["name", "=", pesanan.karyawan_name]],
      ], { fields: ["id", "name", "department_id"], limit: 1 }) as Record<string, unknown>[];
      let match = emp[0];
      if (!match) {
        const fuzzy = await rpc(uid, "hr.employee", "search_read", [
          [["name", "ilike", pesanan.karyawan_name]],
        ], { fields: ["id", "name", "department_id"], limit: 1 }) as Record<string, unknown>[];
        match = fuzzy[0];
      }
      if (match) {
        pickingData[employeeField] = match.id;
        if (departmentField && Array.isArray(match.department_id)) {
          pickingData[departmentField] = match.department_id[0];
        }
        // Delivery Address (partner_id, field standar Odoo) disamain sama
        // Employee — ini cuma buat operator internal, nggak ada tujuan
        // pengiriman khusus, jadi cukup cari res.partner dengan nama yang
        // sama (biasanya otomatis ada — tiap hr.employee di Odoo biasanya
        // punya res.partner terkait dengan nama yang sama).
        const partner = await rpc(uid, "res.partner", "search_read", [
          [["name", "=", pesanan.karyawan_name]],
        ], { fields: ["id"], limit: 1 }) as Record<string, unknown>[];
        const partnerMatch = partner[0] || (await rpc(uid, "res.partner", "search_read", [
          [["name", "ilike", pesanan.karyawan_name]],
        ], { fields: ["id"], limit: 1 }) as Record<string, unknown>[])[0];
        if (partnerMatch) {
          pickingData["partner_id"] = partnerMatch.id;
        } else {
          warnings.push(`Contact "${pesanan.karyawan_name}" nggak ketemu di Odoo — Delivery Address dikosongkan.`);
        }
      } else {
        warnings.push(`Karyawan "${pesanan.karyawan_name}" nggak ketemu di Odoo — field Employee/Department/Delivery Address dikosongkan.`);
      }
    }

    // ---------- Cari picking type "GUDANG SPAREPART BESAR: Delivery Orders" ----------
    const types = await rpc(uid, "stock.picking.type", "search_read", [
      [["code", "=", "outgoing"]],
    ], { fields: ["id", "display_name", "default_location_src_id", "default_location_dest_id"] }) as
      Record<string, unknown>[];
    const type = types.find((t) => odooStr(t.display_name).toLowerCase().includes("gudang sparepart besar"))
      || types[0];
    if (!type) throw new Error('Operation Type "GUDANG SPAREPART BESAR: Delivery Orders" tidak ditemukan di Odoo.');
    const locSrc = Array.isArray(type.default_location_src_id) ? type.default_location_src_id[0] : null;
    const locDest = Array.isArray(type.default_location_dest_id) ? type.default_location_dest_id[0] : null;
    if (!locSrc || !locDest) throw new Error(`Operation Type "${type.display_name}" nggak punya default lokasi sumber/tujuan di Odoo.`);

    // ---------- Cari product_id per item (skip yang sku-nya null) ----------
    const items = (pesanan.items || []) as { sku: string | null; nama_barang: string; qty: number; satuan: string | null }[];
    const moveLines: unknown[] = [];
    for (const it of items) {
      if (!it.sku) { warnings.push(`"${it.nama_barang}" nggak punya SKU (item tulis manual) — dilewati, tambahin manual di Odoo.`); continue; }
      const products = await rpc(uid, "product.product", "search_read", [
        [["default_code", "=", it.sku]],
      ], { fields: ["id", "uom_id"], limit: 1 }) as Record<string, unknown>[];
      const product = products[0];
      if (!product) { warnings.push(`SKU "${it.sku}" (${it.nama_barang}) nggak ketemu di Odoo — dilewati.`); continue; }
      moveLines.push([0, 0, {
        name: it.nama_barang,
        product_id: product.id,
        product_uom_qty: it.qty,
        product_uom: Array.isArray(product.uom_id) ? product.uom_id[0] : undefined,
        location_id: locSrc,
        location_dest_id: locDest,
      }]);
    }
    if (!moveLines.length) throw new Error("Nggak ada satu pun item yang berhasil dipetakan ke produk Odoo — Delivery Order nggak dibuat.");

    // ---------- create() stock.picking (TANPA action_confirm/button_validate) ----------
    // Source Document (origin) SENGAJA dibiarin kosong — nggak diisi apa pun
    // dari SPB, biar sama kayak bikin Delivery Order manual di Odoo.
    //
    // "note" (field standar Odoo, tab "Note" di form Delivery) SELALU diisi
    // Nama/Divisi/Sub Divisi dari data SPB — TERLEPAS dari berhasil/nggaknya
    // pencarian hr.employee di atas. Field Employee/Department (Many2one)
    // emang butuh record ASLI di Odoo buat bisa ke-link (nggak bisa cuma
    // ditulis teks), tapi infonya tetap harus kebaca petugas gudang biarpun
    // link-nya nggak ketemu — apalagi banyak karyawan sekarang cuma tercatat
    // di Google Sheet, sama sekali nggak ada padanannya di Odoo.
    const noteLines = [
      "Karyawan: " + (pesanan.karyawan_name || "-"),
      "Divisi: " + (pesanan.divisi || "-") + (pesanan.sub_divisi ? " / " + pesanan.sub_divisi : ""),
      pesanan.jabatan ? "Jabatan: " + pesanan.jabatan : null,
    ].filter(Boolean);
    Object.assign(pickingData, {
      picking_type_id: type.id,
      location_id: locSrc,
      location_dest_id: locDest,
      note: noteLines.join("\n"),
    });
    let pickingId: number;
    try {
      pickingData["move_ids_without_package"] = moveLines;
      pickingId = await rpc(uid, "stock.picking", "create", [pickingData]);
    } catch (e1) {
      // Versi Odoo lama pakai nama field "move_lines", bukan "move_ids_without_package".
      delete pickingData["move_ids_without_package"];
      pickingData["move_lines"] = moveLines;
      pickingId = await rpc(uid, "stock.picking", "create", [pickingData]);
    }

    const created = await rpc(uid, "stock.picking", "search_read", [
      [["id", "=", pickingId]],
    ], { fields: ["name"], limit: 1 }) as Record<string, unknown>[];
    const whOutRef = odooStr(created[0]?.name) || `#${pickingId}`;

    const { error: uErr } = await supabase.from("pesanan").update({ wh_out_ref: whOutRef }).eq("id", pesanan_id);
    if (uErr) warnings.push(`Delivery Order berhasil dibuat (${whOutRef}) tapi gagal nyimpen referensinya di SPB: ${uErr.message}`);

    return json({ ok: true, wh_out_ref: whOutRef, odoo_picking_id: pickingId, warnings });
  } catch (err) {
    console.error("odoo-create-wh-out:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
