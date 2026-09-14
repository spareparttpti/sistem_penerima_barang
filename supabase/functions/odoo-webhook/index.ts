/**
 * Edge Function: odoo-webhook
 * Penerima data Receipts (WH/IN) yang dikirim Odoo secara otomatis.
 *
 * Deploy:
 *   supabase secrets set ODOO_WEBHOOK_TOKEN=<token-acak-panjang>
 *   supabase functions deploy odoo-webhook --no-verify-jwt
 *
 * `--no-verify-jwt` diperlukan karena Odoo tidak mengirim JWT Supabase.
 * Sebagai gantinya endpoint dilindungi token rahasia di query string
 * (`?token=...`) atau header `x-odoo-token` — Odoo 17 hanya bisa mengisi URL,
 * jadi query string harus didukung.
 *
 * Endpoint: POST https://<ref>.supabase.co/functions/v1/odoo-webhook?token=<token>
 *
 * Menerima dua bentuk payload:
 *   A. Odoo 17+ (Automated Action tipe Webhook) — { "_model": "stock.picking", "_id": 123 }
 *      Function menarik detail lengkap lewat JSON-RPC (butuh secret ODOO_*).
 *   B. Odoo <= 16 / Python code — payload lengkap yang dikirim sendiri:
 *      { "wh_in_ref": "WH/IN/00344", "contact": "...", "origin": "P00308",
 *        "scheduled_date": "2025-11-05", "state": "assigned",
 *        "lines": [ { "product": "...", "sku": "...", "qty_po": 2, "uom": "pcs" } ] }
 *      Bisa juga dibungkus sebagai { "receipts": [ ...banyak... ] } untuk kirim massal.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("ODOO_WEBHOOK_TOKEN") ?? "";

// Hanya dipakai untuk payload bentuk A (Odoo 17 mengirim id saja)
const ODOO_URL = Deno.env.get("ODOO_URL") ?? "";
const ODOO_DB = Deno.env.get("ODOO_DB") ?? "";
const ODOO_USER = Deno.env.get("ODOO_USER") ?? "";
const ODOO_API_KEY = Deno.env.get("ODOO_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-odoo-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Status internal Odoo → label yang dipakai SPB (harus sama dengan odoo.js). */
const STATE_MAP: Record<string, string> = {
  draft: "Draft",
  waiting: "Waiting",
  confirmed: "Waiting",
  assigned: "Ready",
  done: "Done",
  cancel: "Cancelled",
};

function normalizeState(v: unknown): string {
  const k = String(v ?? "").trim().toLowerCase();
  return STATE_MAP[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");
}

/** Odoo mengirim datetime 'YYYY-MM-DD HH:MM:SS'; kolom tujuan bertipe date. */
function normalizeDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Field many2one Odoo datang sebagai [id, "nama"] lewat JSON-RPC. */
function m2oName(v: unknown): string {
  if (Array.isArray(v)) return String(v[1] ?? "");
  return v == null || v === false ? "" : String(v);
}

/** Odoo memakai `false` untuk field kosong, bukan null/"" — rapikan dulu. */
function str(v: unknown): string {
  return v == null || v === false ? "" : String(v);
}

// ---------------------------------------------------------------------------
// Payload bentuk A: tarik detail picking dari Odoo lewat JSON-RPC
// ---------------------------------------------------------------------------
async function jsonRpc(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL.replace(/\/$/, "")}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Date.now(),
    }),
  });
  if (!res.ok) throw new Error(`Odoo JSON-RPC HTTP ${res.status}`);
  const body = await res.json();
  // JSON-RPC membalas HTTP 200 walau gagal — error sesungguhnya ada di dalam body
  if (body.error) {
    throw new Error(`Odoo: ${body.error?.data?.message ?? body.error.message}`);
  }
  return body.result;
}

/** `execute_kw` butuh uid (angka), bukan nama login — jadi login dulu.
 *  uid di-cache selama instance function hidup agar tidak login berulang. */
let cachedUid: number | null = null;
async function getUid(): Promise<number> {
  if (cachedUid) return cachedUid;
  const uid = await jsonRpc("common", "login", [ODOO_DB, ODOO_USER, ODOO_API_KEY]);
  if (!uid || typeof uid !== "number") {
    throw new Error("Login Odoo gagal — cek ODOO_DB, ODOO_USER, dan ODOO_API_KEY.");
  }
  cachedUid = uid;
  return uid;
}

async function rpc(model: string, method: string, args: unknown[], kwargs: unknown = {}) {
  const uid = await getUid();
  return jsonRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
}

async function fetchPicking(pickingId: number) {
  if (!ODOO_URL || !ODOO_API_KEY) {
    throw new Error(
      "Payload hanya berisi id picking, tapi secret ODOO_URL/ODOO_API_KEY belum diset " +
        "sehingga detailnya tidak bisa ditarik. Set secret tersebut, atau kirim payload lengkap dari Odoo.",
    );
  }

  const picks = await rpc("stock.picking", "read", [[pickingId]], {
    fields: [
      "name", "partner_id", "origin", "scheduled_date", "state",
      "location_id", "location_dest_id", "batch_id", "picking_type_code",
    ],
  });
  const p = picks?.[0];
  if (!p) throw new Error(`stock.picking ${pickingId} tidak ditemukan`);

  // Hanya transfer masuk yang relevan — abaikan delivery/internal transfer
  if (p.picking_type_code && p.picking_type_code !== "incoming") return null;

  const moves = await rpc("stock.move", "search_read", [
    [["picking_id", "=", pickingId]],
  ], {
    fields: ["product_id", "product_uom_qty", "product_uom"],
  });

  return {
    wh_in_ref: str(p.name),
    odoo_picking_id: pickingId,
    contact: m2oName(p.partner_id),
    origin: str(p.origin),
    scheduled_date: normalizeDate(p.scheduled_date),
    state: normalizeState(p.state),
    location_from: m2oName(p.location_id),
    location_to: m2oName(p.location_dest_id),
    batch: m2oName(p.batch_id),
    lines: (moves ?? []).map((m: Record<string, unknown>) => {
      const full = m2oName(m.product_id);
      // Odoo menulis produk sebagai "[SPR-0001] Bearing SKF 6205"
      const bracket = full.match(/^\[([^\]]+)\]\s*(.*)$/);
      return {
        product: bracket ? bracket[2] : full,
        sku: bracket ? bracket[1] : "",
        qty_po: Number(m.product_uom_qty ?? 0),
        uom: m2oName(m.product_uom) || "pcs",
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Normalisasi payload bentuk B (dikirim lengkap dari Odoo)
// ---------------------------------------------------------------------------
function normalizeIncoming(r: Record<string, unknown>) {
  const ref = str(r.wh_in_ref ?? r.name ?? r.reference).trim();
  if (!ref) return null;

  return {
    wh_in_ref: ref,
    odoo_picking_id: r.odoo_picking_id != null ? Number(r.odoo_picking_id) : null,
    contact: m2oName(r.contact ?? r.partner_id),
    origin: str(r.origin ?? r.source_document),
    scheduled_date: normalizeDate(r.scheduled_date),
    state: normalizeState(r.state ?? r.status),
    location_from: m2oName(r.location_from ?? r.location_id),
    location_to: m2oName(r.location_to ?? r.location_dest_id),
    batch: m2oName(r.batch ?? r.batch_id),
    // product_id/product_uom bisa datang sebagai many2one [id, "nama"] kalau
    // payload dirakit dari record Odoo mentah — m2oName, bukan str.
    lines: (Array.isArray(r.lines) ? r.lines : []).map((l: Record<string, unknown>) => {
      const full = m2oName(l.product ?? l.product_id);
      const bracket = full.match(/^\[([^\]]+)\]\s*(.*)$/);
      return {
        product: bracket ? bracket[2] : full,
        sku: str(l.sku ?? l.default_code) || (bracket ? bracket[1] : ""),
        qty_po: Number(l.qty_po ?? l.quantity ?? l.product_uom_qty ?? 0) || 0,
        uom: m2oName(l.uom ?? l.product_uom) || "pcs",
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Simpan: upsert header, lalu ganti seluruh baris item
// ---------------------------------------------------------------------------
type Receipt = NonNullable<ReturnType<typeof normalizeIncoming>>;

async function save(r: Receipt) {
  const { lines, ...header } = r;

  const { error: hErr } = await supabase
    .from("odoo_receipts")
    .upsert({ ...header, synced_at: new Date().toISOString() }, { onConflict: "wh_in_ref" });
  if (hErr) throw new Error(`upsert ${r.wh_in_ref}: ${hErr.message}`);

  // Payload tanpa `lines` berarti "tidak ada info item", bukan "item dikosongkan" —
  // jangan hapus baris yang sudah ada.
  if (!lines.length) return;

  const { error: dErr } = await supabase
    .from("odoo_receipt_lines").delete().eq("wh_in_ref", r.wh_in_ref);
  if (dErr) throw new Error(`hapus baris ${r.wh_in_ref}: ${dErr.message}`);

  const { error: iErr } = await supabase
    .from("odoo_receipt_lines")
    .insert(lines.map((l) => ({ ...l, wh_in_ref: r.wh_in_ref })));
  if (iErr) throw new Error(`insert baris ${r.wh_in_ref}: ${iErr.message}`);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Endpoint ini terbuka tanpa JWT, jadi token wajib diset agar tidak bisa
  // diisi sembarang orang.
  if (!WEBHOOK_TOKEN) {
    return json({ error: "ODOO_WEBHOOK_TOKEN belum diset di secret Edge Function" }, 500);
  }
  const token = new URL(req.url).searchParams.get("token") ?? req.headers.get("x-odoo-token");
  if (token !== WEBHOOK_TOKEN) return json({ error: "unauthorized" }, 401);

  try {
    const body = await req.json();

    // Kumpulkan record dari semua bentuk payload yang mungkin
    const raw: Record<string, unknown>[] = Array.isArray(body)
      ? body
      : Array.isArray(body.receipts)
      ? body.receipts
      : [body];

    const receipts: Receipt[] = [];
    const skipped: string[] = [];

    for (const item of raw) {
      // Bentuk A: Odoo 17 hanya mengirim model + id
      const id = item._id ?? item.id ?? item.picking_id;
      const hasDetail = item.wh_in_ref ?? item.name ?? item.reference;
      if (!hasDetail && id != null) {
        const fetched = await fetchPicking(Number(id));
        if (fetched) receipts.push(fetched as Receipt);
        else skipped.push(`picking ${id} bukan transfer masuk`);
        continue;
      }

      const norm = normalizeIncoming(item);
      if (norm) receipts.push(norm);
      else skipped.push("record tanpa Reference/No WH/IN");
    }

    if (!receipts.length) {
      return json({ ok: false, saved: 0, skipped, error: "tidak ada record yang bisa diproses" }, 400);
    }

    for (const r of receipts) await save(r);

    return json({
      ok: true,
      saved: receipts.length,
      refs: receipts.map((r) => r.wh_in_ref),
      skipped,
    });
  } catch (err) {
    console.error("odoo-webhook:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
