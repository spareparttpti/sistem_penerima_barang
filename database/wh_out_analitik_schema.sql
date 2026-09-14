-- =========================================================
-- SPB · wh_out_analitik_schema.sql
-- Tambahan buat WH/OUT (ATK):
--   Status per BARIS distribusi (bukan per transaksi WH/OUT) — barang yang
--   sudah dibagi ke 1 orang ditandai: "Baru" (default/wajar), "Hilang",
--   "Tukar", atau "Habis" (reissue karena barang sebelumnya sudah habis).
--   Sekalian kolom "Keterangan" per baris — alasan manual kenapa pemakaian
--   naik/ada kejadian khusus.
--
--   Kolom "is_shared" — buat barang yang TIDAK dibagi per-orang tapi dipakai
--   bersama 1 Divisi (mis. lem/isolasi dipakai rame-rame, bukan kayak pulpen
--   yang jelas punya siapa). Baris distribusi jenis ini karyawan_name-nya diisi
--   label tetap "Dipakai Bersama Divisi" (bukan nama orang) & department-nya
--   diisi nama Divisi yang dipilih.
--
--   (Fitur "Kategori Barang" + "Otorisasi Divisi" yang sempat ada di sini
--   SUDAH DIHAPUS — nggak kepake, digantikan tab "Analisis Barang" di
--   Laporan WH/OUT. Kalau kamu sempat jalankan versi lama file ini dan mau
--   beres-beres tabel kategori_barang/sku_kategori/otorisasi_divisi, tinggal
--   jalankan: drop table if exists public.otorisasi_divisi, public.sku_kategori,
--   public.kategori_barang; — opsional, boleh dilewat kalau tabelnya memang
--   belum pernah ada.)
--
--   File ini idempotent & satu-satunya yang perlu dijalankan buat fitur status
--   distribusi (aman dijalankan berkali-kali, aman juga walau sebelumnya
--   pernah jalanin versi lama file ini).
-- Jalankan SETELAH wh_out_schema.sql (butuh tabel distribusi_pengeluaran).
-- =========================================================

alter table public.distribusi_pengeluaran
  add column if not exists status text not null default 'Baru';
alter table public.distribusi_pengeluaran
  add column if not exists keterangan text;
alter table public.distribusi_pengeluaran
  add column if not exists is_shared boolean not null default false;

-- Constraint lama (kalau ada) cuma izinkan 'Normal'/'Hilang'/'Tukar' — harus
-- di-drop DULU sebelum update ke 'Baru', kalau nggak update-nya sendiri yang
-- ditolak duluan karena 'Baru' belum termasuk daftar lama.
alter table public.distribusi_pengeluaran drop constraint if exists distribusi_pengeluaran_status_check;

update public.distribusi_pengeluaran set status = 'Baru' where status = 'Normal';

alter table public.distribusi_pengeluaran alter column status set default 'Baru';
alter table public.distribusi_pengeluaran
  add constraint distribusi_pengeluaran_status_check check (status in ('Baru', 'Hilang', 'Tukar', 'Habis'));

create index if not exists idx_distribusi_status on public.distribusi_pengeluaran(status);

-- =========================================================
-- Status "Menunggu Stok" + tabel permintaan_restock — buat kasus barang WH/OUT
-- yang Qty Fisik-nya 0 (habis) di Stok Barang: tombol "Approve" di halaman
-- detail DIGANTI jadi "Ajukan Pemesanan (PO)". Ini CUMA catatan internal SPB
-- (bukan bikin Purchase Order beneran di Odoo — integrasi Odoo tetap satu
-- arah + validate picking doang, nggak nambah scope tulis baru ke Odoo).
-- Kelihatan di tab status "Menunggu Stok" (Log Pengeluaran) & kartu "Perlu
-- Perhatian" (Dashboard Ringkasan) — SENGAJA TIDAK muncul di Log Penerimaan
-- (WH/IN), karena itu buat transaksi yang beneran udah tercatat di Odoo,
-- sedangkan ini baru "permintaan" internal yang belum tentu diproses vendor.
-- =========================================================

alter table public.pengeluaran_barang drop constraint if exists pengeluaran_barang_status_check;
alter table public.pengeluaran_barang
  add constraint pengeluaran_barang_status_check
  check (status in ('Draft', 'In Inspection', 'Approved', 'Rejected', 'Menunggu Stok'));

create table if not exists public.permintaan_restock (
  id             uuid primary key default gen_random_uuid(),
  pengeluaran_id uuid not null references public.pengeluaran_barang(id) on delete cascade,
  detail_id      uuid references public.detail_pengeluaran(id) on delete cascade,
  sku            text,
  product_name   text,
  qty_diminta    numeric(14,3) not null default 0,   -- qty yang diminta WH/OUT ini (kurangnya berapa)
  status         text not null default 'Menunggu'
                   check (status in ('Menunggu', 'Selesai', 'Dibatalkan')),
  created_by     text,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index if not exists idx_restock_pengeluaran on public.permintaan_restock(pengeluaran_id);
create index if not exists idx_restock_status on public.permintaan_restock(status);

alter table public.permintaan_restock enable row level security;
drop policy if exists "permintaan_restock select" on public.permintaan_restock;
create policy "permintaan_restock select" on public.permintaan_restock for select to authenticated using (true);
drop policy if exists "permintaan_restock insert" on public.permintaan_restock;
create policy "permintaan_restock insert" on public.permintaan_restock for insert to authenticated with check (true);
drop policy if exists "permintaan_restock update" on public.permintaan_restock;
create policy "permintaan_restock update" on public.permintaan_restock for update to authenticated using (true);
