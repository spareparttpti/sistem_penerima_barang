-- ============================================================================
-- SUPABASE SCHEMA — SISTEM PENERIMAAN BARANG SPAREPART
-- Deliverable Backend Architect (round 2 of 3) — Full-Stack Guild
-- Terintegrasi dengan: Frontend React (Dashboard / Input 4-step / Detail & QC)
--                      + Teamly Webhook (lihat edge_teamly_webhook.sql)
--
-- Cara pakai:
--   1) Buka Supabase Dashboard -> SQL Editor -> paste & RUN (idempotent, aman dijalankan ulang)
--   2) Atau via CLI: supabase db push
--
-- Isi file:
--   A. Extensions
--   B. ENUM types
--   C. Tabel: roles, spareparts, penerimaan_barang, detail_penerimaan
--   D. Trigger created_at / updated_at
--   E. Index performance
--   F. Row Level Security (RLS) — roles khusus backend/service_role
--   G. Storage bucket 'proofs' + policy upload/read
--   H. Seed data roles + contoh sparepart
-- ============================================================================

-- ============================================================================
-- A. EXTENSIONS
-- ============================================================================
create extension if not exists "pgcrypto";    -- gen_random_uuid()
create extension if not exists "uuid-ossp";

-- ============================================================================
-- B. ENUM TYPES (idempotent — tidak error jika sudah ada)
-- ============================================================================
do $$ begin
  create type public.role_name as enum ('frontend','backend','devops','code_reviewer','gudang');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sparepart_category as enum ('Mesin','Elektrikal','Utility');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.receiving_status as enum ('Draft','In Inspection','Approved','Rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_condition as enum ('Baik','Rusak','Cacat');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- C. TABEL
-- ============================================================================

-- ---------------------------------------------------------------
-- C1. roles — daftar role tim + mapping ke Teamly user ID
--     ⚠️ RLS: tabel ini TIDAK punya policy untuk anon/authenticated.
--        Hanya service_role (backend / Edge Function) yang bisa baca/tulis.
-- ---------------------------------------------------------------
create table if not exists public.roles (
  id            uuid primary key default gen_random_uuid(),
  role_name     public.role_name not null unique,
  display_name  text not null,
  teamly_user_id text,               -- isi dengan Teamly user ID asli (mis. 'U123ABC')
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.roles is
  'Role tim -> Teamly user ID. Hanya boleh diakses service_role (backend), bukan frontend.';

-- ---------------------------------------------------------------
-- C2. spareparts — master data sparepart
-- ---------------------------------------------------------------
create table if not exists public.spareparts (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null unique check (sku <> ''),
  name        text not null check (name <> ''),
  category    public.sparepart_category not null default 'Mesin',
  unit        text not null default 'pcs',
  sales_price numeric not null default 0,  -- "Sales Price" produk di Odoo (list_price), ditarik odoo-pull-prices
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.spareparts is 'Master data sparepart (SKU unik, kategori Mesin/Elektrikal/Utility).';

-- ---------------------------------------------------------------
-- C3. penerimaan_barang — header transaksi penerimaan
-- ---------------------------------------------------------------
create table if not exists public.penerimaan_barang (
  id               uuid primary key default gen_random_uuid(),
  po_number        text not null check (po_number <> ''),
  wh_in_ref        text,               -- No transfer masuk Odoo (stock.picking.name), mis. 'WH/IN/00344'
                                       --   nullable: penerimaan tanpa acuan Odoo tetap boleh dicatat
  vendor_name      text not null check (vendor_name <> ''),
  receiver_name    text not null check (receiver_name <> ''),
  status           public.receiving_status not null default 'Draft',
  notes            text,
  proof_image_url  text,              -- public URL dari storage bucket 'proofs'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint penerimaan_status_check check (status in ('Draft','In Inspection','Approved','Rejected'))
);

-- `create table if not exists` di atas tidak menambah kolom pada tabel yang sudah ada,
-- jadi kolom Odoo ditambahkan terpisah agar skema ini tetap aman dijalankan ulang.
alter table public.penerimaan_barang add column if not exists wh_in_ref text;

-- Dua tanggal yang artinya berbeda dan tidak boleh tertukar:
--   order_date   = tanggal pemesanan / jadwal dari Odoo (sudah diketahui sejak PO dibuat)
--   arrival_date = tanggal barang benar-benar tiba di gudang (diisi petugas saat konfirmasi)
alter table public.penerimaan_barang add column if not exists order_date   date;
alter table public.penerimaan_barang add column if not exists arrival_date timestamptz;
alter table public.penerimaan_barang add column if not exists odoo_state   text;
alter table public.penerimaan_barang add column if not exists source       text not null default 'manual';
-- Tanda "favorit"/urgent di Dashboard — petugas bisa menandai PO yang perlu
-- diprioritaskan; baris favorit tampil paling atas.
alter table public.penerimaan_barang add column if not exists is_favorite  boolean not null default false;

-- Satu WH/IN hanya boleh punya satu baris penerimaan — kunci dedup saat import ulang.
-- Sengaja index PENUH (bukan partial `where wh_in_ref is not null`): upsert()
-- Supabase butuh index yang cocok PERSIS termasuk predicate-nya untuk bisa dipakai
-- sebagai target ON CONFLICT; index partial tidak akan cocok dengan upsert biasa.
-- NULL tetap aman berulang di banyak baris (penerimaan manual) karena constraint
-- unique standar tidak menganggap NULL = NULL.
drop index if exists uq_penerimaan_wh_in_ref;
create unique index if not exists uq_penerimaan_wh_in_ref
  on public.penerimaan_barang (wh_in_ref);

-- Antrean "menunggu kedatangan" adalah query tersering di dashboard
create index if not exists idx_penerimaan_draft
  on public.penerimaan_barang (order_date) where status = 'Draft';

create index if not exists idx_penerimaan_wh_in_ref
  on public.penerimaan_barang (wh_in_ref) where wh_in_ref is not null;

comment on column public.penerimaan_barang.wh_in_ref is
  'No transfer masuk Odoo (stock.picking.name), mis. WH/IN/00344. Dipakai mencocokkan barang datang dengan data Odoo.';

comment on table public.penerimaan_barang is
  'Header penerimaan barang. Alur status: Draft -> In Inspection -> Approved | Rejected.';

-- ---------------------------------------------------------------
-- C4. detail_penerimaan — detail item per penerimaan
-- ---------------------------------------------------------------
create table if not exists public.detail_penerimaan (
  id             uuid primary key default gen_random_uuid(),
  penerimaan_id  uuid not null references public.penerimaan_barang(id) on delete cascade,
  sparepart_id   uuid not null references public.spareparts(id) on delete restrict,
  -- numeric, BUKAN integer: qty dari Odoo bisa pecahan (satuan kg/liter/dst,
  -- mis. 5.76) — kolom integer akan menolak insert-nya dengan error tipe data.
  qty_received   numeric(14,3) not null default 0 check (qty_received >= 0),
  condition      public.item_condition not null default 'Baik',
  created_at     timestamptz not null default now(),
  unique (penerimaan_id, sparepart_id)
);

-- Item hasil import Odoo belum tentu ada padanannya di master `spareparts`,
-- jadi sparepart_id dilonggarkan menjadi nullable dan nama/SKU asli Odoo disimpan.
alter table public.detail_penerimaan alter column sparepart_id drop not null;
alter table public.detail_penerimaan add column if not exists product_name text;
alter table public.detail_penerimaan add column if not exists sku          text;
alter table public.detail_penerimaan add column if not exists qty_po       numeric(14,3) default 0;
-- Retrofit untuk database yang tabelnya sudah terlanjur dibuat dengan qty_received
-- bertipe integer (versi lama file ini) — qty dari Odoo bisa pecahan.
alter table public.detail_penerimaan alter column qty_received type numeric(14,3)
  using qty_received::numeric;
alter table public.detail_penerimaan add column if not exists uom          text;

-- Constraint unik lama memakai (penerimaan_id, sparepart_id); dengan sparepart_id
-- nullable, satu penerimaan bisa punya banyak item tak-terdaftar sekaligus.
alter table public.detail_penerimaan drop constraint if exists detail_penerimaan_penerimaan_id_sparepart_id_key;


comment on table public.detail_penerimaan is
  'Detail item per penerimaan: qty diterima + kondisi fisik (Baik/Rusak/Cacat).';

-- ============================================================================
-- D. TRIGGER created_at / updated_at
--    Task requirement: "trigger created_at default now()".
--    created_at di-set otomatis saat INSERT (default now() + trigger safety),
--    updated_at di-update otomatis saat UPDATE.
-- ============================================================================
create or replace function public.set_created_at()
returns trigger language plpgsql as $$
begin
  if NEW.created_at is null then
    NEW.created_at := now();
  end if;
  return NEW;
end $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  NEW.updated_at := now();
  return NEW;
end $$;

drop trigger if exists trg_roles_created_at  on public.roles;
create trigger trg_roles_created_at before insert on public.roles
  for each row execute function public.set_created_at();

drop trigger if exists trg_roles_updated_at  on public.roles;
create trigger trg_roles_updated_at before update on public.roles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_spareparts_created_at on public.spareparts;
create trigger trg_spareparts_created_at before insert on public.spareparts
  for each row execute function public.set_created_at();

drop trigger if exists trg_spareparts_updated_at on public.spareparts;
create trigger trg_spareparts_updated_at before update on public.spareparts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_penerimaan_created_at on public.penerimaan_barang;
create trigger trg_penerimaan_created_at before insert on public.penerimaan_barang
  for each row execute function public.set_created_at();

drop trigger if exists trg_penerimaan_updated_at on public.penerimaan_barang;
create trigger trg_penerimaan_updated_at before update on public.penerimaan_barang
  for each row execute function public.set_updated_at();

drop trigger if exists trg_detail_created_at on public.detail_penerimaan;
create trigger trg_detail_created_at before insert on public.detail_penerimaan
  for each row execute function public.set_created_at();

-- ============================================================================
-- E. INDEXES (performance)
-- ============================================================================
-- penerimaan_barang: dashboard disaring by date, status, PO, vendor
create index if not exists idx_penerimaan_created_at on public.penerimaan_barang (created_at desc);
create index if not exists idx_penerimaan_status    on public.penerimaan_barang (status);
create index if not exists idx_penerimaan_po_number on public.penerimaan_barang (po_number);
create index if not exists idx_penerimaan_vendor    on public.penerimaan_barang (vendor_name);
-- partial index: hanya record aktif
create index if not exists idx_penerimaan_status_active
  on public.penerimaan_barang (status) where status <> 'Draft';

-- detail_penerimaan: lookup by header & by sparepart
create index if not exists idx_detail_penerimaan_id  on public.detail_penerimaan (penerimaan_id);
create index if not exists idx_detail_sparepart_id   on public.detail_penerimaan (sparepart_id);

-- spareparts: pencarian cepat by SKU & kategori
create index if not exists idx_spareparts_sku      on public.spareparts (sku);
create index if not exists idx_spareparts_category on public.spareparts (category) where is_active = true;

-- ============================================================================
-- F. ROW LEVEL SECURITY (RLS)
--    Penerimaan/Detail/Spareparts: authenticated boleh SELECT/INSERT/UPDATE (sesuai task).
--    roles: TIDAK ADA policy -> anon & authenticated DITOLAK; hanya service_role
--    (backend / Edge Function) yang bisa mengakses karena service_role bypass RLS.
-- ============================================================================

-- F1. roles — backend only (service_role)
alter table public.roles enable row level security;
-- ❌ TIDAK ada policy untuk authenticated / anon.
-- ✅ Backend pakai service_role key -> otomatis bypass RLS.
-- ✅ Defense-in-depth: helper function khusus service_role di bawah (F5).

-- F2. spareparts
alter table public.spareparts enable row level security;
drop policy if exists "spareparts_select_auth" on public.spareparts;
create policy "spareparts_select_auth" on public.spareparts
  for select to authenticated using (true);
drop policy if exists "spareparts_insert_auth" on public.spareparts;
create policy "spareparts_insert_auth" on public.spareparts
  for insert to authenticated with check (true);
drop policy if exists "spareparts_update_auth" on public.spareparts;
create policy "spareparts_update_auth" on public.spareparts
  for update to authenticated using (true) with check (true);

-- F3. penerimaan_barang
alter table public.penerimaan_barang enable row level security;
drop policy if exists "penerimaan_select_auth" on public.penerimaan_barang;
create policy "penerimaan_select_auth" on public.penerimaan_barang
  for select to authenticated using (true);
drop policy if exists "penerimaan_insert_auth" on public.penerimaan_barang;
create policy "penerimaan_insert_auth" on public.penerimaan_barang
  for insert to authenticated with check (true);
drop policy if exists "penerimaan_update_auth" on public.penerimaan_barang;
create policy "penerimaan_update_auth" on public.penerimaan_barang
  for update to authenticated using (true) with check (true);

-- F4. detail_penerimaan
alter table public.detail_penerimaan enable row level security;
drop policy if exists "detail_select_auth" on public.detail_penerimaan;
create policy "detail_select_auth" on public.detail_penerimaan
  for select to authenticated using (true);
drop policy if exists "detail_insert_auth" on public.detail_penerimaan;
create policy "detail_insert_auth" on public.detail_penerimaan
  for insert to authenticated with check (true);
drop policy if exists "detail_update_auth" on public.detail_penerimaan;
create policy "detail_update_auth" on public.detail_penerimaan
  for update to authenticated using (true) with check (true);

-- F5. Helper khusus backend: baca roles (hanya service_role boleh execute)
create or replace function public.get_teamly_roles()
returns table (role_name public.role_name, display_name text, teamly_user_id text)
language sql security definer set search_path = public as $$
  select r.role_name, r.display_name, r.teamly_user_id
  from public.roles r
  order by r.role_name;
$$;

revoke all on function public.get_teamly_roles() from public, anon, authenticated;
grant execute on function public.get_teamly_roles() to service_role;

-- ============================================================================
-- G. STORAGE — bucket 'proofs' + policy upload/read
--    Bucket dibuat PUBLIC agar proof_image_url bisa langsung dipakai di <img src>.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', true, 5242880, array['image/png','image/jpeg','image/webp','application/pdf'])
on conflict (id) do update set public = true, file_size_limit = 5242880;

-- read: publik (foto bukti tampil di halaman detail) — batasi hanya bucket proofs
drop policy if exists "proofs_select_public" on storage.objects;
create policy "proofs_select_public" on storage.objects
  for select using (bucket_id = 'proofs');

-- upload: hanya user authenticated, path harus diawali penerimaan/
drop policy if exists "proofs_insert_auth" on storage.objects;
create policy "proofs_insert_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'proofs' and (storage.foldername(name))[1] = 'penerimaan');

-- update/delete: hanya authenticated untuk bucket proofs
drop policy if exists "proofs_update_auth" on storage.objects;
create policy "proofs_update_auth" on storage.objects
  for update to authenticated using (bucket_id = 'proofs') with check (bucket_id = 'proofs');

drop policy if exists "proofs_delete_auth" on storage.objects;
create policy "proofs_delete_auth" on storage.objects
  for delete to authenticated using (bucket_id = 'proofs');

-- ============================================================================
-- H. SEED DATA
-- ============================================================================

-- H1. roles — teamly_user_id: GANTI dengan Teamly user ID asli (format <@ID> dipakai payload)
insert into public.roles (role_name, display_name, teamly_user_id) values
  ('frontend',     'Frontend Developer', null),
  ('backend',      'Backend Architect',  null),
  ('devops',       'DevOps Automator',   null),
  ('code_reviewer','Code Reviewer',      null),
  ('gudang',       'Warehouse Team',     null)
on conflict (role_name) do nothing;

-- H2. contoh master sparepart (opsional — bisa dihapus)
insert into public.spareparts (sku, name, category, unit) values
  ('SP-0001', 'Bearing 6204-2RS', 'Mesin',      'pcs'),
  ('SP-0002', 'V-Belt A-50',      'Mesin',      'pcs'),
  ('SP-0003', 'Motor Fan 1.5kW',  'Elektrikal', 'unit'),
  ('SP-0004', 'Contactor 32A',    'Elektrikal', 'pcs'),
  ('SP-0005', 'Safety Helmet',    'Utility',    'pcs')
on conflict (sku) do nothing;

-- ============================================================================
-- VERIFIKASI CEPAT (jalankan setelah script di atas sukses)
-- ============================================================================
-- select table_name from information_schema.tables where table_schema='public' order by 1;
-- select rolname from pg_roles where rolname in ('anon','authenticated','service_role');
-- select * from public.roles; -- HARUS kosong/ditolak untuk anon/authenticated, terlihat utk service_role
-- select * from storage.buckets where id='proofs';
