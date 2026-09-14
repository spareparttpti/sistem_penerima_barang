# 📦 Sistem Penerimaan Barang Sparepart (SPB)

> **Versi TERBARU (v2)** — Full-Stack Web App untuk penerimaan barang sparepart berbasis
> PO/Delivery Order, dengan QC fisik (Good / Damaged / Short), notifikasi otomatis ke
> **Teamly**, dan dashboard ringkasan. Terintegrasi **Supabase** (PostgreSQL + Storage + RLS)
> dan **Teamly Webhook** (auto-tagging role).

---

## 🚀 Highlight: Frontend Vanilla (Struktur Terpisah)

Frontend versi terbaru adalah **HTML + CSS + JS terpisah** (tanpa framework) — port dari
kode React ke arsitektur file rapi yang mudah dikembangkan & di-deploy. Mode demo langsung
jalan di browser (pakai `localStorage`) tanpa backend.

```
frontend/
├── index.html              # Entry point — memuat css/ & js/ via link/script tag
├── css/
│   └── style.css           # Seluruh styling: tema, responsif, indikator status, modal
└── js/
    ├── config.js           # Konfigurasi: SUPABASE_URL, ANON_KEY, TEAMLY_WEBHOOK_URL, demoMode
    ├── supabaseClient.js   # Lapisan data: spareparts, penerimaan_barang, detail_penerimaan, proofs
    ├── teamly.js           # Payload generator + notifikasi Teamly (ROLE_TAGS, TRIGGER_ROLE)
    ├── odoo.js             # Integrasi Odoo: parser CSV + XLSX, sync Supabase, pencocokan item
    ├── dashboard.js        # View Dashboard: stat cards, search, filter, tabel log
    ├── inputBarang.js      # View Form Input multi-step 4 section
    ├── detailQc.js         # View Detail & QC: Approve/Reject + modal preview payload
    └── app.js              # Hash router (#/, #/input-barang, #/penerimaan/:id), layout, toast
```

**Fitur utama:**
- 📊 Dashboard ringkasan: stat cards, filter (tanggal, vendor, status, kategori), tabel log
- 📝 Form input multi-step: Informasi Transaksi → Item Sparepart → Foto Bukti → Catatan
- 🔍 Detail & QC: checklist inspeksi, Approve / Reject / Partial, upload bukti
- 🔔 Notifikasi Teamly otomatis + auto-tagging role (ui→frontend, db→backend, server→devops, review→reviewer)
- 🎨 Indikator status: 🟢 Hijau (Approved) · 🟡 Kuning (In Inspection) · 🔴 Merah (Rejected)
- 📱 Responsif mobile-first (HP/Tablet)
- 🖨️ **Cetak Surat Jalan** dari halaman detail — ukuran kertas (A4/A5/F4/Letter), orientasi,
  dan skala tampilan bisa diatur sebelum cetak; kop perusahaan, tabel Qty PO vs Diterima, kolom tanda tangan
- 📷 **Upload/ganti foto bukti** langsung dari halaman detail (tidak harus lewat form input)
- 📊 **Grafik Dashboard**: status pengadaan (Sudah Datang / On The Way / Menunggu Vendor)
  dan peringkat vendor terbanyak
- 🔗 **Integrasi Odoo**: import CSV/XLSX (atau webhook real-time) → data WH/IN langsung
  masuk ke Log Penerimaan sebagai antrean **Draft**. Klik barisnya saat barang tiba →
  isi tanggal kedatangan + petugas → **Done** → masuk antrean QC. Tanggal pemesanan dan
  tanggal kedatangan disimpan terpisah. Lihat [docs/integrasi_odoo.md](docs/integrasi_odoo.md)

---

## 📁 Struktur Folder

```
sistem-penerimaan-sparepart/
├── database/
│   ├── supabase_schema.sql              # Skema lengkap: roles, spareparts, penerimaan_barang,
│   │                                    #   detail_penerimaan + RLS + bucket proofs
│   └── odoo_integration.sql             # Tabel odoo_receipts + odoo_receipt_lines (cermin Odoo)
├── supabase/functions/
│   ├── teamly-webhook/index.ts          # Edge Function webhook Teamly (Deno/TypeScript)
│   ├── odoo-webhook/index.ts            # Edge Function penerima data WH/IN (mode push/webhook)
│   └── odoo-pull/index.ts               # Edge Function penjemput data WH/IN (mode pull, tanpa setting Odoo)
├── frontend/                            # ⭐ Frontend VANILLA terbaru (HTML+CSS+JS terpisah)
│   ├── index.html
│   ├── css/style.css
│   ├── js/ (config, supabaseClient, teamly, dashboard, inputBarang, detailQc, app)
│   └── README.md                        # Panduan lengkap frontend vanilla
├── docs/
│   ├── backend_readme.md                # Dokumentasi backend & deliverable
│   ├── integrasi_odoo.md                # 🔗 Panduan sambungkan data WH/IN dari Odoo
│   └── verifikasi_api_tester.md         # Laporan verifikasi API Tester (PASS)
└── README.md                            # File ini
```

---

## ⚙️ Setup & Deploy

### 1. Database (Supabase)

1. Buka [Supabase](https://supabase.com) → buat project baru.
2. Buka **SQL Editor** → paste isi `database/supabase_schema.sql` → **Run**.
3. Skema akan membuat tabel `roles`, `spareparts`, `penerimaan_barang`, `detail_penerimaan`,
   RLS policy, serta bucket storage `proofs`.

### 2. Edge Function Webhook (Teamly)

1. Buka **Edge Functions** di dashboard Supabase.
2. Buat fungsi `teamly-webhook` → paste isi `supabase/functions/teamly-webhook/index.ts`.
3. Deploy fungsi, lalu salin URL endpoint-nya (mis. `https://<project>.supabase.co/functions/v1/teamly-webhook`).
4. (Opsional) Set secret `TEAMLY_WEBHOOK_URL` bila endpoint Teamly dipanggil dari server.

### 3. Frontend Vanilla

**Mode Demo (tanpa backend):**
```bash
cd frontend
# buka index.html langsung di browser — data simulasi localStorage sudah ter-seed
```

**Mode Produksi (Supabase + Teamly):**
1. Buka `frontend/js/config.js`.
2. Isi kredensial:
   ```js
   SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
   SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
   TEAMLY_WEBHOOK_URL: 'https://YOUR-TEAMLY-WEBHOOK-URL',
   demoMode: false,
   ```
3. Deploy ke hosting statis apa pun (Vercel, Netlify, GitHub Pages, dsb.) — cukup
   upload isi folder `frontend/` (index.html + css/ + js/).

### 4. Integrasi Odoo (opsional)

**Mode cepat (tanpa setup):** Export XLSX/CSV dari Odoo → tombol **Import Odoo** di kanan
atas Dashboard. Data langsung masuk ke log penerimaan.

**Mode Tarik Otomatis (disarankan, nol setting di Odoo):** deploy Edge Function `odoo-pull`
dengan email+password akun Odoo biasa, jadwalkan lewat Supabase Cron — program yang aktif
menjemput data, Odoo tidak perlu disentuh sama sekali.

**Mode Webhook (push, real-time):** jalankan `database/odoo_integration.sql`, deploy Edge
Function `odoo-webhook`, lalu buat Automated Action di Odoo yang menembak ke URL function
tersebut. Langkah lengkap ketiga mode: [docs/integrasi_odoo.md](docs/integrasi_odoo.md).

### 5. Verifikasi

Lihat `docs/verifikasi_api_tester.md` — hasil pengujian API: ✅ **PASS** (3 catatan minor, non-blocking).

---

## 🔄 Alur Status Penerimaan

| Status | Warna | Makna |
|---|---|---|
| `Draft` | ⚪ Abu-abu | Antrean dari Odoo — menunggu barang datang |
| `In Inspection` | 🟡 Kuning | Dalam pemeriksaan tim gudang |
| `Approved` | 🟢 Hijau | Barang diterima sesuai PO |
| `Rejected` | 🔴 Merah | Ditolak / rusak / kurang / tidak sesuai spesifikasi |

Notifikasi Teamly terkirim otomatis saat status berubah ke **Approved** atau **Rejected**
(beserta detail PO, vendor, catatan, dan tag role terkait).

---

*Dibuat oleh Full-Stack Delivery Guild — Frontend Developer, Backend Architect, API Tester,
Code Reviewer. © 2026*
