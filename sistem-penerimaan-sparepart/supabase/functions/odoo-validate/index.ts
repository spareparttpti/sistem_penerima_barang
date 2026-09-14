/**
 * Edge Function: odoo-validate
 *
 * Satu-satunya titik di seluruh integrasi yang MENULIS ke Odoo (semua function
 * lain — odoo-pull, odoo-webhook — murni search_read, baca saja). Dipanggil
 * dari frontend SETELAH petugas menekan "Done — Barang Sudah Datang" di SPB,
 * untuk otomatis memvalidasi (button_validate) transfer yang sama di Odoo —
 * supaya admin tidak perlu buka Odoo manual tiap kali barang datang.
 *
 * Sengaja dipisah dari odoo-pull: kalau ini gagal/timeout/di-nonaktifkan,
 * pencatatan penerimaan fisik di SPB TETAP berhasil duluan (lihat pemanggilnya
 * di supabaseClient.js markArrived) — kegagalan di sini cuma memunculkan
 * peringatan "belum ke-sync ke Odoo", bukan membatalkan apa pun di SPB.
 *
 * Body: { "picking_id": 123, "action": "validate" }
 *   action "validate" (default) -> button_validate  (Ready/Waiting -> Done, potong stok)
 *   action "confirm"            -> action_confirm   (Draft -> Waiting/Ready, "Mark as Todo",
 *                                  TIDAK potong stok — dipakai WH/OUT saat "Approve Barang")
 *
 * Deploy: supabase functions deploy odoo-validate
 * (memakai secrets ODOO_URL/ODOO_DB/ODOO_USER/ODOO_PASSWORD yang sama dengan odoo-pull)
 */

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

function env(key: string): string {
  return (Deno.env.get(key) ?? "").trim();
}

const ODOO_URL = env("ODOO_URL");
const ODOO_DB = env("ODOO_DB");
const ODOO_USER = env("ODOO_USER");
const ODOO_PASSWORD = env("ODOO_PASSWORD");

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
      throw new Error(`Tidak ada balasan dari Odoo dalam ${ODOO_TIMEOUT_MS / 1000} detik.`);
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
    throw new Error("Secret ODOO_URL/ODOO_DB/ODOO_USER/ODOO_PASSWORD belum lengkap.");
  }
  const uid = await jsonRpc("common", "login", [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
  if (!uid || typeof uid !== "number") throw new Error("Login Odoo gagal — cek email & password.");
  return uid;
}

async function rpc(uid: number, model: string, method: string, args: unknown[], kwargs: unknown = {}) {
  return jsonRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const pickingId = Number(body.picking_id);
    const action = body.action === "confirm" ? "confirm" : "validate";
    if (!pickingId) return json({ ok: false, error: "picking_id wajib diisi." }, 400);

    const uid = await login();

    // Kalau transfer sudah Done/Cancel di Odoo (mis. sudah divalidasi manual
    // duluan oleh admin), tidak perlu diproses lagi — bukan error.
    const current = await rpc(uid, "stock.picking", "read", [[pickingId]], { fields: ["state"] });
    const state = current?.[0]?.state;
    if (state === "cancel") return json({ ok: false, error: "Transfer ini sudah dibatalkan di Odoo.", state });

    if (action === "confirm") {
      // "Mark as Todo": Draft -> Waiting/Ready. TIDAK potong stok, jadi aman
      // dipanggil berkali-kali / kalau sudah lewat dari Draft (mis. sudah
      // Done duluan) tinggal no-op.
      if (state !== "draft") return json({ ok: true, already: true, state });
      await rpc(uid, "stock.picking", "action_confirm", [[pickingId]]);
      // action_confirm SENDIRIAN nggak bikin Odoo nge-reserve stok (kolom
      // "Direservasi" di Stok Barang tetap 0) — itu quant baru kereservasi
      // kalau ada action_assign ("Check Availability") yang jalan. Dulu di
      // sini cuma action_confirm doang, jadi reservasi nggak pernah kejadian
      // sampai barang beneran divalidasi (button_validate) — padahal itu
      // sudah kepotong permanen, bukan lagi "direservasi". Sekarang
      // action_assign dipanggil juga di sini supaya begitu barang di-Approve
      // di SPB, reserved_quantity di Odoo langsung naik (kelihatan di kolom
      // Direservasi begitu odoo-pull-stock sync lagi). Kalau stoknya
      // kebetulan kosong/kurang, action_assign nggak error — cuma nggak
      // nge-reserve apa-apa (aman dibiarkan, bukan alasan buat gagalin
      // Approve di SPB).
      let reserveWarning: string | null = null;
      try {
        await rpc(uid, "stock.picking", "action_assign", [[pickingId]]);
      } catch (e) {
        // Tetap dianggap sukses (Approve-nya sendiri sudah kejadian) — tapi
        // pesannya dikirim balik ke SPB (bukan cuma masuk log server) supaya
        // kelihatan alasannya kalau reservasi gagal (mis. stok kosong/produk
        // di Odoo di-set consumable/dsb).
        reserveWarning = (e as Error).message;
        console.error("odoo-validate: action_assign gagal:", reserveWarning);
      }
      return json({ ok: true, state: "confirmed", reserveWarning });
    }

    if (state === "done") return json({ ok: true, already: true, state });

    // button_validate bisa mengembalikan `true` (langsung sukses) ATAU sebuah
    // dict aksi (mis. wizard konfirmasi backorder) yang butuh keputusan manual
    // di Odoo — di sini itu dianggap "belum benar-benar selesai", bukan error,
    // supaya pesannya jelas ke petugas kalau perlu cek Odoo langsung.
    const result = await rpc(uid, "stock.picking", "button_validate", [[pickingId]]);
    if (result === true) return json({ ok: true, state: "done" });

    return json({
      ok: false,
      needsManualStep: true,
      error: "Odoo meminta konfirmasi tambahan (mis. backorder) yang tidak bisa diselesaikan otomatis — buka Odoo untuk menyelesaikannya manual.",
    });
  } catch (err) {
    console.error("odoo-validate:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});