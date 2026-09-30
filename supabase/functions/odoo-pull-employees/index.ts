/**
 * Edge Function: odoo-pull-employees
 *
 * Menarik daftar karyawan (hr.employee) dari Odoo ke tabel public.karyawan —
 * dipakai sebagai sumber autocomplete di form "Distribusi ke Karyawan"
 * (WH/OUT). Read-only, sama seperti odoo-pull.
 *
 * Data karyawan jarang berubah, jadi function ini TIDAK perlu dijadwalkan
 * serapat odoo-pull — cukup dipanggil manual dari tombol "Sync dari Odoo" di
 * halaman Karyawan, atau dijadwalkan cron sekali sehari kalau mau otomatis.
 *
 * Deploy: supabase functions deploy odoo-pull-employees
 * (pakai secrets ODOO_* yang sama dengan odoo-pull)
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
function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const uid = await login();

    const PAGE = 500;
    const employees: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += PAGE) {
      // active_test:false -> ikut tarik karyawan nonaktif juga, biar riwayat
      // distribusi lama tetap terbaca namanya walau orangnya sudah resign.
      // identification_id & job_title ditambahin buat isi NIP & Jabatan
      // otomatis di fitur Permintaan Barang (dulu cuma name/department_id,
      // dua field ini standar bawaan Odoo hr.employee, bukan custom field —
      // aman ditambah tanpa perlu setup apa pun di sisi Odoo).
      const page = await rpc(uid, "hr.employee", "search_read", [[]], {
        fields: ["name", "department_id", "active", "identification_id", "job_title"],
        limit: PAGE, offset, context: { active_test: false },
      });
      employees.push(...(page as Record<string, unknown>[]));
      if (page.length < PAGE) break;
    }

    const rows = employees.map((e) => ({
      odoo_employee_id: e.id as number,
      name: odooStr(e.name),
      department: m2oName(e.department_id),
      active: e.active !== false,
      nip: odooStr(e.identification_id) || null,
      jabatan: odooStr(e.job_title) || null,
    })).filter((r) => r.name);

    let upserted = 0;
    const errors: string[] = [];
    for (const chunk of chunks(rows, 200)) {
      const { error, count } = await supabase
        .from("karyawan").upsert(chunk, { onConflict: "odoo_employee_id" }).select("id", { count: "exact" });
      if (error) errors.push(error.message);
      else upserted += count ?? chunk.length;
    }

    return json({ ok: true, fetched: employees.length, upserted, errors });
  } catch (err) {
    console.error("odoo-pull-employees:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
