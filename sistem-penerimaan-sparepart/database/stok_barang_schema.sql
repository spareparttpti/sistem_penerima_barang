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

alter table public.stok_barang enable row level security;

create policy "stok_barang_select" on public.stok_barang
  for select to authenticated using (true);
create policy "stok_barang_insert" on public.stok_barang
  for insert to authenticated with check (true);
create policy "stok_barang_update" on public.stok_barang
  for update to authenticated using (true);
