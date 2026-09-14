-- =========================================================
-- SPB · pesanan_schema.sql
-- Fitur "Permintaan Barang" (portal pemesanan online per-divisi, digabung ke
-- SPB — Pilihan B yang dibahas: 1 program, 1 Supabase, HANYA 2 tabel baru).
--
-- SENGAJA TIDAK bikin tabel karyawan/barang baru — dipakai ulang yang udah
-- ada di SPB:
--   - Autocomplete nama & divisi/sub-divisi karyawan -> tabel public.karyawan
--     (sinkron dari Odoo, department-nya diparsing "DIVISI / SUB DIVISI / POS"
--     sama kayak karyawan.js/laporan.js).
--   - Katalog barang yang bisa dipesan -> tabel public.stok_barang (sinkron
--     dari Odoo lewat odoo-pull-stock).
--
--   NIP & Jabatan karyawan (dipakai autofill form pemesanan) ditarik dari
--   Odoo lewat odoo-pull-employees & disimpan di kolom karyawan.nip/jabatan
--   — itu bagian dari fitur Karyawan/WH-OUT, jadi kolomnya di-ALTER di
--   database/wh_out_schema.sql (bukan file ini), sekalian pas tabel
--   karyawan-nya sendiri didefinisikan. Jalankan file itu duluan (atau
--   ulang) sebelum file ini kalau kolomnya belum ada.
--
-- sku di pesanan_item SENGAJA bukan foreign key ke stok_barang (nilainya
-- cuma disalin manual pas order dibuat) — sama pola dengan
-- detail_pengeluaran.sku di wh_out_schema.sql: tetap utuh walau barangnya
-- di stok_barang belakangan berubah/hilang dari Odoo.
-- =========================================================

create table if not exists public.pesanan (
  id             uuid primary key default gen_random_uuid(),
  queue_no       bigserial,                -- nomor urut antrean (ditampilkan format bebas di frontend, mis. "A-0001")
  karyawan_name  text not null,
  nip            text,                     -- disalin dari karyawan.nip (Odoo identification_id) pas nama dipilih
  divisi         text,
  sub_divisi     text,
  jabatan        text,                     -- disalin dari karyawan.jabatan (Odoo job_title) pas nama dipilih
  tujuan         text,                     -- "Kebutuhan Kantor (ATK)" / "Return Barang ATK" / dst
  mode           text not null default 'umum' check (mode in ('umum', 'titip')),
  titip_ke_name  text,                     -- kalau mode 'titip': nama karyawan penerima titipan
  status         text not null default 'waiting' check (status in ('waiting', 'processing', 'ready', 'done')),
  catatan        text,
  breakdown      jsonb,                    -- rincian pembagian ke beberapa penerima (kalau ada)
  shortage_report jsonb,                   -- laporan "barang kurang" yang diisi karyawan dari tiket
  processing_at  timestamptz,
  ready_at       timestamptz,
  done_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_pesanan_status on public.pesanan(status);
create index if not exists idx_pesanan_divisi on public.pesanan(divisi);
create index if not exists idx_pesanan_created on public.pesanan(created_at);

-- Jaga-jaga: kalau tabel pesanan ini sempat dibuat dari versi file SEBELUM
-- kolom nip/jabatan ada di sini, "create table if not exists" di atas nggak
-- bakal nambahin kolomnya (di-skip total karena tabelnya udah ada) — makanya
-- ditambahin eksplisit lagi di sini biar aman dijalankan ulang kapan aja.
alter table public.pesanan add column if not exists nip text;
alter table public.pesanan add column if not exists jabatan text;

-- is_urgent — karyawan bisa tandai pesanannya "Urgent" di form pemesanan.
-- Pesanan urgent otomatis dinaikkan ke atas antrean di dashboard admin
-- (lihat permintaan.js), MELEWATI urutan FIFO biasa — bukan cuma badge
-- doang, beneran ngubah urutan yang dilihat petugas gudang.
alter table public.pesanan add column if not exists is_urgent boolean not null default false;
create index if not exists idx_pesanan_urgent on public.pesanan(is_urgent);

-- wh_out_ref — diisi kalau pesanan ini SUDAH dikirim jadi Delivery Order di
-- Odoo (tombol "Kirim ke Odoo" di dashboard admin, lihat odoo-create-wh-out).
-- Simpan nomornya (mis. "WH/OUT/01302") biar (1) kelihatan di dashboard admin
-- pesanan mana yang udah dikirim, (2) nyegah dikirim dobel jadi 2 Delivery
-- Order buat pesanan yang sama.
alter table public.pesanan add column if not exists wh_out_ref text;

-- PostgREST kadang nyimpen cache skema lama abis ada perubahan kolom (baru
-- kebaca lagi abis reload) — notify ini maksa dia refresh sekarang juga,
-- biar error "Could not find the 'xxx' column ... in the schema cache"
-- nggak nyantol lama nunggu auto-refresh berkala.
notify pgrst, 'reload schema';

drop trigger if exists trg_pesanan_updated_at on public.pesanan;
create trigger trg_pesanan_updated_at before update on public.pesanan
  for each row execute function public.set_updated_at();

create table if not exists public.pesanan_item (
  id           uuid primary key default gen_random_uuid(),
  pesanan_id   uuid not null references public.pesanan(id) on delete cascade,
  sku          text,                       -- disalin dari stok_barang.sku, BUKAN foreign key (lihat catatan di atas)
  nama_barang  text not null,
  qty          numeric(14,3) not null default 0,
  satuan       text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pesanan_item_parent on public.pesanan_item(pesanan_id);

-- ---------------------------------------------------------------------------
-- RLS — beda dari tabel lain di SPB: sisi pemesanan TANPA LOGIN (karyawan
-- buka link divisinya, pesan, cek status tiket — semua tanpa akun), jadi
-- kebijakannya harus izinkan `anon` juga, bukan cuma `authenticated`. Ini
-- pola yang SAMA dengan yang udah jalan di Program Pemesanan sebelumnya
-- (tabel pesanan/pesanan_item di sana juga bisa dibaca anon key).
-- ---------------------------------------------------------------------------
alter table public.pesanan enable row level security;
drop policy if exists "pesanan select" on public.pesanan;
create policy "pesanan select" on public.pesanan for select to anon, authenticated using (true);
drop policy if exists "pesanan insert" on public.pesanan;
create policy "pesanan insert" on public.pesanan for insert to anon, authenticated with check (true);
drop policy if exists "pesanan update" on public.pesanan;
create policy "pesanan update" on public.pesanan for update to anon, authenticated using (true);

-- Portal pemesanan (form karyawan) butuh baca karyawan.name/department buat
-- autocomplete & stok_barang buat katalog — DUA-DUANYA sebelum ini cuma bisa
-- dibaca `authenticated` (admin login). Ditambah izin `anon` KHUSUS SELECT
-- (baca doang, insert/update/delete tetap cuma admin) supaya portal tanpa
-- login bisa jalan. Trade-off yang disadari: sama kayak Program Pemesanan
-- lama (tabel karyawan di sana juga kebaca penuh pakai anon key) — bukan hal
-- baru, cuma dipindah ke sini.
drop policy if exists "karyawan_select_anon" on public.karyawan;
create policy "karyawan_select_anon" on public.karyawan for select to anon using (true);
drop policy if exists "stok_barang_select_anon" on public.stok_barang;
create policy "stok_barang_select_anon" on public.stok_barang for select to anon using (true);

alter table public.pesanan_item enable row level security;
drop policy if exists "pesanan_item select" on public.pesanan_item;
create policy "pesanan_item select" on public.pesanan_item for select to anon, authenticated using (true);
drop policy if exists "pesanan_item insert" on public.pesanan_item;
create policy "pesanan_item insert" on public.pesanan_item for insert to anon, authenticated with check (true);
drop policy if exists "pesanan_item update" on public.pesanan_item;
create policy "pesanan_item update" on public.pesanan_item for update to anon, authenticated using (true);
drop policy if exists "pesanan_item delete" on public.pesanan_item;
create policy "pesanan_item delete" on public.pesanan_item for delete to anon, authenticated using (true);
