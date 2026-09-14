/* =========================================================
   SPB · odoo.js
   Jembatan data Odoo → SPB.

   Sumber data saat ini: file hasil **Export** dari list view Odoo
   (Inventory → Receipts → centang baris → ⚙️ Action → Export → CSV).
   Tidak butuh API key, jadi bisa dipakai tanpa izin tim IT.

   Kalau nanti API key Odoo tersedia, cukup ganti isi `fetchFromApi()`
   (XML-RPC/JSON-RPC via Edge Function) — struktur data & seluruh UI
   yang memakainya tidak perlu diubah.

   Struktur record hasil normalisasi:
     {
       wh_in_ref:      'WH/IN/00002',
       contact:        'GURITA MANDALA PERSADA, PT.',
       origin:         'P00002',        // Source Document (No PO)
       scheduled_date: '2025-12-02',
       state:          'Ready',         // Draft | Ready | Done | Cancelled
       location_from:  'Partners/Vendors',
       location_to:    'Physical Locations/WH/Stock',
       lines: [ { product: 'Bearing SKF 6205', sku: 'SPR-0001', qty_po: 10, uom: 'pcs' } ]
     }
   ========================================================= */

(function () {
  'use strict';


  /* ---------------------------------------------------------
     1. Parser CSV (RFC 4180: quoted field, escaped quote, newline
        di dalam field). Odoo mengekspor UTF-8 dengan BOM.
     --------------------------------------------------------- */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === '"') { inQuotes = true; continue; }
      if (c === delim) { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    return rows.filter(function (r) {
      return r.some(function (cell) { return cell.trim() !== ''; });
    });
  }

  /* Odoo memakai ',' atau ';' tergantung locale — deteksi dari baris header. */
  function detectDelimiter(text) {
    const head = text.split(/\r?\n/)[0] || '';
    let comma = 0, semi = 0, inQ = false;
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && c === ',') comma++;
      else if (!inQ && c === ';') semi++;
    }
    return semi > comma ? ';' : ',';
  }

  /* ---------------------------------------------------------
     2. Pemetaan header → field kanonik.
        Menangani label UI Odoo (EN/ID) maupun nama teknis field
        (name, partner_id, origin, ...) karena export bisa memakai
        salah satu, dan versi Odoo berbeda memberi label berbeda.
     --------------------------------------------------------- */
  const HEADER_MAP = {
    wh_in_ref: ['reference', 'referensi', 'name', 'nomor', 'no referensi', 'picking'],
    contact: ['contact', 'kontak', 'partner_id', 'partner', 'vendor', 'supplier', 'pemasok'],
    origin: ['source document', 'dokumen sumber', 'origin', 'sumber', 'source doc'],
    scheduled_date: ['scheduled date', 'tanggal dijadwalkan', 'scheduled_date', 'jadwal', 'tanggal'],
    state: ['status', 'state', 'keadaan'],
    location_from: ['from', 'dari', 'location_id', 'source location', 'lokasi asal'],
    location_to: ['to', 'ke', 'location_dest_id', 'destination location', 'lokasi tujuan'],
    batch: ['batch transfer', 'batch_id', 'batch'],
    product: ['product', 'produk', 'move_ids/product_id', 'product_id', 'item', 'nama produk'],
    sku: ['sku', 'internal reference', 'default_code', 'kode', 'kode produk'],
    qty_po: ['quantity', 'demand', 'kuantitas', 'permintaan', 'qty', 'product_uom_qty',
             'move_ids/product_uom_qty', 'move_ids/quantity'],
    uom: ['unit of measure', 'uom', 'satuan', 'product_uom'],
  };

  function normalizeHeader(h) {
    return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /* Cocokkan tiap kolom header ke field kanonik. Kolom yang tidak
     dikenali diabaikan (Odoo sering menyertakan kolom tambahan). */
  function mapHeaders(headerRow) {
    const idx = {};
    headerRow.forEach(function (raw, i) {
      const h = normalizeHeader(raw);
      if (!h) return;
      // Buang prefix relasi Odoo, mis. "move_ids_without_package/product_id" → cocokkan juga potongan akhir
      const tail = h.indexOf('/') >= 0 ? h.slice(h.lastIndexOf('/') + 1) : h;
      Object.keys(HEADER_MAP).forEach(function (field) {
        if (field in idx) return; // kolom pertama yang cocok yang dipakai
        const found = HEADER_MAP[field].some(function (alias) {
          return h === alias || tail === alias;
        });
        if (found) idx[field] = i;
      });
    });
    return idx;
  }

  /* ---------------------------------------------------------
     3. Normalisasi status Odoo → label yang dipakai UI.
     --------------------------------------------------------- */
  const STATE_MAP = {
    draft: 'Draft', 'ready': 'Ready', assigned: 'Ready', confirmed: 'Waiting',
    waiting: 'Waiting', done: 'Done', cancel: 'Cancelled', cancelled: 'Cancelled',
    'siap': 'Ready', 'selesai': 'Done', 'dibatalkan': 'Cancelled', 'menunggu': 'Waiting',
  };

  function normalizeState(v) {
    const k = String(v || '').trim().toLowerCase();
    return STATE_MAP[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : '');
  }

  /* Odoo mengekspor tanggal sebagai 'YYYY-MM-DD HH:MM:SS' atau '02 Dec 2025'
     tergantung format bahasa. Kembalikan 'YYYY-MM-DD', atau string asli
     bila tidak terbaca (lebih baik tampil apa adanya daripada hilang). */
  function normalizeDate(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];

    // XLSX menyimpan tanggal sebagai angka serial (hari sejak 1899-12-30).
    // Hanya diterapkan pada kolom tanggal, jadi tidak mungkin mengacaukan qty.
    // Rentang 20000–80000 ≈ tahun 1954–2119; di luar itu anggap bukan tanggal.
    if (/^\d+(\.\d+)?$/.test(s)) {
      const serial = parseFloat(s);
      if (serial >= 20000 && serial <= 80000) {
        const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
        return new Date(ms).toISOString().slice(0, 10);
      }
    }
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      const p = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
      return p.toISOString().slice(0, 10);
    }
    return s;
  }

  /* Angka bisa datang sebagai '1250', '1250.00', '1.250,00' (ID) atau '1,250.00' (EN).
     Aturan: bila kedua pemisah ada, yang paling kanan adalah desimal. Bila hanya satu
     jenis yang ada, itu desimal hanya kalau muncul sekali dan diikuti selain 3 digit —
     '1,250' berarti seribu dua ratus lima puluh, bukan 1,25. */
  function toNumber(v) {
    let s = String(v == null ? '' : v).trim().replace(/\s/g, '');
    if (!s) return 0;

    const hasDot = s.indexOf('.') >= 0;
    const hasComma = s.indexOf(',') >= 0;

    if (hasDot && hasComma) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
    } else if (hasDot || hasComma) {
      const sep = hasComma ? ',' : '.';
      const parts = s.split(sep);
      const isDecimal = parts.length === 2 && parts[1].length !== 3;
      s = isDecimal ? parts[0] + '.' + parts[1] : parts.join('');
    }

    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  /* ---------------------------------------------------------
     4. Rows → daftar receipt.
        Export Odoo dengan sub-field (item) menghasilkan baris lanjutan
        yang kolom header-nya KOSONG — baris itu milik receipt di atasnya.
        Karena itu kolom header di-"forward fill".
     --------------------------------------------------------- */
  function rowsToReceipts(rows) {
    if (!rows.length) return { receipts: [], warnings: ['File kosong.'] };

    const idx = mapHeaders(rows[0]);
    const warnings = [];
    if (!('wh_in_ref' in idx)) {
      return {
        receipts: [],
        warnings: ['Kolom "Reference" (No WH/IN) tidak ditemukan di file. ' +
                   'Pastikan kolom Reference ikut diekspor dari Odoo.'],
      };
    }
    if (!('origin' in idx)) warnings.push('Kolom "Source Document" tidak ada — No PO tidak akan terisi otomatis.');
    if (!('contact' in idx)) warnings.push('Kolom "Contact" tidak ada — nama vendor tidak akan terisi otomatis.');
    if (!('product' in idx)) warnings.push('Kolom item/produk tidak ada — daftar barang harus diisi manual.');

    const cell = function (row, field) {
      return field in idx ? String(row[idx[field]] == null ? '' : row[idx[field]]).trim() : '';
    };

    const byRef = {};
    const order = [];
    let current = null;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const ref = cell(row, 'wh_in_ref');

      if (ref) {
        if (byRef[ref]) {
          current = byRef[ref];
        } else {
          current = {
            wh_in_ref: ref,
            contact: cell(row, 'contact'),
            origin: cell(row, 'origin'),
            scheduled_date: normalizeDate(cell(row, 'scheduled_date')),
            state: normalizeState(cell(row, 'state')),
            location_from: cell(row, 'location_from'),
            location_to: cell(row, 'location_to'),
            batch: cell(row, 'batch'),
            lines: [],
          };
          byRef[ref] = current;
          order.push(ref);
        }
      }
      if (!current) continue; // baris item sebelum header apa pun — tidak bisa dipetakan

      const product = cell(row, 'product');
      const sku = cell(row, 'sku');
      if (product || sku) {
        current.lines.push({
          product: product,
          sku: sku,
          qty_po: toNumber(cell(row, 'qty_po')),
          uom: cell(row, 'uom') || 'pcs',
        });
      }
    }

    return { receipts: order.map(function (k) { return byRef[k]; }), warnings: warnings };
  }

  /* ---------------------------------------------------------
     4b. Pembaca XLSX — tanpa library eksternal.

     File .xlsx sebenarnya arsip ZIP berisi XML. Isinya dibuka memakai
     DecompressionStream('deflate-raw') yang sudah ada di browser modern,
     jadi tidak perlu memuat SheetJS dari CDN (aplikasi ini dirancang bisa
     jalan tanpa internet).

     Catatan: .xls lama (biner BIFF) format-nya sama sekali berbeda dan
     TIDAK didukung — Odoo mengekspor .xlsx, jadi ini tidak jadi masalah.
     --------------------------------------------------------- */

  function supportsXlsx() {
    return typeof DecompressionStream === 'function';
  }

  /* --- ZIP: baca central directory, ambil entri yang dibutuhkan --- */
  function unzip(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Cari End Of Central Directory dari belakang (comment maksimal 65535 byte)
    let eocd = -1;
    const minPos = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minPos; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('File Excel tidak valid (struktur ZIP tidak ditemukan).');

    let count = view.getUint16(eocd + 10, true);
    let dirOffset = view.getUint32(eocd + 16, true);
    if (dirOffset === 0xffffffff || count === 0xffff) {
      throw new Error('File Excel memakai format ZIP64 (terlalu besar). Export ulang dengan baris lebih sedikit, atau pakai CSV.');
    }

    const entries = [];
    let p = dirOffset;
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const cmtLen = view.getUint16(p + 32, true);
      const localOff = view.getUint32(p + 42, true);
      const name = utf8(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name: name, method: method, compSize: compSize, localOff: localOff });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return { view: view, bytes: bytes, entries: entries };
  }

  function utf8(u8) {
    return typeof TextDecoder === 'function'
      ? new TextDecoder('utf-8').decode(u8)
      : String.fromCharCode.apply(null, u8);
  }

  /* Ambil isi satu entri ZIP sebagai teks. Panjang header lokal harus dibaca
     ulang di sini — nilai di central directory bisa berbeda. */
  function readEntry(zip, name) {
    const e = zip.entries.find(function (x) { return x.name === name; });
    if (!e) return Promise.resolve(null);

    const off = e.localOff;
    if (zip.view.getUint32(off, true) !== 0x04034b50) {
      return Promise.reject(new Error('Struktur file Excel rusak pada ' + name + '.'));
    }
    const nameLen = zip.view.getUint16(off + 26, true);
    const extraLen = zip.view.getUint16(off + 28, true);
    const start = off + 30 + nameLen + extraLen;
    const data = zip.bytes.subarray(start, start + e.compSize);

    if (e.method === 0) return Promise.resolve(utf8(data));           // disimpan apa adanya
    if (e.method !== 8) {
      return Promise.reject(new Error('Kompresi file Excel tidak didukung (metode ' + e.method + ').'));
    }
    // Kompresi deflate mentah — dibuka oleh browser
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return utf8(new Uint8Array(buf));
    });
  }

  function xmlDecode(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&amp;/g, '&');   // terakhir, agar "&amp;lt;" tidak ikut terurai
  }

  /* Tabel string bersama: sel bertipe "s" menyimpan indeks ke tabel ini. */
  function parseSharedStrings(xml) {
    if (!xml) return [];
    const out = [];
    const si = xml.match(/<si\b[^>]*>[\s\S]*?<\/si>|<si\b[^>]*\/>/g) || [];
    si.forEach(function (block) {
      // Satu <si> bisa berisi banyak <t> (teks dengan format campuran) — digabung
      const parts = block.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
      out.push(parts.map(function (t) {
        return xmlDecode(t.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''));
      }).join(''));
    });
    return out;
  }

  /* "BC12" → 54 (indeks kolom berbasis 0). Perlu karena sel kosong
     tidak ditulis di XLSX — tanpa ini kolom bisa bergeser. */
  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
    if (!m) return -1;
    let n = 0;
    for (let i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }

  function parseSheet(xml, shared) {
    const rows = [];
    const rowXml = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || [];

    rowXml.forEach(function (rx) {
      const cells = [];
      let max = -1;
      const cellXml = rx.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || [];

      cellXml.forEach(function (cx) {
        const attrs = (/^<c\b([^>]*?)\/?>/.exec(cx) || [, ''])[1];
        const ref = (/\br="([^"]+)"/.exec(attrs) || [])[1];
        const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';

        let val = '';
        if (type === 'inlineStr') {
          const t = cx.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
          val = t.map(function (x) {
            return xmlDecode(x.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''));
          }).join('');
        } else {
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cx);
          val = v ? xmlDecode(v[1]) : '';
          if (type === 's') {
            const i = parseInt(val, 10);
            val = shared[i] != null ? shared[i] : '';
          }
        }

        const ci = ref ? colIndex(ref) : cells.length;
        const at = ci >= 0 ? ci : cells.length;
        cells[at] = val;
        if (at > max) max = at;
      });

      for (let i = 0; i <= max; i++) if (cells[i] == null) cells[i] = '';
      rows.push(cells);
    });

    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  /* Tentukan worksheet pertama lewat workbook.xml + rels; kalau gagal,
     jatuh ke file worksheet pertama yang ada. */
  function firstSheetPath(zip, workbookXml, relsXml) {
    const sheetsInZip = zip.entries
      .map(function (e) { return e.name; })
      .filter(function (n) { return /^xl\/worksheets\/[^/]+\.xml$/.test(n); })
      .sort();

    if (workbookXml && relsXml) {
      const first = /<sheet\b[^>]*>/.exec(workbookXml);
      const rid = first && (/r:id="([^"]+)"/.exec(first[0]) || [])[1];
      if (rid) {
        const re = new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*>');
        const rel = re.exec(relsXml);
        const target = rel && (/Target="([^"]+)"/.exec(rel[0]) || [])[1];
        if (target) {
          const path = target.indexOf('/') === 0
            ? target.slice(1)
            : 'xl/' + target.replace(/^\.\//, '');
          if (sheetsInZip.indexOf(path) >= 0) return path;
        }
      }
    }
    return sheetsInZip[0] || null;
  }

  function parseXlsx(buffer) {
    if (!supportsXlsx()) {
      return Promise.reject(new Error(
        'Browser ini belum mendukung pembacaan Excel. Pakai Chrome/Edge versi baru, ' +
        'atau export ulang dari Odoo dalam format CSV.'
      ));
    }

    let zip;
    try { zip = unzip(buffer); }
    catch (e) { return Promise.reject(e); }

    return Promise.all([
      readEntry(zip, 'xl/sharedStrings.xml'),
      readEntry(zip, 'xl/workbook.xml'),
      readEntry(zip, 'xl/_rels/workbook.xml.rels'),
    ]).then(function (res) {
      const shared = parseSharedStrings(res[0]);
      const path = firstSheetPath(zip, res[1], res[2]);
      if (!path) throw new Error('Tidak ada worksheet di dalam file Excel ini.');
      return readEntry(zip, path).then(function (sheetXml) {
        if (!sheetXml) throw new Error('Worksheet tidak terbaca: ' + path);
        return parseSheet(sheetXml, shared);
      });
    });
  }

  /* ---------------------------------------------------------
     5. Import.

     Modul ini TIDAK lagi menyimpan data sendiri. Hasil parsing langsung
     diserahkan ke lapisan data (SPB.db.importOdoo) agar masuk ke log
     penerimaan utama — tidak ada lagi salinan sementara yang bisa
     berbeda isi dengan log.
     --------------------------------------------------------- */

  /* Ubah baris mentah (CSV/XLSX) menjadi daftar receipt siap simpan. */
  function importRows(rows) {
    return rowsToReceipts(rows);
  }

  function importCsv(text) {
    return importRows(parseCsv(text));
  }

  function importXlsx(buffer) {
    return parseXlsx(buffer).then(importRows);
  }

  function readFile(file, asBuffer) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('File gagal dibaca.')); };
      reader.onload = function () { resolve(reader.result); };
      if (asBuffer) reader.readAsArrayBuffer(file);
      else reader.readAsText(file, 'utf-8');
    });
  }

  /* Terima .csv maupun .xlsx — format dipilih dari ekstensi berkas.
     Mengembalikan { receipts, warnings }; penyimpanan dilakukan pemanggil. */
  function importFile(file) {
    const name = String(file.name || '').toLowerCase();

    if (/\.xlsx$/.test(name)) {
      return readFile(file, true).then(importXlsx);
    }
    if (/\.(csv|txt)$/.test(name)) {
      return readFile(file, false).then(function (text) { return importCsv(String(text)); });
    }
    if (/\.xls$/.test(name)) {
      return Promise.reject(new Error(
        'Format .xls lama tidak didukung. Saat Export di Odoo pilih XLSX atau CSV — ' +
        'atau buka file ini di Excel lalu Save As .xlsx.'
      ));
    }
    return Promise.reject(new Error(
      'Format "' + (name.split('.').pop() || '?') + '" tidak didukung. Pakai file CSV atau XLSX hasil Export dari Odoo.'
    ));
  }

  /* ---------------------------------------------------------
     7. Pencocokan item Odoo → master sparepart SPB.
        Prioritas: SKU persis → nama persis → nama mengandung.
        Baris yang tidak cocok dikembalikan agar user bisa pilih manual
        (lebih aman daripada menebak dan salah SKU).
     --------------------------------------------------------- */
  function matchLines(lines, spareparts) {
    const bySku = {};
    const byName = {};
    (spareparts || []).forEach(function (sp) {
      bySku[String(sp.sku || '').toLowerCase()] = sp;
      byName[String(sp.name || '').toLowerCase()] = sp;
    });

    return (lines || []).map(function (ln) {
      const sku = String(ln.sku || '').toLowerCase();
      const name = String(ln.product || '').toLowerCase();
      let sp = bySku[sku] || byName[name] || null;

      if (!sp && name) {
        // Odoo sering menulis "[SPR-0001] Bearing SKF 6205"
        const bracket = name.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (bracket) sp = bySku[bracket[1].toLowerCase()] || byName[bracket[2]] || null;
      }
      if (!sp && name) {
        sp = (spareparts || []).find(function (x) {
          const n = String(x.name || '').toLowerCase();
          return n && (name.indexOf(n) >= 0 || n.indexOf(name) >= 0);
        }) || null;
      }

      return {
        odoo_product: ln.product,
        odoo_sku: ln.sku,
        qty_po: ln.qty_po,
        uom: ln.uom,
        sparepart_id: sp ? sp.id : '',
        matched: !!sp,
      };
    });
  }

  /* ---------------------------------------------------------
     8. Sinkronisasi dari Supabase.

        Odoo mengirim data ke Edge Function `odoo-webhook` setiap kali ada
        transfer masuk dibuat/diubah; function itu menulis ke tabel
        odoo_receipts + odoo_receipt_lines. Fungsi di bawah menariknya ke
        browser dalam bentuk yang sama persis dengan hasil parser file,
        sehingga pemanggil memperlakukan keduanya identik.

        Browser tidak pernah menghubungi Odoo langsung — kena CORS dan
        kredensial Odoo akan terbaca di source code.
     --------------------------------------------------------- */
  function isSupabaseConfigured() {
    const c = window.SPB_CONFIG || {};
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY) &&
           c.SUPABASE_URL.indexOf('YOUR-PROJECT') < 0 &&
           c.SUPABASE_ANON_KEY.indexOf('YOUR-ANON') < 0;
  }

  function syncFromSupabase() {
    if (!isSupabaseConfigured()) {
      return Promise.reject(new Error(
        'Supabase belum dikonfigurasi — isi SUPABASE_URL & SUPABASE_ANON_KEY di config.js. ' +
        'Sementara ini pakai Import CSV.'
      ));
    }

    const c = window.SPB_CONFIG;
    const url = c.SUPABASE_URL.replace(/\/$/, '') +
      '/rest/v1/odoo_receipts' +
      '?select=wh_in_ref,contact,origin,scheduled_date,state,location_from,location_to,batch,' +
      'lines:odoo_receipt_lines(product,sku,qty_po,uom)' +
      '&order=scheduled_date.desc.nullslast&limit=500';

    return fetch(url, {
      headers: { apikey: c.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + c.SUPABASE_ANON_KEY },
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('Supabase ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    }).then(function (rows) {
      // Bentuk baris Supabase sudah sama dengan hasil parser CSV, hanya perlu
      // memastikan field yang null tidak bocor sebagai "null" di UI.
      const receipts = (rows || []).map(function (r) {
        return {
          wh_in_ref: r.wh_in_ref || '',
          contact: r.contact || '',
          origin: r.origin || '',
          scheduled_date: r.scheduled_date || '',
          state: normalizeState(r.state),
          location_from: r.location_from || '',
          location_to: r.location_to || '',
          batch: r.batch || '',
          lines: (r.lines || []).map(function (l) {
            return {
              product: l.product || '',
              sku: l.sku || '',
              qty_po: Number(l.qty_po) || 0,
              uom: l.uom || 'pcs',
            };
          }),
        };
      }).filter(function (r) { return r.wh_in_ref; });

      // Bentuk hasil disamakan dengan importFile agar pemanggil tidak bercabang
      return { receipts: receipts, warnings: [] };
    });
  }

  // Nama lama dipertahankan agar pemanggil yang sudah ada tidak perlu diubah
  const fetchFromApi = syncFromSupabase;

  window.SPB = window.SPB || {};
  window.SPB.odoo = {
    parseCsv: parseCsv,
    parseXlsx: parseXlsx,
    rowsToReceipts: rowsToReceipts,
    importRows: importRows,
    importCsv: importCsv,
    importXlsx: importXlsx,
    importFile: importFile,
    supportsXlsx: supportsXlsx,
    matchLines: matchLines,
    syncFromSupabase: syncFromSupabase,
    fetchFromApi: fetchFromApi,
    isSupabaseConfigured: isSupabaseConfigured,
  };
})();
