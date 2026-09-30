/**
 * Edge Function: sheet-pull-employees
 *
 * GANTI TOTAL sumber data public.karyawan dari Odoo (odoo-pull-employees) ke
 * Google Sheet — READ-ONLY, sama sekali nggak nulis/ngubah apa pun ke
 * sheet-nya (cuma baca lewat Google Sheets API pakai service account).
 *
 * MODE LAIN: kalau body request-nya berisi { mode: "po" }, function ini malah
 * jalanin jalur "Purchase Order dari sheet + Odoo" — dipanggil OTOMATIS
 * tiap halaman Purchase Order role Spinning dibuka, ATAU manual lewat
 * tombol "Sync PO" (spinningPurchase.js). Digabung ke function yang sama
 * (bukan Edge Function/tabel baru) sesuai permintaan biar nggak
 * nambah-nambah function/skema terus. Alurnya (lihat findPoNumbersFromSheet
 * & syncPoFromOdoo):
 *   1. Baca sheet "Laporan Permintaan Sparepart" (secret GOOGLE_SHEET_PO_ID,
 *      TERPISAH dari sheet karyawan) — cari baris dengan kolom Divisi
 *      mengandung "SPINNING" DAN kolom "No PO" sudah terisi manual sama
 *      tim procurement (baris yang No PO-nya masih kosong berarti belum
 *      jadi PO, dilewati).
 *   2. Ambil daftar No PO UNIK dari baris-baris itu.
 *   3. Buat tiap No PO, cari purchase.order di Odoo yang field `name`-nya
 *      (No PO itu sendiri) SAMA PERSIS — field ini PASTI ada di model
 *      purchase.order manapun, jadi TIDAK ada tebak field custom lagi
 *      (pendekatan sebelumnya yang coba tebak field "Department"/"Employee"
 *      di purchase.order ternyata nggak reliable, makanya balik ke sheet).
 *      Kalau ketemu, tarik detail lengkapnya (vendor, tanggal, item, qty,
 *      harga, status) dan upsert ke spinning_po/spinning_po_item (key
 *      upsert: kolom `nomor` = No PO Odoo, sudah unique dari skema lama,
 *      TIDAK butuh kolom baru). No PO di sheet yang TIDAK ketemu di Odoo
 *      dilewati (dicatat di `notFoundInOdoo`, bukan dipaksakan masuk).
 *   4. Baris hasil sync ini ditandai `dibuat_oleh = "Sync Odoo"` (kolom yang
 *      SUDAH ADA dari fitur PO manual) — dipakai UI buat tau baris ini
 *      read-only (nggak boleh diedit/dihapus manual dari SPB), BUKAN kolom
 *      baru. PO manual buatan SPB sendiri (dibuat_oleh lain) tetap ada,
 *      tampil berdampingan di list yang sama.
 *   5. Buat tiap PO itu, dicari juga stock.picking tipe INCOMING (WH IN)
 *      yang Odoo bikin OTOMATIS waktu PO dikonfirmasi (origin = No PO),
 *      status "done" doang (barang beneran udah masuk fisik) — ini yang
 *      jadi "Riwayat Penerimaan" di popup detail PO SPB. BUKAN dari
 *      input manual Admin Gudang lagi buat PO yang sumbernya Odoo (qty
 *      diterima per item juga udah ikut kebawa dari purchase.order.line.
 *      qty_received di langkah 3). Qty per produk WH IN dicocokkan ke item
 *      PO lewat NAMA part (persis sama teks) — best-effort, dicatat di
 *      `errors` kalau ada yang nggak ketemu padanannya.
 *   6. PO hasil sync Odoo yang SEKARANG udah nggak ketemu lagi (dihapus di
 *      Odoo, atau No PO-nya udah nggak ada/ganti di sheet) ikut DIHAPUS
 *      dari SPB (cascade ke item & riwayat penerimaannya) — biar SPB nggak
 *      nyimpen PO basi yang udah nggak valid.
 *
 * Cara kerja (mode default / employee sync):
 *  1. Login pakai service account (JWT RS256, signed manual pakai Web Crypto
 *     bawaan Deno — nggak butuh library tambahan) buat dapetin access token
 *     Google OAuth2 (scope read-only spreadsheets).
 *  2. Ambil metadata spreadsheet buat tau nama tab pertama (kalau
 *     GOOGLE_SHEET_TAB nggak diisi manual).
 *  3. Ambil semua baris dari tab itu. Baris PERTAMA dianggap header — nama
 *     kolomnya dicocokkan (case-insensitive) ke beberapa alias yang wajar,
 *     JADI SHEET-NYA BOLEH KOLOMNYA URUTAN APA AJA, nggak harus persis:
 *       - Nama       : "nama" / "name" / "nama karyawan"
 *       - Departemen : "departemen" / "divisi" / "department"
 *       - NIP        : "nip"
 *       - Jabatan    : "jabatan" / "posisi" / "position"
 *       - Aktif      : "aktif" / "active" / "status" (opsional; default aktif)
 *  4. Dicocokkan ke public.karyawan yang SUDAH ADA lewat NAMA (bukan
 *     odoo_employee_id lagi, itu kolom khusus buat sumber Odoo) — kalau
 *     namanya udah ada, di-update; kalau belum, di-insert baru.
 *  5. Karyawan yang ADA di database tapi NAMANYA UDAH NGGAK ADA di sheet
 *     ditandai active=false (bukan dihapus — biar riwayat WH/OUT & Permintaan
 *     Barang yang nyimpen nama itu tetap kebaca).
 *
 * Secrets yang perlu diisi di Supabase (Project Settings -> Edge Functions -> Secrets):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL   -> "xxx@xxx.iam.gserviceaccount.com" dari file JSON key
 *   GOOGLE_SERVICE_ACCOUNT_KEY     -> isi "private_key" dari file JSON key (apa adanya, termasuk \n)
 *   GOOGLE_SHEET_ID                -> ID sheet KARYAWAN (bagian di URL antara /d/ dan /edit)
 *   GOOGLE_SHEET_TAB               -> (opsional) nama tab sheet karyawan, default tab pertama
 *   GOOGLE_SHEET_PO_ID             -> ID sheet "Laporan Permintaan Sparepart" (mode "po"), TERPISAH dari sheet karyawan
 *   GOOGLE_SHEET_PO_TAB            -> (opsional) nama tab, default tab pertama (mis. "REKAP PERMINTAAN")
 *   ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASSWORD -> SAMA dengan yang dipakai odoo-pull-stock, dipakai mode "po"
 *
 * PENTING (biar Sheet-nya tetap read-only dari sisi Google juga): share
 * sheet ke email service account itu sebagai "Viewer" doang, JANGAN Editor —
 * fungsi ini emang cuma baca (metode GET semua), tapi izinnya juga baiknya
 * dibatasi cuma baca dari sisi Google Sheets-nya sendiri.
 *
 * Deploy: supabase functions deploy sheet-pull-employees
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function env(key: string): string {
  return (Deno.env.get(key) ?? "").trim();
}
const SA_EMAIL = env("GOOGLE_SERVICE_ACCOUNT_EMAIL");
const SA_KEY = env("GOOGLE_SERVICE_ACCOUNT_KEY");
const SHEET_ID = env("GOOGLE_SHEET_ID");
const SHEET_TAB = env("GOOGLE_SHEET_TAB"); // boleh kosong -> pakai tab pertama
// Default di-hardcode langsung ke sheet & tab yang dikasih user ("TRIAL
// AULIA") — biar nggak wajib isi secret GOOGLE_SHEET_PO_ID/_TAB dulu di
// Supabase Dashboard buat mulai coba. Isi secret itu TETAP menang/override
// kalau suatu saat mau ganti sheet lain tanpa ubah kode ini lagi.
const SHEET_PO_ID = env("GOOGLE_SHEET_PO_ID") || "1sDPbPVzNl7dwXGUOibyPSuPDaAs22fikPVba7OLfvds";
const SHEET_PO_TAB = env("GOOGLE_SHEET_PO_TAB") || "TRIAL AULIA";
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

/* ---------- JWT RS256 (service account) -> access token Google OAuth2 ---------- */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "\n") // jaga-jaga kalau secret-nya kesimpen dengan \n literal (bukan newline asli)
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
async function getAccessToken(): Promise<string> {
  // Sengaja TIDAK validasi SHEET_ID di sini — mode default (karyawan) dan
  // mode "po" pakai spreadsheet ID yang beda (SHEET_ID vs SHEET_PO_ID),
  // masing-masing sync function yang validasi ID-nya sendiri.
  if (!SA_EMAIL || !SA_KEY) throw new Error("Secret GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_KEY belum diisi.");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const enc = (obj: unknown) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const key = await importPrivateKey(SA_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Login Google gagal: ${body.error_description || body.error || res.status}`);
  return body.access_token as string;
}

/* ---------- Baca sheet ---------- */
// Header kolom di sheet ternyata nggak selalu bersih (mis. "NAMA*:" — ada
// tanda bintang/titik dua nemplok, atau "DIV NEW"/"SUB DIV NEW"/"POS NEW"
// yang beda penamaan dari sheet lain kayak "MASTER"). normalizeHeader()
// buang semua karakter selain huruf/angka/spasi biar "NAMA*:" jadi "nama"
// bersih, terus findCol() cocokin PERSIS dulu, kalau nggak ketemu baru coba
// cocokin AWALAN-nya aja (misal alias "div" ketemu di "div new").
function normalizeHeader(h: string): string {
  return (h || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function findCol(headers: string[], aliases: string[]): number {
  const norm = headers.map(normalizeHeader);
  for (const a of aliases) {
    const idx = norm.indexOf(a);
    if (idx !== -1) return idx;
  }
  for (const a of aliases) {
    const idx = norm.findIndex((h) => h.startsWith(a + " "));
    if (idx !== -1) return idx;
  }
  return -1;
}
function cell(row: string[], idx: number): string {
  return idx >= 0 ? String(row[idx] ?? "").trim() : "";
}
// Isi kolom NAMA di tab "DATA INDEX" ternyata nempel "* :" di belakang tiap
// nama (mis. "ADE SUNARYA* :"), bukan cuma di header-nya doang — kalau
// dibiarin, nama yang kesimpen di SPB jadi beda teks dari yang udah ada
// (dianggap "orang baru" padahal orang yang sama), bikin data dobel.
function cleanName(s: string): string {
  return s.replace(/[\s*:.,;]+$/, "").trim();
}

// Baca semua baris (values) dari 1 tab spreadsheet — dipakai dua-duanya
// (sync karyawan & sync PO), cuma beda sheetId/tab yang dioper.
async function readSheetRows(token: string, sheetId: string, tab: string): Promise<string[][]> {
  const range = encodeURIComponent(`${tab}!A1:Z20000`);
  const valuesRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const valuesBody = await valuesRes.json();
  if (!valuesRes.ok) throw new Error(`Gagal baca isi sheet: ${valuesBody.error?.message || valuesRes.status}`);
  return valuesBody.values || [];
}
async function resolveFirstTab(token: string, sheetId: string): Promise<string> {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(`Gagal baca metadata sheet: ${meta.error?.message || metaRes.status}`);
  const tab = meta.sheets?.[0]?.properties?.title;
  if (!tab) throw new Error("Nggak nemu tab/sheet pertama — cek ID sheet-nya.");
  return tab;
}

async function syncEmployees() {
  const token = await getAccessToken();
  if (!SHEET_ID) throw new Error("Secret GOOGLE_SHEET_ID belum diisi.");
  const tab = SHEET_TAB || await resolveFirstTab(token, SHEET_ID);
  const rows = await readSheetRows(token, SHEET_ID, tab);
    if (rows.length < 2) return json({ ok: true, fetched: 0, upserted: 0, deactivated: 0, note: "Sheet kosong atau cuma ada header." });

    // Baris header NGGAK SELALU baris pertama (mis. sheet "MASTER" punya 3
    // baris ringkasan/rekap di atas sebelum baris header beneran) — jadi
    // di-scan 10 baris pertama, dipilih yang paling banyak cocok sama
    // alias kolom yang kita butuhin, bukan asumsi rows[0] langsung.
    function scoreHeaderRow(row: string[]): number {
      const norm = row.map(normalizeHeader);
      let score = 0;
      if (norm.some((h) => h === "nama" || h.startsWith("nama "))) score++;
      if (norm.some((h) => ["divisi", "departemen", "department"].includes(h) || h.startsWith("div"))) score++;
      if (norm.includes("nip")) score++;
      if (norm.includes("jabatan")) score++;
      return score;
    }
    let headerRowIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const s = scoreHeaderRow(rows[i]);
      if (s > bestScore) { bestScore = s; headerRowIdx = i; }
    }
    if (headerRowIdx === -1) {
      throw new Error(`Nggak nemu baris header (kolom NAMA/NIP/DIVISI/JABATAN) di 10 baris pertama tab "${tab}".`);
    }
    const headers = rows[headerRowIdx];
    const dataRows = rows.slice(headerRowIdx + 1);

    const idxName = findCol(headers, ["nama", "name", "nama karyawan"]);
    // Divisi/Sub tetap digabung ke "department" (format "DIVISI / SUB") —
    // dipertahankan biar konsisten sama divisiOfDept/subDivisiOfDept yang
    // udah dipakai di karyawan.js/laporan.js/pesan.js. Bagian & Shift
    // SEKARANG disimpan sebagai KOLOM SENDIRI (bagian, shift) — bukan ikut
    // digabung ke department lagi — biar bisa ditampilkan apa adanya di
    // tabel Karyawan, sama persis kayak di sheet-nya.
    // "div" (buat nangkep header "DIV NEW" dsb) & "sub" (nangkep "SUB DIV
    // NEW") ditambah SETELAH alias yang lebih spesifik — findCol coba exact
    // match SEMUA alias dulu baru fallback ke awalan, jadi "divisi" tetap
    // menang kalau ada, "div" cuma jaring pengaman buat variasi penamaan.
    const idxDivisi = findCol(headers, ["divisi", "departemen", "department", "div"]);
    const idxSub = findCol(headers, ["sub divisi", "subdivisi", "sub"]);
    // "pos" (buat nangkep "POS NEW") — di sheet ini POS NEW itu beda kolom
    // dari JABATAN (dua-duanya ada), jadi posisi/position dipetakan ke sini
    // (Bagian/Posisi), BUKAN ke Jabatan, biar nggak ketuker.
    const idxBagian = findCol(headers, ["bagian", "posisi", "position", "pos"]);
    const idxShift = findCol(headers, ["shift"]);
    const idxNip = findCol(headers, ["nip"]);
    const idxJabatan = findCol(headers, ["jabatan"]);
    // SENGAJA nggak pakai alias "status" generik — sheet "MASTER" punya
    // kolom "STATUS" yang isinya status PERNIKAHAN (K/1, K/2, TK), BUKAN
    // status aktif/nonaktif karyawan. Kalau mau kontrol aktif/nonaktif dari
    // sheet, kasih nama kolom eksplisit "AKTIF" atau "ACTIVE".
    const idxActive = findCol(headers, ["aktif", "active"]);
    if (idxName === -1) {
      throw new Error(`Kolom "Nama" nggak ketemu di header sheet (header yang kebaca: ${headers.join(", ")}).`);
    }

    const sheetRowsRaw = dataRows
      .map((r) => {
        const activeRaw = cell(r, idxActive).toLowerCase();
        const active = idxActive === -1 ? true : !["nonaktif", "inactive", "resign", "no", "false", "0", "tidak aktif"].includes(activeRaw);
        const department = [cell(r, idxDivisi), cell(r, idxSub)].filter(Boolean).join(" / ");
        return {
          name: cleanName(cell(r, idxName)),
          department,
          bagian: cell(r, idxBagian) || null,
          shift: cell(r, idxShift) || null,
          nip: cell(r, idxNip) || null,
          jabatan: cell(r, idxJabatan) || null,
          active,
        };
      })
      .filter((r) => r.name);

    // Jaring pengaman anti-duplikat DALAM SATU KALI TARIK — kalau ternyata
    // sheet-nya sendiri punya 2 baris nama yang sama (typo/re-entry manual),
    // tanpa ini bakal ke-insert 2 baris baru sekaligus di database (karena
    // "byName" di bawah cuma dicek dari data yang UDAH ADA SEBELUM sync ini
    // jalan, bukan dicek ulang antar-baris sheet yang lagi diproses). Baris
    // belakangan MENANG (nimpa yang duluan) kalau namanya sama persis.
    const dedup = new Map<string, typeof sheetRowsRaw[number]>();
    sheetRowsRaw.forEach((r) => dedup.set(r.name.toLowerCase(), r));
    const sheetRows = Array.from(dedup.values());

    // Cocokkan ke karyawan yang udah ada lewat NAMA (lowercase, trim) — bukan
    // odoo_employee_id lagi (kolom itu tetap ada di skema, tapi biarin null
    // buat baris yang datang dari sheet, jangan dipaksa isi apa pun ke situ).
    const { data: existing, error: exErr } = await supabase.from("karyawan").select("id, name");
    if (exErr) throw new Error(exErr.message);
    const byName = new Map<string, string>(); // lowercase name -> id
    (existing || []).forEach((k: { id: string; name: string }) => byName.set((k.name || "").trim().toLowerCase(), k.id));

    const toInsert: Record<string, unknown>[] = [];
    const toUpdate: { id: string; data: Record<string, unknown> }[] = [];
    const matchedIds = new Set<string>();
    for (const r of sheetRows) {
      const key = r.name.toLowerCase();
      const existingId = byName.get(key);
      if (existingId) {
        matchedIds.add(existingId);
        toUpdate.push({ id: existingId, data: { department: r.department, bagian: r.bagian, shift: r.shift, nip: r.nip, jabatan: r.jabatan, active: r.active } });
      } else {
        toInsert.push({ name: r.name, department: r.department, bagian: r.bagian, shift: r.shift, nip: r.nip, jabatan: r.jabatan, active: r.active });
      }
    }

    let upserted = 0;
    const errors: string[] = [];
    if (toInsert.length) {
      const { error, count } = await supabase.from("karyawan").insert(toInsert).select("id", { count: "exact" });
      if (error) errors.push(error.message); else upserted += count ?? toInsert.length;
    }
    for (const u of toUpdate) {
      const { error } = await supabase.from("karyawan").update(u.data).eq("id", u.id);
      if (error) errors.push(`${u.id}: ${error.message}`); else upserted += 1;
    }

    // Karyawan lama yang namanya udah nggak ada di sheet -> tandai nonaktif
    // (bukan dihapus, biar histori WH/OUT & Permintaan Barang yang udah
    // nyimpen namanya tetap kebaca).
    const missingIds = (existing || []).map((k: { id: string }) => k.id).filter((id: string) => !matchedIds.has(id));
    let deactivated = 0;
    if (missingIds.length) {
      const { error, count } = await supabase.from("karyawan").update({ active: false }).in("id", missingIds).select("id", { count: "exact" });
      if (error) errors.push(error.message); else deactivated = count ?? missingIds.length;
    }

    return json({ ok: true, fetched: sheetRows.length, upserted, deactivated, errors });
}

/* =========================================================
   Mode "po" — sheet TRACKING PO (No Permintaan/Divisi/No PO) + Odoo purchase.order.
   Lihat catatan panjang di komentar atas file.
   ========================================================= */

/* ---------- Odoo JSON-RPC (copy dari pola odoo-pull-stock/odoo-pull-suppliers) ---------- */
const ODOO_TIMEOUT_MS = 25000;
async function odooJsonRpc(service: string, method: string, args: unknown[]) {
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
async function odooLogin(): Promise<number> {
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASSWORD) {
    throw new Error("Secret ODOO_URL/ODOO_DB/ODOO_USER/ODOO_PASSWORD belum lengkap.");
  }
  const uid = await odooJsonRpc("common", "login", [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
  if (!uid || typeof uid !== "number") throw new Error("Login Odoo gagal — cek email & password.");
  return uid;
}
async function odooRpc(uid: number, model: string, method: string, args: unknown[], kwargs: unknown = {}) {
  return odooJsonRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs]);
}
function odooStr(v: unknown): string {
  return v == null || v === false ? "" : String(v);
}
function odooM2oName(v: unknown): string {
  return Array.isArray(v) ? odooStr(v[1]) : odooStr(v);
}

// Odoo purchase.order.state -> status yang SUDAH ADA di check constraint
// spinning_po.status (TIDAK nambah nilai baru, biar nggak perlu ubah skema).
function mapOdooPoState(state: string, allDelivered: boolean, anyDelivered: boolean): string {
  if (state === "cancel") return "dibatalkan";
  if (state === "draft" || state === "sent") return "menunggu_konfirmasi";
  // purchase/done -> confirmed di Odoo, dipetakan lagi berdasar progres
  // penerimaan (qty_received per line) biar progress bar SPB tetap akurat.
  if (allDelivered) return "diterima";
  if (anyDelivered) return "dikirim_sebagian";
  return "dikonfirmasi";
}

// Balik lagi ke pendekatan sheet — sheet "Laporan Permintaan Sparepart"
// (tab REKAP PERMINTAAN, kolom "No Permintaan"/"Divisi"/"No PO") itu SUDAH
// PASTI benar nentuin No PO mana yang relevan buat Spinning (diisi manual
// sama tim procurement begitu PR jadi PO) — dibanding coba nebak/deteksi
// field Odoo yang ternyata gampang salah. Jadi caranya:
//   1. Baca sheet itu, filter baris Divisi mengandung "SPINNING" DAN kolom
//      No PO udah keisi (baris belum ada No PO = belum jadi PO, dilewati).
//   2. Ambil daftar No PO UNIK dari situ.
//   3. Buat tiap No PO, cari purchase.order di Odoo dengan field `name`
//      (No PO-nya sendiri) SAMA PERSIS — field ini PASTI ada di model
//      purchase.order manapun, jadi TIDAK ada tebak-tebak field lagi.
type PoSheetInfo = { noPermintaan: string; pemohon: string; divisi: string; subDivisi: string; bagian: string };
async function findPoNumbersFromSheet(token: string): Promise<{ noPoList: string[]; infoByNoPo: Map<string, PoSheetInfo> }> {
  if (!SHEET_PO_ID) throw new Error("Secret GOOGLE_SHEET_PO_ID belum diisi.");
  const tab = SHEET_PO_TAB || await resolveFirstTab(token, SHEET_PO_ID);
  const rows = await readSheetRows(token, SHEET_PO_ID, tab);
  if (rows.length < 2) return { noPoList: [], infoByNoPo: new Map() };

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const idxNoPermintaan = findCol(headers, ["no permintaan", "nomor permintaan"]);
  const idxPemohon = findCol(headers, ["pemohon"]);
  const idxDivisi = findCol(headers, ["divisi"]);
  const idxNoPo = findCol(headers, ["no po", "nomor po"]);
  if (idxDivisi === -1 || idxNoPo === -1) {
    throw new Error(`Kolom "Divisi" / "No PO" nggak ketemu di header tab "${tab}" (header yang kebaca: ${headers.join(", ")}).`);
  }

  const noPoSet = new Set<string>();
  const infoByNoPo = new Map<string, PoSheetInfo>();
  for (const r of dataRows) {
    const divisiRaw = cell(r, idxDivisi);
    const noPo = cell(r, idxNoPo);
    if (!noPo || !/spinning/i.test(divisiRaw)) continue;
    noPoSet.add(noPo);
    if (!infoByNoPo.has(noPo)) {
      // Kolom "Divisi" di sheet isinya digabung 1 sel format "DIVISI/SUB
      // DIVISI/BAGIAN" (mis. "SPINNING/OE/MEKANIK") — dipecah lagi di sini
      // biar bisa ditampilkan per-bagian di popup detail PO SPB, sama
      // persis kayak yang keliatan di form Employee Odoo.
      const parts = divisiRaw.split("/").map((s) => s.trim());
      infoByNoPo.set(noPo, {
        noPermintaan: idxNoPermintaan !== -1 ? cell(r, idxNoPermintaan) : "",
        pemohon: idxPemohon !== -1 ? cell(r, idxPemohon) : "",
        divisi: parts[0] || "",
        subDivisi: parts[1] || "",
        bagian: parts[2] || "",
      });
    }
  }
  return { noPoList: Array.from(noPoSet), infoByNoPo };
}

// Tarik WH IN (stock.picking tipe incoming) yang OTOMATIS dibikin Odoo waktu
// PO dikonfirmasi (origin-nya = No PO) — ini yang jadi "Riwayat Penerimaan"
// di popup detail PO SPB, BUKAN dari input manual Admin Gudang lagi buat PO
// yang sumbernya Odoo. Qty per produk dicocokkan ke po_item lewat NAMA part
// (persis sama teks) — nggak ada SKU/product_id tersimpan di po_item versi
// sekarang, jadi ini best-effort; kalau namanya beda dikit antara
// purchase.order.line vs stock.move.line punya Odoo, baris itu dilewati
// (dicatat di errors, nggak dipaksa nebak).
async function syncReceiptsForOrder(uid: number, noPo: string, poId: string, poItemIdByName: Map<string, string>): Promise<string[]> {
  const errs: string[] = [];
  const pickings = await odooRpc(uid, "stock.picking", "search_read", [
    [["origin", "=", noPo], ["picking_type_id.code", "=", "incoming"]],
  ], { fields: ["name", "state", "date_done", "scheduled_date"] }) as Record<string, unknown>[];

  for (const picking of pickings) {
    // Cuma picking yang statusnya "done" (barang beneran udah fisik masuk)
    // yang dicatat sebagai penerimaan — draft/assigned/cancel dilewati
    // (belum kejadian secara fisik, baru rencana/reservasi).
    if (odooStr(picking.state) !== "done") continue;

    const lines = await odooRpc(uid, "stock.move.line", "search_read", [
      [["picking_id", "=", picking.id]],
    ], { fields: ["product_id", "quantity", "qty_done"] }) as Record<string, unknown>[];
    if (!lines.length) continue;

    const noWhIn = odooStr(picking.name);
    const tanggal = (odooStr(picking.date_done) || odooStr(picking.scheduled_date)).slice(0, 10) || new Date().toISOString().slice(0, 10);
    const { data: receipt, error: eReceipt } = await supabase.from("spinning_receipt").upsert({
      nomor: noWhIn,
      po_id: poId,
      tanggal,
      diterima_oleh: "Sync Odoo",
      no_surat_jalan: noWhIn,
      catatan: null,
    }, { onConflict: "nomor" }).select().single();
    if (eReceipt) { errs.push(`upsert receipt ${noWhIn}: ${eReceipt.message}`); continue; }

    const { error: eDelRi } = await supabase.from("spinning_receipt_item").delete().eq("receipt_id", receipt.id);
    if (eDelRi) { errs.push(`hapus item receipt lama ${noWhIn}: ${eDelRi.message}`); continue; }

    const itemPayload = lines.map((l) => {
      const productName = odooM2oName(l.product_id);
      const poItemId = poItemIdByName.get(productName);
      if (!poItemId) return null;
      const qty = Number(l.quantity ?? l.qty_done ?? 0);
      return { receipt_id: receipt.id, po_item_id: poItemId, qty_terima: qty, qty_reject: 0 };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    if (itemPayload.length) {
      const { error: eIns } = await supabase.from("spinning_receipt_item").insert(itemPayload);
      if (eIns) errs.push(`insert item receipt ${noWhIn}: ${eIns.message}`);
    } else {
      errs.push(`WH IN ${noWhIn}: produk di picking nggak ketemu padanan nama part-nya di PO ${noPo}, item receipt dilewati.`);
    }
  }
  return errs;
}

async function syncPoFromOdoo() {
  const token = await getAccessToken();
  const { noPoList, infoByNoPo } = await findPoNumbersFromSheet(token);
  if (!noPoList.length) return json({ ok: true, poFound: 0, poSynced: 0, notFoundInOdoo: [], deleted: 0, errors: [] });

  const uid = await odooLogin();
  const errors: string[] = [];
  const notFoundInOdoo: string[] = [];
  const syncedNomors: string[] = [];
  let poSynced = 0;

  for (const noPo of noPoList) {
    try {
      const orders = await odooRpc(uid, "purchase.order", "search_read", [
        [["name", "=", noPo]],
      ], {
        fields: ["name", "partner_id", "date_order", "date_planned", "state", "amount_untaxed", "amount_tax", "amount_total"],
        limit: 1,
      }) as Record<string, unknown>[];
      if (!orders.length) { notFoundInOdoo.push(noPo); continue; }
      const order = orders[0];

      const lines = await odooRpc(uid, "purchase.order.line", "search_read", [
        [["order_id", "=", order.id]],
      ], { fields: ["name", "product_qty", "qty_received", "price_unit", "price_subtotal", "product_uom"] }) as Record<string, unknown>[];

      const allDelivered = lines.length > 0 && lines.every((l) => Number(l.qty_received ?? 0) >= Number(l.product_qty ?? 0));
      const anyDelivered = lines.some((l) => Number(l.qty_received ?? 0) > 0);
      const status = mapOdooPoState(odooStr(order.state), allDelivered, anyDelivered);
      const tanggal = odooStr(order.date_order).slice(0, 10) || new Date().toISOString().slice(0, 10);
      const tanggalKirimEstimasi = odooStr(order.date_planned).slice(0, 10) || null;
      const ppnPersen = Number(order.amount_untaxed) > 0 ? Math.round((Number(order.amount_tax) / Number(order.amount_untaxed)) * 10000) / 100 : 11;
      const sheetInfo = infoByNoPo.get(noPo);
      // Nama pemohon & Divisi/Sub Divisi/Bagian nggak ada kolom khusus di
      // skema spinning_po lama — dititip di `catatan` (kolom yang sudah
      // ada) dalam baris "Label: nilai" biar bisa di-parse balik & tampil
      // rapi sebagai info tersendiri di popup detail PO SPB (bukan cuma
      // teks bebas), bukan nambah kolom baru.
      const catatanLines: string[] = [];
      if (sheetInfo?.pemohon) catatanLines.push(`Pemohon: ${sheetInfo.pemohon}`);
      if (sheetInfo?.divisi) catatanLines.push(`Divisi: ${sheetInfo.divisi}`);
      if (sheetInfo?.subDivisi) catatanLines.push(`Sub Divisi: ${sheetInfo.subDivisi}`);
      if (sheetInfo?.bagian) catatanLines.push(`Bagian: ${sheetInfo.bagian}`);
      const catatan = catatanLines.length ? catatanLines.join("\n") : null;

      // Upsert by "nomor" (kolom unique yang SUDAH ADA di skema lama) — key
      // upsert-nya No PO Odoo itu sendiri, TIDAK butuh kolom penanda baru.
      const { data: po, error: ePo } = await supabase.from("spinning_po").upsert({
        nomor: noPo,
        tanggal,
        supplier_id: null,
        supplier_nama: odooM2oName(order.partner_id) || "-",
        pr_id: null,
        pr_nomor: sheetInfo?.noPermintaan || null,
        status,
        subtotal: Number(order.amount_untaxed ?? 0),
        diskon_persen: 0,
        diskon: 0,
        ppn_persen: ppnPersen,
        ppn: Number(order.amount_tax ?? 0),
        total: Number(order.amount_total ?? 0),
        termin_hari: 30,
        tanggal_kirim_estimasi: tanggalKirimEstimasi,
        dibuat_oleh: "Sync Odoo",
        catatan,
      }, { onConflict: "nomor" }).select().single();
      if (ePo) { errors.push(`upsert PO ${noPo}: ${ePo.message}`); continue; }

      // Ganti total isi item tiap sync (pola yang sama dengan updatePO() di
      // spinningClient.js) — lebih sederhana & aman daripada matching
      // baris-per-baris, karena Odoo bisa nambah/hapus/ubah urutan line.
      const { error: eDelItems } = await supabase.from("spinning_po_item").delete().eq("po_id", po.id);
      if (eDelItems) { errors.push(`hapus item lama PO ${noPo}: ${eDelItems.message}`); continue; }
      const poItemIdByName = new Map<string, string>();
      if (lines.length) {
        const itemPayload = lines.map((l) => ({
          po_id: po.id,
          part_id: null,
          nama_part: odooStr(l.name) || "-",
          satuan: odooM2oName(l.product_uom) || null,
          qty: Number(l.product_qty ?? 0),
          harga_satuan: Number(l.price_unit ?? 0),
          subtotal: Number(l.price_subtotal ?? 0),
          qty_diterima: Number(l.qty_received ?? 0),
        }));
        const { data: insertedItems, error: eItems } = await supabase.from("spinning_po_item").insert(itemPayload).select();
        if (eItems) { errors.push(`insert item PO ${noPo}: ${eItems.message}`); continue; }
        (insertedItems || []).forEach((it: { id: string; nama_part: string }) => poItemIdByName.set(it.nama_part, it.id));
      }

      // WH IN (Penerimaan Barang) — ditarik dari Odoo langsung, BUKAN input
      // manual Admin Gudang lagi buat PO yang sumbernya Odoo (lihat catatan
      // di syncReceiptsForOrder).
      const receiptErrs = await syncReceiptsForOrder(uid, noPo, po.id, poItemIdByName);
      errors.push(...receiptErrs);

      poSynced++;
      syncedNomors.push(noPo);
    } catch (err) {
      errors.push(`PO ${noPo}: ${(err as Error).message}`);
    }
  }

  // Bersih-bersih: PO hasil sync Odoo yang SEKARANG nggak ketemu lagi di
  // sheet+Odoo (dihapus di Odoo, atau No PO-nya udah nggak ada di sheet)
  // ikut dihapus dari SPB — spinning_po_item & spinning_receipt(_item)
  // ikut kehapus otomatis (on delete cascade), biar SPB nggak nyimpen PO
  // basi yang sebenarnya udah nggak valid lagi.
  let deleted = 0;
  const { data: staleRows, error: eStale } = await supabase
    .from("spinning_po").select("id, nomor").eq("dibuat_oleh", "Sync Odoo");
  if (eStale) errors.push(`baca PO lama buat cleanup: ${eStale.message}`);
  else {
    const staleIds = (staleRows || []).filter((r: { nomor: string }) => !syncedNomors.includes(r.nomor)).map((r: { id: string }) => r.id);
    if (staleIds.length) {
      const { error: eDelStale, count } = await supabase.from("spinning_po").delete({ count: "exact" }).in("id", staleIds);
      if (eDelStale) errors.push(`hapus PO basi: ${eDelStale.message}`);
      else deleted = count ?? staleIds.length;
    }
  }

  return json({ ok: true, poFound: noPoList.length, poSynced, notFoundInOdoo, deleted, errors });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({} as { mode?: string })) : {};
    if (body && body.mode === "po") return await syncPoFromOdoo();
    return await syncEmployees();
  } catch (err) {
    console.error("sheet-pull-employees:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
