# SPB · Sistem Penerimaan Barang Sparepart — Frontend Vanilla (Struktur Terpisah)

Frontend versi **HTML + CSS + JS terpisah** (tanpa framework) untuk Sistem Penerimaan
Barang Sparepart, terintegrasi **Supabase** (PostgreSQL + Storage) dan **Teamly Webhook**
(notifikasi otomatis + auto-tagging role).

Versi ini adalah port dari kode React (`frontend_react_components.md`) ke arsitektur
file terpisah yang rapi, dengan **demo interaktif** yang langsung bisa dijalankan di
browser tanpa backend (mode demo memakai `localStorage`).

---

## 📁 Struktur Folder

```
frontend_vanilla/
├── index.html              # Entry point — memuat CSS & JS via link/script tag
├── css/
│   └── style.css           # Seluruh styling: tema, responsif, status warna, modal, drawer
├── js/
│   ├── config.js           # Konfigurasi: SUPABASE_URL, ANON_KEY, TEAMLY_WEBHOOK_URL, demoMode
│   ├── supabaseClient.js   # Lapisan data: spareparts, penerimaan_barang, detail_penerimaan,
│   │                       #   bucket proofs, subscribePenerimaan + fallback demo (localStorage)
│   ├── teamly.js           # Payload generator + notifikasi Teamly (ROLE_TAGS, TRIGGER_ROLE)
│   ├── dashboard.js        # View Dashboard: stat cards, search, filter, tabel log
│   ├── inputBarang.js      # View Form Input multi-step 4 section
│   ├── detailQc.js         # View Detail & QC: Approve/Reject + modal preview payload
│   └── app.js              # Hash router (#/, #/input-barang, #/penerimaan/:id), layout, toast
└── assets/                 # (opsional) gambar/logo lokal
```

Urutan pemuatan script di `index.html` (penting):

```html
<script src="js/config.js"></script>
<script src="js/supabaseClient.js"></script>
<script src="js/teamly.js"></script>
<script src="js/dashboard.js"></script>
<script src="js/inputBarang.js"></script>
<script src="js/detailQc.js"></script>
<script src="js/app.js"></script>
```

---

## 🚀 Menjalankan

### Mode Demo (default)

`js/config.js` diset `demoMode: true` — semua data disimpan di `localStorage`
(seed 6 sparepart + 6 penerimaan). Cukup buka `index.html` di browser, atau buka
demo yang sudah di-hosting.

### Mode Produksi (Supabase + Teamly)

1. Buka `js/config.js`.
2. Isi kredensial:
   ```js
   SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
   SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
   TEAMLY_WEBHOOK_URL: 'https://YOUR-TEAMLY-WEBHOOK-URL',
   demoMode: false,
   ```
3. Pastikan skema Supabase sudah dibuat (lihat `supabase_schema.sql` dari Backend
   Architect): tabel `spareparts`, `penerimaan_barang`, `detail_penerimaan`, RLS,
   bucket storage `proofs`.
4. Pastikan Edge Function/endpoint Teamly Webhook sudah aktif (lihat
   `edge_teamly_webhook.sql`).

---

## 🔌 Konsistensi dengan Versi React

| React (`src/lib/*`) | Vanilla (`js/*`) | Keterangan |
|---|---|---|
| `lib/supabaseClient.js` | `js/supabaseClient.js` | API sama: `spareparts()`, `list()`, `get()`, `insert()`, `updateStatus()`, `uploadProof()`, `subscribePenerimaan()` |
| `lib/teamly.js` | `js/teamly.js` | `buildTeamlyPayload()` & `sendTeamlyNotification()` identik: status → role tag (ui→frontend, db→backend, server→devops, review→reviewer) |
| `components/DashboardPage.jsx` | `js/dashboard.js` | Stat cards, search/filter, tabel + mobile cards |
| `components/InputBarangPage.jsx` | `js/inputBarang.js` | Form 4 section: Informasi → Item → Foto Bukti → Catatan |
| `components/DetailQcPage.jsx` | `js/detailQc.js` | Detail + modal Approve/Reject + preview payload webhook |
| `App.jsx` (HashRouter) | `js/app.js` | Route `#/`, `#/input-barang`, `#/penerimaan/:id` |

### Payload Teamly (auto-tagging)

```
🚨 **[ALERTA PENERIMAAN BARANG - STATUS: APPROVED]**

📌 **No PO:** #PO-9918
🏭 **Vendor:** CV Karya Utama
📦 **Catatan:** Semua item diterima sesuai PO.
🔍 **Trigger:** Approval ditandai untuk verifikasi akhir oleh Code Reviewer

👉 **Perhatian Tim:**
- <@teamly_code_reviewer> Membutuhkan masukan/verifikasi lanjutan.
```

Mapping trigger → role yang di-tag:

| Trigger | Role | Kondisi |
|---|---|---|
| `ui` | @Frontend Developer | Upload fail / penerimaan baru (In Inspection) |
| `db` | @Backend Architect | Rejected / penyesuaian stok |
| `server` | @DevOps Automator | Server/API down |
| `review` | @Code Reviewer | Approval ditandai |

---

## 🎨 Indikator Warna Status

| Status | Warna | Makna |
|---|---|---|
| `Approved` | 🟢 Hijau | Barang diterima sesuai PO |
| `In Inspection` | 🟡 Kuning | Dalam pemeriksaan tim gudang |
| `Rejected` | 🔴 Merah | Ditolak / rusak / tidak sesuai |
| `Draft` | ⚪ Abu-abu | Belum diproses |

Tampilan responsif: tabel berubah menjadi kartu di layar kecil (mobile-first),
stepper menyesuaikan, modal bottom-sheet di HP.

---

*Frontend Vanilla — Sistem Penerimaan Barang Sparepart (SPB). Dibuat ulang dari
komponen React, siap dipakai langsung maupun diintegrasikan ke Supabase & Teamly.*
