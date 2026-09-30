# Backend Deliverable — Sistem Penerimaan Barang Sparepart

**Role:** Backend Architect · **Round:** 2 of 3 · **Group:** Full-Stack Delivery Guild
**Status:** ✅ Selesai — siap diverifikasi oleh @API Tester (round 3)

---

## 📦 Deliverable Files

| File | Isi | Link |
|---|---|---|
| `supabase_schema.sql` | Skema lengkap: ENUM, 4 tabel, trigger `created_at`, index, RLS, storage bucket `proofs`, seed roles & sparepart | [Buka](https://static.teamily.ai/sites/a17db48a-29be-45b2-9c15-097a6e6fc314/documents/sistem-penerimaan-sparepart/supabase_schema.sql) |
| `edge_teamly_webhook.sql` | Edge Function `teamly-webhook` (payload generator + auto tagging) + DB trigger otomatis (pg_net) + contoh test | [Buka](https://static.teamily.ai/sites/a17db48a-29be-45b2-9c15-097a6e6fc314/documents/sistem-penerimaan-sparepart/edge_teamly_webhook.sql) |
| Frontend (sebelumnya) | Demo interaktif + komponen React | [Demo](https://static.teamily.ai/sites/30e121b6-bafa-4fc1-b0ec-583cf9398fda/webpages/sistem-penerimaan-sparepart/index.html) · [React code](https://static.teamily.ai/sites/30e121b6-bafa-4fc1-b0ec-583cf9398fda/documents/sistem-penerimaan-sparepart/frontend_react_components.md) |

---

## 🧱 1. Skema Database (ringkasan)

- **ENUM:** `role_name` (frontend/backend/devops/code_reviewer/gudang), `sparepart_category` (Mesin/Elektrikal/Utility), `receiving_status` (Draft/In Inspection/Approved/Rejected), `item_condition` (Baik/Rusak/Cacat)
- **Tabel:**
  - `roles` — role_name UNIQUE + `teamly_user_id` (mapping ke Teamly user ID)
  - `spareparts` — `sku` UNIQUE, name, category, unit, is_active
  - `penerimaan_barang` — `po_number`, `vendor_name`, `receiver_name`, `status`, `notes`, `proof_image_url`, `created_at` (default now())
  - `detail_penerimaan` — FK `penerimaan_id` (cascade), FK `sparepart_id` (restrict), `qty_received`, `condition`
- **Trigger:** `set_created_at()` (INSERT) + `set_updated_at()` (UPDATE) di semua tabel
- **Index:** `penerimaan_barang(created_at desc)`, `(status)`, `(po_number)`, `(vendor_name)`, partial index status aktif; `detail_penerimaan(penerimaan_id)`, `(sparepart_id)`; `spareparts(sku)`, `(category)`

## 🔒 2. RLS & Keamanan

| Tabel | anon | authenticated | service_role (backend) |
|---|---|---|---|
| `roles` | ❌ ditolak | ❌ **ditolak (tanpa policy)** | ✅ bypass RLS |
| `spareparts` | ❌ | ✅ SELECT / INSERT / UPDATE | ✅ |
| `penerimaan_barang` | ❌ | ✅ SELECT / INSERT / UPDATE | ✅ |
| `detail_penerimaan` | ❌ | ✅ SELECT / INSERT / UPDATE | ✅ |

- Frontend **tidak bisa membaca/mengubah `roles`** — hanya service_role (backend/Edge Function) yang bisa, via `get_teamly_roles()` (security definer, revoke dari anon/authenticated).
- **Storage:** bucket `proofs` public-read (agar `<img src>` langsung jalan), upload/update/delete hanya `authenticated` dengan path wajib `penerimaan/` (5 MB, png/jpeg/webp/pdf).

## 🤖 3. Webhook Teamly — Auto Tagging

Payload generator **identik** dengan `lib/teamly.js` frontend → satu format pesan:

```
🚨 **[ALERTA PENERIMAAN BARANG - STATUS: REJECTED]**
📌 **No PO:** #PO-9923
🏭 **Vendor:** PT Sukses Teknik
📦 **Catatan:** Barang rusak 2 pcs
🔎 **Trigger:** QC action
👉 **Perhatian Tim:**
- <@teamly_backend_id> Mohon verifikasi penyesuaian data stok.
```

| Trigger | Kondisi | Role yang ditag |
|---|---|---|
| `ui` | UI / Upload Fail, status `In Inspection` | `<@...>` Frontend Developer |
| `db` | DB / Stok Minus, status `Rejected` | `<@...>` Backend Architect |
| `server` | Server / API Down | `<@...>` DevOps Automator |
| `review` | Approval Flagged / status `Approved` | `<@...>` Code Reviewer |

**Mention dinamis:** Edge Function membaca `teamly_user_id` dari tabel `roles` (service_role) → mention `<@ID_asli>` dipakai otomatis, fallback placeholder `<@teamly_..._id>`.

**Cara deploy:**
1. Jalankan `supabase_schema.sql` di SQL Editor
2. Buat `supabase/functions/teamly-webhook/index.ts` (isi di SECTION 1 file edge)
3. `supabase secrets set TEAMLY_WEBHOOK_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...`
4. `supabase functions deploy teamly-webhook --no-verify-jwt`
5. Jalankan SECTION 2 (pg_net + trigger) → notifikasi otomatis setiap status berubah

---

## ✅ Checklist Verifikasi (untuk @API Tester, round 3)

- [ ] `supabase_schema.sql` jalan tanpa error di SQL Editor (idempotent, bisa di-run ulang)
- [ ] ENUM `receiving_status` menerima keempat status; selain itu error
- [ ] `sku` UNIQUE: insert duplikat ditolak
- [ ] `qty_received >= 0` constraint bekerja
- [ ] `detail_penerimaan` cascade delete saat header dihapus; `sparepart_id` restrict
- [ ] `created_at` otomatis terisi (default now() + trigger)
- [ ] RLS: query `roles` dengan anon key → error/tanpa data; dengan service_role → data tampil
- [ ] RLS: authenticated bisa SELECT/INSERT/UPDATE `penerimaan_barang`
- [ ] Storage: upload file > 5 MB ditolak; upload path selain `penerimaan/` ditolak
- [ ] Edge Function: POST `{"status":"Rejected","record":{...},"trigger":"db"}` → 200 + payload benar
- [ ] DB trigger: UPDATE status → `teamly_notification_log` terisi + webhook terkirim
