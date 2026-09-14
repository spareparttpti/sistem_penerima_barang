/**
 * Edge Function: odoo-pull
 *
 * Menarik data Receipts (WH/IN) dari Odoo TANPA Odoo perlu disentuh sama sekali —
 * tidak ada Automated Action, tidak ada Developer Mode, tidak ada API key khusus.
 * Cukup email + password akun Odoo biasa (yang sama dipakai login ke web Odoo).
 *
 * Ini kebalikan dari odoo-webhook (yang menunggu Odoo mengirim data). Function ini
 * yang AKTIF menjemput, dipanggil terjadwal lewat Supabase Cron — persis seperti
 * scraper yang menarik dari sistem vendor tanpa API resmi, hanya di sini memakai
 * endpoint resmi Odoo (JSON-RPC) yang memang disediakan untuk client web-nya sendiri,
 * bukan HTML scraping.
 *
 * Deploy:
 *   supabase secrets set ODOO_URL=https://<odoo-kamu>
 *   supabase secrets set ODOO_DB=<nama-database>
 *   supabase secrets set ODOO_USER=<email-login>
 *   supabase secrets set ODOO_PASSWORD=<password-akun-odoo>
 *   supabase secrets set SUPABASE_URL=https://<ref>.supabase.co
 *   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
 *   supabase functions deploy odoo-pull
 *
 * Jadwalkan (Supabase Dashboard → Database → Cron Jobs, atau SQL):
 *   select cron.schedule('odoo-pull-15min', '*\/15 * * * *', $$
 *     select net.http_post(
 *       url := '<function-url>',
 *       headers := jsonb_build_object('Authorization','Bearer <anon-or-service-key>')
 *     );
 *   $$);
 *
 * Endpoint juga bisa dipanggil manual: POST <function-url> (tanpa body).
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// .trim() berjaga-jaga terhadap spasi/tab tak terlihat yang ikut ter-copy saat
// mengisi secret lewat form web — sekali kejadian, DB name "\tbengkel_dev01"
// (tab di depan) membuat Postgres di sisi Odoo gagal connect dengan pesan
// error yang membingungkan (seolah database tidak ada, padahal cuma typo tersembunyi).
function env(key: string): string {
  return (Deno.env.get(key) ?? "").trim();
}

const ODOO_URL = env("ODOO_URL");
const ODOO_DB = env("ODOO_DB");
const ODOO_USER = env("ODOO_USER");
// Password akun Odoo biasa — endpoint login Odoo menerima password maupun API key
// di field yang sama, jadi tidak ada langkah khusus yang perlu diminta ke IT.
const ODOO_PASSWORD = env("ODOO_PASSWORD");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* Odoo TIDAK memakai null untuk field kosong — field text/date/many2one yang
   kosong dikirim sebagai boolean `false` (via XML-RPC/JSON-RPC). `String(false)`
   di JS menghasilkan literal teks "false" — itulah kenapa No PO/tanggal sempat
   tampil sebagai "#false" di Dashboard: field origin/scheduled_date yang
   kosong (mis. return barang, internal transfer) ikut ke-`String()`-kan apa
   adanya. `?? ""` TIDAK menangkap `false` (cuma null/undefined), jadi semua
   konversi ke string di file ini WAJIB lewat fungsi ini, bukan `String(x ?? "")`
   langsung. */
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

// Tanpa batas waktu, fetch ke host yang tidak bisa dijangkau akan menggantung
// sampai timeout platform (bisa beberapa menit) tanpa pesan yang jelas. 15 detik
// cukup longgar untuk round-trip normal, tapi cukup ketat untuk cepat mendeteksi
// "server tidak terjangkau" sebagai penyebab, bukan sekadar lambat.
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
    if ((e as Error).name === "AbortError") {
      throw new Error(
        `Tidak ada balasan dari ${ODOO_URL} dalam ${ODOO_TIMEOUT_MS / 1000} detik. ` +
        `Kemungkinan besar server tempat Edge Function berjalan tidak bisa menjangkau URL Odoo ini ` +
        `(mis. Odoo hanya bisa diakses dari jaringan tertentu/VPN). Coba akses ODOO_URL dari luar jaringan kantor dulu.`
      );
    }
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
    throw new Error(
      "Secret ODOO_URL/ODOO_DB/ODOO_USER/ODOO_PASSWORD belum lengkap. " +
      "ODOO_PASSWORD cukup diisi password akun Odoo biasa — tidak perlu API key khusus."
    );
  }
  const uid = await jsonRpc("common", "login", [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
  if (!uid || typeof uid !== "number") {
    throw new Error("Login Odoo gagal — cek email & password. Kalau akun memakai 2FA, " +
      "Odoo mewajibkan API Key (Preferences → Account Security) menggantikan password di sini.");
  }
  return uid;
}

async function rpc(uid: number, model: string, method: string, args: unknown[], kwargs: unknown = {}) {
  return jsonRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs]);
}

/* Ambil SELURUH Receipts (incoming) — tanpa syarat umur/status. Sebelumnya
   dibatasi ke yang belum Done/Cancel atau baru berubah 3 hari terakhir, jadi
   histori lama (Done/Ready/Cancel bertahun-tahun lalu) tidak pernah ketarik
   sama sekali. Odoo membatasi search_read ke `limit` per panggilan, jadi di
   sini di-paginasi pakai `offset` sampai semua baris habis. */
async function fetchReceipts(uid: number) {
  const PAGE = 500;
  const pickings: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rpc(uid, "stock.picking", "search_read", [
      // Retur barang ATK (dikembalikan ke gudang) juga bertipe "incoming" di
      // Odoo — makanya ikut kepull ke sini kalau tidak dikecualikan. Itu
      // bukan penerimaan dari vendor, jadi bukan urusan WH/IN (biarkan
      // odoo-pull-wh-out yang urus, kalau memang perlu ditangani di sana).
      // Source Document-nya selalu berbunyi "Return of WH/OUT/xxxxx".
      [["picking_type_code", "=", "incoming"], ["origin", "not ilike", "%WH/OUT%"]],
    ], {
      fields: ["name", "partner_id", "origin", "scheduled_date", "state",
                "location_id", "location_dest_id", "batch_id"],
      limit: PAGE,
      offset,
      order: "scheduled_date desc",
    });
    pickings.push(...(page as Record<string, unknown>[]));
    if (page.length < PAGE) break;
  }

  if (!pickings.length) return [];

  const ids = pickings.map((p: Record<string, unknown>) => p.id);
  const moves = await rpc(uid, "stock.move", "search_read", [
    [["picking_id", "in", ids]],
  ], {
    fields: ["picking_id", "product_id", "product_uom_qty", "product_uom"],
  });

  const linesByPicking: Record<number, unknown[]> = {};
  for (const m of moves as Record<string, unknown>[]) {
    const pid = Array.isArray(m.picking_id) ? m.picking_id[0] : m.picking_id;
    const full = m2oName(m.product_id);
    const bracket = full.match(/^\[([^\]]+)\]\s*(.*)$/);
    (linesByPicking[pid as number] ??= []).push({
      product: bracket ? bracket[2] : full,
      sku: bracket ? bracket[1] : "",
      qty_po: Number(m.product_uom_qty ?? 0),
      uom: m2oName(m.product_uom) || "pcs",
    });
  }

  return (pickings as Record<string, unknown>[]).map((p) => ({
    wh_in_ref: odooStr(p.name),
    odoo_picking_id: p.id as number,
    contact: m2oName(p.partner_id),
    origin: odooStr(p.origin), // return barang/internal transfer sering tanpa Source Document -> false di Odoo
    scheduled_date: normalizeDate(p.scheduled_date),
    state: normalizeState(p.state),
    location_from: m2oName(p.location_id),
    location_to: m2oName(p.location_dest_id),
    batch: m2oName(p.batch_id),
    lines: linesByPicking[p.id as number] ?? [],
  }));
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* Tulis ke penerimaan_barang secara BATCH, bukan satu-per-satu.
   Versi awal melakukan ~4 round-trip network berurutan PER WH/IN (select, insert/
   update, delete detail, insert detail) — dengan ratusan WH/IN dari Odoo sungguhan,
   itu jauh melebihi batas 150 detik platform. Versi ini mengelompokkan tiap langkah
   jadi beberapa panggilan saja untuk SEMUA baris sekaligus (dipecah per potongan 200
   baris supaya payload tidak raksasa), jadi totalnya cuma puluhan round-trip, bukan
   ribuan. */
async function upsertReceipts(receipts: Awaited<ReturnType<typeof fetchReceipts>>) {
  let cancelled = 0;
  const errors: string[] = [];

  const { data: sparepartsRaw } = await supabase.from("spareparts").select("id, sku, name");
  const spareparts = (sparepartsRaw ?? []) as { id: string; sku: string; name: string }[];
  const bySku: Record<string, { id: string }> = {};
  const byName: Record<string, { id: string }> = {};
  for (const sp of spareparts) {
    if (sp.sku) bySku[sp.sku.toLowerCase()] = sp;
    if (sp.name) byName[sp.name.toLowerCase()] = sp;
  }

  // Cancelled TETAP diproses (bukan dibuang) — supaya kalau di Odoo suatu
  // WH/IN dibatalkan, badge/status "Dibatalkan di Odoo" ikut muncul otomatis
  // di program, bukan cuma menghilang diam-diam. `cancelled` dihitung dari
  // hasil akhir headerRows di bawah, bukan di sini.
  const toProcess = receipts.filter((rc) => !!rc.wh_in_ref);
  if (!toProcess.length) return { added: 0, updated: 0, locked: 0, cancelled, errors };

  // 1) Baca status yang SUDAH ada untuk semua ref sekaligus — bukan satu select per ref.
  const existingByRef: Record<string, { id: string; status: string }> = {};
  for (const chunk of chunks(toProcess.map((r) => r.wh_in_ref), 200)) {
    const { data, error } = await supabase
      .from("penerimaan_barang").select("id, wh_in_ref, status").in("wh_in_ref", chunk);
    if (error) { errors.push(`baca status existing: ${error.message}`); continue; }
    for (const row of (data ?? []) as { id: string; wh_in_ref: string; status: string }[]) {
      existingByRef[row.wh_in_ref] = row;
    }
  }

  let locked = 0;
  // receiver_name selalu "-" di sini karena baris yang sampai tahap ini SELALU
  // berstatus Draft (yang bukan Draft sudah disaring lewat pengecekan `locked` di
  // atas) — Draft tidak pernah punya petugas penerima selain "-".
  const headerRows = toProcess
    .filter((rc) => {
      const existing = existingByRef[rc.wh_in_ref];
      if (existing && existing.status !== "Draft") { locked++; return false; }
      return true;
    })
    .map((rc) => ({
      wh_in_ref: rc.wh_in_ref,
      po_number: rc.origin || rc.wh_in_ref,
      vendor_name: rc.contact || "-",
      receiver_name: "-",
      status: "Draft",
      order_date: rc.scheduled_date,
      odoo_state: rc.state,
      odoo_picking_id: rc.odoo_picking_id,
      source: "odoo",
    }));

  cancelled = headerRows.filter((r) => r.odoo_state === "Cancelled").length;

  if (!headerRows.length) return { added: 0, updated: 0, locked, cancelled, errors };

  // 2) Tulis header dalam batch memakai upsert (on conflict wh_in_ref) — insert
  //    baris baru & update baris lama dalam SATU pernyataan per potongan.
  const upsertedIds: { id: string; wh_in_ref: string }[] = [];
  for (const chunk of chunks(headerRows, 200)) {
    const { data, error } = await supabase
      .from("penerimaan_barang")
      .upsert(chunk, { onConflict: "wh_in_ref" })
      .select("id, wh_in_ref");
    if (error) {
      errors.push(`upsert header (${chunk.length} baris): ${error.message}`);
      continue;
    }
    upsertedIds.push(...((data ?? []) as { id: string; wh_in_ref: string }[]));
  }

  const added = upsertedIds.filter((u) => !existingByRef[u.wh_in_ref]).length;
  const updated = upsertedIds.length - added;

  // 3) Hapus baris item lama untuk SEMUA penerimaan yang baru diupsert sekaligus,
  //    lalu tulis ulang seluruh baris item dalam batch juga.
  const idByRef: Record<string, string> = {};
  for (const u of upsertedIds) idByRef[u.wh_in_ref] = u.id;
  const touchedIds = upsertedIds.map((u) => u.id);

  for (const chunk of chunks(touchedIds, 200)) {
    const { error } = await supabase.from("detail_penerimaan").delete().in("penerimaan_id", chunk);
    if (error) errors.push(`hapus item lama: ${error.message}`);
  }

  const lineRows: Record<string, unknown>[] = [];
  for (const rc of toProcess) {
    const pid = idByRef[rc.wh_in_ref];
    if (!pid) continue; // wh_in_ref ini terkunci (locked) atau gagal di-upsert
    for (const l of rc.lines as { product: string; sku: string; qty_po: number; uom: string }[]) {
      const sp = (l.sku && bySku[l.sku.toLowerCase()]) || byName[(l.product || "").toLowerCase()];
      lineRows.push({
        penerimaan_id: pid,
        sparepart_id: sp ? sp.id : null,
        product_name: l.product,
        sku: l.sku,
        uom: l.uom,
        qty_po: l.qty_po,
        qty_received: l.qty_po,
        condition: "Baik",
      });
    }
  }

  for (const chunk of chunks(lineRows, 500)) {
    const { error } = await supabase.from("detail_penerimaan").insert(chunk);
    if (error) errors.push(`insert item (${chunk.length} baris): ${error.message}`);
  }

  return { added, updated, locked, cancelled, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const uid = await login();
    const receipts = await fetchReceipts(uid);
    const result = await upsertReceipts(receipts);
    return json({ ok: true, fetched: receipts.length, ...result });
  } catch (err) {
    console.error("odoo-pull:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
