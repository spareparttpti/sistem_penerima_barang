-- =========================================================
-- SPB · part_mesin_schema.sql
-- Modul "Part Mesin" — KHUSUS role 'spinning' (lihat auth_setup.sql), beda
-- total dari modul ATK: katalog part mesin (dengan hierarki part utama ->
-- sub-part) + permintaan part yang bercabang dua jalur:
--   - jenis='gudang'   -> ambil dari stok gudang, dipakai buat repair mesin
--   - jenis='supplier' -> stok kosong, harus dibeli dulu ke supplier
-- Lihat rekap alur (artifact "Alur Sparepart Spinning") untuk gambaran
-- lengkapnya. Odoo Repair Order / auto-PO BELUM diintegrasikan di sini —
-- kolom status disediakan tapi transisinya masih manual dari sisi SPB
-- (menyusul kalau detail integrasi Odoo-nya sudah dikonfirmasi).
--
-- Jalankan SEKALI di SQL Editor. Aman dijalankan ulang (semua idempotent).
-- =========================================================

-- ---------------------------------------------------------------------------
-- mesin — daftar mesin produksi Spinning (mis. Ring Frame, Winding, dst).
-- ---------------------------------------------------------------------------
create table if not exists public.mesin (
  id          uuid primary key default gen_random_uuid(),
  no_mesin    text not null,
  nama_mesin  text,
  keterangan  text,
  created_at  timestamptz not null default now()
);
create unique index if not exists idx_mesin_no_unique on public.mesin(no_mesin);

-- Kolom tambahan buat halaman "Data Mesin" (Master Data > Data Mesin, role
-- Spinning) — merk/kategori/lokasi/jam_operasi/interval servis/status/tahun,
-- dipakai buat progress bar "Jam Operasi" & badge status di halaman itu.
-- status DIISI MANUAL (bukan dihitung otomatis dari % jam operasi — dua hal
-- ini independen, sesuai contoh referensi UI-nya).
alter table public.mesin add column if not exists merk text;
alter table public.mesin add column if not exists kategori text;
alter table public.mesin add column if not exists lokasi text;
alter table public.mesin add column if not exists jam_operasi numeric(12,2) not null default 0;
alter table public.mesin add column if not exists interval_servis_jam numeric(12,2) not null default 20000;
alter table public.mesin add column if not exists status text not null default 'Beroperasi' check (status in ('Beroperasi', 'Perlu Perawatan', 'Rusak', 'Nonaktif'));
alter table public.mesin add column if not exists tahun integer;

-- ---------------------------------------------------------------------------
-- part_mesin — katalog part, dengan hierarki parent_id (part utama -> sub-part,
-- mis. "Spindel OE" -> "Rotor"/"Opening"/"Brake"/"Housing"). Field dari Odoo
-- (internal_reference, category, stok, harga, supplier_name) diisi manual
-- dulu / sinkron belakangan lewat Edge Function serupa stokBarangClient.js
-- kalau sudah ada akses API-nya — untuk sekarang kolomnya disediakan saja.
-- ---------------------------------------------------------------------------
create table if not exists public.part_mesin (
  id                 uuid primary key default gen_random_uuid(),
  parent_id          uuid references public.part_mesin(id) on delete set null,
  nama_part          text not null,
  category           text,
  satuan             text,
  internal_reference text,   -- dari Odoo (Item Card)
  part_number        text,   -- tambahan sistem
  catalog_number     text,   -- tambahan sistem
  consumable         boolean not null default true,
  asal               text check (asal in ('Import', 'Lokal')),
  stok               numeric(14,3) not null default 0,
  harga              numeric(14,2),
  supplier_name      text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_part_mesin_parent on public.part_mesin(parent_id);
create index if not exists idx_part_mesin_nama on public.part_mesin(nama_part);

-- ---------------------------------------------------------------------------
-- permintaan_part_mesin — satu tabel buat DUA jalur (gudang & supplier),
-- dibedakan kolom `jenis`. Status disatukan (bukan 2 kolom terpisah) supaya
-- riwayat/laporan gampang digabung, tapi tiap jenis cuma make sub-set status
-- yang relevan buat dia (lihat komentar constraint di bawah).
-- ---------------------------------------------------------------------------
create table if not exists public.permintaan_part_mesin (
  id             uuid primary key default gen_random_uuid(),
  no_antrian     bigserial,
  jenis          text not null check (jenis in ('gudang', 'supplier')),
  no_mesin       text,
  nama_mekanik   text not null,
  part_id        uuid references public.part_mesin(id) on delete set null,
  nama_part      text not null,       -- disalin manual, tetap utuh walau part_mesin berubah/dihapus
  jumlah         numeric(14,3) not null default 1,
  catatan        text,
  -- menunggu       -> baru diajukan, nunggu ACC
  -- disetujui      -> sudah di-ACC ADMIN SPINNING SENDIRI (jenis gudang maupun supplier
  --                   dua-duanya — bukan role "atasan" terpisah). Admin Gudang cuma
  --                   TERIMA NOTIFIKASI begitu ini disetujui, bukan ikut approve.
  -- ditolak        -> ACC ditolak, alur berhenti di sini
  -- diambil        -> (jenis gudang) barang sudah diserahkan gudang secara fisik
  -- repair_start   -> (jenis gudang) mekanik mulai pasang/perbaikan
  -- repair_end     -> (jenis gudang) selesai, mesin jalan lagi
  -- po_dibuat      -> (jenis supplier) PO otomatis/manual sudah dibuat ke supplier
  -- barang_datang  -> (jenis supplier) barang sudah sampai & diinspeksi disetujui
  status         text not null default 'menunggu' check (status in (
                   'menunggu', 'disetujui', 'ditolak',
                   'diambil', 'repair_start', 'repair_end',
                   'po_dibuat', 'barang_datang'
                 )),
  requested_by   text,               -- username yang input permintaan
  approved_by    text,
  approved_at    timestamptz,
  repair_start_at timestamptz,
  repair_end_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_ppm_status on public.permintaan_part_mesin(status);
create index if not exists idx_ppm_jenis on public.permintaan_part_mesin(jenis);
create index if not exists idx_ppm_created on public.permintaan_part_mesin(created_at);

drop trigger if exists trg_ppm_updated_at on public.permintaan_part_mesin;
create trigger trg_ppm_updated_at before update on public.permintaan_part_mesin
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — modul ini CUMA dipakai user yang sudah login (role 'spinning' atau
-- 'admin' lihat semua) lewat halaman admin, bukan portal publik seperti
-- pesanan/pesanan_item — jadi `authenticated` saja, sama pola dengan
-- permintaan_restock di wh_out_analitik_schema.sql.
-- ---------------------------------------------------------------------------
alter table public.mesin enable row level security;
drop policy if exists "mesin select" on public.mesin;
create policy "mesin select" on public.mesin for select to authenticated using (true);
drop policy if exists "mesin insert" on public.mesin;
create policy "mesin insert" on public.mesin for insert to authenticated with check (true);
drop policy if exists "mesin update" on public.mesin;
create policy "mesin update" on public.mesin for update to authenticated using (true);
drop policy if exists "mesin delete" on public.mesin;
create policy "mesin delete" on public.mesin for delete to authenticated using (true);

alter table public.part_mesin enable row level security;
drop policy if exists "part_mesin select" on public.part_mesin;
create policy "part_mesin select" on public.part_mesin for select to authenticated using (true);
drop policy if exists "part_mesin insert" on public.part_mesin;
create policy "part_mesin insert" on public.part_mesin for insert to authenticated with check (true);
drop policy if exists "part_mesin update" on public.part_mesin;
create policy "part_mesin update" on public.part_mesin for update to authenticated using (true);
drop policy if exists "part_mesin delete" on public.part_mesin;
create policy "part_mesin delete" on public.part_mesin for delete to authenticated using (true);

alter table public.permintaan_part_mesin enable row level security;
drop policy if exists "ppm select" on public.permintaan_part_mesin;
create policy "ppm select" on public.permintaan_part_mesin for select to authenticated using (true);
drop policy if exists "ppm insert" on public.permintaan_part_mesin;
create policy "ppm insert" on public.permintaan_part_mesin for insert to authenticated with check (true);
drop policy if exists "ppm update" on public.permintaan_part_mesin;
create policy "ppm update" on public.permintaan_part_mesin for update to authenticated using (true);
drop policy if exists "ppm delete" on public.permintaan_part_mesin;
create policy "ppm delete" on public.permintaan_part_mesin for delete to authenticated using (true);

-- =========================================================
-- spinning_supplier — daftar supplier buat Purchase Order ke Supplier
-- (dulu file terpisah spinning_master_schema.sql, digabung ke sini karena
-- sama-sama bagian dari modul Part Mesin, bukan modul lain).
-- =========================================================
create table if not exists public.spinning_supplier (
  id         uuid primary key default gen_random_uuid(),
  nama       text not null,
  kontak     text,
  telepon    text,
  alamat     text,
  created_at timestamptz not null default now()
);
create index if not exists idx_spinning_supplier_nama on public.spinning_supplier(nama);

-- Supplier SEKARANG ditarik dari Odoo (res.partner, supplier_rank > 0) lewat
-- Edge Function odoo-pull-suppliers — bukan diketik manual lagi (form
-- "Tambah Supplier" lama dicabut dari UI). odoo_partner_id = key upsert.
-- email/npwp/kota ikut dari Odoo tiap sync. termin_hari & status SENGAJA
-- TIDAK ditimpa re-sync (Odoo nggak punya kolom "termin hari" yang bersih)
-- — dikelola manual di SPB, sama pola trade-off dengan satuan_odoo.
alter table public.spinning_supplier add column if not exists odoo_partner_id integer;
create unique index if not exists idx_spinning_supplier_odoo_partner on public.spinning_supplier(odoo_partner_id);
alter table public.spinning_supplier add column if not exists email text;
alter table public.spinning_supplier add column if not exists npwp text;
alter table public.spinning_supplier add column if not exists kota text;
alter table public.spinning_supplier add column if not exists termin_hari integer not null default 30;
alter table public.spinning_supplier add column if not exists status text not null default 'Aktif' check (status in ('Aktif', 'Nonaktif'));

-- kode/kategori_utama/rating — field TAMBAHAN yang SPB kelola sendiri (Odoo
-- nggak punya kolom setara yang bisa ditarik apa adanya), diisi/diedit lewat
-- popup "Ubah Supplier". kontak (sudah ada dari awal, dulu SELALU null waktu
-- sync) sekarang dipakai sebagai "Nama PIC" — TIDAK ikut ditimpa Odoo lagi
-- (lihat odoo-pull-suppliers), aman diisi manual.
alter table public.spinning_supplier add column if not exists kode text;
alter table public.spinning_supplier add column if not exists kategori_utama text;
alter table public.spinning_supplier add column if not exists rating numeric(2,1);

alter table public.spinning_supplier enable row level security;
drop policy if exists "spinning_supplier select" on public.spinning_supplier;
create policy "spinning_supplier select" on public.spinning_supplier for select to authenticated using (true);
drop policy if exists "spinning_supplier insert" on public.spinning_supplier;
create policy "spinning_supplier insert" on public.spinning_supplier for insert to authenticated with check (true);
drop policy if exists "spinning_supplier update" on public.spinning_supplier;
create policy "spinning_supplier update" on public.spinning_supplier for update to authenticated using (true);
drop policy if exists "spinning_supplier delete" on public.spinning_supplier;
create policy "spinning_supplier delete" on public.spinning_supplier for delete to authenticated using (true);

-- =========================================================
-- spinning_supplier_product — daftar product + harga per supplier, ditarik
-- dari Odoo (product.supplierinfo, "Vendor Pricelist"-nya Odoo). Muncul di
-- popup modal waktu klik nama supplier di halaman Master Data > Supplier.
-- =========================================================
create table if not exists public.spinning_supplier_product (
  id               uuid primary key default gen_random_uuid(),
  supplier_id      uuid not null references public.spinning_supplier(id) on delete cascade,
  odoo_supplierinfo_id integer,
  sku              text,
  product_name     text not null,
  price            numeric(14,2) not null default 0,
  currency         text,
  min_qty          numeric(14,3) not null default 0,
  delay_hari       integer,
  updated_at       timestamptz not null default now()
);
create index if not exists idx_spinning_supplier_product_supplier on public.spinning_supplier_product(supplier_id);
create unique index if not exists idx_spinning_supplier_product_odoo on public.spinning_supplier_product(odoo_supplierinfo_id);

alter table public.spinning_supplier_product enable row level security;
drop policy if exists "spinning_supplier_product select" on public.spinning_supplier_product;
create policy "spinning_supplier_product select" on public.spinning_supplier_product for select to authenticated using (true);
drop policy if exists "spinning_supplier_product insert" on public.spinning_supplier_product;
create policy "spinning_supplier_product insert" on public.spinning_supplier_product for insert to authenticated with check (true);
drop policy if exists "spinning_supplier_product update" on public.spinning_supplier_product;
create policy "spinning_supplier_product update" on public.spinning_supplier_product for update to authenticated using (true);
drop policy if exists "spinning_supplier_product delete" on public.spinning_supplier_product;
create policy "spinning_supplier_product delete" on public.spinning_supplier_product for delete to authenticated using (true);

-- Referensi supplier dari dropdown Master Data (bukan ketik bebas lagi) —
-- supplier_name lama TETAP ada di permintaan_part_mesin (diisi otomatis dari
-- master waktu dipilih) supaya histori lama & laporan yang sudah jalan
-- nggak perlu migrasi data. karyawan_id DIBIARKAN nullable & tidak dipakai
-- lagi (mekanik sekarang dari public.karyawan/Odoo langsung, lihat
-- spinningTransaksi.js — kolomnya tetap ada di sini biar aman kalau ada
-- baris lama yang kepalang keisi).
alter table public.permintaan_part_mesin add column if not exists supplier_id uuid references public.spinning_supplier(id) on delete set null;
alter table public.permintaan_part_mesin add column if not exists karyawan_id uuid;

-- Status 'masuk_inventory' — tahap akhir alur PO ke Supplier (Approve
-- Inspeksi & Masuk Inventory jadi satu klik, bukan tahap terpisah).
alter table public.permintaan_part_mesin drop constraint if exists permintaan_part_mesin_status_check;
alter table public.permintaan_part_mesin add constraint permintaan_part_mesin_status_check check (status in (
  'menunggu', 'disetujui', 'ditolak',
  'diambil', 'repair_start', 'repair_end',
  'po_dibuat', 'barang_datang', 'masuk_inventory'
));

-- =========================================================
-- Purchase Request & Purchase Order (jalur SUPPLIER) — versi dokumen
-- multi-item dengan harga/diskon/PPN, MENGGANTIKAN alur lama yang nempel di
-- permintaan_part_mesin (jenis='supplier'). Tabel permintaan_part_mesin
-- TETAP ada & tetap dipakai buat jalur GUDANG (jenis='gudang', PR ke Gudang
-- + Work Order) — dua jalur ini sekarang benar-benar terpisah tabelnya.
--
-- Alur: spinning_pr (menunggu -> disetujui/ditolak) --[Buat PO]--> spinning_po
-- (menunggu_konfirmasi -> dikonfirmasi -> dikirim_sebagian -> diterima /
-- dibatalkan), penerimaan fisik dicatat di spinning_receipt (1 PO bisa
-- diterima bertahap/beberapa kali, makanya qty_diterima disimpan per item PO
-- bukan per header).
-- =========================================================
create table if not exists public.spinning_pr (
  id              uuid primary key default gen_random_uuid(),
  no_urut         bigserial,
  nomor           text not null unique,
  tanggal         date not null default current_date,
  divisi_pemohon  text,
  pemohon_id      uuid,          -- id dari public.karyawan (sinkron Odoo), bukan FK strict
  pemohon_nama    text not null,
  mesin_id        uuid references public.mesin(id) on delete set null,
  mesin_kode      text,
  mesin_nama      text,
  prioritas       text not null default 'Normal' check (prioritas in ('Rendah', 'Normal', 'Tinggi', 'Mendesak')),
  status          text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak', 'diproses_po', 'selesai')),
  keperluan       text,
  catatan         text,
  total_estimasi  numeric(14,2) not null default 0,
  approved_by     text,
  approved_at     timestamptz,
  alasan_reject   text,
  po_id           uuid,          -- diisi begitu PR ini dipakai buat terbitkan PO
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_spinning_pr_status on public.spinning_pr(status);
create index if not exists idx_spinning_pr_created on public.spinning_pr(created_at);

-- urgent (Ya/Tidak, GANTI dari "prioritas" 4-level di form — kolom
-- prioritas TETAP ada/dipertahankan buat kompatibilitas data lama, tapi UI
-- baru cuma nulis 'Mendesak' (urgent=true) / 'Normal' (urgent=false) ke situ)
-- & jalur (po_baru/order_gudang, dipilih di form PR) — dua-duanya field
-- TAMBAHAN doang, bukan ganti alur permintaan_part_mesin (jenis='gudang')
-- yang udah ada. "order_gudang" di sini CUMA nandain baris PR ini butuh
-- notifikasi ke Admin Gudang, PR-nya TETAP 1 dokumen yang sama di
-- spinning_pr (bukan didobelin ke permintaan_part_mesin).
alter table public.spinning_pr add column if not exists urgent boolean not null default false;
alter table public.spinning_pr add column if not exists jalur text not null default 'po_baru' check (jalur in ('po_baru', 'order_gudang'));

create table if not exists public.spinning_pr_item (
  id            uuid primary key default gen_random_uuid(),
  pr_id         uuid not null references public.spinning_pr(id) on delete cascade,
  part_id       uuid references public.part_mesin(id) on delete set null,
  nama_part     text not null,
  satuan        text,
  qty           numeric(14,3) not null default 1,
  harga_satuan  numeric(14,2) not null default 0,
  subtotal      numeric(14,2) not null default 0
);
create index if not exists idx_spinning_pr_item_pr on public.spinning_pr_item(pr_id);

create table if not exists public.spinning_po (
  id                     uuid primary key default gen_random_uuid(),
  no_urut                bigserial,
  nomor                  text not null unique,
  tanggal                date not null default current_date,
  supplier_id            uuid references public.spinning_supplier(id) on delete set null,
  supplier_nama          text not null,
  pr_id                  uuid references public.spinning_pr(id) on delete set null,
  pr_nomor               text,
  status                 text not null default 'menunggu_konfirmasi' check (status in ('menunggu_konfirmasi', 'dikonfirmasi', 'dikirim_sebagian', 'diterima', 'dibatalkan')),
  subtotal               numeric(14,2) not null default 0,
  diskon_persen          numeric(5,2) not null default 0,
  diskon                 numeric(14,2) not null default 0,
  ppn_persen             numeric(5,2) not null default 11,
  ppn                    numeric(14,2) not null default 0,
  total                  numeric(14,2) not null default 0,
  termin_hari            integer not null default 30,
  tanggal_kirim_estimasi date,
  dibuat_oleh            text,
  catatan                text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_spinning_po_status on public.spinning_po(status);
create index if not exists idx_spinning_po_created on public.spinning_po(created_at);

create table if not exists public.spinning_po_item (
  id            uuid primary key default gen_random_uuid(),
  po_id         uuid not null references public.spinning_po(id) on delete cascade,
  part_id       uuid references public.part_mesin(id) on delete set null,
  nama_part     text not null,
  satuan        text,
  qty           numeric(14,3) not null default 1,
  harga_satuan  numeric(14,2) not null default 0,
  subtotal      numeric(14,2) not null default 0,
  qty_diterima  numeric(14,3) not null default 0
);
create index if not exists idx_spinning_po_item_po on public.spinning_po_item(po_id);

create table if not exists public.spinning_receipt (
  id             uuid primary key default gen_random_uuid(),
  no_urut        bigserial,
  nomor          text not null unique,
  po_id          uuid not null references public.spinning_po(id) on delete cascade,
  tanggal        date not null default current_date,
  diterima_oleh  text,
  no_surat_jalan text,
  catatan        text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_spinning_receipt_po on public.spinning_receipt(po_id);

create table if not exists public.spinning_receipt_item (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references public.spinning_receipt(id) on delete cascade,
  po_item_id  uuid not null references public.spinning_po_item(id) on delete cascade,
  qty_terima  numeric(14,3) not null default 0,
  qty_reject  numeric(14,3) not null default 0
);
create index if not exists idx_spinning_receipt_item_receipt on public.spinning_receipt_item(receipt_id);

drop trigger if exists trg_spinning_pr_updated_at on public.spinning_pr;
create trigger trg_spinning_pr_updated_at before update on public.spinning_pr
  for each row execute function public.set_updated_at();
drop trigger if exists trg_spinning_po_updated_at on public.spinning_po;
create trigger trg_spinning_po_updated_at before update on public.spinning_po
  for each row execute function public.set_updated_at();

alter table public.spinning_pr enable row level security;
drop policy if exists "spinning_pr select" on public.spinning_pr;
create policy "spinning_pr select" on public.spinning_pr for select to authenticated using (true);
drop policy if exists "spinning_pr insert" on public.spinning_pr;
create policy "spinning_pr insert" on public.spinning_pr for insert to authenticated with check (true);
drop policy if exists "spinning_pr update" on public.spinning_pr;
create policy "spinning_pr update" on public.spinning_pr for update to authenticated using (true);
drop policy if exists "spinning_pr delete" on public.spinning_pr;
create policy "spinning_pr delete" on public.spinning_pr for delete to authenticated using (true);

alter table public.spinning_pr_item enable row level security;
drop policy if exists "spinning_pr_item select" on public.spinning_pr_item;
create policy "spinning_pr_item select" on public.spinning_pr_item for select to authenticated using (true);
drop policy if exists "spinning_pr_item insert" on public.spinning_pr_item;
create policy "spinning_pr_item insert" on public.spinning_pr_item for insert to authenticated with check (true);
drop policy if exists "spinning_pr_item update" on public.spinning_pr_item;
create policy "spinning_pr_item update" on public.spinning_pr_item for update to authenticated using (true);
drop policy if exists "spinning_pr_item delete" on public.spinning_pr_item;
create policy "spinning_pr_item delete" on public.spinning_pr_item for delete to authenticated using (true);

alter table public.spinning_po enable row level security;
drop policy if exists "spinning_po select" on public.spinning_po;
create policy "spinning_po select" on public.spinning_po for select to authenticated using (true);
drop policy if exists "spinning_po insert" on public.spinning_po;
create policy "spinning_po insert" on public.spinning_po for insert to authenticated with check (true);
drop policy if exists "spinning_po update" on public.spinning_po;
create policy "spinning_po update" on public.spinning_po for update to authenticated using (true);
drop policy if exists "spinning_po delete" on public.spinning_po;
create policy "spinning_po delete" on public.spinning_po for delete to authenticated using (true);

alter table public.spinning_po_item enable row level security;
drop policy if exists "spinning_po_item select" on public.spinning_po_item;
create policy "spinning_po_item select" on public.spinning_po_item for select to authenticated using (true);
drop policy if exists "spinning_po_item insert" on public.spinning_po_item;
create policy "spinning_po_item insert" on public.spinning_po_item for insert to authenticated with check (true);
drop policy if exists "spinning_po_item update" on public.spinning_po_item;
create policy "spinning_po_item update" on public.spinning_po_item for update to authenticated using (true);
drop policy if exists "spinning_po_item delete" on public.spinning_po_item;
create policy "spinning_po_item delete" on public.spinning_po_item for delete to authenticated using (true);

alter table public.spinning_receipt enable row level security;
drop policy if exists "spinning_receipt select" on public.spinning_receipt;
create policy "spinning_receipt select" on public.spinning_receipt for select to authenticated using (true);
drop policy if exists "spinning_receipt insert" on public.spinning_receipt;
create policy "spinning_receipt insert" on public.spinning_receipt for insert to authenticated with check (true);
drop policy if exists "spinning_receipt delete" on public.spinning_receipt;
create policy "spinning_receipt delete" on public.spinning_receipt for delete to authenticated using (true);

alter table public.spinning_receipt_item enable row level security;
drop policy if exists "spinning_receipt_item select" on public.spinning_receipt_item;
create policy "spinning_receipt_item select" on public.spinning_receipt_item for select to authenticated using (true);
drop policy if exists "spinning_receipt_item insert" on public.spinning_receipt_item;
create policy "spinning_receipt_item insert" on public.spinning_receipt_item for insert to authenticated with check (true);
drop policy if exists "spinning_receipt_item delete" on public.spinning_receipt_item;
create policy "spinning_receipt_item delete" on public.spinning_receipt_item for delete to authenticated using (true);

notify pgrst, 'reload schema';
