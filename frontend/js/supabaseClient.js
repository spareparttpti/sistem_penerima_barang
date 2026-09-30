/* =========================================================
   SPB · supabaseClient.js
   Lapisan data — API konsisten dengan lib/supabaseClient.js React:
   - spareparts  : master data sparepart (SKU, nama, kategori, unit)
   - penerimaan_barang : header penerimaan
   - detail_penerimaan : item-item penerimaan
   - storage bucket `proofs` : upload foto bukti
   - Realtime subscribe perubahan status

   demoMode=true  → simulasi localStorage (dipakai demo interaktif)
   demoMode=false → Supabase client asli (siap produksi)
   ========================================================= */

(function () {
  'use strict';

  const CFG = window.SPB_CONFIG;
  const DEMO = CFG.demoMode;
  const STORE_KEY = CFG.STORE_KEY;

  /* Client Supabase mentah dibuat sekali di auth.js (dimuat sebelum file ini)
     supaya sesi login yang sama dipakai bareng untuk query data — bukan bikin
     client baru di sini yang tidak tahu-menahu soal status login. */
  function sb() {
    const c = window.SPB && window.SPB.sb;
    if (!c) throw new Error('Supabase belum dikonfigurasi (isi SUPABASE_URL & SUPABASE_ANON_KEY di config.js).');
    return c;
  }

  function throwIfError(error) {
    if (error) throw new Error(error.message || String(error));
  }

  /* ---------- Seed Data (demo) ---------- */
  const SEED_SPAREPARTS = [
    { id: 'sp1', sku: 'SPR-0001', name: 'Bearing SKF 6205', category: 'Mesin', unit: 'pcs' },
    { id: 'sp2', sku: 'SPR-0002', name: 'Motor Listrik 1.5kW', category: 'Elektrikal', unit: 'unit' },
    { id: 'sp3', sku: 'SPR-0003', name: 'V-Belt B65', category: 'Mesin', unit: 'pcs' },
    { id: 'sp4', sku: 'SPR-0004', name: 'Kabel NYY 4x2.5mm', category: 'Elektrikal', unit: 'm' },
    { id: 'sp5', sku: 'SPR-0005', name: 'Mur Baut M12', category: 'Utility', unit: 'box' },
    { id: 'sp6', sku: 'SPR-0006', name: 'Pelumas Grease EP2', category: 'Utility', unit: 'pail' },
  ];

  const SEED_PENERIMAAN = [
    {
      id: 'pb1', po_number: 'PO-9921', vendor_name: 'PT Sukses Teknik', receiver_name: 'Budi Santoso',
      status: 'Rejected', notes: 'Barang mengalami kerusakan pada bagian fisik. Sebagian item tidak sesuai spesifikasi.',
      proof_image_url: '', created_at: '2026-08-06T08:15:00+07:00',
      items: [
        { id: 'd1', penerimaan_id: 'pb1', sparepart_id: 'sp1', qty_received: 10, condition: 'Rusak' },
        { id: 'd2', penerimaan_id: 'pb1', sparepart_id: 'sp3', qty_received: 5, condition: 'Cacat' },
      ],
    },
    {
      id: 'pb2', po_number: 'PO-9922', vendor_name: 'PT Mitra Jaya', receiver_name: 'Siti Aminah',
      status: 'In Inspection', notes: 'Menunggu pengecekan fisik oleh tim gudang.',
      proof_image_url: '', created_at: '2026-08-06T09:40:00+07:00',
      items: [
        { id: 'd3', penerimaan_id: 'pb2', sparepart_id: 'sp2', qty_received: 2, condition: 'Baik' },
        { id: 'd4', penerimaan_id: 'pb2', sparepart_id: 'sp6', qty_received: 4, condition: 'Baik' },
      ],
    },
    {
      id: 'pb3', po_number: 'PO-9918', vendor_name: 'CV Karya Utama', receiver_name: 'Andi Wijaya',
      status: 'Approved', notes: 'Semua item diterima sesuai PO. Kualitas baik.',
      proof_image_url: '', created_at: '2026-08-05T14:20:00+07:00',
      items: [
        { id: 'd5', penerimaan_id: 'pb3', sparepart_id: 'sp4', qty_received: 100, condition: 'Baik' },
        { id: 'd6', penerimaan_id: 'pb3', sparepart_id: 'sp5', qty_received: 12, condition: 'Baik' },
      ],
    },
    {
      id: 'pb4', po_number: 'PO-9915', vendor_name: 'PT Indo Partindo', receiver_name: 'Rina Marlina',
      status: 'Approved', notes: 'Penerimaan sesuai surat jalan.',
      proof_image_url: '', created_at: '2026-08-05T10:05:00+07:00',
      items: [
        { id: 'd7', penerimaan_id: 'pb4', sparepart_id: 'sp1', qty_received: 20, condition: 'Baik' },
      ],
    },
    {
      id: 'pb5', po_number: 'PO-9910', vendor_name: 'PT Sukses Teknik', receiver_name: 'Budi Santoso',
      status: 'Rejected', notes: 'Ditolak — dokumen surat jalan tidak sesuai dengan PO.',
      proof_image_url: '', created_at: '2026-08-04T13:30:00+07:00',
      items: [
        { id: 'd8', penerimaan_id: 'pb5', sparepart_id: 'sp2', qty_received: 1, condition: 'Cacat' },
      ],
    },
    {
      id: 'pb6', po_number: 'PO-9908', vendor_name: 'CV Maju Bersama', receiver_name: 'Dewi Lestari',
      status: 'Draft', notes: 'Belum dilakukan pemeriksaan fisik.',
      proof_image_url: '', created_at: '2026-08-04T09:00:00+07:00',
      items: [
        { id: 'd9', penerimaan_id: 'pb6', sparepart_id: 'sp4', qty_received: 50, condition: 'Baik' },
      ],
    },
  ];

  /* ---------- State demo ---------- */
  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.penerimaan)) return parsed;
      }
    } catch (e) { /* ignore */ }
    const seed = {
      spareparts: SEED_SPAREPARTS.slice(),
      penerimaan: SEED_PENERIMAAN.map(function (r) {
        return { id: r.id, po_number: r.po_number, vendor_name: r.vendor_name, receiver_name: r.receiver_name,
                 status: r.status, notes: r.notes, proof_image_url: r.proof_image_url, created_at: r.created_at };
      }),
      details: SEED_PENERIMAAN.reduce(function (acc, r) {
        r.items.forEach(function (it) { acc.push(it); });
        return acc;
      }, []),
      seq: 7,
    };
    saveState(seed);
    return seed;
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore quota */ }
  }

  /* Ambil ID unik dari objek state yang SEDANG dipakai pemanggil.
     (Versi lama memakai loadState().seq++ — objeknya dibuang seketika,
     sehingga setiap penerimaan baru mendapat ID yang sama.) */
  function nextId(st, prefix) {
    if (typeof st.seq !== 'number') st.seq = 1;
    const p = prefix || 'pb';
    // Data lama bisa mengandung ID duplikat hasil bug tersebut, jadi ID baru
    // selalu diperiksa terhadap yang sudah ada sebelum dipakai.
    const taken = {};
    st.penerimaan.forEach(function (r) { taken[r.id] = true; });
    st.details.forEach(function (d) { taken[d.id] = true; });
    let id;
    do { id = p + (st.seq++); } while (taken[id]);
    return id;
  }

  function chunks(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /* Versi produksi dari importOdoo — dipakai tombol "Import Odoo" di Dashboard
     (Import File langsung dari browser, bukan lewat Edge Function odoo-pull).
     Logikanya sengaja disamakan dengan supabase/functions/odoo-pull/index.ts:
     batch upsert (bukan satu-per-satu), lewati yang Cancelled/sudah diproses. */
  async function importOdooProd(receipts, spareparts) {
    const client = sb();
    const bySku = {}, byName = {};
    spareparts.forEach(function (sp) {
      if (sp.sku) bySku[sp.sku.toLowerCase()] = sp;
      if (sp.name) byName[sp.name.toLowerCase()] = sp;
    });

    let cancelled = 0;
    const toProcess = (receipts || []).filter(function (rc) {
      if (!rc.wh_in_ref) return false;
      if (rc.state === 'Cancelled') { cancelled++; return false; }
      return true;
    });
    if (!toProcess.length) return { added: 0, updated: 0, locked: 0, cancelled: cancelled };

    const existingByRef = {};
    for (const chunk of chunks(toProcess.map(function (r) { return r.wh_in_ref; }), 200)) {
      const { data, error } = await client
        .from('penerimaan_barang').select('id, wh_in_ref, status').in('wh_in_ref', chunk);
      throwIfError(error);
      (data || []).forEach(function (row) { existingByRef[row.wh_in_ref] = row; });
    }

    let locked = 0;
    const headerRows = toProcess
      .filter(function (rc) {
        const existing = existingByRef[rc.wh_in_ref];
        if (existing && existing.status !== 'Draft') { locked++; return false; }
        return true;
      })
      .map(function (rc) {
        return {
          wh_in_ref: rc.wh_in_ref,
          po_number: rc.origin || rc.wh_in_ref,
          vendor_name: rc.contact || '-',
          receiver_name: '-',
          status: 'Draft',
          order_date: rc.scheduled_date || null,
          odoo_state: rc.state || '',
          source: 'odoo',
        };
      });

    if (!headerRows.length) return { added: 0, updated: 0, locked: locked, cancelled: cancelled };

    const upsertedIds = [];
    for (const chunk of chunks(headerRows, 200)) {
      const { data, error } = await client
        .from('penerimaan_barang').upsert(chunk, { onConflict: 'wh_in_ref' }).select('id, wh_in_ref');
      throwIfError(error);
      upsertedIds.push.apply(upsertedIds, data || []);
    }

    const added = upsertedIds.filter(function (u) { return !existingByRef[u.wh_in_ref]; }).length;
    const updated = upsertedIds.length - added;

    const idByRef = {};
    upsertedIds.forEach(function (u) { idByRef[u.wh_in_ref] = u.id; });
    const touchedIds = upsertedIds.map(function (u) { return u.id; });

    for (const chunk of chunks(touchedIds, 200)) {
      const { error } = await client.from('detail_penerimaan').delete().in('penerimaan_id', chunk);
      throwIfError(error);
    }

    const lineRows = [];
    toProcess.forEach(function (rc) {
      const pid = idByRef[rc.wh_in_ref];
      if (!pid) return; // locked atau gagal di-upsert
      (rc.lines || []).forEach(function (l) {
        const sp = (l.sku && bySku[l.sku.toLowerCase()]) || byName[(l.product || '').toLowerCase()];
        lineRows.push({
          penerimaan_id: pid,
          sparepart_id: sp ? sp.id : null,
          product_name: l.product,
          sku: l.sku,
          uom: l.uom,
          qty_po: l.qty_po,
          qty_received: l.qty_po,
          condition: 'Baik',
        });
      });
    });

    for (const chunk of chunks(lineRows, 500)) {
      const { error } = await client.from('detail_penerimaan').insert(chunk);
      throwIfError(error);
    }

    return { added: added, updated: updated, locked: locked, cancelled: cancelled };
  }

  /* ---------- API Publik ---------- */
  const db = {
    /* Ambil master sparepart */
    spareparts: async function () {
      if (DEMO) return loadState().spareparts;
      const { data, error } = await sb().from('spareparts').select('*').order('sku');
      throwIfError(error);
      return data || [];
    },

    /* Daftar penerimaan (header) + detail item */
    list: async function () {
      if (DEMO) {
        const st = loadState();
        return st.penerimaan
          .map(function (r) {
            return Object.assign({}, r, {
              wh_in_ref: r.wh_in_ref || null,
              items: st.details.filter(function (d) { return d.penerimaan_id === r.id; }),
            });
          })
          .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
      }
      // items:detail_penerimaan(*) — embed lewat FK penerimaan_id, dialiaskan
      // "items" supaya bentuknya sama persis dengan yang dipakai seluruh UI.
      const { data, error } = await sb()
        .from('penerimaan_barang')
        .select('*, items:detail_penerimaan(*)')
        .order('created_at', { ascending: false });
      throwIfError(error);
      return data || [];
    },

    /* Detail satu penerimaan + item-nya */
    get: async function (id) {
      if (DEMO) {
        const st = loadState();
        const r = st.penerimaan.find(function (x) { return x.id === id; });
        if (!r) return null;
        return Object.assign({}, r, {
          wh_in_ref: r.wh_in_ref || null,
          items: st.details.filter(function (d) { return d.penerimaan_id === id; }),
        });
      }
      const { data, error } = await sb()
        .from('penerimaan_barang')
        .select('*, items:detail_penerimaan(*)')
        .eq('id', id)
        .maybeSingle();
      throwIfError(error);
      return data || null;
    },

    /* Simpan header + detail (status awal: In Inspection) */
    insert: async function (payload) {
      if (DEMO) {
        const st = loadState();
        const id = nextId(st, 'pb');
        const now = payload.created_at || new Date().toISOString();
        const header = {
          id: id, po_number: payload.po_number, wh_in_ref: payload.wh_in_ref || null,
          vendor_name: payload.vendor_name,
          receiver_name: payload.receiver_name, status: 'In Inspection',
          notes: payload.notes || '', proof_image_url: payload.proof_image_url || null,
          created_at: now,
          order_date: payload.order_date || null,      // tanggal pemesanan (dari Odoo)
          arrival_date: payload.arrival_date || now,   // input manual = barang sudah di tangan
          source: 'manual',
        };
        st.penerimaan.unshift(header);
        (payload.items || []).forEach(function (it) {
          st.details.push({
            id: nextId(st, 'd'), penerimaan_id: id,
            sparepart_id: it.sparepart_id, qty_received: it.qty_received, condition: it.condition,
            product_name: it.product_name || '', sku: it.sku || '', qty_po: it.qty_po || 0,
          });
        });
        saveState(st);
        return { id: id };
      }

      const client = sb();
      const { data: header, error: hErr } = await client
        .from('penerimaan_barang')
        .insert({
          po_number: payload.po_number,
          wh_in_ref: payload.wh_in_ref || null,
          vendor_name: payload.vendor_name,
          receiver_name: payload.receiver_name,
          status: 'In Inspection',
          notes: payload.notes || '',
          proof_image_url: payload.proof_image_url || null,
          created_at: payload.created_at || undefined,
          order_date: payload.order_date || null,
          arrival_date: payload.arrival_date || new Date().toISOString(),
          source: 'manual',
        })
        .select('id')
        .single();
      throwIfError(hErr);

      const items = payload.items || [];
      if (items.length) {
        const rows = items.map(function (it) {
          return {
            penerimaan_id: header.id,
            sparepart_id: it.sparepart_id || null,
            qty_received: it.qty_received,
            condition: it.condition,
            product_name: it.product_name || '',
            sku: it.sku || '',
            qty_po: it.qty_po || 0,
          };
        });
        const { error: dErr } = await client.from('detail_penerimaan').insert(rows);
        throwIfError(dErr);
      }
      return { id: header.id };
    },

    /* Masukkan hasil import Odoo langsung ke log penerimaan sebagai antrean
       berstatus Draft (= barang belum datang).

       Kunci dedup: wh_in_ref. Baris yang SUDAH diproses petugas (status apa pun
       selain Draft) tidak pernah ditimpa — import ulang tidak boleh menghapus
       hasil kerja QC. */
    importOdoo: async function (receipts, spareparts) {
      if (!DEMO) return importOdooProd(receipts, spareparts || []);

      const st = loadState();
      const master = spareparts || st.spareparts || [];
      const pos = {};
      st.penerimaan.forEach(function (r, i) { if (r.wh_in_ref) pos[r.wh_in_ref] = i; });

      let added = 0, updated = 0, locked = 0, cancelled = 0;
      const now = new Date().toISOString();

      (receipts || []).forEach(function (rc) {
        if (!rc.wh_in_ref) return;

        // Transfer batal di Odoo — barangnya tidak akan datang, jangan ramaikan log
        if (rc.state === 'Cancelled') { cancelled++; return; }

        const idx = pos[rc.wh_in_ref];
        const existing = idx != null ? st.penerimaan[idx] : null;
        if (existing && existing.status !== 'Draft') { locked++; return; }

        const id = existing ? existing.id : nextId(st, 'pb');
        const header = {
          id: id,
          po_number: rc.origin || rc.wh_in_ref,
          wh_in_ref: rc.wh_in_ref,
          vendor_name: rc.contact || '-',
          receiver_name: '-',                 // diisi saat barang datang
          status: 'Draft',
          notes: existing ? existing.notes : '',
          proof_image_url: existing ? existing.proof_image_url : null,
          created_at: existing ? existing.created_at : now,
          order_date: rc.scheduled_date || null,
          arrival_date: null,                 // belum datang
          odoo_state: rc.state || '',
          source: 'odoo',
        };

        if (existing) { st.penerimaan[idx] = header; updated++; }
        else { pos[rc.wh_in_ref] = st.penerimaan.push(header) - 1; added++; }

        // Item ditulis ulang penuh agar selalu sama dengan Odoo
        st.details = st.details.filter(function (d) { return d.penerimaan_id !== id; });
        const matched = window.SPB.odoo.matchLines(rc.lines || [], master);
        matched.forEach(function (m) {
          st.details.push({
            id: nextId(st, 'd'), penerimaan_id: id,
            sparepart_id: m.sparepart_id || '',
            product_name: m.odoo_product || '',
            sku: m.odoo_sku || '',
            uom: m.uom || '',
            qty_po: m.qty_po || 0,
            qty_received: m.qty_po || 0,      // dugaan awal = qty PO, dikoreksi saat QC
            condition: 'Baik',
          });
        });
      });

      saveState(st);
      return Promise.resolve({
        added: added, updated: updated, locked: locked, cancelled: cancelled,
      });
    },

    /* Tandai barang sudah datang: isi tanggal kedatangan, status → In Inspection. */
    markArrived: async function (id, arrivalDate, receiverName) {
      if (DEMO) {
        const st = loadState();
        const r = st.penerimaan.find(function (x) { return x.id === id; });
        if (!r) throw new Error('Data tidak ditemukan');
        if (r.status !== 'Draft') throw new Error('Penerimaan ini sudah ditandai datang sebelumnya.');
        r.arrival_date = arrivalDate || new Date().toISOString();
        if (receiverName) r.receiver_name = receiverName;
        r.status = 'In Inspection';
        saveState(st);
        return r;
      }
      // `.eq('status','Draft')` dipertahankan sebagai syarat WHERE, bukan cuma
      // dicek di JS — mencegah dua petugas menekan Done bersamaan sama-sama lolos.
      const { data, error } = await sb()
        .from('penerimaan_barang')
        .update({
          arrival_date: arrivalDate || new Date().toISOString(),
          receiver_name: receiverName,
          status: 'In Inspection',
        })
        .eq('id', id)
        .eq('status', 'Draft')
        .select()
        .maybeSingle();
      throwIfError(error);
      if (!data) throw new Error('Penerimaan ini sudah ditandai datang sebelumnya (atau data tidak ditemukan).');

      // Pencatatan di SPB SUDAH selesai & sukses di titik ini (baris di atas).
      // Coba validasi otomatis ke Odoo sebagai langkah TAMBAHAN, best-effort —
      // gagal di sini TIDAK membatalkan apa pun yang sudah tersimpan, cuma
      // ditandai lewat data.odoo_sync supaya pemanggil (detailQc.js) bisa
      // kasih peringatan non-blocking ke petugas.
      if (data.source === 'odoo' && data.odoo_picking_id) {
        try {
          const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/odoo-validate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ picking_id: data.odoo_picking_id }),
          });
          const result = await res.json();
          data.odoo_sync = result.ok
            ? { ok: true }
            : { ok: false, message: result.error || 'Gagal disinkronkan ke Odoo.' };
        } catch (e) {
          data.odoo_sync = { ok: false, message: e.message };
        }
      }
      return data;
    },

    /* Update status + catatan (Approved / Rejected) */
    updateStatus: async function (id, status, notes) {
      if (DEMO) {
        const st = loadState();
        const r = st.penerimaan.find(function (x) { return x.id === id; });
        if (!r) throw new Error('Data tidak ditemukan');
        r.status = status;
        if (notes !== undefined) r.notes = notes;
        saveState(st);
        return r;
      }
      const patch = { status: status };
      if (notes !== undefined) patch.notes = notes;
      const { data, error } = await sb()
        .from('penerimaan_barang').update(patch).eq('id', id).select().single();
      throwIfError(error);
      return data;
    },

    /* Tempel URL foto (hasil uploadProof) ke record yang sudah ada.
       Dipakai di halaman Detail — beda dari insert() yang menyimpan foto
       untuk penerimaan yang baru dibuat lewat form. */
    updatePhoto: async function (id, url) {
      if (DEMO) {
        const st = loadState();
        const r = st.penerimaan.find(function (x) { return x.id === id; });
        if (!r) throw new Error('Data tidak ditemukan');
        r.proof_image_url = url;
        saveState(st);
        return r;
      }
      const { data, error } = await sb()
        .from('penerimaan_barang').update({ proof_image_url: url }).eq('id', id).select().single();
      throwIfError(error);
      return data;
    },

    /* Tandai/lepas favorit (urgent) — dipanggil dengan nilai target eksplisit
       (bukan "toggle" di server) supaya tidak perlu round-trip baca dulu;
       pemanggil (dashboard.js) sudah tahu status saat ini dari data yang dirender. */
    setFavorite: async function (id, value) {
      if (DEMO) {
        const st = loadState();
        const r = st.penerimaan.find(function (x) { return x.id === id; });
        if (!r) throw new Error('Data tidak ditemukan');
        r.is_favorite = !!value;
        saveState(st);
        return r;
      }
      const { data, error } = await sb()
        .from('penerimaan_barang').update({ is_favorite: !!value }).eq('id', id).select().single();
      throwIfError(error);
      return data;
    },

    /* Upload foto bukti ke bucket `proofs` (demo: object URL) */
    uploadProof: async function (file) {
      if (DEMO) {
        return new Promise(function (resolve) {
          const reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.readAsDataURL(file);
        });
      }
      const client = sb();
      const safeName = String(file.name || 'foto').replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = 'penerimaan/' + Date.now() + '_' + safeName;
      const { error } = await client.storage.from('proofs')
        .upload(path, file, { cacheControl: '3600', upsert: false });
      throwIfError(error);
      const { data } = client.storage.from('proofs').getPublicUrl(path);
      return data.publicUrl;
    },

    /* Realtime: subscribe perubahan tabel penerimaan_barang */
    subscribePenerimaan: function (onChange) {
      if (DEMO) return { unsubscribe: function () {} };
      const channel = sb().channel('penerimaan-changes')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'penerimaan_barang' },
          function (payload) { onChange(payload.new); })
        .subscribe();
      return { unsubscribe: function () { channel.unsubscribe(); } };
    },

    isDemo: function () { return DEMO; },
  };

  window.SPB = window.SPB || {};
  window.SPB.db = db;
})();
