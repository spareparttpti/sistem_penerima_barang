-- ============================================================================
-- EDGE FUNCTION + TRIGGER — TEAMLY WEBHOOK NOTIFICATION
-- SISTEM PENERIMAAN BARANG SPAREPART
-- Deliverable Backend Architect (round 2 of 3) — Full-Stack Guild
--
-- Isi file:
--   SECTION 1: Supabase Edge Function `teamly-webhook` (Deno/TypeScript)
--              - Payload generator konsisten dgn lib/teamly.js (Frontend)
--              - Auto tagging: UI/Upload -> @Frontend Developer
--                              DB/Stok   -> @Backend Architect
--                              Server/API -> @DevOps Automator
--                              Approval  -> @Code Reviewer
--              - Baca teamly_user_id dari tabel roles (service_role only)
--   SECTION 2: SQL trigger otomatis -> kirim notifikasi saat status berubah
--              (pakai pg_net; fallback manual: panggil Edge Function via fetch)
--   SECTION 3: config.toml (deploy)
--   SECTION 4: Contoh test curl
-- ============================================================================

-- ============================================================================
-- SECTION 1 — SUPABASE EDGE FUNCTION: teamly-webhook
-- ----------------------------------------------------------------------------
-- Deploy:
--   1) Buat folder: supabase/functions/teamly-webhook/index.ts
--   2) Isi index.ts dengan kode di bawah
--   3) Set secrets:
--        supabase secrets set TEAMLY_WEBHOOK_URL=https://webhook.teamly.app/xxx
--        supabase secrets set SUPABASE_URL=https://<ref>.supabase.co
--        supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
--   4) Deploy:
--        supabase functions deploy teamly-webhook --no-verify-jwt
--      (--no-verify-jwt agar bisa dipanggil DB trigger; gunakan header x-api-key
--       opsional sebagai proteksi tambahan)
--
-- Endpoint: POST https://<ref>.supabase.co/functions/v1/teamly-webhook
-- Body:     { "status": "Rejected", "record": { "id": "...", "po_number": "PO-1",
--             "vendor_name": "...", "notes": "..." },
--             "trigger": "db", "triggerReason": "Stok minus / QC action" }
-- ============================================================================

/*
import { createClient } from "jsr:@supabase/supabase-js@2";

const TEAMLY_WEBHOOK_URL = Deno.env.get("TEAMLY_WEBHOOK_URL")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_KEY = Deno.env.get("API_KEY") ?? null; // opsional: proteksi tambahan

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// --- ROLE -> mention, konsisten dengan lib/teamly.js (Frontend) ---------------
type RoleKey = "frontend" | "backend" | "devops" | "reviewer";
const ROLE_TAGS: Record<RoleKey, { label: string }> = {
  frontend: { label: "Frontend Developer" },
  backend:  { label: "Backend Architect" },
  devops:   { label: "DevOps Automator" },
  reviewer: { label: "Code Reviewer" },
};

const TRIGGER_ROLE: Record<string, RoleKey> = {
  ui:     "frontend",
  db:     "backend",
  server: "devops",
  review: "reviewer",
};

// Muat teamly_user_id dari tabel roles (service_role -> bypass RLS)
let roleMentions: Record<RoleKey, string> | null = null;
async function getMentions(): Promise<Record<RoleKey, string>> {
  if (roleMentions) return roleMentions;
  const { data, error } = await supabase
    .from("roles")
    .select("role_name, teamly_user_id")
    .not("teamly_user_id", "is", null);
  if (error) throw new Error(`roles fetch: ${error.message}`);
  const map: Record<string, string> = {
    frontend: "<@teamly_frontend_id>",
    backend:  "<@teamly_backend_id>",
    devops:   "<@teamly_devops_id>",
    reviewer: "<@teamly_code_reviewer>",
  };
  for (const r of data ?? []) {
    if (r.teamly_user_id) {
      const key = r.role_name === "code_reviewer" ? "reviewer" : r.role_name;
      if (key in map) map[key] = `<@${r.teamly_user_id}>`;
    }
  }
  roleMentions = map as Record<RoleKey, string>;
  return roleMentions!;
}

// --- Payload generator (sama persis dengan lib/teamly.js) ---------------------
export async function buildTeamlyPayload(args: {
  status: string;
  record: Record<string, unknown>;
  trigger?: string;
  triggerReason?: string;
}) {
  const { status, record, trigger, triggerReason } = args;
  const mentions = await getMentions();
  const lines: string[] = [];
  lines.push(`🚨 **[ALERTA PENERIMAAN BARANG - STATUS: ${status.toUpperCase()}]**`);
  lines.push("");
  lines.push(`📌 **No PO:** #${record.po_number ?? "-"}`);
  lines.push(`🏭 **Vendor:** ${record.vendor_name ?? "-"}`);
  lines.push(`📦 **Catatan:** ${record.notes || "-"}`);
  if (trigger && triggerReason) lines.push(`🔎 **Trigger:** ${triggerReason}`);
  lines.push("");
  lines.push("👉 **Perhatian Tim:**");

  if (status === "Rejected" || status === "In Inspection" || trigger) {
    const added = new Set<string>();
    const add = (role: RoleKey, msg: string) => {
      if (added.has(role)) return;
      added.add(role);
      lines.push(`- ${mentions[role]} ${msg}`);
    };
    if (trigger === "ui" || status === "In Inspection") {
      add("frontend", "Cek kelengkapan bukti foto fisik penerimaan.");
    }
    if (trigger === "db" || status === "Rejected") {
      add("backend", "Mohon verifikasi penyesuaian data stok.");
    }
    if (trigger === "server") add("devops", "Pastikan log server & webhook berjalan lancar.");
    if (trigger === "review") add("reviewer", "Membutuhkan masukan/verifikasi lanjutan.");
  }

  return {
    text: lines.join("\n"),
    status,
    trigger: trigger ?? null,
    recordId: record.id ?? null,
    ts: new Date().toISOString(),
  };
}

// --- Handler ----------------------------------------------------------------
Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Proteksi tambahan opsional (jika set API_KEY)
  if (API_KEY && req.headers.get("x-api-key") !== API_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();

    // Mode 1: panggilan langsung { status, record, trigger?, triggerReason? }
    if (body.status && body.record) {
      const payload = await buildTeamlyPayload({
        status: body.status,
        record: body.record,
        trigger: body.trigger,
        triggerReason: body.triggerReason,
      });
      const res = await fetch(TEAMLY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload.text }),
      });
      if (!res.ok) throw new Error(`Teamly webhook ${res.status}`);
      return new Response(JSON.stringify({ ok: true, payload }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Mode 2: Supabase Database Webhook (type INSERT/UPDATE dari tabel)
    //   { type, table, record, old_record, ... }
    if (body.type && body.record) {
      const rec = body.record;
      const status: string = rec.status ?? "Draft";
      // Peta trigger otomatis dari perubahan status (default Frontend)
      const triggerMap: Record<string, string> = {
        "In Inspection": "ui",   // barang masuk -> cek foto fisik
        "Approved":      "review", // lolos QC -> verifikasi reviewer
        "Rejected":      "db",   // ditolak -> verifikasi stok
      };
      const trigger = triggerMap[status] ?? null;
      const payload = await buildTeamlyPayload({
        status,
        record: rec,
        trigger,
        triggerReason: `Status berubah via ${body.type} (tabel ${body.table})`,
      });
      const res = await fetch(TEAMLY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload.text }),
      });
      if (!res.ok) throw new Error(`Teamly webhook ${res.status}`);
      return new Response(JSON.stringify({ ok: true, payload }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "invalid payload" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
*/

-- ============================================================================
-- SECTION 2 — SQL TRIGGER OTOMATIS (notifikasi saat status berubah)
--   Memakai ekstensi pg_net (HTTP request async dari Postgres).
--   Setelah deploy Edge Function, jalankan bagian ini di SQL Editor.
-- ============================================================================

create extension if not exists pg_net;

-- Fungsi: kirim notifikasi Teamly setiap kali status penerimaan_barang berubah
-- (INSERT -> In Inspection, UPDATE -> Approved/Rejected), lalu catat log.
create or replace function public.notify_teamly_on_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status  text := NEW.status::text;
  v_trigger text;
  v_reason  text;
  v_payload jsonb;
  v_edge_url text := current_setting('app.settings.edge_url', true);  -- ex: https://<ref>.supabase.co/functions/v1/teamly-webhook
  v_api_key  text := current_setting('app.settings.edge_api_key', true);
begin
  -- hanya kirim untuk status yang memicu alert
  if v_status = 'Draft' then
    return NEW;
  end if;

  if v_status = 'In Inspection' then
    v_trigger := 'ui';
    v_reason  := 'Barang tiba, menunggu inspeksi fisik.';
  elsif v_status = 'Approved' then
    v_trigger := 'review';
    v_reason  := 'QC action: penerimaan disetujui.';
  elsif v_status = 'Rejected' then
    v_trigger := 'db';
    v_reason  := 'QC action: barang ditolak / sebagian diterima.';
  else
    v_trigger := 'server';
    v_reason  := 'Status tidak dikenal, cek log server.';
  end if;

  v_payload := jsonb_build_object(
    'status', v_status,
    'record', jsonb_build_object(
      'id',           NEW.id,
      'po_number',    NEW.po_number,
      'vendor_name',  NEW.vendor_name,
      'notes',        NEW.notes
    ),
    'trigger',        v_trigger,
    'triggerReason',  v_reason
  );

  if v_edge_url is not null and v_edge_url <> '' then
    perform net.http_post(
      url := v_edge_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-api-key', coalesce(v_api_key, '')
      ),
      body := v_payload
    );
  end if;

  -- Audit log (opsional)
  insert into public.teamly_notification_log (penerimaan_id, status, trigger, reason, payload)
  values (NEW.id, v_status, v_trigger, v_reason, v_payload);

  return NEW;
end;
$$;

-- Tabel audit log notifikasi
create table if not exists public.teamly_notification_log (
  id            bigint generated always as identity primary key,
  penerimaan_id uuid,
  status        text,
  trigger       text,
  reason        text,
  payload       jsonb,
  sent_at       timestamptz not null default now()
);

alter table public.teamly_notification_log enable row level security;
-- Hanya backend (service_role) yang boleh baca log notifikasi
-- (tidak ada policy untuk authenticated -> frontend tidak bisa lihat).

-- Trigger pada penerimaan_barang
drop trigger if exists trg_penerimaan_teamly_notify on public.penerimaan_barang;
create trigger trg_penerimaan_teamly_notify
  after insert or update of status on public.penerimaan_barang
  for each row execute function public.notify_teamly_on_status_change();

-- Konfigurasi (GANTI dengan nilai project Anda, jalankan SEKALI):
-- select set_config('app.settings.edge_url', 'https://<ref>.supabase.co/functions/v1/teamly-webhook', false);
-- select set_config('app.settings.edge_api_key', '<API_KEY_optional>', false);

-- ============================================================================
-- SECTION 3 — supabase/config.toml (tambahkan di bawah [functions.teamly-webhook])
-- ============================================================================
-- [functions.teamly-webhook]
-- verify_jwt = false

-- ============================================================================
-- SECTION 4 — CONTOH TEST
-- ============================================================================
-- 1) Langsung ke Edge Function:
--    curl -X POST https://<ref>.supabase.co/functions/v1/teamly-webhook \
--      -H "Authorization: Bearer <anon_key>" \
--      -H "Content-Type: application/json" \
--      -d '{"status":"Rejected","record":{"id":"00000000-0000-0000-0000-000000000001","po_number":"PO-9923","vendor_name":"PT Sukses Teknik","notes":"Barang rusak 2 pcs"},"trigger":"db","triggerReason":"QC action"}'
--
-- 2) Simulasi DB trigger (status berubah ke Rejected):
--    update public.penerimaan_barang
--       set status = 'Rejected', notes = 'QC: rusak 2 pcs'
--     where id = '<id_penerimaan>';
--    -- cek log:
--    select * from public.teamly_notification_log order by sent_at desc limit 5;
