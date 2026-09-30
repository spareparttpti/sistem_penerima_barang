-- ============================================================================
-- AUTH SETUP — Login pakai USERNAME (bukan email) + ROLE (admin / crew).
--
-- Jalankan SEKALI di SQL Editor. Menyediakan dua fungsi RPC:
--   - create_user_account(p_username, p_password, p_role) → buat akun baru
--   - list_user_accounts()                                 → daftar akun
--
-- ---------------------------------------------------------------------------
-- ROLE: 'admin' atau 'crew'
--   - admin: lihat & kelola halaman Manajemen Pengguna, plus semua yang crew bisa.
--   - crew : hanya alur terima barang (Dashboard, Input Barang, Detail & QC).
--            TIDAK melihat menu Pengguna sama sekali.
-- Role disimpan di raw_user_meta_data->>'role' pada auth.users, dipilih saat
-- akun dibuat (dropdown di modal Tambah Pengguna).
--
-- Akun PERTAMA (bootstrap, sebelum ada siapa pun) SELALU dipaksa jadi 'admin'
-- apa pun yang dipilih di form — supaya tidak mungkin sistem berakhir tanpa
-- admin sama sekali (lihat komentar di create_user_account).
--
-- ---------------------------------------------------------------------------
-- KENAPA ADA "EMAIL SINTETIS" DI SINI
-- Supabase Auth (GoTrue) secara internal dibangun di atas kolom email — tidak
-- ada mode "murni username" bawaan. Solusinya: setiap username diam-diam
-- disimpan sebagai email palsu `<username>@spb.local` di dalam auth.users.
-- Domain .local sengaja dipakai (reserved, tidak pernah dikirimi email
-- sungguhan) dan TIDAK PERNAH ditampilkan ke pengguna. Nilai domain ini HARUS
-- SAMA PERSIS dengan yang dipakai di frontend/js/auth.js (konstanta
-- USERNAME_DOMAIN) — kalau salah satu diubah tanpa yang lain, login gagal.
--
-- ⚠️ CATATAN JUJUR: kedua fungsi menulis/membaca LANGSUNG tabel internal
-- Supabase Auth (auth.users, auth.identities) — bukan lewat Admin API resmi.
-- Ini pola yang umum dipakai komunitas dan bekerja di versi Postgres/GoTrue
-- saat ini, tapi TIDAK didukung resmi — kalau Supabase mengubah skema
-- internal auth mereka di masa depan, ini bisa berhenti bekerja.
-- ============================================================================

create extension if not exists pgcrypto; -- untuk crypt()/gen_salt() (hash password)

-- ---------------------------------------------------------------------------
-- create_user_account — buat akun baru dari username + password + role
--
-- DROP dulu, bukan langsung CREATE OR REPLACE: Postgres menolak REPLACE kalau
-- nama parameter ATAU jumlah parameter berubah dari versi sebelumnya (di sini
-- versi lama cuma punya 2 parameter, sekarang 3). DROP+CREATE membuat file ini
-- aman dijalankan ulang berapa kali pun ke depannya, apa pun perubahannya nanti.
-- ---------------------------------------------------------------------------
drop function if exists public.create_user_account(text, text);
drop function if exists public.create_user_account(text, text, text);
drop function if exists public.create_user_account(text, text, text, text);
drop function if exists public.create_user_account(text, text, text, text, text);

-- p_divisi HANYA dipakai (dan WAJIB diisi) kalau p_role = 'admin_divisi' — lihat
-- komentar role di bawah. Untuk role lain, boleh dikirim null/kosong, diabaikan.
-- p_access_level ('edit' default, atau 'view') — CUMA berlaku buat role
-- 'spinning' (lihat komentar di update_user_access_level di bawah). 'view'
-- artinya akun itu cuma bisa LIHAT modul Part Mesin, semua tombol
-- ajukan/approve/tambah didisable di sisi frontend (spinningPartMesin.js).
create function public.create_user_account(p_username text, p_password text, p_role text default 'crew', p_divisi text default null, p_access_level text default 'edit')
returns json
language plpgsql
security definer          -- jalan dengan hak pemilik fungsi (bisa tulis ke auth.*),
                           -- BUKAN hak pemanggil — makanya pengecekan akses di
                           -- bawah ini krusial, jangan dihapus.
set search_path = public, extensions, auth, pg_temp
as $$
declare
  v_username     text := lower(trim(p_username));
  v_email        text := lower(trim(p_username)) || '@spb.local'; -- HARUS sama dengan auth.js
  v_role         text := lower(trim(coalesce(p_role, 'crew')));
  v_divisi       text := nullif(trim(coalesce(p_divisi, '')), '');
  v_access_level text := lower(trim(coalesce(p_access_level, 'edit')));
  v_user_id      uuid;
  v_has_users    boolean;
  v_caller_role  text;
begin
  -- ---------------------------------------------------------------------
  -- Gerbang akses: siapa boleh membuat akun baru & role apa yang diizinkan.
  -- ---------------------------------------------------------------------
  select exists (select 1 from auth.users limit 1) into v_has_users;

  if v_has_users then
    -- Sudah ada akun -> HANYA admin yang boleh menambah pengguna baru.
    -- `is distinct from` menangani auth.uid() null (belum login) DAN
    -- login-tapi-bukan-admin dengan satu pengecekan yang sama.
    select raw_user_meta_data->>'role' into v_caller_role
    from auth.users where auth.users.id = auth.uid();

    if v_caller_role is distinct from 'admin' then
      raise exception 'Hanya admin yang boleh menambah pengguna baru.' using errcode = '42501';
    end if;
  else
    -- Akun PERTAMA di sistem ini — paksa jadi admin apa pun yang dipilih di
    -- form, supaya tidak mungkin sistem ini berakhir tanpa satu pun admin
    -- (mis. kalau form-nya entah kenapa mengirim role lain saat bootstrap).
    v_role := 'admin';
  end if;

  if v_role not in ('admin', 'crew', 'admin_divisi', 'spinning') then
    raise exception 'Role harus "admin", "crew", "admin_divisi", atau "spinning".' using errcode = '22023';
  end if;

  -- admin_divisi WAJIB terkait ke satu divisi (dipakai buat menyaring Live
  -- Antrean & bedain wording voice-over "siap diambil" khusus divisinya).
  -- spinning SELALU divisi 'Spinning' (dashboard-nya total beda, bukan cuma
  -- versi terfilter dari dashboard gudang — lihat app.js/spinningDashboard.js).
  if v_role = 'admin_divisi' and v_divisi is null then
    raise exception 'Pilih divisi untuk role Admin Divisi.' using errcode = '22023';
  end if;
  if v_role = 'spinning' then
    v_divisi := 'Spinning';
  end if;
  if v_role not in ('admin_divisi', 'spinning') then
    v_divisi := null; -- role lain nggak butuh, jangan sampai nyangkut data basi
  end if;

  if v_access_level not in ('edit', 'view') then
    v_access_level := 'edit';
  end if;
  if v_role <> 'spinning' then
    v_access_level := 'edit'; -- cuma relevan buat role spinning, role lain diabaikan
  end if;

  -- ---------------------------------------------------------------------
  -- Validasi input — huruf kecil/besar, angka, titik, garis bawah, strip.
  -- Tanpa spasi, tanpa @ (supaya jelas beda dari email, dan tidak bentrok
  -- format email sintetis di atas).
  -- ---------------------------------------------------------------------
  if v_username !~ '^[a-z0-9_.-]{3,32}$' then
    raise exception 'Username harus 3-32 karakter: huruf, angka, titik (.), underscore (_), atau strip (-). Tanpa spasi.'
      using errcode = '22023';
  end if;
  -- Tidak ada minimal panjang — terserah yang buat akun. Cuma dijaga tidak kosong.
  if length(p_password) < 1 then
    raise exception 'Password tidak boleh kosong.' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'Username "%" sudah dipakai. Coba username lain.', v_username using errcode = '23505';
  end if;

  -- ---------------------------------------------------------------------
  -- Tulis ke auth.users + auth.identities — dua tabel yang dipakai GoTrue
  -- untuk login. email_confirmed_at diisi langsung (now()) supaya akun aktif
  -- seketika. raw_user_meta_data menyimpan username & role supaya kode
  -- frontend bisa membacanya langsung tanpa query tambahan.
  -- ---------------------------------------------------------------------
  v_user_id := gen_random_uuid();

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_user_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    json_build_object('username', v_username, 'role', v_role, 'divisi', v_divisi, 'access_level', v_access_level)::jsonb,
    '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_user_id, v_user_id::text,
    json_build_object('sub', v_user_id::text, 'email', v_email)::jsonb,
    'email', now(), now(), now()
  );

  return json_build_object('id', v_user_id, 'username', v_username, 'role', v_role, 'divisi', v_divisi, 'access_level', v_access_level);
end;
$$;

revoke all on function public.create_user_account(text, text, text, text, text) from public;
grant execute on function public.create_user_account(text, text, text, text, text) to anon, authenticated;

comment on function public.create_user_account is
  'Buat akun login (username+password+role+divisi+access_level) lewat RPC — supabase.rpc('
  '''create_user_account'', {p_username, p_password, p_role, p_divisi, p_access_level}). Role: '
  'admin|crew|admin_divisi|spinning (divisi wajib kalau admin_divisi; access_level edit|view cuma '
  'relevan kalau spinning). Akun pertama selalu jadi admin (bootstrap, boleh tanpa login); setelahnya '
  'HANYA admin yang boleh menambah akun baru.';

-- ---------------------------------------------------------------------------
-- list_user_accounts — daftar akun untuk halaman Manajemen Pengguna
-- (DROP dulu — sama alasannya seperti create_user_account di atas: kolom
-- balikannya bertambah "role", dan Postgres menolak REPLACE yang mengubah
-- bentuk hasil tanpa DROP dulu.)
-- ---------------------------------------------------------------------------
drop function if exists public.list_user_accounts();

create function public.list_user_accounts()
returns table (id uuid, username text, role text, divisi text, access_level text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_caller_role text;
begin
  -- Hanya admin yang boleh melihat daftar pengguna — orang lain yang sudah
  -- login pun tetap ditolak di sini, bukan cuma di sisi UI.
  select raw_user_meta_data->>'role' into v_caller_role
  from auth.users where auth.users.id = auth.uid();

  if v_caller_role is distinct from 'admin' then
    raise exception 'Hanya admin yang boleh melihat daftar pengguna.' using errcode = '42501';
  end if;

  return query
    select u.id,
           coalesce(u.raw_user_meta_data->>'username', split_part(u.email, '@', 1)) as username,
           coalesce(u.raw_user_meta_data->>'role', 'crew') as role,
           u.raw_user_meta_data->>'divisi' as divisi,
           coalesce(u.raw_user_meta_data->>'access_level', 'edit') as access_level,
           u.created_at,
           u.last_sign_in_at
    from auth.users u
    order by u.created_at desc;
end;
$$;

revoke all on function public.list_user_accounts() from public;
grant execute on function public.list_user_accounts() to authenticated;

comment on function public.list_user_accounts() is
  'Daftar semua akun (username, role, divisi, dibuat kapan, terakhir login) — dipakai '
  'halaman Manajemen Pengguna. Wajib admin untuk memanggilnya.';

-- ---------------------------------------------------------------------------
-- update_user_access_level — ubah 'edit'/'view' akun role 'spinning' TANPA
-- perlu bikin ulang akunnya. Cuma admin yang boleh, sama pola gerbang akses
-- kayak fungsi lain di file ini. Dipakai tombol "Ubah Akses" di halaman
-- Manajemen Pengguna (users.js) — SATU-SATUNYA tempat pengaturan ini ada,
-- sesuai permintaan eksplisit: cuma Admin Gudang yang boleh mengatur ini.
-- ---------------------------------------------------------------------------
drop function if exists public.update_user_access_level(text, text);

create function public.update_user_access_level(p_username text, p_access_level text)
returns void
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_caller_role text;
  v_email text := lower(trim(p_username)) || '@spb.local';
  v_target_role text;
  v_level text := lower(trim(coalesce(p_access_level, 'edit')));
begin
  select raw_user_meta_data->>'role' into v_caller_role
  from auth.users where auth.users.id = auth.uid();
  if v_caller_role is distinct from 'admin' then
    raise exception 'Hanya admin yang boleh mengubah akses pengguna.' using errcode = '42501';
  end if;

  if v_level not in ('edit', 'view') then
    raise exception 'Akses harus "edit" atau "view".' using errcode = '22023';
  end if;

  select raw_user_meta_data->>'role' into v_target_role from auth.users where email = v_email;
  if v_target_role is null then
    raise exception 'Akun "%" tidak ditemukan.', p_username using errcode = 'P0002';
  end if;
  if v_target_role <> 'spinning' then
    raise exception 'Pengaturan akses cuma berlaku untuk akun role Spinning.' using errcode = '22023';
  end if;

  update auth.users
     set raw_user_meta_data = raw_user_meta_data || json_build_object('access_level', v_level)::jsonb
   where email = v_email;
end;
$$;

revoke all on function public.update_user_access_level(text, text) from public;
grant execute on function public.update_user_access_level(text, text) to authenticated;

comment on function public.update_user_access_level(text, text) is
  'Ubah access_level (edit|view) akun role spinning — supabase.rpc(''update_user_access_level'', '
  '{p_username, p_access_level}). Wajib admin. Dipakai halaman Manajemen Pengguna.';

-- ---------------------------------------------------------------------------
-- reset_user_account_password — "Lupa Password" versi admin (bukan lewat
-- email, soalnya akun di sini pakai email SINTETIS <username>@spb.local yang
-- bukan email asli — nggak ada tempat buat ngirim link reset beneran).
-- Admin bisa reset password akun MANA PUN (termasuk akunnya sendiri) langsung
-- dari halaman Manajemen Pengguna, tanpa perlu buka Supabase Dashboard.
-- ---------------------------------------------------------------------------
drop function if exists public.reset_user_account_password(text, text);

create function public.reset_user_account_password(p_username text, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $$
declare
  v_caller_role text;
  v_email text;
begin
  select raw_user_meta_data->>'role' into v_caller_role
  from auth.users where auth.users.id = auth.uid();

  if v_caller_role is distinct from 'admin' then
    raise exception 'Hanya admin yang boleh reset password akun.' using errcode = '42501';
  end if;

  if length(p_new_password) < 1 then
    raise exception 'Password tidak boleh kosong.' using errcode = '22023';
  end if;

  v_email := lower(trim(p_username)) || '@spb.local';

  if not exists (select 1 from auth.users where email = v_email) then
    raise exception 'Akun "%" tidak ditemukan.', p_username using errcode = 'P0002';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where email = v_email;
end;
$$;

revoke all on function public.reset_user_account_password(text, text) from public;
grant execute on function public.reset_user_account_password(text, text) to authenticated;

comment on function public.reset_user_account_password(text, text) is
  'Reset password akun (dipanggil lewat RPC supabase.rpc(''reset_user_account_password'', '
  '{p_username, p_new_password})) — dipakai halaman Manajemen Pengguna. Wajib admin, '
  'bisa reset akun siapa pun termasuk akun sendiri (dipakai kalau lupa password login).';

-- ---------------------------------------------------------------------------
-- forgot_password_reset — "Lupa Password" versi HALAMAN LOGIN (SEBELUM login),
-- dipanggil dari tombol "Lupa Password?" di login.js. BEDA dari
-- reset_user_account_password di atas: fungsi ini SENGAJA bisa dipanggil
-- tanpa sesi login sama sekali (grant ke `anon`), dan TIDAK ADA verifikasi
-- identitas tambahan (nggak ada pertanyaan keamanan/PIN/email) — cuma modal
-- username + password baru, atas permintaan eksplisit user sistem ini.
--
-- ⚠️ TRADE-OFF KEAMANAN YANG DISADARI: siapa pun yang tau USERNAME orang lain
-- bisa ganti password akun itu tanpa perlu tau password lama. Ini pilihan
-- sadar buat kemudahan (tim kecil, semua saling kenal) — BUKAN kelalaian.
-- Kalau nanti mau dikerasin, tambahkan pertanyaan keamanan/PIN cadangan
-- sebagai syarat tambahan di fungsi ini sebelum update password-nya.
-- ---------------------------------------------------------------------------
drop function if exists public.forgot_password_reset(text, text);

create function public.forgot_password_reset(p_username text, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $$
declare
  v_email text := lower(trim(p_username)) || '@spb.local';
begin
  if length(p_new_password) < 1 then
    raise exception 'Password tidak boleh kosong.' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users where email = v_email) then
    raise exception 'Username "%" tidak ditemukan.', p_username using errcode = 'P0002';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where email = v_email;
end;
$$;

revoke all on function public.forgot_password_reset(text, text) from public;
grant execute on function public.forgot_password_reset(text, text) to anon, authenticated;

comment on function public.forgot_password_reset(text, text) is
  'Reset password TANPA login (dipanggil dari tombol "Lupa Password?" di halaman '
  'Masuk, supabase.rpc(''forgot_password_reset'', {p_username, p_new_password})). '
  'SENGAJA tanpa verifikasi identitas tambahan — trade-off keamanan yang disadari, '
  'diminta eksplisit oleh pemilik sistem ini (tim kecil, saling kenal).';

-- ============================================================================
-- MIGRASI dari versi lama
-- Aman dijalankan meski belum pernah pakai versi lama — tidak melakukan apa-apa
-- kalau tidak ada baris yang cocok.
--   1) Isi 'username' kalau kosong (dari versi berbasis email paling lama).
--   2) Isi 'role': akun bernama 'aulia26' jadi admin (dia admin hardcode versi
--      sebelumnya), sisanya default 'crew'.
-- ============================================================================
update auth.users
   set raw_user_meta_data = raw_user_meta_data || json_build_object('username', split_part(email, '@', 1))::jsonb
 where raw_user_meta_data->>'username' is null
   and email is not null;

update auth.users
   set raw_user_meta_data = raw_user_meta_data || json_build_object(
         'role', case when raw_user_meta_data->>'username' = 'aulia26' then 'admin' else 'crew' end
       )::jsonb
 where raw_user_meta_data->>'role' is null;

notify pgrst, 'reload schema';

-- ============================================================================
-- user_permissions — Matriks Permission PER PENGGUNA (bukan per role) x
-- modul x aksi, diedit langsung dari halaman Manajemen Pengguna (users.js) —
-- klik "Edit" di samping satu username, muncul matriksnya. BEDA dari
-- role_inventory_access (yang cuma ngatur produk stok mana yang kelihatan)
-- — tabel ini soal MODUL/HALAMAN apa saja yang boleh diakses satu akun dan
-- aksi apa yang boleh dilakukan di situ (Lihat/Tambah/Ubah/Hapus/Approve/
-- Ekspor).
--
-- CATATAN PENTING: tabel & UI-nya sudah jalan (bisa disimpan & dibaca),
-- TAPI belum ada satu pun halaman lain di app yang benar-benar MEMBACA
-- tabel ini buat menolak akses — pengecekan role saat ini masih pola lama
-- (isAdmin()/isCrew()/dst tersebar di app.js & file lain). Anggap ini
-- "panel kontrolnya" dulu; menyambungkan tiap halaman ke tabel ini adalah
-- pekerjaan susulan yang lebih besar.
--
-- `username` dipakai sebagai key (bukan user id) — konsisten dengan pola
-- RPC lain di file ini yang semua identifikasi akun pakai username, dan
-- baris permission-nya otomatis "ikut lepas" kalau akunnya dihapus (lihat
-- delete_user_account di bawah, yang membersihkan baris ini juga).
-- ============================================================================
create table if not exists public.user_permissions (
  id         uuid primary key default gen_random_uuid(),
  username   text not null,
  module     text not null,   -- 'dashboard', 'wh-out', 'karyawan', dst — lihat MODULES di users.js
  action     text not null check (action in ('lihat', 'tambah', 'ubah', 'hapus', 'approve', 'ekspor')),
  allowed    boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_user_permissions_unique on public.user_permissions(username, module, action);
create index if not exists idx_user_permissions_username on public.user_permissions(username);

alter table public.user_permissions enable row level security;
drop policy if exists "user_permissions select" on public.user_permissions;
create policy "user_permissions select" on public.user_permissions for select to authenticated using (true);
drop policy if exists "user_permissions insert" on public.user_permissions;
create policy "user_permissions insert" on public.user_permissions for insert to authenticated with check (true);
drop policy if exists "user_permissions update" on public.user_permissions;
create policy "user_permissions update" on public.user_permissions for update to authenticated using (true);
drop policy if exists "user_permissions delete" on public.user_permissions;
create policy "user_permissions delete" on public.user_permissions for delete to authenticated using (true);

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- delete_user_account — hapus akun login dari halaman Manajemen Pengguna
-- (tombol "Hapus" di samping username). Admin-only, tidak boleh hapus akun
-- sendiri, dan tidak boleh hapus admin TERAKHIR (biar sistem nggak pernah
-- kehabisan admin). Baris user_permissions milik akun itu ikut dibersihkan.
-- ---------------------------------------------------------------------------
drop function if exists public.delete_user_account(text);

create function public.delete_user_account(p_username text)
returns void
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_caller_role     text;
  v_caller_username text;
  v_username        text := lower(trim(p_username));
  v_target_id       uuid;
  v_target_role     text;
  v_admin_count     int;
begin
  select raw_user_meta_data->>'role', raw_user_meta_data->>'username'
    into v_caller_role, v_caller_username
    from auth.users where auth.users.id = auth.uid();

  if v_caller_role is distinct from 'admin' then
    raise exception 'Hanya admin yang boleh menghapus pengguna.' using errcode = '42501';
  end if;
  if v_username = lower(trim(coalesce(v_caller_username, ''))) then
    raise exception 'Tidak bisa menghapus akun sendiri.' using errcode = '22023';
  end if;

  select id, raw_user_meta_data->>'role' into v_target_id, v_target_role
    from auth.users where email = v_username || '@spb.local';
  if v_target_id is null then
    raise exception 'Akun "%" tidak ditemukan.', p_username using errcode = 'P0002';
  end if;

  if v_target_role = 'admin' then
    select count(*) into v_admin_count from auth.users where raw_user_meta_data->>'role' = 'admin';
    if v_admin_count <= 1 then
      raise exception 'Tidak bisa menghapus admin terakhir di sistem.' using errcode = '22023';
    end if;
  end if;

  delete from public.user_permissions where username = v_username;
  delete from auth.identities where user_id = v_target_id;
  delete from auth.users where id = v_target_id;
end;
$$;

revoke all on function public.delete_user_account(text) from public;
grant execute on function public.delete_user_account(text) to authenticated;

comment on function public.delete_user_account(text) is
  'Hapus akun login (supabase.rpc(''delete_user_account'', {p_username})) — dipakai halaman '
  'Manajemen Pengguna. Wajib admin, tidak bisa hapus diri sendiri atau admin terakhir.';

-- ============================================================================
-- VERIFIKASI CEPAT (jalankan terpisah setelah script di atas sukses)
-- ============================================================================
-- select public.create_user_account('budi', 'password123', 'crew');
-- select * from public.list_user_accounts();
