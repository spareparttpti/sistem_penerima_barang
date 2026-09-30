-- Stok Barang — snapshot qty_on_hand SEMUA produk dari Odoo (stock.quant di
-- lokasi WH/Stok), ditarik berkala lewat cron (sama pola dengan
-- wh_out_schema.sql). Read-only dari sisi SPB: tabel ini cuma dibaca/ditimpa
-- oleh Edge Function odoo-pull-stock, user tidak pernah insert/update manual
-- dari UI.
--
-- category: 'ATK' (SKU diawali "ATK") vs 'Lainnya' (semua produk lain) —
-- dipakai buat toggle "Barang ATK" / "Semua Barang" di halaman Stok Barang.

create table if not exists public.stok_barang (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  product_name text not null default '-',
  uom text not null default 'Pcs',
  category text not null default 'Lainnya' check (category in ('ATK', 'Lainnya')),
  qty_on_hand numeric not null default 0,
  qty_reserved numeric not null default 0,
  qty_available numeric not null default 0,
  sales_price numeric not null default 0,  -- "Sales Price" produk di Odoo (list_price)
  location_name text,
  odoo_product_id integer,
  updated_at timestamptz not null default now()
);
alter table public.stok_barang add column if not exists category text not null default 'Lainnya';
create index if not exists idx_stok_barang_category on public.stok_barang(category);

-- qty_incoming — dari field bawaan Odoo product.product.incoming_qty (jumlah
-- barang yang lagi "di jalan" dari Purchase Order yang udah confirm tapi
-- belum diterima). SEKADAR informasi buat sekarang — belum ada fitur PO
-- sendiri di SPB (nanti dijelaskan/dibahas terpisah), kolom ini cuma
-- nampilin apa yang Odoo udah tau.
alter table public.stok_barang add column if not exists qty_incoming numeric not null default 0;

-- odoo_category — path kategori ASLI dari Odoo (product.product.categ_id,
-- display_name-nya sudah berbentuk "Induk / Anak / Cucu" bawaan Odoo),
-- BEDA dari `category` di atas (yang cuma label buatan sendiri ATK/Lainnya
-- dari awalan SKU). Dipakai modul Spinning buat filter "category contains
-- Spinning/PLKUM/PLKEL" — persis pola filter yang sama dipakai admin
-- langsung di Odoo (Product Category contains ...).
alter table public.stok_barang add column if not exists odoo_category text;
create index if not exists idx_stok_barang_odoo_category on public.stok_barang(odoo_category);
notify pgrst, 'reload schema';

alter table public.stok_barang enable row level security;

-- DROP dulu tiap policy — biar file ini aman dijalankan ulang berkali-kali
-- (dulu langsung CREATE tanpa DROP, jadi meledak "policy already exists"
-- begitu di-run lebih dari sekali).
drop policy if exists "stok_barang_select" on public.stok_barang;
create policy "stok_barang_select" on public.stok_barang
  for select to authenticated using (true);
drop policy if exists "stok_barang_insert" on public.stok_barang;
create policy "stok_barang_insert" on public.stok_barang
  for insert to authenticated with check (true);
drop policy if exists "stok_barang_update" on public.stok_barang;
create policy "stok_barang_update" on public.stok_barang
  for update to authenticated using (true);

-- =========================================================
-- satuan_odoo — Master Satuan (Unit of Measure), ditarik dari Odoo (uom.uom)
-- lewat Edge Function odoo-pull-uom. Digabung di file yang sama dengan
-- stok_barang (bukan file terpisah) karena sama-sama "produk/inventory dari
-- Odoo" — read-only dari sisi SPB, cuma dibaca/ditimpa Edge Function.
-- Dipakai halaman "Master Satuan" role Spinning (spinningMaster.js).
-- =========================================================
create table if not exists public.satuan_odoo (
  id          uuid primary key default gen_random_uuid(),
  odoo_id     integer not null unique,
  name        text not null,          -- nama satuan persis dari Odoo, mis. "Pcs", "Kg", "Meter"
  category    text,                   -- kategori Odoo, mis. "Unit", "Weight", "Length / Distance"
  uom_type    text,                   -- 'reference' | 'bigger' | 'smaller' (bawaan Odoo)
  active      boolean not null default true, -- status aktif/nonaktif dari Odoo
  updated_at  timestamptz not null default now()
);
create index if not exists idx_satuan_odoo_category on public.satuan_odoo(category);
create index if not exists idx_satuan_odoo_active on public.satuan_odoo(active);
notify pgrst, 'reload schema';

alter table public.satuan_odoo enable row level security;
drop policy if exists "satuan_odoo select" on public.satuan_odoo;
create policy "satuan_odoo select" on public.satuan_odoo for select to authenticated using (true);
drop policy if exists "satuan_odoo insert" on public.satuan_odoo;
create policy "satuan_odoo insert" on public.satuan_odoo for insert to authenticated with check (true);
drop policy if exists "satuan_odoo update" on public.satuan_odoo;
create policy "satuan_odoo update" on public.satuan_odoo for update to authenticated using (true);

-- =========================================================
-- role_inventory_access — aturan "role X boleh lihat produk apa saja" di
-- stok_barang, dikelola Admin Gudang lewat halaman Manajemen Pengguna
-- (users.js), BUKAN di-hardcode di kode (dulu SPINNING_STOK_CATEGORIES
-- ditulis langsung di spinningMaster.js). Dipakai pertama kali buat role
-- 'spinning', tapi kolom `role` sengaja generik biar role lain nanti bisa
-- ikut pola yang sama tanpa tabel baru.
--
-- match_type='category'   -> match_value dicocokkan "contains" ke
--                             stok_barang.odoo_category (case-insensitive)
-- match_type='sku_prefix' -> match_value dicocokkan "starts with" ke
--                             stok_barang.sku (case-insensitive)
-- =========================================================
create table if not exists public.role_inventory_access (
  id          uuid primary key default gen_random_uuid(),
  role        text not null,
  match_type  text not null check (match_type in ('category', 'sku_prefix')),
  match_value text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_role_inventory_access_role on public.role_inventory_access(role);
create unique index if not exists idx_role_inventory_access_unique on public.role_inventory_access(role, match_type, lower(match_value));

alter table public.role_inventory_access enable row level security;
drop policy if exists "role_inventory_access select" on public.role_inventory_access;
create policy "role_inventory_access select" on public.role_inventory_access for select to authenticated using (true);
drop policy if exists "role_inventory_access insert" on public.role_inventory_access;
create policy "role_inventory_access insert" on public.role_inventory_access for insert to authenticated with check (true);
drop policy if exists "role_inventory_access delete" on public.role_inventory_access;
create policy "role_inventory_access delete" on public.role_inventory_access for delete to authenticated using (true);

-- Seed 3 rule bawaan biar Spinning nggak mendadak kosong pas fitur ini
-- pertama kali dinyalakan (persis nilai SPINNING_STOK_CATEGORIES lama).
insert into public.role_inventory_access (role, match_type, match_value, created_by)
values
  ('spinning', 'category', 'Spinning', 'system'),
  ('spinning', 'category', 'PLKUM', 'system'),
  ('spinning', 'category', 'PLKEL', 'system')
on conflict (role, match_type, lower(match_value)) do nothing;

notify pgrst, 'reload schema';
