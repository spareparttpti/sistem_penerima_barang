/**
 * Edge Function: sheet-pull-employees
 *
 * GANTI TOTAL sumber data public.karyawan dari Odoo (odoo-pull-employees) ke
 * Google Sheet — READ-ONLY, sama sekali nggak nulis/ngubah apa pun ke
 * sheet-nya (cuma baca lewat Google Sheets API pakai service account).
 *
 * Cara kerja:
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
 *   GOOGLE_SHEET_ID                -> ID sheet-nya (bagian di URL antara /d/ dan /edit)
 *   GOOGLE_SHEET_TAB               -> (opsional) nama tab, default tab pertama
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
  if (!SA_EMAIL || !SA_KEY) throw new Error("Secret GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_KEY belum diisi.");
  if (!SHEET_ID) throw new Error("Secret GOOGLE_SHEET_ID belum diisi.");
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = await getAccessToken();

    let tab = SHEET_TAB;
    if (!tab) {
      const metaRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const meta = await metaRes.json();
      if (!metaRes.ok) throw new Error(`Gagal baca metadata sheet: ${meta.error?.message || metaRes.status}`);
      tab = meta.sheets?.[0]?.properties?.title;
      if (!tab) throw new Error("Nggak nemu tab/sheet pertama — cek GOOGLE_SHEET_ID-nya.");
    }

    const range = encodeURIComponent(`${tab}!A1:Z20000`);
    const valuesRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const valuesBody = await valuesRes.json();
    if (!valuesRes.ok) throw new Error(`Gagal baca isi sheet: ${valuesBody.error?.message || valuesRes.status}`);

    const rows: string[][] = valuesBody.values || [];
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
  } catch (err) {
    console.error("sheet-pull-employees:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});
