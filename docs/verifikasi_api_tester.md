# 🔬 Laporan Verifikasi API Tester — Sistem Penerimaan Barang Sparepart

**Tester:** API Tester · **Round:** 3 of 3 · **Tanggal:** 2026-08-06
**Verdict:** ✅ **PASS** (dengan 3 catatan minor, non-blocking)

---

## 1. Ringkasan Pengujian

| Aspek | Metode | Hasil |
|---|---|---|
| Static parse (pglast) | `supabase_schema.sql` | ✅ 75 statements PARSE OK |
| Static parse (pglast) | `edge_teamly_webhook.sql` | ✅ 6 statements PARSE OK |
| Eksekusi nyata | PostgreSQL 15 lokal (mock storage + pg_net) | ✅ Skema berjalan penuh tanpa error |
| Idempotency | Run ulang skema 2× | ✅ 0 error (aman di-run ulang) |
| RLS | Simulasi role `authenticated` vs `service_role` | ✅ Sesuai spesifikasi |
| Storage | Mock bucket `proofs` + policy | ✅ Path & bucket terbatas |
| Webhook trigger | Mock `net.http_post` + audit log | ✅ Payload benar untuk 3 status |

---

## 2. Verifikasi `supabase_schema.sql`

### ✅ LULUS
- **ENUM**: `role_name` (5), `sparepart_category` (3), `receiving_status` (4), `item_condition` (3) — idempotent via `do $$ ... exception`.
- **FK**: `detail_penerimaan.penerimaan_id → penerimaan_barang(id) ON DELETE CASCADE` ✅ teruji; `sparepart_id → spareparts(id) ON DELETE RESTRICT` ✅ teruji (DELETE sparepart terpakai → ERROR).
- **Constraint**: `sku UNIQUE` ✅ (duplikat ditolak); `qty_received >= 0` ✅ (negatif ditolak); ENUM status ✅ (`'BOGUS'` ditolak).
- **Trigger**: `created_at` otomatis terisi saat INSERT ✅; `updated_at` ter-update saat UPDATE ✅.
- **Index**: 9 index sesuai kebutuhan dashboard (created_at desc, status, po_number, vendor, partial status aktif, detail FK, spareparts sku/kategori).
- **RLS**:
  - `roles`: **TANPA policy** → `authenticated` SELECT = **0 baris / ditolak** ✅; `service_role` (bypass) = data tampil ✅.
  - `spareparts` / `penerimaan_barang` / `detail_penerimaan`: `authenticated` SELECT/INSERT/UPDATE ✅.
  - `get_teamly_roles()`: REVOKE dari `public/anon/authenticated`, GRANT hanya `service_role` ✅ — authenticated = `permission denied for function` ✅, service_role = berhasil ✅.
- **Storage**: bucket `proofs` public=true, limit 5 MB, mime `png/jpeg/webp/pdf` ✅; INSERT path `penerimaan/` diterima ✅; path lain `lain/evil.png` ditolak (RLS) ✅; bucket lain ditolak ✅; SELECT publik ✅.

### ⚠️ Catatan Minor (tidak menghalangi deploy)
1. `penerimaan_status_check` redundant dengan ENUM `receiving_status` — harmless, boleh dibiarkan.
2. Policy storage `proofs_update_auth` tidak membatasi path `penerimaan/` (beda dengan INSERT). Risiko rendah karena bucket khusus; **disarankan** menambahkan `storage.foldername(name)[1] = 'penerimaan'` pada WITH CHECK update untuk konsistensi.

---

## 3. Verifikasi `edge_teamly_webhook.sql`

### ✅ LULUS
- **Payload generator identik dengan `lib/teamly.js` frontend**:
  - Header `🚨 **[ALERTA PENERIMAAN BARANG - STATUS: X]**` ✅
  - `📌 **No PO:** #...` / `🏭 **Vendor:** ...` / `📦 **Catatan:** ...` / `🔎 **Trigger:** ...` / `👉 **Perhatian Tim:**` ✅
  - Backend menambah fallback `?? "-"` untuk PO/Vendor — improvement, format tetap sama.
- **Mapping trigger → role** (konsisten dengan `TRIGGER_ROLE` frontend):
  - `ui` → Frontend Developer ✅
  - `db` → Backend Architect ✅
  - `server` → DevOps Automator ✅
  - `review` → Code Reviewer ✅
- **Mention dinamis**: membaca `teamly_user_id` dari tabel `roles` via service_role (bypass RLS) → fallback placeholder `<@teamly_..._id>` ✅.
- **DB trigger (pg_net)**: `after insert or update of status` → payload terkirim otomatis + tercatat di `teamly_notification_log` ✅.

### 🔬 Hasil uji payload aktual (mock pg_net)
| Status | Trigger | Mention yang ditag | Hasil |
|---|---|---|---|
| `In Inspection` | `ui` | Frontend Developer | ✅ payload `{"status":"In Inspection","trigger":"ui","triggerReason":"Barang tiba, menunggu inspeksi fisik."}` |
| `Approved` | `review` | Code Reviewer | ✅ payload `{"status":"Approved","trigger":"review","triggerReason":"QC action: penerimaan disetujui."}` |
| `Rejected` | `db` | Backend Architect | ✅ payload `{"status":"Rejected","trigger":"db","triggerReason":"QC action: barang ditolak / sebagian diterima."}` |
| `Draft` | — | (skip, tidak kirim) | ✅ tidak memicu notifikasi |

Audit log `teamly_notification_log` terisi 3 baris sesuai urutan ✅.

### ⚠️ Catatan Minor
1. `create extension if not exists pg_net;` — **di Supabase pg_net tersedia**, jadi OK; error hanya muncul di PostgreSQL lokal murni (ekstensi tidak terpasang). Bukan bug.
2. Contoh curl memakai `-H "Authorization: Bearer <anon_key>"` sementara deploy memakai `--no-verify-jwt` — keduanya valid (anon key tetap diterima; x-api-key opsional sebagai proteksi). Pastikan `API_KEY` secret di-set jika ingin proteksi tambahan.
3. `set_config(..., false)` bersifat per-session — disarankan dokumentasi menyebut `ALTER DATABASE ... SET` atau set ulang di setiap sesi/trigger jika Edge URL berubah.

---

## 4. Konsistensi Frontend ↔ Backend

| Item | Frontend `lib/teamly.js` | Backend `edge_teamly_webhook.sql` | Status |
|---|---|---|---|
| ROLE_TAGS | frontend/backend/devops/reviewer | ROLE_TAGS sama | ✅ |
| TRIGGER_ROLE | ui/db/server/review | TRIGGER_ROLE sama | ✅ |
| Format payload | ALERTA + PO + Vendor + Catatan + Trigger + Perhatian Tim | Identik | ✅ |
| Kondisi mention | Rejected / In Inspection / trigger | Identik | ✅ |
| Trigger status DB | — | In Inspection→ui, Approved→review, Rejected→db | ✅ selaras |

---

## 5. Kesimpulan & Rekomendasi

**Verdict: ✅ PASS — release ready (Go).**

Ketiga deliverable (SQL schema, Edge Function webhook, README) telah lolos:
1. Parse statis pglast (81 statements total, 0 error sintaks).
2. Eksekusi nyata di PostgreSQL 15: seluruh skema, constraint, trigger, RLS, storage policy bekerja sesuai spesifikasi.
3. Payload webhook untuk status Rejected / In Inspection / Approved menghasilkan mention role yang tepat, identik dengan frontend.
4. RLS `roles` hanya bisa diakses service_role — kebutuhan keamanan inti terpenuhi.

**Minor (opsional, bisa ditangani sesi berikutnya):**
- (Rendah) `proofs_update_auth` sebaiknya membatasi path `penerimaan/` agar konsisten dengan INSERT.
- (Rendah) Dokumentasikan set_config persisten (ALTER DATABASE) untuk edge_url.
- (Info) Constraint status redundant dengan ENUM.

**Saran next step:** Deploy di project Supabase asli → jalankan checklist di `backend_readme.md` → isi `teamly_user_id` di tabel `roles` dengan ID Teamly asli → test kirim notifikasi ke channel Teamly.

---
**API Tester** · Quality Status: **PASS** · Release Readiness: **GO**
