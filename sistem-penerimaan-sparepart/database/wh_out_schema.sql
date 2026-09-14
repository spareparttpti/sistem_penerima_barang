-- =========================================================
-- SPB · wh_out_schema.sql
-- Skema WH/OUT (pengeluaran barang ATK) — struktur & pola RLS SENGAJA dibuat
-- mirip penerimaan_barang/detail_penerimaan (lihat supabase_schema.sql) supaya
-- konsisten dan reuse cara kerja yang sudah terbukti jalan di WH/IN:
--   status internal:  Draft -> In Inspection -> Approved / Rejected
--   odoo_state:       Draft/Waiting/Ready/Done/Cancelled (dari Odoo, read-only)
--   source:           selalu 'odoo' (ditarik otomatis, sama seperti odoo-pull)
--
-- Tambahan yang TIDAK ada di WH/IN:
--   - employee_name/department/sub_divisi : siapa yang mengambil barang di Odoo
--   - detail_pengeluaran.qty_actual        : qty yang benar-benar dikeluarkan
--   - distribusi_pengeluaran               : rincian "barang untuk siapa saja"
--     yang diisi manual oleh yang mengambil, SETELAH status Approved
--   - karyawan                             : master nama karyawan, ditarik dari
--     Odoo (hr.employee) lewat odoo-pull-employees, dipakai sebagai sumber
--     autocomplete di form distribusi
-- =========================================================

-- ---------------------------------------------------------------------------
-- A. pengeluaran_barang (header WH/OUT)
-- ---------------------------------------------------------------------------
create table if not exists public.pengeluaran_barang (
  id              uuid primary key default gen_random_uuid(),
  wh_out_ref      text unique not null check (wh_out_ref <> ''),
  source_document text,                 -- Source Document di Odoo (kalau ada)
  employee_name   text,                 -- "Delivery Address" / yang mengambil barang
  department      text,                 -- Department di Odoo
  sub_divisi      text,                 -- "Sub Divisi Pemakaian" (custom field Odoo)
  receiver_name   text not null default '-',  -- petugas SPB yang memproses (mirip WH/IN)
  status          text not null default 'Draft'
                    check (status in ('Draft','In Inspection','Approved','Rejected')),
  notes           text,
  order_date      date,                 -- scheduled_date dari Odoo
  arrival_date    timestamptz,          -- kapan ditandai "barang sudah datang" di SPB
  odoo_state      text,                 -- Draft/Waiting/Ready/Done/Cancelled (read-only)
  odoo_picking_id integer,
  source          text not null default 'odoo',
  is_favorite     boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_pengeluaran_status on public.pengeluaran_barang(status);
create index if not exists idx_pengeluaran_odoo_picking on public.pengeluaran_barang(odoo_picking_id);

drop trigger if exists trg_pengeluaran_updated_at on public.pengeluaran_barang;
create trigger trg_pengeluaran_updated_at before update on public.pengeluaran_barang
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- B. detail_pengeluaran (item per WH/OUT — cuma baris yang SKU-nya "ATK*")
-- ---------------------------------------------------------------------------
create table if not exists public.detail_pengeluaran (
  id             uuid primary key default gen_random_uuid(),
  pengeluaran_id uuid not null references public.pengeluaran_barang(id) on delete cascade,
  sparepart_id   uuid references public.spareparts(id),  -- null kalau belum ada di master
  product_name   text,
  sku            text,
  uom            text,
  qty_demand     numeric(14,3) not null default 0,   -- diminta di Odoo
  qty_actual     numeric(14,3) not null default 0,   -- benar-benar dikeluarkan (default = qty_demand)
  created_at     timestamptz not null default now()
);
create index if not exists idx_detail_pengeluaran_parent on public.detail_pengeluaran(pengeluaran_id);

-- ---------------------------------------------------------------------------
-- C. karyawan (master nama, ditarik dari Odoo hr.employee)
-- ---------------------------------------------------------------------------
create table if not exists public.karyawan (
  id               uuid primary key default gen_random_uuid(),
  odoo_employee_id integer unique,
  name             text not null,
  department       text,
  active           boolean not null default true,
  updated_at       timestamptz not null default now()
);
create index if not exists idx_karyawan_active on public.karyawan(active);
create index if not exists idx_karyawan_name on public.karyawan(lower(name));

-- nip & jabatan — ditambah belakangan, ditarik dari field bawaan Odoo
-- hr.employee (identification_id -> nip, job_title -> jabatan) lewat
-- odoo-pull-employees. Dipakai buat autocomplete di form Distribusi WH/OUT
-- (halaman ini) SEKALIGUS form Permintaan Barang (lihat pesanan_schema.sql)
-- — satu sumber data karyawan buat dua-duanya, nggak dobel kelola.
alter table public.karyawan add column if not exists nip text;
alter table public.karyawan add column if not exists jabatan text;

-- bagian & shift — ditambah lagi belakangan, SEKARANG sumber datanya udah
-- ganti dari Odoo ke Google Sheet (lihat sheet-pull-employees), sheet-nya
-- punya kolom BAGIAN & SHIFT terpisah dari DIVISI/SUB, jadi disimpan sebagai
-- kolom sendiri (bukan digabung ke "department") biar bisa ditampilkan apa
-- adanya di tabel Karyawan.
alter table public.karyawan add column if not exists bagian text;
alter table public.karyawan add column if not exists shift text;

-- WIPE BERSIH (SEKALI JALAN) — percobaan "gabung-gabungin" data lama (dari
-- Odoo/tab MASTER) sama data baru (dari tab DATA INDEX) ternyata tetap
-- berantakan (masih dobel, masih ada sisa "* :"). Solusinya bukan digabung
-- lagi, tapi dikosongin total terus di-sync ULANG MURNI dari DATA INDEX —
-- itu SATU-SATUNYA sumber sekarang (Odoo/MASTER nggak dipakai lagi).
--
-- karyawan_id di distribusi_pengeluaran di-null-in dulu (BUKAN dihapus
-- baris distribusinya) — nama karyawan di riwayat lama tetap kebaca karena
-- disimpan terpisah di kolom distribusi_pengeluaran.karyawan_name (text,
-- disalin manual pas dibuat, nggak bergantung ke tabel karyawan).
--
-- SETELAH jalanin ini, klik "Sync dari Google Sheet" di halaman Karyawan
-- buat isi ulang dari DATA INDEX (versi sheet-pull-employees yang udah ada
-- cleanName() bakal otomatis buang "* :" pas narik, jadi hasilnya bersih).
update public.distribusi_pengeluaran set karyawan_id = null;
delete from public.karyawan;

drop trigger if exists trg_karyawan_updated_at on public.karyawan;
create trigger trg_karyawan_updated_at before update on public.karyawan
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- D. distribusi_pengeluaran (rincian "barang untuk siapa saja")
-- ---------------------------------------------------------------------------
create table if not exists public.distribusi_pengeluaran (
  id             uuid primary key default gen_random_uuid(),
  pengeluaran_id uuid not null references public.pengeluaran_barang(id) on delete cascade,
  detail_id      uuid not null references public.detail_pengeluaran(id) on delete cascade,
  karyawan_id    uuid references public.karyawan(id),
  karyawan_name  text not null,     -- disalin manual — tetap utuh walau master karyawan berubah/hapus
  department     text,
  qty            numeric(14,3) not null check (qty > 0),
  created_by     text,              -- username petugas yang input (dari auth.currentUsername())
  created_at     timestamptz not null default now()
);
create index if not exists idx_distribusi_parent on public.distribusi_pengeluaran(pengeluaran_id);
create index if not exists idx_distribusi_detail on public.distribusi_pengeluaran(detail_id);

-- ---------------------------------------------------------------------------
-- E. RLS — pola SAMA PERSIS dengan penerimaan_barang/detail_penerimaan:
--    siapa pun yang login (authenticated) boleh baca/insert/update. Tidak ada
--    policy delete lewat client — penghapusan detail lama saat re-sync Odoo
--    dilakukan Edge Function pakai SERVICE_ROLE_KEY (bypass RLS).
-- ---------------------------------------------------------------------------
alter table public.pengeluaran_barang enable row level security;
drop policy if exists "pengeluaran_select_auth" on public.pengeluaran_barang;
create policy "pengeluaran_select_auth" on public.pengeluaran_barang
  for select to authenticated using (true);
drop policy if exists "pengeluaran_insert_auth" on public.pengeluaran_barang;
create policy "pengeluaran_insert_auth" on public.pengeluaran_barang
  for insert to authenticated with check (true);
drop policy if exists "pengeluaran_update_auth" on public.pengeluaran_barang;
create policy "pengeluaran_update_auth" on public.pengeluaran_barang
  for update to authenticated using (true) with check (true);

alter table public.detail_pengeluaran enable row level security;
drop policy if exists "detail_pengeluaran_select_auth" on public.detail_pengeluaran;
create policy "detail_pengeluaran_select_auth" on public.detail_pengeluaran
  for select to authenticated using (true);
drop policy if exists "detail_pengeluaran_insert_auth" on public.detail_pengeluaran;
create policy "detail_pengeluaran_insert_auth" on public.detail_pengeluaran
  for insert to authenticated with check (true);
drop policy if exists "detail_pengeluaran_update_auth" on public.detail_pengeluaran;
create policy "detail_pengeluaran_update_auth" on public.detail_pengeluaran
  for update to authenticated using (true) with check (true);

alter table public.karyawan enable row level security;
drop policy if exists "karyawan_select_auth" on public.karyawan;
create policy "karyawan_select_auth" on public.karyawan
  for select to authenticated using (true);
drop policy if exists "karyawan_insert_auth" on public.karyawan;
create policy "karyawan_insert_auth" on public.karyawan
  for insert to authenticated with check (true);
drop policy if exists "karyawan_update_auth" on public.karyawan;
create policy "karyawan_update_auth" on public.karyawan
  for update to authenticated using (true) with check (true);

alter table public.distribusi_pengeluaran enable row level security;
drop policy if exists "distribusi_select_auth" on public.distribusi_pengeluaran;
create policy "distribusi_select_auth" on public.distribusi_pengeluaran
  for select to authenticated using (true);
drop policy if exists "distribusi_insert_auth" on public.distribusi_pengeluaran;
create policy "distribusi_insert_auth" on public.distribusi_pengeluaran
  for insert to authenticated with check (true);
drop policy if exists "distribusi_delete_auth" on public.distribusi_pengeluaran;
create policy "distribusi_delete_auth" on public.distribusi_pengeluaran
  for delete to authenticated using (true);  -- perlu hapus baris salah-input sebelum submit ulang
