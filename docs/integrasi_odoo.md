# 🔗 Integrasi Odoo → SPB

Menyambungkan data **Receipts (WH/IN)** dari Odoo ke Sistem Penerimaan Barang, supaya saat
barang datang petugas tinggal pilih No WH/IN dan data vendor, No PO, serta daftar item
langsung terisi otomatis — lalu qty fisik dicocokkan dengan qty PO.

---

## Tiga mode, pilih sesuai kesiapan

| | **Import File** | **Tarik Otomatis (Pull)** | **Webhook (push)** |
|---|---|---|---|
| Kapan data masuk | Saat petugas import file | Terjadwal (mis. tiap 15 menit) | Seketika saat diinput di Odoo |
| Butuh Supabase | Tidak | Ya | Ya |
| Perlu setting di Odoo | Tidak | **Tidak — nol setting** | Ya (Automated Action) |
| Kredensial Odoo | Tidak | Email + password biasa | Password/API key (Automated Action) |
| Butuh Developer Mode Odoo | Tidak | Tidak | Ya |
| Data tersimpan di | Browser (per-perangkat) | Supabase (semua perangkat) | Supabase (semua perangkat) |
| Siap dipakai | Sekarang juga | Setelah setup (~10 menit) | Setelah setup |

**Rekomendasi: mulai dari Tarik Otomatis.** Sifatnya paling dekat dengan Import File —
program kamu yang aktif menjemput data, memakai email+password akun Odoo biasa, tanpa
menyentuh konfigurasi Odoo sama sekali. Webhook (push) baru masuk akal kalau butuh
benar-benar seketika (selisih detik, bukan menit) dan kamu sudah nyaman mengubah setting Odoo.

Ketiganya bisa hidup berdampingan — Import File tetap berguna sebagai cadangan kalau
koneksi bermasalah.

Dokumen ini dibagi tiga: **Import File (CSV/XLSX)**, lalu
[**Tarik Otomatis (Pull, tanpa setting Odoo)**](#-tarik-otomatis-pull---tanpa-setting-odoo),
lalu [**Webhook (push, real-time)**](#-mode-real-time-webhook).

---

## Cara Pakai (Harian)

### 1. Export dari Odoo

1. Buka **Inventory → Transfers → Receipts** (list yang berisi WH/IN/xxxxx).
2. Centang baris yang mau diambil (atau centang kotak paling atas untuk semua).
3. **⚙️ Action → Export**.
4. Pilih format **XLSX** atau **CSV** — keduanya didukung.
5. Pastikan kolom berikut ikut diekspor:

   | Kolom Odoo | Kegunaan di SPB |
   |---|---|
   | **Reference** | No WH/IN — **wajib**, ini kunci pencocokan |
   | Contact | Nama vendor terisi otomatis |
   | Source Document | No PO terisi otomatis |
   | Scheduled Date | Tanggal jadwal kedatangan |
   | Status | Menyaring yang sudah Done/Cancelled |
   | **Operations → Product** | Nama barang — **harus ditambahkan manual** |
   | **Operations → Demand** (atau Quantity) | Qty PO, dibandingkan dengan qty fisik |
   | Operations → Unit of Measure | Satuan (opsional) |

   > ⚠️ **Paling sering terlewat:** kolom di grup **Operations** TIDAK ikut otomatis meski
   > terlihat di layar Odoo. Di dialog Export, buka grup `Operations` di panel kiri dan
   > tambahkan `Product` + `Demand` sendiri. Tanpa itu, penerimaan tetap masuk ke log
   > tapi **tanpa rincian barang** — tabel Detail Item akan kosong.
   >
   > Kalau terlanjur, cukup export ulang dengan kolom lengkap lalu import lagi: baris yang
   > masih berstatus **Draft** akan terisi otomatis.
6. Klik **Export** → file `.xlsx` atau `.csv` terunduh.

### 2. Import ke SPB

1. Buka **Dashboard** → klik tombol **Import Odoo** di kanan atas.
2. Pilih file hasil export tadi.
3. Data langsung masuk ke tabel **Log Penerimaan Realtime** sebagai antrean
   berstatus **Draft** (menunggu kedatangan) — tidak ada penyimpanan terpisah.

Yang terjadi saat import:

| Kondisi di Odoo | Perlakuan di SPB |
|---|---|
| WH/IN baru | Ditambahkan sebagai antrean Draft |
| WH/IN sudah ada, masih Draft | Diperbarui mengikuti Odoo |
| WH/IN sudah dikonfirmasi datang / di-QC | **Dilewati** — hasil kerja petugas tidak pernah ditimpa |
| Status `Cancelled` di Odoo | **Dilewati** — barangnya tidak akan datang |

Karena itu import ulang setiap hari aman dilakukan berkali-kali.

### 3. Saat Barang Datang

1. Di Dashboard, cari barisnya (statusnya **Draft**, tombolnya **Barang Datang**).
   Kolom **Tanggal** untuk baris ini menampilkan **tanggal pemesanan**, ditandai
   label kecil `tgl pemesanan` agar tidak tertukar dengan tanggal kedatangan.
2. **Klik barisnya** → halaman detail terbuka, berisi informasi penerimaan,
   No WH/IN, dan daftar item beserta qty sesuai PO Odoo.
3. Di panel **Konfirmasi Kedatangan Barang**, isi **Nama Petugas Penerima**.
4. Tekan **Done — Barang Sudah Datang**.

Tanggal dan jam otomatis memakai **waktu saat tombol ditekan** — bukan waktu halaman
dibuka. Jadi kalau petugas membuka halaman lalu baru menekan Done setengah jam kemudian,
yang tercatat tetap benar.

Field tanggal/jam hanya perlu diubah kalau barang datang di waktu lain (mis. dicatat
menyusul keesokan harinya). Begitu diubah manual, isian petugas yang dipakai — tidak
ditimpa waktu klik.

Status berubah menjadi **In Inspection**, kolom Tanggal di Dashboard beralih
menampilkan **tanggal kedatangan** (label `tgl barang datang`), dan notifikasi
Teamly terkirim ke tim gudang.

Setelah itu alur QC berjalan seperti biasa: **Approve** atau **Reject** di halaman
yang sama.

> Tombol Done hanya bisa ditekan sekali. Kalau ditekan lagi, sistem menolak dengan
> pesan bahwa penerimaan sudah ditandai datang sebelumnya.

### Cetak Surat Jalan

Di halaman detail ada tombol **Cetak Surat Jalan** (pojok kanan atas). Dokumen A4 yang
dihasilkan berisi:

- Kop perusahaan — diatur di `COMPANY` pada [frontend/js/config.js](../frontend/js/config.js)
- No WH/IN, No PO, vendor, tanggal pemesanan, tanggal kedatangan, petugas, status
- Tabel barang: SKU, nama, **Qty PO vs Qty Diterima**, kondisi, plus baris total
- Tiga kolom tanda tangan: Pengirim/Vendor, Penerima/Gudang, Mengetahui

Bisa dicetak kapan saja — sebelum maupun sesudah barang datang. Kalau rincian barang belum
ada (kolom Operations tidak diekspor), tabelnya tetap tercetak dengan baris kosong supaya
bisa diisi tangan saat serah terima.

Dokumen tidak membuka jendela baru; ia disembunyikan di halaman yang sama dan hanya muncul
saat dicetak — jadi tidak akan diblokir sebagai popup. Di dialog cetak browser, pilih
**Save as PDF** kalau ingin menyimpan alih-alih mencetak.

### Dua tanggal yang berbeda

Ini pembedaan yang paling mudah tertukar, jadi ditegaskan di seluruh tampilan:

| Field | Asal | Arti |
|---|---|---|
| `order_date` | Scheduled Date di Odoo | Tanggal pemesanan / jadwal rencana |
| `arrival_date` | Diisi petugas saat konfirmasi | Tanggal barang fisik tiba di gudang |

Keduanya disimpan terpisah dan sama-sama ditampilkan di halaman detail, jadi selisih
antara rencana dan kenyataan tetap bisa ditelusuri.

---

## Catatan Teknis

### Pencocokan item Odoo ↔ master sparepart

Urutan prioritas: **SKU persis → nama persis → nama mengandung**. Format Odoo
`[SPR-0001] Bearing SKF 6205` juga dikenali (kode dalam kurung siku dipakai sebagai SKU).

Item yang tidak ketemu padanannya **tidak ditebak**. Nama dan SKU asli dari Odoo tetap
ditampilkan apa adanya di halaman detail, diberi tanda `belum terdaftar`. Menebak SKU lebih
berbahaya daripada menampilkan data mentahnya.

Kalau banyak item tidak cocok, tambahkan SKU-nya ke tabel `spareparts` agar cocok otomatis
di kemudian hari.

### Format yang ditangani parser

**Berlaku untuk CSV & XLSX:**

- Header dalam bahasa Inggris maupun Indonesia, serta nama teknis field (`partner_id`, `origin`, …)
- Baris item lanjutan yang kolom header-nya kosong (hasil export dengan sub-field)
- Angka format ID (`1.250,50`) maupun EN (`1,250.50`)
- Status Odoo internal (`assigned`, `done`, `cancel`) maupun label UI (`Ready`, `Done`, `Cancelled`)

**Khusus CSV:**

- Pemisah kolom `,` maupun `;` (terdeteksi otomatis dari baris header)
- Field ber-tanda kutip, koma di dalam nama (`"GURITA MANDALA PERSADA, PT."`), dan BOM UTF-8

**Khusus XLSX:**

- Dibaca **tanpa library eksternal** — `.xlsx` adalah arsip ZIP berisi XML, dibuka memakai
  `DecompressionStream` bawaan browser. Aplikasi tetap bisa jalan tanpa internet.
- Tanggal serial Excel (mis. `45993.33`) dikonversi otomatis ke `2025-12-02`. Konversi ini
  **hanya** diterapkan pada kolom tanggal, jadi tidak mungkin mengacaukan angka qty.
- Sel kosong yang tidak ditulis di XML tetap terhitung, jadi kolom tidak bergeser
- Worksheet pertama yang dipakai kalau file berisi banyak sheet
- Karakter khusus (`&`, `<`, `>`) di nama vendor/produk
- **`.xls` lama (biner) tidak didukung** — formatnya sama sekali berbeda. Odoo mengekspor
  `.xlsx`, jadi ini jarang jadi masalah. Kalau terlanjur punya `.xls`, buka di Excel lalu
  *Save As* `.xlsx`.
- Butuh browser modern (Chrome/Edge 80+, Firefox 113+, Safari 16.4+). Kalau browsernya
  terlalu lama, muncul pesan yang menyarankan pakai CSV.

### Penyimpanan

Hasil import **tidak disimpan terpisah**. Data langsung masuk ke `penerimaan_barang`
(dan `detail_penerimaan`) — sumber yang sama dengan penerimaan manual — sehingga log
Dashboard selalu menampilkan satu kebenaran, bukan dua salinan yang bisa berbeda.

Kolom baru di `penerimaan_barang`: `wh_in_ref`, `order_date`, `arrival_date`, `odoo_state`,
`source`. Di `detail_penerimaan`: `product_name`, `sku`, `qty_po`, dan `sparepart_id`
dilonggarkan jadi nullable (item Odoo belum tentu ada di master).

Jalankan ulang [supabase_schema.sql](../database/supabase_schema.sql) untuk menambahkannya
ke database yang sudah ada — idempotent, aman.

Dalam mode demo (`demoMode: true`), semuanya tetap di `localStorage` browser dan bersifat
**per-perangkat**.

---

# 🟢 TARIK OTOMATIS (Pull) — tanpa setting Odoo

Program kamu yang aktif menjemput data dari Odoo secara berkala — sama seperti cara rekan
kerjamu menarik data absensi/tracking dari sistem vendor: bukan lewat "API resmi" yang
harus diminta ke IT, tapi login memakai **email + password akun Odoo biasa** (kredensial
yang sama dipakai login ke web Odoo sehari-hari), lalu membaca data lewat endpoint yang
memang disediakan Odoo untuk client web-nya sendiri (JSON-RPC).

**Odoo tidak disentuh sama sekali** — tidak ada Automated Action, tidak ada Developer Mode,
tidak ada API key khusus yang perlu dibuatkan. Kalau akun Odoo kamu tidak memakai 2FA,
password login biasa sudah cukup.

## Cara kerja

```
Supabase Cron (tiap 15 menit, bisa diatur)
   ↓ memanggil
Edge Function `odoo-pull`
   ↓ login (email + password) → JSON-RPC search_read stock.picking
Odoo  (hanya DIBACA — tidak pernah ditulis)
   ↓
Tabel penerimaan_barang + detail_penerimaan (langsung — sama seperti Import File)
   ↓
Dashboard SPB
```

## Setup

1. **SQL Editor** Supabase → jalankan [database/supabase_schema.sql](../database/supabase_schema.sql)
   (kalau belum) supaya kolom `wh_in_ref`, `order_date`, dst. ada.
2. Deploy function:

   ```bash
   supabase secrets set ODOO_URL=https://<odoo-kamu>
   supabase secrets set ODOO_DB=<nama-database>
   supabase secrets set ODOO_USER=<email-login-odoo>
   supabase secrets set ODOO_PASSWORD=<password-akun-odoo>
   supabase functions deploy odoo-pull
   ```

   `ODOO_DB` bisa dilihat di URL login Odoo, atau tanya IT satu kali saja (ini bukan
   kredensial rahasia, cuma nama database).

3. **Uji manual dulu**, sebelum dijadwalkan:

   ```bash
   curl -X POST https://<ref>.supabase.co/functions/v1/odoo-pull \
     -H "Authorization: Bearer <anon-key>"
   ```

   Balasan sukses: `{"ok":true,"fetched":12,"added":8,"updated":2,"locked":1,"cancelled":1,"errors":[]}`

4. Cek hasilnya langsung di **Dashboard** SPB — harusnya WH/IN baru sudah muncul sebagai
   antrean Draft, tanpa kamu import apa pun secara manual.

5. **Jadwalkan** — Supabase Dashboard → **Database → Cron Jobs** → New cron job, atau lewat SQL:

   ```sql
   select cron.schedule(
     'odoo-pull-15min',
     '*/15 * * * *',                 -- tiap 15 menit; ubah sesuai kebutuhan
     $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/odoo-pull',
       headers := jsonb_build_object('Authorization', 'Bearer <anon-key>')
     );
     $$
   );
   ```

   Butuh ekstensi `pg_cron` dan `pg_net` aktif — keduanya tersedia di semua paket Supabase,
   tinggal diaktifkan di **Database → Extensions**.

## Kenapa ini bisa tanpa "API key resmi"

Login Odoo (`common.login`) menerima **password atau API key di field yang sama** — Odoo
tidak membedakan keduanya di endpoint ini. API key hanya *wajib* kalau akun memakai
autentikasi dua faktor (2FA), karena password biasa tidak cukup saat 2FA aktif. Di luar
itu, password akun yang sudah kamu punya sekarang sudah cukup — tidak ada langkah
tambahan yang perlu diminta ke siapa pun.

Ini bukan celah keamanan atau scraping HTML — JSON-RPC adalah endpoint resmi yang dipakai
Odoo Web Client itu sendiri untuk semua operasinya. Fungsi ini memakainya persis seperti
browser kamu memakainya saat kamu login manual, hanya **read-only**: satu-satunya
pemanggilan yang dipakai adalah `read` dan `search_read`, tidak ada `write`/`create`/`unlink`.

## Keamanan

- Simpan `ODOO_PASSWORD` sebagai **secret** Edge Function — jangan pernah di URL, chat,
  atau kode yang di-commit.
- Kalau ragu, buat **user Odoo terpisah** khusus integrasi ini dengan hak akses **read-only**
  ke modul Inventory saja (Odoo mendukung ini lewat Access Rights per user/group). Jauh
  lebih aman daripada memakai akun pribadi.
- Fungsi ini hanya membaca `stock.picking` dan `stock.move` — tidak menyentuh modul lain.

---

# 🔴 MODE REAL-TIME (Webhook)

Supaya data **langsung masuk begitu orang input di Odoo** — tanpa export manual sama sekali.

Alurnya:

```
Odoo (Automated Action, saat WH/IN dibuat/diubah)
   ↓ HTTP POST
Edge Function `odoo-webhook` di Supabase
   ↓
Tabel odoo_receipts + odoo_receipt_lines
   ↓ tombol "Sync Odoo"
Program SPB
```

Odoo tidak pernah dihubungi langsung dari browser — kena CORS dan kredensial akan terbaca
di source code. Karena itu Edge Function jadi perantara.

## Langkah 1 — Cek versi Odoo

Cara setup berbeda antar versi. Cek dulu:

- Klik ikon **⋮⋮⋮** (kotak-kotak) di pojok kiri atas → **About** / **Tentang**, **atau**
- Buka URL: `https://<odoo-kamu>/web#action=base_setup.action_general_configuration`
  lalu scroll ke bawah — versi tertera di footer

Catat angkanya (mis. `Odoo 16.0` atau `Odoo 17.0`).

## Langkah 2 — Siapkan sisi Supabase

1. **SQL Editor** → jalankan [database/odoo_integration.sql](../database/odoo_integration.sql)
   (membuat tabel `odoo_receipts`, `odoo_receipt_lines`, index, dan RLS).
2. Jalankan juga [database/supabase_schema.sql](../database/supabase_schema.sql) sekali lagi
   untuk menambah kolom `wh_in_ref` — idempotent, aman.
3. Buat token rahasia bebas (acak, panjang), lalu deploy function:

   ```bash
   supabase secrets set ODOO_WEBHOOK_TOKEN=<token-acak-panjang>
   supabase functions deploy odoo-webhook --no-verify-jwt
   ```

   `--no-verify-jwt` wajib karena Odoo tidak mengirim JWT Supabase. Sebagai gantinya
   endpoint dilindungi token di atas — **jangan dikosongkan**, function akan menolak
   semua request kalau token belum diset.

4. Isi `SUPABASE_URL` & `SUPABASE_ANON_KEY` di [frontend/js/config.js](../frontend/js/config.js)
   supaya tombol **Sync Odoo** muncul.

URL webhook-nya jadi:

```
https://<ref>.supabase.co/functions/v1/odoo-webhook?token=<token-acak-panjang>
```

## Langkah 3 — Setup di Odoo

Aktifkan **Developer Mode** dulu: Settings → scroll paling bawah → **Developer Tools** →
*Activate the developer mode*. Lalu muncul menu **Settings → Technical**.

### Kalau Odoo 17 / 18 / 19

Ada tipe action **Webhook** bawaan, tidak perlu menulis kode:

1. **Settings → Technical → Automation → Automated Actions** → **New**
2. Isi:
   - **Model**: `Transfer` (`stock.picking`)
   - **Trigger**: *On Save* / *On Creation & Update*
   - **Domain** (filter, penting — jangan kirim delivery order):
     `[("picking_type_code", "=", "incoming")]`
   - **Action To Do**: **Send Webhook Notification**
   - **URL**: URL webhook di Langkah 2
3. **Save**, lalu buka satu WH/IN di Odoo dan tekan Save untuk memicunya.

Odoo 17 hanya mengirim `{"_model": ..., "_id": ...}` — Edge Function akan menarik detail
lengkapnya lewat JSON-RPC. Untuk itu tambahkan secret berikut:

```bash
supabase secrets set ODOO_URL=https://<odoo-kamu>
supabase secrets set ODOO_DB=<nama-database>
supabase secrets set ODOO_USER=<email-login>
supabase secrets set ODOO_API_KEY=<api-key>
```

API key dibuat sendiri dari **Preferences → Account Security → New API Key**. User
**read-only sudah cukup** — integrasi ini hanya membaca, tidak pernah menulis ke Odoo.

### Kalau Odoo 16 atau lebih lama

Tidak ada tipe Webhook, jadi pakai **Execute Python Code**. Cara ini justru **tidak butuh
API key sama sekali**, karena Odoo mengirim datanya sendiri secara lengkap.

1. **Settings → Technical → Automation → Automated Actions** → **Create**
2. Isi:
   - **Model**: `Transfer` (`stock.picking`)
   - **Trigger**: *On Creation & Update*
   - **Apply on** (filter): `[("picking_type_code", "=", "incoming")]`
   - **Action To Do**: **Execute Python Code**
3. Paste kode ini di kolom Python Code:

```python
# Kirim data transfer masuk ke SPB (Supabase Edge Function)
import json
import urllib.request

URL = "https://<ref>.supabase.co/functions/v1/odoo-webhook?token=<token-acak-panjang>"

for pick in records:
    if pick.picking_type_code != "incoming":
        continue

    lines = []
    for mv in pick.move_ids:          # Odoo <=13 memakai: pick.move_lines
        lines.append({
            "product": mv.product_id.name or "",
            "sku": mv.product_id.default_code or "",
            "qty_po": mv.product_uom_qty,
            "uom": mv.product_uom.name or "pcs",
        })

    payload = {
        "wh_in_ref": pick.name,
        "odoo_picking_id": pick.id,
        "contact": pick.partner_id.name or "",
        "origin": pick.origin or "",
        "scheduled_date": str(pick.scheduled_date or "")[:10],
        "state": pick.state,
        "location_from": pick.location_id.complete_name or "",
        "location_to": pick.location_dest_id.complete_name or "",
        "lines": lines,
    }

    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        # Jangan sampai gagal kirim membuat user tidak bisa menyimpan transfer di Odoo
        log("SPB webhook gagal untuk %s: %s" % (pick.name, e))
```

> **Penting:** blok `try/except` itu bukan hiasan. Tanpa itu, kalau Supabase sedang down
> atau lambat, petugas gudang **tidak bisa menyimpan transfer di Odoo sama sekali**.
> Lebih baik satu WH/IN gagal terkirim (bisa disusul import file manual) daripada Odoo macet.

`move_ids` berganti nama antar versi — kalau muncul error field tidak ada, coba
`pick.move_lines` (Odoo ≤13) atau `pick.move_ids_without_package`.

## Langkah 4 — Uji

Uji Edge Function langsung tanpa menyentuh Odoo:

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/odoo-webhook?token=<token>" \
  -H "Content-Type: application/json" \
  -d '{"wh_in_ref":"WH/IN/99999","contact":"TES VENDOR","origin":"P99999",
       "scheduled_date":"2026-08-12","state":"assigned",
       "lines":[{"product":"Bearing SKF 6205","sku":"SPR-0001","qty_po":10,"uom":"pcs"}]}'
```

Balasan sukses: `{"ok":true,"saved":1,"refs":["WH/IN/99999"],"skipped":[]}`

Lalu cek di Supabase SQL Editor:

```sql
select * from public.odoo_receipts order by synced_at desc limit 5;
```

Terakhir, di SPB: **Input Barang Masuk → Sync Odoo** → cari `WH/IN/99999`.
Kalau muncul, rantainya sudah tersambung penuh.

Kalau gagal, cek log: Supabase Dashboard → **Edge Functions → odoo-webhook → Logs**.

## Catatan keamanan

- Endpoint berjalan tanpa JWT, jadi **token adalah satu-satunya pengaman**. Perlakukan
  seperti password: jangan ditulis di chat, dokumen publik, atau di-commit ke git.
- Tabel `odoo_receipts` bisa dibaca `anon` (frontend memakai anon key). Isinya nama vendor
  dan No PO. Kalau aplikasi nanti dibuka ke publik, ubah policy-nya menjadi
  `to authenticated` di [odoo_integration.sql](../database/odoo_integration.sql).
- Integrasi ini **satu arah**. Tidak ada satu pun jalur kode yang menulis ke Odoo, jadi
  tidak mungkin merusak data di sana.

## Kalau Odoo tidak bisa akses internet keluar

Sebagian instalasi Odoo di jaringan kantor diblokir dari koneksi keluar. Kalau webhook
selalu gagal padahal setup sudah benar, kemungkinan besar ini penyebabnya — minta tim IT
membuka akses ke domain `*.supabase.co`, atau tetap pakai jalur Export file manual.

---

# 🔐 Login (Supabase Auth, pakai Username)

Setelah `demoMode: false`, aplikasi wajib login — tidak ada halaman yang bisa diakses
tanpa akun. Ini WAJIB diselesaikan sebelum mengubah `demoMode`, karena tabel
`penerimaan_barang`/`detail_penerimaan` hanya bisa dibaca/ditulis oleh role
`authenticated` (lihat bagian F di `supabase_schema.sql`) — anon (belum login)
akan ditolak RLS.

**Login pakai username, bukan email.** Supabase Auth internal tetap berbasis email,
jadi di baliknya username diam-diam disimpan sebagai email sintetis
`<username>@spb.local` — domain khusus yang tidak pernah dipakai kirim email
sungguhan dan tidak pernah terlihat di UI mana pun. Konstanta domain ini ada di dua
tempat yang **harus sama persis**: `USERNAME_DOMAIN` di
[frontend/js/auth.js](../frontend/js/auth.js) dan di dalam fungsi
`create_user_account` pada [database/auth_setup.sql](../database/auth_setup.sql).

## Dua role: Admin & Crew

- **Admin** — bisa segalanya, termasuk buka halaman **Manajemen Pengguna** dan
  menambah akun baru.
- **Crew** — cuma alur terima barang: **Dashboard** + **Input Barang** + buka
  **Detail & QC**. Menu **Pengguna** tidak muncul sama sekali untuknya, dan
  kalaupun coba akses `#/pengguna` langsung lewat URL, tetap dilempar balik.

Role disimpan per-akun (`raw_user_meta_data->>'role'` di `auth.users`), dipilih
lewat dropdown saat membuat akun. Dicek di **dua lapis**: SQL (`create_user_account`
dan `list_user_accounts` menolak sendiri kalau pemanggilnya bukan admin — tidak bisa
diakali lewat console browser) dan UI (menu disembunyikan untuk kerapian).

## Cara buat akun — lewat aplikasi, bukan Supabase Dashboard

Buka halaman **Manajemen Pengguna** (menu **Pengguna** di header, khusus admin) →
**Tambah Pengguna** → isi username, password, pilih role (**Admin**/**Crew**) →
**Buat Akun**. Akun langsung aktif. Halaman ini juga menampilkan daftar semua akun,
role masing-masing, kapan dibuat, dan kapan terakhir login.

**Akun pertama** (sebelum ada siapa pun yang bisa login) juga dibuat lewat aplikasi —
di halaman **Masuk** ada link **"Buat akun pertama"**. Ini disebut mode *bootstrap*:
diizinkan **tanpa login** HANYA kalau di project ini belum ada satu pun akun
terdaftar, dan akun itu **selalu otomatis jadi Admin** apa pun yang dipilih —
supaya sistem tidak mungkin berakhir tanpa satu pun admin. Begitu akun pertama
jadi, jendela bootstrap otomatis tertutup sendiri.

### Setup — SQL sekali jalan, tidak ada Edge Function

Tidak ada Deno, tidak ada deploy function, tidak ada secret yang perlu diisi manual di
Supabase. Cukup satu file SQL:

1. Buka **SQL Editor** di project Supabase kamu
2. Buka [database/auth_setup.sql](../database/auth_setup.sql) di VSCode → copy semua isinya
3. Tempel ke SQL Editor → **Run**

Selesai — tombol "Tambah Pengguna" dan "Buat akun pertama" di aplikasi langsung
berfungsi, dipanggil lewat `supabase.rpc('create_user_account', {...})` dari
[frontend/js/auth.js](../frontend/js/auth.js).

> ⚠️ **Catatan jujur:** fungsi ini menulis langsung ke tabel internal Supabase Auth
> (`auth.users`, `auth.identities`) — bukan lewat Admin API resmi Supabase. Ini pola
> yang umum dipakai komunitas dan bekerja di versi Postgres/Auth saat ini, tapi
> **tidak didukung resmi** — kalau Supabase mengubah struktur tabel auth internal
> mereka di masa depan, fungsi ini bisa berhenti bekerja dan perlu disesuaikan ulang
> (lihat komentar lengkap di dalam file SQL-nya).

## Cara pakai

- Buka aplikasi → otomatis diarahkan ke halaman **Masuk** kalau belum login
- **Belum ada akun sama sekali?** Klik **"Buat akun pertama"** di halaman Masuk
- Sudah ada akun → isi username & password → **Masuk**
- Menu **Pengguna** di header untuk kelola akun (lihat daftar + tambah rekan kerja),
  ikon **Keluar** untuk logout

## File terkait

| File | Isi |
|---|---|
| [frontend/js/auth.js](../frontend/js/auth.js) | Sesi login, signIn/signOut, createUserAccount, listUserAccounts, konversi username↔email sintetis |
| [frontend/js/login.js](../frontend/js/login.js) | Halaman form login (username) |
| [frontend/js/addUser.js](../frontend/js/addUser.js) | Modal Tambah Pengguna |
| [frontend/js/users.js](../frontend/js/users.js) | Halaman Manajemen Pengguna (#/pengguna) — daftar akun + tombol tambah |
| [frontend/js/app.js](../frontend/js/app.js) | Gerbang router — redirect ke #/login kalau belum masuk |
| [database/auth_setup.sql](../database/auth_setup.sql) | Fungsi SQL `create_user_account` + `list_user_accounts` — jalankan sekali di SQL Editor |
