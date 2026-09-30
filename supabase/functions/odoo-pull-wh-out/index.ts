/**
 * Edge Function: odoo-pull-wh-out
 *
 * Sama seperti odoo-pull (WH/IN), tapi buat WH/OUT (Delivery Orders) — dan
 * CUMA menarik baris yang SKU produknya diawali "ATK" (case-insensitive),
 * sesuai instruksi user: WH/OUT campur ATK+sparepart tetap ditarik headernya,
 * tapi item non-ATK-nya dibuang; WH/OUT yang sama sekali tidak punya item ATK
 * dilewati semuanya. Read-only — tidak ada tulis balik ke Odoo di sini.
 *
 * Field Employee/Department/Divisi Pemakaian itu custom field (dibuat lewat
 * Odoo Studio) — technical name-nya BUKAN "employee_id"/"department"/dst
 * secara default, dan bisa beda-beda tiap instalasi Odoo. Daripada minta user
 * buka Developer Mode buat cari tahu manual, function ini TANYA LANGSUNG ke
 * Odoo lewat `fields_get` (satu-satunya panggilan tambahan, dieksekusi sekali
 * di awal) — mencocokkan LABEL yang tampil di layar ("Employee", "Department",
 * "Divisi Pemakaian") ke nama field teknisnya secara otomatis. Kalau suatu
 * saat label di Odoo diganti, tinggal tambahkan variannya di FIELD_LABELS di
 * bawah — tidak perlu bongkar Developer Mode sama sekali.
 *
 * Deploy: supabase functions deploy odoo-pull-wh-out
 * (pakai secrets ODOO_* yang SAMA dengan odoo-pull — tidak perlu diisi ulang)
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

// Label yang tampil di layar Odoo untuk tiap field custom — dicocokkan case-
// insensitive. Tambahkan varian lain di sini kalau resolveFieldByLabel()
// gagal menemukan field tertentu (pesan errornya akan sebut nama label yang
// tidak ketemu).
const FIELD_LABELS = {
  employee: ["Employee"],
  department: ["Department"],
  subDivisi: ["Divisi Pemakaian", "Sub Divisi Pemakaian"],
};

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
const STATE_MAP: Record<string, string> = {
  draft: "Draft", waiting: "Waiting", confirmed: "Waiting",
  assigned: "Ready", done: "Done", cancel: "Cancelled",
};
function normalizeState(v: unknown): string {
  const k = odooStr(v).trim().toLowerCase();
  return STATE_MAP[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");
}
function normalizeDate(v: unknown): string | null {
  const s = odooStr(v).trim();
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
function m2oName(v: unknown): string {
  if (Array.isArray(v)) return odooStr(v[1]);
  return odooStr(v);
}

const ODOO_TIMEOUT_MS = 15000;
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

// Cari nama teknis 1 field dari label yang tampil di layar Odoo — dipanggil
// sekali per label, hasilnya dipakai di seluruh fetch berikutnya. Kalau tidak
// ketemu, error-nya sebut persis label mana yang gagal dicocokkan, supaya
// gampang ditambahkan variannya di FIELD_LABELS kalau labelnya beda.
async function resolveFieldByLabel(
  model: string,
  fieldMeta: Record<string, { string?: string }>,
  key: keyof typeof FIELD_LABELS,
): Promise<string> {
  const candidates = FIELD_LABELS[key].map((s) => s.toLowerCase());

  // 1) Cocok PERSIS dulu (paling aman — tidak salah pilih field lain).
  for (const [technicalName, info] of Object.entries(fieldMeta)) {
    const label = (info.string || "").trim().toLowerCase();
    if (candidates.includes(label)) return technicalName;
  }
  // 2) Fallback: cocok SEBAGIAN (mis. Odoo-nya "Sub Divisi Pemakaian ATK" atau
  //    ada spasi/kata tambahan) — cukup salah satu kandidat jadi substring
  //    label, atau sebaliknya.
  for (const [technicalName, info] of Object.entries(fieldMeta)) {
    const label = (info.string || "").trim().toLowerCase();
    if (!label) continue;
    if (candidates.some((c) => label.includes(c) || c.includes(label))) return technicalName;
  }
  throw new Error(
    `Field dengan label ${FIELD_LABELS[key].map((s) => `"${s}"`).join(" / ")} tidak ditemukan di model ${model}. ` +
    `Cek nama persis label field itu di Odoo (mungkin beda kapitalisasi/kata), lalu tambahkan variannya ke FIELD_LABELS di odoo-pull-wh-out/index.ts.`
  );
}

async function resolveCustomFields(uid: number) {
  const fieldMeta = await rpc(uid, "stock.picking", "fields_get", [], { attributes: ["string"] }) as
    Record<string, { string?: string }>;
  // Employee & Department WAJIB ketemu (kalau gagal, seluruh sinkron berhenti
  // — itu benar, karena datanya penting). "Divisi Pemakaian" TIDAK ketemu di
  // manapun lewat API (sudah dicoba fields_get, ir.model.fields, ir.ui.view —
  // nihil semua, kemungkinan dirender lewat mekanisme non-standar) — jadi
  // dibikin best-effort: kalau gagal, field ini dikosongkan (null) saja,
  // BUKAN menggagalkan seluruh proses tarik data WH/OUT.
  let subDivisi: string | null = null;
  try {
    subDivisi = await resolveFieldByLabel("stock.picking", fieldMeta, "subDivisi");
  } catch (e) {
    console.error("subDivisi tidak ditemukan, dilewati:", (e as Error).message);
  }
  return {
    employee: await resolveFieldByLabel("stock.picking", fieldMeta, "employee"),
    department: await resolveFieldByLabel("stock.picking", fieldMeta, "department"),
    subDivisi,
  };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchDeliveries(uid: number, customFields: Awaited<ReturnType<typeof resolveCustomFields>>) {
  const PAGE = 500;
  const pickings: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rpc(uid, "stock.picking", "search_read", [
      [["picking_type_code", "=", "outgoing"]],
    ], {
      fields: ["name", "origin", "scheduled_date", "state", "note",
                customFields.employee, customFields.department,
                ...(customFields.subDivisi ? [customFields.subDivisi] : [])],
      limit: PAGE, offset, order: "scheduled_date desc",
    });
    pickings.push(...(page as Record<string, unknown>[]));
    if (page.length < PAGE) break;
  }
  if (!pickings.length) return [];

  const ids = pickings.map((p) => p.id);
  const moves = await rpc(uid, "stock.move", "search_read", [
    [["picking_id", "in", ids]],
  ], { fields: ["picking_id", "product_id", "product_uom_qty", "product_uom"] });

  // Cuma simpan baris yang SKU-nya diawali "ATK" — sisanya (sparepart biasa
  // yang numpang di WH/OUT sama) dibuang di sini, bukan di database.
  const atkLinesByPicking: Record<number, unknown[]> = {};
  for (const m of moves as Record<string, unknown>[]) {
    const pid = Array.isArray(m.picking_id) ? m.picking_id[0] : m.picking_id;
    const full = m2oName(m.product_id);
    const bracket = full.match(/^\[([^\]]+)\]\s*(.*)$/);
    const sku = bracket ? bracket[1] : "";
    if (!sku.toUpperCase().startsWith("ATK")) continue;
    (atkLinesByPicking[pid as number] ??= []).push({
      product: bracket ? bracket[2] : full,
      sku,
      qty_demand: Number(m.product_uom_qty ?? 0),
      uom: m2oName(m.product_uom) || "pcs",
    });
  }

  return (pickings as Record<string, unknown>[])
    .filter((p) => (atkLinesByPicking[p.id as number] ?? []).length > 0)
    .map((p) => {
      // Kalau Employee/Department m2o kosong (mis. Delivery Order dibikin
      // dari SPB via odoo-create-wh-out, buat karyawan yang nggak ketemu
      // padanannya di Odoo) — fallback baca dari field "note" (isinya
      // "Karyawan: ..." / "Divisi: ..." yang ditulis odoo-create-wh-out),
      // biar Log Pengeluaran SPB tetap kebaca infonya, bukan blank total.
      const note = odooStr(p.note);
      const noteEmployee = note.match(/Karyawan:\s*(.+)/)?.[1]?.trim();
      const noteDivisi = note.match(/Divisi:\s*(.+)/)?.[1]?.trim(); // format "DIVISI / SUB DIVISI"
      const [noteDivisiOnly, noteSubDivisi] = (noteDivisi || "").split(" / ").map((s) => s.trim());

      const employeeName = m2oName(p[customFields.employee]) || noteEmployee || "";
      const department = m2oName(p[customFields.department]) || noteDivisiOnly || "";
      const subDivisi = (customFields.subDivisi ? odooStr(p[customFields.subDivisi]) : "") || noteSubDivisi || "";

      return {
        wh_out_ref: odooStr(p.name),
        odoo_picking_id: p.id as number,
        source_document: odooStr(p.origin),
        employee_name: employeeName,
        department: department,
        sub_divisi: subDivisi,
        scheduled_date: normalizeDate(p.scheduled_date),
        state: normalizeState(p.state),
        lines: atkLinesByPicking[p.id as number] ?? [],
      };
    });
}

// Hapus baris WH/OUT yang statusnya masih Draft di SPB TAPI sudah tidak
// muncul lagi di hasil tarikan Odoo terbaru (activeRefs) — artinya picking-nya
// betul-betul DIHAPUS di Odoo (bukan cuma di-cancel; yang cancel tetap ke-pull
// dan cuma ditandai odoo_state="Cancelled", tidak dihapus).
// SENGAJA dibatasi cuma status Draft: baris yang sudah In Inspection/Approved/
// Rejected artinya sudah ada kerjaan manusia di dalamnya (keputusan QC,
// distribusi ke karyawan) — itu jejak kerja tim gudang, jangan ikut kehapus
// otomatis cuma karena picking-nya lenyap dari Odoo belakangan.
// detail_pengeluaran ikut kehapus otomatis lewat "on delete cascade".
async function deleteStaleDrafts(activeRefs: Set<string>): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  const { data, error } = await supabase
    .from("pengeluaran_barang").select("id, wh_out_ref")
    .eq("source", "odoo").eq("status", "Draft");
  if (error) { errors.push(`baca draft existing: ${error.message}`); return { deleted: 0, errors }; }

  const staleIds = ((data ?? []) as { id: string; wh_out_ref: string }[])
    .filter((r) => !activeRefs.has(r.wh_out_ref))
    .map((r) => r.id);
  if (!staleIds.length) return { deleted: 0, errors };

  let deleted = 0;
  for (const chunk of chunks(staleIds, 200)) {
    const { error: delError, count } = await supabase
      .from("pengeluaran_barang").delete({ count: "exact" }).in("id", chunk);
    if (delError) { errors.push(`hapus draft basi (${chunk.length} baris): ${delError.message}`); continue; }
    deleted += count ?? chunk.length;
  }
  return { deleted, errors };
}

async function upsertDeliveries(deliveries: Awaited<ReturnType<typeof fetchDeliveries>>) {
  let cancelled = 0;
  let deleted = 0;
  const errors: string[] = [];

  const { data: sparepartsRaw } = await supabase.from("spareparts").select("id, sku, name");
  const spareparts = (sparepartsRaw ?? []) as { id: string; sku: string; name: string }[];
  const bySku: Record<string, { id: string }> = {};
  const byName: Record<string, { id: string }> = {};
  for (const sp of spareparts) {
    if (sp.sku) bySku[sp.sku.toLowerCase()] = sp;
    if (sp.name) byName[sp.name.toLowerCase()] = sp;
  }

  const toProcess = deliveries.filter((d) => !!d.wh_out_ref);
  // Kosong berarti pull-nya sendiri kemungkinan bermasalah (bukan Odoo memang
  // lagi kosong) — JANGAN jalankan pembersihan draft basi di kondisi ini,
  // supaya sekali gagal fetch tidak memicu hapus massal semua Draft.
  if (!toProcess.length) return { added: 0, updated: 0, locked: 0, cancelled, deleted, errors };

  const activeRefs = new Set(toProcess.map((d) => d.wh_out_ref));

  const existingByRef: Record<string, { id: string; status: string }> = {};
  for (const chunk of chunks(toProcess.map((d) => d.wh_out_ref), 200)) {
    const { data, error } = await supabase
      .from("pengeluaran_barang").select("id, wh_out_ref, status").in("wh_out_ref", chunk);
    if (error) { errors.push(`baca status existing: ${error.message}`); continue; }
    for (const row of (data ?? []) as { id: string; wh_out_ref: string; status: string }[]) {
      existingByRef[row.wh_out_ref] = row;
    }
  }

  let locked = 0;
  const headerRows = toProcess
    .filter((d) => {
      const existing = existingByRef[d.wh_out_ref];
      if (existing && existing.status !== "Draft") { locked++; return false; }
      return true;
    })
    .map((d) => ({
      wh_out_ref: d.wh_out_ref,
      source_document: d.source_document || null,
      employee_name: d.employee_name || "-",
      department: d.department || "-",
      sub_divisi: d.sub_divisi || "-",
      receiver_name: "-",
      status: "Draft",
      order_date: d.scheduled_date,
      odoo_state: d.state,
      odoo_picking_id: d.odoo_picking_id,
      source: "odoo",
    }));

  cancelled = headerRows.filter((r) => r.odoo_state === "Cancelled").length;

  if (headerRows.length) {
    const upsertedIds: { id: string; wh_out_ref: string }[] = [];
    for (const chunk of chunks(headerRows, 200)) {
      const { data, error } = await supabase
        .from("pengeluaran_barang").upsert(chunk, { onConflict: "wh_out_ref" }).select("id, wh_out_ref");
      if (error) { errors.push(`upsert header (${chunk.length} baris): ${error.message}`); continue; }
      upsertedIds.push(...((data ?? []) as { id: string; wh_out_ref: string }[]));
    }

    var added = upsertedIds.filter((u) => !existingByRef[u.wh_out_ref]).length;
    var updated = upsertedIds.length - added;

    const idByRef: Record<string, string> = {};
    for (const u of upsertedIds) idByRef[u.wh_out_ref] = u.id;
    const touchedIds = upsertedIds.map((u) => u.id);

    for (const chunk of chunks(touchedIds, 200)) {
      const { error } = await supabase.from("detail_pengeluaran").delete().in("pengeluaran_id", chunk);
      if (error) errors.push(`hapus item lama: ${error.message}`);
    }

    const lineRows: Record<string, unknown>[] = [];
    for (const d of toProcess) {
      const pid = idByRef[d.wh_out_ref];
      if (!pid) continue;
      for (const l of d.lines as { product: string; sku: string; qty_demand: number; uom: string }[]) {
        const sp = (l.sku && bySku[l.sku.toLowerCase()]) || byName[(l.product || "").toLowerCase()];
        lineRows.push({
          pengeluaran_id: pid,
          sparepart_id: sp ? sp.id : null,
          product_name: l.product,
          sku: l.sku,
          uom: l.uom,
          qty_demand: l.qty_demand,
          qty_actual: l.qty_demand,
        });
      }
    }
    for (const chunk of chunks(lineRows, 500)) {
      const { error } = await supabase.from("detail_pengeluaran").insert(chunk);
      if (error) errors.push(`insert item (${chunk.length} baris): ${error.message}`);
    }
  }

  const cleanup = await deleteStaleDrafts(activeRefs);
  deleted = cleanup.deleted;
  errors.push(...cleanup.errors);

  return {
    added: typeof added !== "undefined" ? added : 0,
    updated: typeof updated !== "undefined" ? updated : 0,
    locked, cancelled, deleted, errors,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const uid = await login();

    // Mode debug: POST { "debug": true } -> nggak narik data, cuma nampilin
    // semua field custom (x_studio_*) di stock.picking beserta label aslinya.
    // Dipakai SEKALI buat cari tahu nama field "Divisi Pemakaian" yang benar
    // waktu resolveFieldByLabel() gagal cocokin — setelah FIELD_LABELS
    // diperbaiki sesuai hasil ini, mode debug ini nggak perlu dipakai lagi.
    const body = await req.json().catch(() => ({}));
    if (body.debug) {
      // "Divisi Pemakaian" ternyata bukan field_description resmi di model
      // MANAPUN — berarti itu teks label yang ditulis langsung di XML
      // tampilan (view), bukan nama field. Dicari dari isi arch view-nya
      // (ir.ui.view.arch_db) — potongan XML di sekitar teks itu bakal
      // nunjukin atribut for="..." yang isinya nama field teknis aslinya.
      // Coba cuma kata "Divisi" dulu (bukan "Divisi Pemakaian" nyambung) —
      // kemungkinan di tampilan itu 2 baris terpisah ("Divisi" / "Pemakaian"),
      // bukan 1 frasa utuh, jadi pencarian frasa lengkap sebelumnya meleset.
      const views = await rpc(uid, "ir.ui.view", "search_read", [
        [["arch_db", "ilike", "Divisi"]],
      ], { fields: ["name", "model", "arch_db"] });
      const snippets = (views as Record<string, unknown>[]).map((v) => {
        const arch = String(v.arch_db ?? "");
        const idx = arch.toLowerCase().indexOf("divisi");
        return {
          view_name: v.name,
          model: v.model,
          snippet: arch.slice(Math.max(0, idx - 200), idx + 200),
        };
      });
      // Kalau field-nya juga bukan berupa label form biasa (mis. dirender lewat
      // widget custom/JS), coba juga cari field_description yang lebih longgar
      // (cuma kata "Pakai" — nangkep "Pemakaian"/"Pemakai"/dll).
      const fieldsLoose = await rpc(uid, "ir.model.fields", "search_read", [
        [["field_description", "ilike", "Pakai"]],
      ], { fields: ["name", "model", "field_description"] });
      return json({ ok: true, debug: true, viewCount: views.length, snippets, fieldsLoose });
    }

    const customFields = await resolveCustomFields(uid);
    const deliveries = await fetchDeliveries(uid, customFields);
    const result = await upsertDeliveries(deliveries);
    return json({ ok: true, fetched: deliveries.length, ...result });
  } catch (err) {
    console.error("odoo-pull-wh-out:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
