-- ============================================================================
-- INTEGRASI ODOO → SPB
-- Tabel penampung data Receipts (stock.picking, tipe incoming) dari Odoo.
--
-- Diisi oleh Edge Function `odoo-webhook` (service_role), dibaca oleh frontend
-- (anon) saat petugas mencari No WH/IN ketika barang datang.
--
-- Jalankan di Supabase → SQL Editor. Idempotent, aman dijalankan ulang.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Header transfer masuk
--    Kunci utama = wh_in_ref (nomor WH/IN). Nomor ini unik di Odoo dan itulah
--    yang dibaca petugas dari surat jalan, jadi lebih berguna sebagai kunci
--    daripada UUID buatan sendiri.
-- ---------------------------------------------------------------------------
create table if not exists public.odoo_receipts (
  wh_in_ref       text primary key check (wh_in_ref <> ''),
  odoo_picking_id integer unique,     -- stock.picking id di Odoo, untuk penelusuran balik
  contact         text,               -- partner_id — nama vendor
  origin          text,               -- Source Document — No PO
  scheduled_date  date,
  state           text,               -- Draft | Waiting | Ready | Done | Cancelled
  location_from   text,
  location_to     text,
  batch           text,
  synced_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

comment on table public.odoo_receipts is
  'Cermin data Receipts (WH/IN) dari Odoo. Hanya baca — SPB tidak pernah menulis balik ke Odoo.';

-- ---------------------------------------------------------------------------
-- 2. Baris item per transfer
--    on delete cascade: saat webhook memperbarui satu WH/IN, baris lama dihapus
--    lalu ditulis ulang — lebih sederhana dan selalu konsisten dengan Odoo
--    dibanding mencoba mencocokkan baris satu per satu.
-- ---------------------------------------------------------------------------
create table if not exists public.odoo_receipt_lines (
  id          bigint generated always as identity primary key,
  wh_in_ref   text not null references public.odoo_receipts(wh_in_ref) on delete cascade,
  product     text,
  sku         text,
  qty_po      numeric(14,3) not null default 0,
  uom         text default 'pcs'
);

create index if not exists idx_odoo_lines_ref on public.odoo_receipt_lines (wh_in_ref);

-- Pencarian petugas: berdasarkan No PO atau nama vendor
create index if not exists idx_odoo_receipts_origin  on public.odoo_receipts (origin);
create index if not exists idx_odoo_receipts_contact on public.odoo_receipts (contact);

-- Daftar pencarian menyembunyikan Done/Cancelled, jadi index parsial ini yang
-- benar-benar terpakai saat menampilkan WH/IN yang masih terbuka.
create index if not exists idx_odoo_receipts_open
  on public.odoo_receipts (scheduled_date desc)
  where state not in ('Done', 'Cancelled');

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
--    Frontend memakai anon key, jadi anon perlu SELECT. Tulis hanya oleh
--    service_role (Edge Function) — anon tidak boleh mengubah cermin data Odoo.
--    Catatan: data ini berisi nama vendor & No PO. Kalau aplikasi nanti dibuka
--    ke publik, ganti policy anon di bawah menjadi `to authenticated`.
-- ---------------------------------------------------------------------------
alter table public.odoo_receipts      enable row level security;
alter table public.odoo_receipt_lines enable row level security;

drop policy if exists odoo_receipts_read on public.odoo_receipts;
create policy odoo_receipts_read on public.odoo_receipts
  for select to anon, authenticated using (true);

drop policy if exists odoo_lines_read on public.odoo_receipt_lines;
create policy odoo_lines_read on public.odoo_receipt_lines
  for select to anon, authenticated using (true);

-- Tidak ada policy insert/update/delete → hanya service_role yang bisa menulis.

-- ---------------------------------------------------------------------------
-- 4. Verifikasi cepat setelah webhook pertama masuk
-- ---------------------------------------------------------------------------
-- select r.wh_in_ref, r.contact, r.origin, r.state, r.scheduled_date,
--        count(l.id) as jml_item
--   from public.odoo_receipts r
--   left join public.odoo_receipt_lines l using (wh_in_ref)
--  group by r.wh_in_ref, r.contact, r.origin, r.state, r.scheduled_date
--  order by r.synced_at desc
--  limit 20;
