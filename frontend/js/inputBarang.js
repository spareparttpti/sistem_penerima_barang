/* =========================================================
   SPB · inputBarang.js
   Form multi-step 4 section:
   1. Informasi (tanggal, jam, No PO, vendor, petugas)
   2. Item (tambah/hapus baris sparepart, qty, kondisi)
   3. Foto Bukti (upload ke bucket proofs / preview demo)
   4. Catatan + ringkasan
   Submit → simpan ke db (status In Inspection) → notifikasi Teamly.
   ========================================================= */

(function () {
  'use strict';

  const STEPS = [
    { n: 1, label: 'Informasi', icon: 'file-text' },
    { n: 2, label: 'Item', icon: 'package' },
    { n: 3, label: 'Foto Bukti', icon: 'camera' },
    { n: 4, label: 'Catatan', icon: 'message-square' },
  ];

  function defaultForm(spareparts) {
    return {
      step: 1,
      tanggal: new Date().toISOString().slice(0, 10),
      jam: new Date().toTimeString().slice(0, 5),
      po_number: '',
      vendor_name: '',
      receiver_name: '',
      items: [{ sparepart_id: spareparts[0] ? spareparts[0].id : '', qty: 1, condition: 'Baik' }],
      proof: { file: null, preview: '', url: '', uploading: false, progress: 0 },
      notes: '',
      submitting: false,
    };
  }

  const inputCls = 'input';
  const selCls = 'select';

  function stepBtn(s) {
    const f = window.SPB.form;
    const active = f.step === s.n;
    const done = f.step > s.n;
    const circle = done ? 'step-circle done' : active ? 'step-circle active' : 'step-circle pending';
    const labelCls = active ? 'step-label active-label' : 'step-label pending-label';
    const icon = done ? '<i data-lucide="check" class="icon-sm"></i>' : '<i data-lucide="' + s.icon + '" class="icon-sm"></i>';
    return '<div class="step-item">' +
      '<div class="step-node">' +
        '<button type="button" onclick="SPB.inputBarang.goStep(' + s.n + ')" class="' + circle + '" aria-label="Langkah ' + s.n + '">' + icon + '</button>' +
        '<span class="' + labelCls + '">' + s.label + '</span>' +
      '</div>' +
      (s.n < 4 ? '<div class="step-line ' + (done ? 'done' : 'pending') + '"></div>' : '') +
    '</div>';
  }

  function section1Html() {
    const f = window.SPB.form;
    // Alur Odoo tidak lagi lewat form ini: data WH/IN masuk ke log lewat
    // "Import Odoo" di Dashboard, lalu dikonfirmasi di halaman detail.
    // Form ini khusus penerimaan yang dicatat manual tanpa acuan Odoo.
    return '<div class="form-grid">' +
      '<div><label class="field-label" for="f-tanggal">Tanggal Terima *</label>' +
      '<input type="date" id="f-tanggal" class="' + inputCls + '" value="' + esc(f.tanggal) + '"></div>' +
      '<div><label class="field-label" for="f-jam">Jam Terima</label>' +
      '<input type="time" id="f-jam" class="' + inputCls + '" value="' + esc(f.jam) + '"></div>' +
      '<div><label class="field-label" for="f-po">No PO / Surat Jalan *</label>' +
      '<input type="text" id="f-po" class="' + inputCls + '" placeholder="cth: PO-9923" value="' + esc(f.po_number) + '"></div>' +
      '<div><label class="field-label" for="f-vendor">Nama Vendor / Supplier *</label>' +
      '<input type="text" id="f-vendor" class="' + inputCls + '" placeholder="cth: PT Sukses Teknik" value="' + esc(f.vendor_name) + '"></div>' +
      '<div class="form-field-full"><label class="field-label" for="f-receiver">Nama Petugas Penerima *</label>' +
      '<input type="text" id="f-receiver" class="' + inputCls + '" placeholder="cth: Budi Santoso" value="' + esc(f.receiver_name) + '"></div>' +
    '</div>';
  }

  function itemRow(it, idx) {
    const spareparts = window.SPB.spareparts;
    const opts = spareparts.map(function (sp) {
      return '<option value="' + sp.id + '"' + (it.sparepart_id === sp.id ? ' selected' : '') + '>' +
        esc(sp.sku) + ' — ' + esc(sp.name) + ' (' + esc(sp.category) + ')</option>';
    }).join('');
    const condOpts = ['Baik', 'Rusak', 'Cacat'].map(function (c) {
      return '<option value="' + c + '"' + (it.condition === c ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
    return '<div class="item-row" data-row="' + idx + '">' +
      '<div class="col-12 col-sm-5"><label class="item-label">Sparepart / SKU *</label>' +
      '<select data-field="sparepart_id" class="' + selCls + '">' + opts + '</select></div>' +
      '<div class="col-4 col-sm-2"><label class="item-label">Qty *</label>' +
      '<input type="number" min="1" data-field="qty" class="' + inputCls + '" value="' + esc(it.qty) + '"></div>' +
      '<div class="col-5 col-sm-3"><label class="item-label">Kondisi *</label>' +
      '<select data-field="condition" class="' + selCls + '">' + condOpts + '</select></div>' +
      '<div class="col-3 col-sm-2 row-delete">' +
      '<button type="button" class="item-delete-btn" onclick="SPB.inputBarang.removeRow(' + idx + ')" aria-label="Hapus item"><i data-lucide="trash-2" class="icon-sm"></i></button></div>' +
    '</div>';
  }

  function section2Html() {
    const f = window.SPB.form;
    return '<div id="items-wrap">' + f.items.map(itemRow).join('') + '</div>' +
      '<button type="button" class="btn btn-dashed" onclick="SPB.inputBarang.addRow()"><i data-lucide="plus" class="icon-sm"></i>Tambah Item</button>' +
      '<p style="font-size:0.6875rem;color:var(--slate-400);margin-top:0.5rem">Pilih SKU dari master data <code style="background:var(--slate-100);border-radius:0.25rem;padding:0 0.25rem">spareparts</code> (Supabase). Qty &amp; kondisi diisi sesuai pemeriksaan fisik.</p>';
  }

  function section3Html() {
    const f = window.SPB.form;
    const p = f.proof;
    if (p.url) {
      return '<div class="upload-done fade-in">' +
        '<i data-lucide="cloud-upload" class="icon-md"></i>' +
        '<div style="min-width:0"><p style="font-weight:600">Foto berhasil diunggah</p>' +
        '<p class="upload-done-url">' + esc(p.url) + '</p>' +
        '<button type="button" class="upload-again" onclick="SPB.inputBarang.resetProof()">Unggah ulang</button></div>' +
        (p.preview ? '<img src="' + p.preview + '" style="width:4rem;height:4rem;border-radius:0.75rem;object-fit:cover;margin-left:auto;border:1px solid var(--emerald-200)" alt="preview">' : '') +
      '</div>';
    }
    if (p.uploading) {
      return '<div class="upload-progress">' +
        '<p class="upload-progress-label"><i data-lucide="loader-2" class="icon-sm spin" style="color:var(--brand-600)"></i>Mengunggah ke bucket <code style="background:var(--slate-100);border-radius:0.25rem;padding:0 0.25rem">proofs</code>...</p>' +
        '<div class="progress-track"><div class="progress-bar" style="width:' + p.progress + '%"></div></div>' +
        '<p class="progress-meta">' + p.progress + '% · direct upload ke Supabase Storage</p></div>';
    }
    return '<div class="dropzone" onclick="document.getElementById(\'f-file\').click()">' +
      '<div class="dropzone-icon"><i data-lucide="camera" class="icon-xl"></i></div>' +
      '<p class="dropzone-title">Foto Surat Jalan / Fisik Barang</p>' +
      '<p class="dropzone-sub">Klik atau seret foto ke sini — langsung diunggah ke bucket <code>proofs</code></p>' +
      '<input type="file" id="f-file" accept="image/*" class="hidden" onchange="SPB.inputBarang.handleFile(this.files[0])">' +
      (p.preview ? '<img src="' + p.preview + '" class="dropzone-preview" alt="preview">' : '') +
    '</div>';
  }

  function section4Html() {
    const f = window.SPB.form;
    const totalItems = f.items.reduce(function (a, it) { return a + (parseInt(it.qty, 10) || 0); }, 0);
    return '<div><label class="field-label" for="f-notes">Catatan / Discrepancy</label>' +
      '<textarea id="f-notes" class="textarea" rows="4" placeholder="cth: Ada 2 item rusak, mohon tindak lanjut ke vendor...">' + esc(f.notes) + '</textarea></div>' +
      '<div class="summary-box">' +
        '<p class="summary-title"><i data-lucide="clipboard-check" class="icon-md"></i>Ringkasan Penerimaan</p>' +
        '<dl class="summary-grid">' +
          '<dt>No PO</dt><dd>#' + esc(f.po_number || '-') + '</dd>' +
          '<dt>Vendor</dt><dd>' + esc(f.vendor_name || '-') + '</dd>' +
          '<dt>Jumlah Item</dt><dd>' + f.items.length + ' jenis</dd>' +
          '<dt>Total Qty</dt><dd>' + totalItems + ' pcs</dd>' +
          '<dt>Bukti Foto</dt><dd>' + (f.proof.url ? 'Terupload' : 'Belum ada') + '</dd>' +
        '</dl>' +
      '</div>';
  }

  function collectForm() {
    const f = window.SPB.form;
    f.tanggal = document.getElementById('f-tanggal').value;
    f.jam = document.getElementById('f-jam').value;
    f.po_number = document.getElementById('f-po').value.trim();
    f.vendor_name = document.getElementById('f-vendor').value.trim();
    f.receiver_name = document.getElementById('f-receiver').value.trim();
    const notes = document.getElementById('f-notes');
    if (notes) f.notes = notes.value;
    const wrap = document.getElementById('items-wrap');
    if (wrap) {
      f.items = Array.prototype.map.call(wrap.querySelectorAll('.item-row'), function (row) {
        return {
          sparepart_id: row.querySelector('[data-field="sparepart_id"]').value,
          qty: parseInt(row.querySelector('[data-field="qty"]').value, 10) || 0,
          condition: row.querySelector('[data-field="condition"]').value,
        };
      });
    }
  }

  function render() {
    const app = document.getElementById('app');
    let f = window.SPB.form;
    if (!f) {
      // Pastikan spareparts sudah ada (fallback ke array kosong)
      window.SPB.spareparts = window.SPB.spareparts || [];
      window.SPB.form = defaultForm(window.SPB.spareparts);
      f = window.SPB.form;
    }

    const sections = { 1: section1Html(), 2: section2Html(), 3: section3Html(), 4: section4Html() };
    const nextLabel = f.step < 4 ? 'Lanjut' : 'Simpan & Kirim ke QC';
    const nextIcon = f.step < 4 ? 'arrow-right' : 'send';

    app.innerHTML = window.SPB.ui.layout('input',
      '<div class="page-head"><div><h1 class="page-title">Input Barang Masuk</h1>' +
      '<p class="page-sub">Form multi-langkah untuk mencatat penerimaan sparepart.</p></div></div>' +
      '<div class="stepper">' + STEPS.map(stepBtn).join('') + '</div>' +
      '<div class="form-card">' +
        '<h2 class="section-title">Section ' + f.step + ': ' + STEPS[f.step - 1].label + '</h2>' +
        '<form onsubmit="event.preventDefault();SPB.inputBarang.next()">' +
          sections[f.step] +
          '<div class="form-actions">' +
            (f.step > 1
              ? '<button type="button" class="btn btn-outline" onclick="SPB.inputBarang.prev()"><i data-lucide="arrow-left" class="icon-sm"></i>Kembali</button>'
              : '<span></span>') +
            '<button type="submit" class="btn btn-primary" ' + (f.submitting ? 'disabled' : '') + '>' +
              '<i data-lucide="' + nextIcon + '" class="icon-sm"></i>' + (f.submitting ? 'Menyimpan...' : nextLabel) +
            '</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="callout"><i data-lucide="shield-check" class="icon-md"></i>' +
      '<p><b style="color:var(--slate-700)">Alur:</b> Data tersimpan ke <code>penerimaan_barang</code> + <code>detail_penerimaan</code> dengan status awal <b>In Inspection</b>. Tim QC kemudian Approve/Reject via halaman Detail.</p></div>'
    );
    window.SPB.ui.afterRender();
  }

  function goStep(n) {
    const f = window.SPB.form;
    if (n < f.step) { f.step = n; render(); return; }
    if (n === f.step) return;
    // Hanya boleh maju jika langkah sebelumnya valid
    collectForm();
    if (f.step === 1) {
      if (!f.tanggal || !f.po_number || !f.vendor_name || !f.receiver_name) {
        window.SPB.ui.toast('Lengkapi Section 1', 'Tanggal, No PO, vendor, dan petugas wajib diisi.', 'error');
        return;
      }
    }
    if (f.step === 2) {
      if (!f.items.length || f.items.some(function (it) { return !it.sparepart_id || it.qty <= 0; })) {
        window.SPB.ui.toast('Lengkapi item', 'Pilih sparepart dan isi qty minimal 1.', 'error');
        return;
      }
    }
    f.step = n;
    render();
  }

  function prev() {
    const f = window.SPB.form;
    if (f.step > 1) { f.step--; render(); }
  }

  async function next() {
    const f = window.SPB.form;
    collectForm();

    if (f.step === 1) {
      if (!f.tanggal || !f.po_number || !f.vendor_name || !f.receiver_name) {
        window.SPB.ui.toast('Lengkapi Section 1', 'Tanggal, No PO, vendor, dan petugas wajib diisi.', 'error');
        return;
      }
      f.step = 2; render(); return;
    }
    if (f.step === 2) {
      if (!f.items.length || f.items.some(function (it) { return !it.sparepart_id || it.qty <= 0; })) {
        window.SPB.ui.toast('Lengkapi item', 'Pilih sparepart dan isi qty minimal 1.', 'error');
        return;
      }
      f.step = 3; render(); return;
    }
    if (f.step === 3) {
      if (f.proof.file && !f.proof.url) {
        await uploadNow();
        return; // setelah upload selesai lanjut manual via handleFile callback
      }
      f.step = 4; render(); return;
    }
    if (f.step === 4) {
      await submit();
    }
  }

  async function uploadNow() {
    const f = window.SPB.form;
    if (!f.proof.file || f.proof.uploading || f.proof.url) return;
    f.proof.uploading = true;
    f.proof.progress = 0;
    render();
    try {
      const url = await window.SPB.db.uploadProof(f.proof.file);
      f.proof.url = url;
      f.proof.uploading = false;
      f.proof.progress = 100;
      render();
      window.SPB.ui.toast('Foto terunggah', 'Bukti tersimpan di bucket proofs.', 'success');
      // Lanjut otomatis ke Section 4 bila berasal dari tombol Lanjut
      if (f.step === 3) { f.step = 4; render(); }
    } catch (err) {
      f.proof.uploading = false;
      render();
      // Trigger UI / Upload Fail -> @Frontend Developer
      try {
        const payload = window.SPB.teamly.buildTeamlyPayload({
          status: 'In Inspection',
          record: { id: 'n/a', po_number: f.po_number || '-', vendor_name: f.vendor_name || '-', notes: 'Upload foto gagal: ' + err.message },
          trigger: 'ui', triggerReason: 'Upload file ke Supabase Storage gagal',
        });
        await window.SPB.teamly.sendTeamlyNotification(payload);
      } catch (e) { /* ignore */ }
      window.SPB.ui.toast('Upload gagal', err.message, 'error');
    }
  }

  async function submit() {
    const f = window.SPB.form;
    if (!f.po_number || !f.vendor_name || !f.receiver_name) {
      window.SPB.ui.toast('Data belum lengkap', 'Lengkapi informasi penerimaan.', 'error');
      return;
    }
    f.submitting = true;
    render();
    try {
      const created_at = new Date(f.tanggal + 'T' + f.jam + ':00+07:00').toISOString();
      const { id } = await window.SPB.db.insert({
        po_number: f.po_number,
        vendor_name: f.vendor_name,
        receiver_name: f.receiver_name,
        notes: f.notes,
        proof_image_url: f.proof.url || null,
        created_at: created_at,
        items: f.items.map(function (it) {
          return { sparepart_id: it.sparepart_id, qty_received: it.qty, condition: it.condition };
        }),
      });

      // Notifikasi Teamly: status In Inspection -> @Frontend Developer
      const payload = window.SPB.teamly.buildTeamlyPayload({
        status: 'In Inspection',
        record: { id: id, po_number: f.po_number, vendor_name: f.vendor_name, notes: f.notes || '-' },
        trigger: 'ui',
        triggerReason: 'Penerimaan baru dicatat — menunggu inspeksi tim gudang',
      });
      await window.SPB.teamly.sendTeamlyNotification(payload);

      window.SPB.form = defaultForm(window.SPB.spareparts);
      window.SPB.ui.toast('Penerimaan tersimpan', '#' + f.po_number + ' masuk antrean inspeksi (In Inspection).', 'success');
      location.hash = '#/penerimaan/' + id;
    } catch (err) {
      f.submitting = false;
      render();
      window.SPB.ui.toast('Gagal menyimpan', err.message, 'error');
    }
  }

  function addRow() {
    const f = window.SPB.form;
    f.items.push({ sparepart_id: window.SPB.spareparts[0] ? window.SPB.spareparts[0].id : '', qty: 1, condition: 'Baik' });
    render();
  }

  function removeRow(idx) {
    const f = window.SPB.form;
    if (f.items.length > 1) {
      f.items.splice(idx, 1);
      render();
    }
  }

  function handleFile(file) {
    if (!file) return;
    const f = window.SPB.form;
    f.proof.file = file;
    f.proof.preview = URL.createObjectURL(file);
    render();
    uploadNow();
  }

  function resetProof() {
    const f = window.SPB.form;
    f.proof = { file: null, preview: '', url: '', uploading: false, progress: 0 };
    render();
  }

  window.SPB = window.SPB || {};
  window.SPB.inputBarang = {
    render: render,
    goStep: goStep,
    prev: prev,
    next: next,
    addRow: addRow,
    removeRow: removeRow,
    handleFile: handleFile,
    resetProof: resetProof,
  };
})();