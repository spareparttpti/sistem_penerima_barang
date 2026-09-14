/* =========================================================
   SPB · laporan.js
   Halaman Laporan — dua SUMBER data:
     - WH/IN  : rekap penerimaan barang (Semua Data / Ranking Vendor / Ranking
                Status) — perilaku LAMA, tidak diubah.
     - WH/OUT : rekap distribusi ATK ke karyawan (siapa ambil apa & kapan) —
                BARU: Semua Distribusi / Ranking Karyawan / Ringkasan Periode
                (mingguan/bulanan, dengan preset cepat 7 hari/2 minggu/1
                bulan/3 bulan) sesuai permintaan user.
   Diekspor ke Excel (SheetJS) atau PDF (jsPDF + autotable), CDN di index.html.
   ========================================================= */

(function () {
  'use strict';

  // Bukan `const esc = window.esc;` — file ini dimuat SEBELUM app.js sempat
  // memasang window.esc, jadi nilainya ke-capture undefined selamanya kalau
  // diambil di sini. Dipanggil bare (esc(...)) di bawah, di-resolve ke global
  // window.esc saat benar-benar dipanggil (setelah app.js jalan), sama seperti
  // pola yang dipakai dashboard.js/detailQc.js.
  const state = {
    source: 'gabungan',    // 'gabungan' | 'wh-in' | 'wh-out' — 'gabungan' = tampilan awal
    view: 'all',            // wh-in: 'all'|'vendor'|'status'  ·  wh-out: 'all'|'karyawan'|'periode'
    dateFrom: '',
    dateTo: '',
    vendor: '',
    karyawan: '',   // sekarang dipakai sebagai teks PENCARIAN (substring), bukan lagi pilihan dropdown exact-match
    divisi: '',     // filter Departemen/Divisi (dari department si PENERIMA) di semua view WH/OUT
    distStatus: '', // filter status distribusi (Baru/Hilang/Tukar/Habis) di semua view WH/OUT
    granularity: 'week',    // dipakai view 'periode': 'week' | 'month'
    periodPreset: '',       // '' | '7' | '14' | '30' | '90' | 'custom' — dropdown periode WH/OUT
    analisisSku: '',        // SKU yang lagi dipilih di view 'analisis' (Analisis Barang)
    rankDivisi: '', rankSubDivisi: '', rankPos: '', rankMode: 'ringkasan', // filter & tabel di view 'rankingDivisi'
    trendGranularity: 'day', // 'day' | 'week' | 'twoweek' | 'month' — dipakai grafik tren (trendLineHtml)
    trendSplitLevel: '',     // grafik tren WH/OUT: '' = gabungan, 'divisi' | 'subdivisi' | 'pos' = multi-garis
    trendSelectedSeries: [], // nama Divisi/Sub Divisi/Pos yang dipilih manual lewat chip picker (kosong = otomatis top N)
    page: 1,
  };
  const PAGE_SIZE = 20;

  /* ---------- Util umum ---------- */
  function ymd(v) {
    if (!v) return '';
    return String(v).length <= 10 ? String(v) : new Date(v).toISOString().slice(0, 10);
  }
  function fmtDate(v) {
    if (!v) return '-';
    const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function todayYmd() { return new Date().toISOString().slice(0, 10); }
  function daysAgoYmd(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function statCard(icon, iconClass, label, value, sub) {
    return '<div class="stat-card">' +
      '<div><p class="stat-label">' + label + '</p>' +
      '<p class="stat-value">' + value + '</p>' +
      (sub ? '<p class="stat-sub">' + sub + '</p>' : '') + '</div>' +
      '<div class="stat-icon ' + iconClass + '"><i data-lucide="' + icon + '" class="icon-md"></i></div>' +
    '</div>';
  }
  function reportTab(view, icon, label, onclick) {
    return '<button type="button" class="report-tab' + (state.view === view ? ' active' : '') + '" ' +
      'onclick="' + onclick + '">' +
      '<i data-lucide="' + icon + '" class="icon-sm"></i>' + label + '</button>';
  }
  function reportCard(icon, title, bodyHtml) {
    return '<div class="chart-card" style="margin-top:1.25rem">' +
      '<p class="chart-title"><i data-lucide="' + icon + '" class="icon-md"></i>' + title + '</p>' +
      bodyHtml +
    '</div>';
  }
  // Komponen ranking "mewah" (badge emas/perak/perunggu buat top 3) — dipakai
  // di tampilan Gabungan. agg = [{key, value, sub}], color = warna bar.
  function rankListHtml(agg, color, valueSuffix) {
    if (!agg.length) return '<div class="empty-state" style="padding:1.5rem 0">Belum ada data.</div>';
    const max = Math.max(1, agg.reduce(function (m, a) { return Math.max(m, a.value); }, 0));
    return '<div class="rank-list">' +
      agg.map(function (a, i) {
        const pct = Math.round((a.value / max) * 100);
        const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
        return '<div class="rank-item">' +
          '<div class="rank-badge ' + rankClass + '">' + (i + 1) + '</div>' +
          '<div class="rank-info">' +
            '<p class="rank-name" title="' + esc(a.key) + '">' + esc(a.key) + '</p>' +
            '<div class="rank-bar-track"><div class="rank-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
          '</div>' +
          '<div>' +
            '<p class="rank-value">' + a.value + (valueSuffix || '') + '</p>' +
            (a.sub ? '<p class="rank-value-sub">' + esc(a.sub) + '</p>' : '') +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }
  function paginationHtml(page, totalPages, totalRows) {
    if (totalRows === 0) return '';
    if (totalPages <= 1) return '<div class="pagination"><span class="pagination-info">' + totalRows + ' data</span></div>';
    const pages = [];
    const add = function (p) { if (pages.indexOf(p) === -1) pages.push(p); };
    add(1); add(totalPages);
    for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) add(p);
    pages.sort(function (a, b) { return a - b; });
    let numbersHtml = '';
    let prev = 0;
    pages.forEach(function (p) {
      if (p - prev > 1) numbersHtml += '<span class="pagination-ellipsis">…</span>';
      numbersHtml += '<button type="button" class="pagination-num' + (p === page ? ' active' : '') +
        '" onclick="SPB.laporan.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });
    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.laporan.goToPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.laporan.goToPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }
  // Potong array sesuai state.page & PAGE_SIZE, sekalian koreksi state.page
  // kalau kepentok (mis. filter baru bikin total halaman berkurang).
  function paginate(rows) {
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * PAGE_SIZE;
    return { pageRows: rows.slice(start, start + PAGE_SIZE), totalPages: totalPages, totalRows: rows.length };
  }

  function rankBarsHtml(agg, colorFn, valueFn) {
    valueFn = valueFn || function (a) { return a.count; };
    const max = Math.max(1, agg.reduce(function (m, a) { return Math.max(m, valueFn(a)); }, 0));
    return '<div class="hbar-chart">' +
      agg.map(function (a) {
        const v = valueFn(a);
        const pct = Math.round((v / max) * 100);
        return '<div class="hbar-row">' +
          '<div class="hbar-label" title="' + esc(a.key) + '">' + esc(a.key) + '</div>' +
          '<div class="hbar-track" title="' + esc(a.key) + ': ' + v + '">' +
            '<div class="hbar-fill" style="width:' + pct + '%;background:' + colorFn(a) + '"></div>' +
          '</div>' +
          '<div class="hbar-value">' + v + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // Sumbu BAWAH grafik tren = waktu, granularitasnya bisa dipilih (Harian/
  // Mingguan/2 Mingguan/Bulanan) — bukan cuma auto-mingguan kalau kepanjangan
  // kayak dulu. bucketKeyFor() ngasih tau tanggal ini masuk "kotak" yang mana,
  // bucketLabelFor() yang nentuin teks label-nya (beda buat granularitas bulan).
  function mondayOf(dateStr) {
    const dt = new Date(dateStr + 'T00:00:00');
    const day = dt.getDay();
    const monday = new Date(dt); monday.setDate(dt.getDate() - ((day + 6) % 7));
    return monday;
  }
  function bucketKeyFor(dateStr, granularity) {
    if (granularity === 'month') return dateStr.slice(0, 7) + '-01';
    if (granularity === 'week') return mondayOf(dateStr).toISOString().slice(0, 10);
    if (granularity === 'twoweek') {
      const monday = mondayOf(dateStr);
      const epoch = new Date('2020-01-06T00:00:00'); // Senin acuan tetap, biar bucket 14-harinya konsisten antar panggilan
      const weeksSinceEpoch = Math.round((monday - epoch) / (7 * 24 * 3600 * 1000));
      const bucketStart = new Date(epoch);
      bucketStart.setDate(epoch.getDate() + Math.floor(weeksSinceEpoch / 2) * 14);
      return bucketStart.toISOString().slice(0, 10);
    }
    return dateStr; // 'day'
  }
  function bucketLabelFor(key, granularity) {
    if (granularity === 'month') {
      return new Date(key + 'T00:00:00').toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });
    }
    if (granularity === 'twoweek') {
      const end = new Date(key + 'T00:00:00'); end.setDate(end.getDate() + 13);
      return fmtDate(key) + '–' + fmtDate(end.toISOString().slice(0, 10));
    }
    if (granularity === 'week') {
      const end = new Date(key + 'T00:00:00'); end.setDate(end.getDate() + 6);
      return fmtDate(key) + '–' + fmtDate(end.toISOString().slice(0, 10));
    }
    return fmtDate(key);
  }
  // Isi SEMUA titik waktu berurutan di antara minKey..maxKey (nilai 0 buat
  // yang nggak ada datanya) — sebelumnya cuma bikin titik buat tanggal yang
  // BENERAN ada datanya, jadi kalau ada hari kosong grafiknya "loncat"
  // langsung ke tanggal berikutnya yang ada data (jaraknya jadi nggak
  // konsisten/nggak urut hari beneran).
  function fillContinuousKeys(minKey, maxKey, granularity) {
    const keys = [];
    if (granularity === 'month') {
      let cur = new Date(minKey + 'T00:00:00');
      const end = new Date(maxKey + 'T00:00:00');
      while (cur <= end) {
        keys.push(cur.toISOString().slice(0, 10));
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      }
      return keys;
    }
    const step = granularity === 'week' ? 7 : granularity === 'twoweek' ? 14 : 1;
    let cur = new Date(minKey + 'T00:00:00');
    const end = new Date(maxKey + 'T00:00:00');
    while (cur <= end) {
      keys.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + step);
    }
    return keys;
  }
  const TREND_GRANULARITY_LABEL = { day: 'Harian', week: 'Mingguan', twoweek: '2 Mingguan', month: 'Bulanan' };
  const TREND_PALETTE = ['var(--brand-600)', 'var(--sky-600)', 'var(--amber-600)', 'var(--indigo-600)', 'var(--emerald-600)', 'var(--red-500)', 'var(--slate-500)'];

  // Dropdown granularitas (Harian/Mingguan/2 Mingguan/Bulanan) — dipasang di
  // header tiap grafik tren, sama untuk semua pemanggil (WH/IN, WH/OUT,
  // Gabungan) lewat SPB.laporan.setTrendGranularity().
  function trendGranularityPicker() {
    return '<select class="select-input select-input-sm" onchange="SPB.laporan.setTrendGranularity(this.value)">' +
      Object.keys(TREND_GRANULARITY_LABEL).map(function (g) {
        return '<option value="' + g + '"' + (state.trendGranularity === g ? ' selected' : '') + '>' + TREND_GRANULARITY_LABEL[g] + '</option>';
      }).join('') +
    '</select>';
  }

  // Grafik tren (garis + area, model "naik ke atas") — dipasang di setiap
  // laporan (WH/IN, WH/OUT, Gabungan) biar kelihatan arah pergerakannya dari
  // waktu ke waktu, bukan cuma angka/ranking statis. SVG murni (tanpa
  // library chart) — sesuai constraint project (vanilla JS, tanpa build
  // step/dependency baru). Dukung 2 mode:
  //   - seriesKeyFn KOSONG  -> 1 garis gabungan (total).
  //   - seriesKeyFn DIISI   -> multi-garis, 1 warna per hasil seriesKeyFn(row)
  //     (mis. per Divisi) — dibatasi TREND_PALETTE.length garis, sisanya
  //     digabung jadi "Lainnya" biar chart nggak penuh sesak.
  function trendLineHtml(rows, dateFn, qtyFn, opts) {
    opts = opts || {};
    const color = opts.color || 'var(--brand-600)';
    const label = opts.label || 'Tren Qty';
    const granularity = opts.granularity || state.trendGranularity || 'day';
    const seriesKeyFn = opts.seriesKeyFn || null;
    const extraControls = opts.extraControls || '';
    const headerControls = '<span style="margin-left:auto;display:flex;gap:0.5rem;align-items:center">' + extraControls + trendGranularityPicker() + '</span>';

    // bySeries['']['2026-09-01'] = total qty di bucket itu (series '' dipakai
    // kalau seriesKeyFn kosong, artinya cuma 1 garis).
    const bySeries = {};
    const allKeys = {};
    rows.forEach(function (r) {
      const d = ymd(dateFn(r));
      if (!d) return;
      const key = bucketKeyFor(d, granularity);
      const series = seriesKeyFn ? (seriesKeyFn(r) || '-') : '';
      if (!bySeries[series]) bySeries[series] = {};
      bySeries[series][key] = (bySeries[series][key] || 0) + qtyFn(r);
      allKeys[key] = true;
    });
    const observedKeys = Object.keys(allKeys).sort();
    const keys = observedKeys.length
      ? fillContinuousKeys(observedKeys[0], observedKeys[observedKeys.length - 1], granularity)
      : observedKeys;
    if (keys.length < 2) {
      return '<div class="chart-card" style="margin-top:1rem">' +
        '<p class="chart-title"><i data-lucide="trending-up" class="icon-md"></i>' + esc(label) + headerControls + '</p>' +
        '<div class="empty-state" style="margin-top:0.5rem">Butuh data di minimal 2 ' + (granularity === 'day' ? 'tanggal' : 'periode') + ' berbeda buat nampilin tren.</div>' +
      '</div>';
    }

    // Semua nama series yang ADA di data (sebelum dibatasi/dipilih) — dipakai
    // buat "chip picker" di bawah chart, diurut dari qty terbesar biar yang
    // paling relevan gampang ditemukan kalau daftarnya panjang (mis. per Pos,
    // bisa banyak banget).
    const allSeriesSorted = Object.keys(bySeries).map(function (s) {
      return { name: s, total: Object.values(bySeries[s]).reduce(function (a, v) { return a + v; }, 0) };
    }).sort(function (a, b) { return b.total - a.total; });

    // Kalau user udah milih manual (opts.selectedSeries diisi lewat chip
    // picker), pakai itu apa adanya — user yang nentuin sendiri, gak usah
    // digabung "Lainnya" walau banyak. Belum milih apa-apa (mode "Otomatis")
    // -> batasi top N (by total qty) + gabungin sisanya jadi "Lainnya", biar
    // nggak berantakan begitu buka pertama kali.
    let seriesNames;
    let pickerHtml = '';
    if (seriesKeyFn) {
      const selected = opts.selectedSeries || [];
      if (selected.length) {
        seriesNames = selected.filter(function (s) { return bySeries[s]; });
        if (!seriesNames.length) seriesNames = allSeriesSorted.slice(0, TREND_PALETTE.length).map(function (a) { return a.name; });
      } else if (allSeriesSorted.length > TREND_PALETTE.length) {
        const top = allSeriesSorted.slice(0, TREND_PALETTE.length - 1).map(function (a) { return a.name; });
        const rest = allSeriesSorted.slice(TREND_PALETTE.length - 1).map(function (a) { return a.name; });
        const merged = {};
        rest.forEach(function (s) {
          Object.keys(bySeries[s]).forEach(function (k) { merged[k] = (merged[k] || 0) + bySeries[s][k]; });
          delete bySeries[s];
        });
        bySeries['Lainnya'] = merged;
        seriesNames = top.concat(['Lainnya']);
      } else {
        seriesNames = allSeriesSorted.map(function (a) { return a.name; });
      }

      if (opts.onToggleSeries && allSeriesSorted.length > 1) {
        const activeSet = {};
        (selected.length ? selected : seriesNames.filter(function (s) { return s !== 'Lainnya'; })).forEach(function (s) { activeSet[s] = true; });
        pickerHtml = '<div class="trend-chart-picker">' +
          '<p class="trend-chart-picker-hint">Pilih yang mau ditampilkan (' + allSeriesSorted.length + ' total)' + (selected.length ? '' : ' — otomatis nunjukin top ' + Math.min(TREND_PALETTE.length, allSeriesSorted.length)) + ':</p>' +
          allSeriesSorted.map(function (a) {
            const on = !!activeSet[a.name];
            return '<button type="button" class="trend-chip' + (on ? ' active' : '') + '" onclick="' + opts.onToggleSeries + '(\'' + esc(a.name).replace(/'/g, "\\'") + '\')">' + esc(a.name) + '</button>';
          }).join('') +
        '</div>';
      }
    } else {
      seriesNames = [''];
    }

    // PAD_L diperlebar (dulu 10) buat nampung angka skala sumbu kiri (0/
    // tengah/max) — sebelumnya nggak ada keterangan angka sama sekali di
    // kiri, cuma garis polos.
    const W = 1000, H = 220, PAD_L = 46, PAD_R = 10, PAD_T = 16, PAD_B = 34;
    const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
    const n = keys.length;
    const xAt = function (i) { return PAD_L + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW); };
    const maxV = Math.max(1, seriesNames.reduce(function (m, s) {
      return keys.reduce(function (mm, k) { return Math.max(mm, bySeries[s][k] || 0); }, m);
    }, 0));
    const yAt = function (v) { return PAD_T + innerH - (v / maxV) * innerH; };

    // Sumbu kiri (Qty): 4 garis bantu horizontal + angka skalanya (0 di
    // bawah, maxV di atas) — biar grafiknya kebaca nilainya, bukan cuma
    // bentuk naik-turunnya doang.
    const Y_TICKS = 4;
    const gridLines = [];
    for (let t = 0; t <= Y_TICKS; t++) {
      const v = Math.round((maxV / Y_TICKS) * t);
      const y = yAt(v);
      gridLines.push(
        '<line x1="' + PAD_L + '" y1="' + y.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + y.toFixed(1) + '" stroke="var(--slate-100)" stroke-width="1"></line>' +
        '<text x="' + (PAD_L - 8) + '" y="' + (y + 3).toFixed(1) + '" font-size="11" fill="var(--slate-400)" text-anchor="end">' + v + '</text>'
      );
    }
    const gridHtml = gridLines.join('');

    // 1 garis gabungan (seriesKeyFn kosong) masih dapet area fill + trend
    // badge (naik/turun) kayak sebelumnya; multi-garis cukup garis + legend
    // tanpa area (biar nggak numpuk saling tindih).
    let svgLayers = '';
    let trendBadgeHtml = '';
    let legendHtml = '';
    const gradId = 'trendGrad' + Math.random().toString(36).slice(2, 8);

    if (!seriesKeyFn) {
      const series = bySeries[''] || {};
      const values = keys.map(function (k) { return series[k] || 0; });
      const linePath = values.map(function (v, i) { return (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1); }).join(' ');
      const areaPath = linePath + ' L' + xAt(n - 1).toFixed(1) + ',' + (PAD_T + innerH) + ' L' + xAt(0).toFixed(1) + ',' + (PAD_T + innerH) + ' Z';
      const half = Math.floor(n / 2) || 1;
      const firstAvg = values.slice(0, half).reduce(function (a, v) { return a + v; }, 0) / half;
      const secondAvg = values.slice(n - half).reduce(function (a, v) { return a + v; }, 0) / half;
      const trendPct = firstAvg > 0 ? Math.round(((secondAvg - firstAvg) / firstAvg) * 100) : (secondAvg > 0 ? 100 : 0);
      trendBadgeHtml = trendPct > 3
        ? '<span class="badge badge-approved"><span class="badge-dot"></span>Naik ' + trendPct + '%</span>'
        : trendPct < -3
          ? '<span class="badge badge-rejected"><span class="badge-dot"></span>Turun ' + Math.abs(trendPct) + '%</span>'
          : '<span class="badge badge-draft"><span class="badge-dot"></span>Stabil</span>';
      const dotEvery = Math.max(1, Math.ceil(n / 20));
      const dots = values.map(function (v, i) {
        if (i % dotEvery !== 0 && i !== n - 1) return '';
        return '<circle cx="' + xAt(i).toFixed(1) + '" cy="' + yAt(v).toFixed(1) + '" r="3.5" fill="' + color + '" stroke="#fff" stroke-width="1.5">' +
          '<title>' + esc(bucketLabelFor(keys[i], granularity)) + ': ' + v + '</title></circle>';
      }).join('');
      svgLayers =
        '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.02"/>' +
        '</linearGradient></defs>' +
        '<path d="' + areaPath + '" fill="url(#' + gradId + ')" stroke="none"></path>' +
        '<path d="' + linePath + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>' +
        dots;
    } else {
      svgLayers = seriesNames.map(function (s, si) {
        const c = TREND_PALETTE[si % TREND_PALETTE.length];
        const values = keys.map(function (k) { return (bySeries[s] && bySeries[s][k]) || 0; });
        const linePath = values.map(function (v, i) { return (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1); }).join(' ');
        const dotEvery = Math.max(1, Math.ceil(n / 15));
        const dots = values.map(function (v, i) {
          if (i % dotEvery !== 0 && i !== n - 1) return '';
          return '<circle cx="' + xAt(i).toFixed(1) + '" cy="' + yAt(v).toFixed(1) + '" r="3" fill="' + c + '" stroke="#fff" stroke-width="1.25">' +
            '<title>' + esc(s) + ' · ' + esc(bucketLabelFor(keys[i], granularity)) + ': ' + v + '</title></circle>';
        }).join('');
        return '<path d="' + linePath + '" fill="none" stroke="' + c + '" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"></path>' + dots;
      }).join('');
      legendHtml = '<div class="trend-chart-legend">' +
        seriesNames.map(function (s, si) {
          const c = TREND_PALETTE[si % TREND_PALETTE.length];
          return '<span class="trend-chart-legend-item"><span class="trend-chart-legend-dot" style="background:' + c + '"></span>' + esc(s) + '</span>';
        }).join('') +
      '</div>';
    }

    // Keterangan sumbu — "Qty" (kiri, apa yang diukur) & granularitas waktu
    // yang lagi aktif (bawah, "Waktu (Harian)" dst) — sebelumnya cuma ada
    // tanggal awal/akhir doang tanpa penjelasan itu sumbu apa.
    return '<div class="chart-card" style="margin-top:1rem">' +
      '<p class="chart-title"><i data-lucide="trending-up" class="icon-md"></i>' + esc(label) + trendBadgeHtml + headerControls + '</p>' +
      '<div class="trend-chart-axis-y">Qty</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" class="trend-chart" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' +
        gridHtml + svgLayers +
      '</svg>' +
      '<div class="trend-chart-labels"><span>' + esc(bucketLabelFor(keys[0], granularity)) + '</span><span>' + esc(bucketLabelFor(keys[n - 1], granularity)) + '</span></div>' +
      '<p class="trend-chart-axis-x">Waktu (' + TREND_GRANULARITY_LABEL[granularity] + ')</p>' +
      legendHtml +
      pickerHtml +
    '</div>';
  }

  /* =========================================================
     SUMBER: WH/IN (perilaku lama, tidak diubah)
     ========================================================= */
  function isOdooClosed(r) { return r.status === 'Draft' && r.odoo_state === 'Done'; }
  function isOdooCancelled(r) { return r.status === 'Draft' && r.odoo_state === 'Cancelled'; }
  function categoryOf(r) {
    if (r.status !== 'Draft') return 'Sudah Datang';
    if (isOdooClosed(r)) return 'Selesai di Odoo';
    if (isOdooCancelled(r)) return 'Dibatalkan di Odoo';
    if (r.odoo_state === 'Ready') return 'On The Way';
    return 'Menunggu Vendor';
  }
  const CATEGORY_COLOR = {
    'Sudah Datang': 'var(--emerald-500)', 'On The Way': 'var(--amber-500)',
    'Menunggu Vendor': 'var(--slate-400)', 'Selesai di Odoo': 'var(--indigo-600)',
    'Dibatalkan di Odoo': 'var(--red-500)',
  };
  // Sama persis kelasnya dengan statusLegendHtml() di dashboard.js — biar
  // warna status di Laporan konsisten dengan Dashboard WH/IN.
  const CATEGORY_BADGE_CLASS = {
    'Sudah Datang': 'badge-approved',
    'On The Way': 'badge-draft',
    'Menunggu Vendor': 'badge-draft',
    'Selesai di Odoo': 'badge-odoo-done',
    'Dibatalkan di Odoo': 'badge-odoo-cancel',
  };
  function categoryBadgeHtml(cat) {
    const cls = CATEGORY_BADGE_CLASS[cat] || 'badge-draft';
    return '<span class="badge ' + cls + '"><span class="badge-dot"></span>' + esc(cat) + '</span>';
  }
  function displayDateOfIn(r) {
    return r.status === 'Draft' ? r.order_date : (r.arrival_date || r.created_at);
  }
  function itemQtyIn(r) {
    const draft = r.status === 'Draft';
    return (r.items || []).reduce(function (a, it) { return a + (draft ? (it.qty_po || 0) : (it.qty_received || 0)); }, 0);
  }
  function applyFiltersIn(rows) {
    return rows.filter(function (r) {
      const d = ymd(displayDateOfIn(r));
      if (state.dateFrom && (!d || d < state.dateFrom)) return false;
      if (state.dateTo && (!d || d > state.dateTo)) return false;
      if (state.vendor && r.vendor_name !== state.vendor) return false;
      return true;
    });
  }
  function vendorList(rows) {
    const set = {};
    rows.forEach(function (r) { if (r.vendor_name) set[r.vendor_name] = true; });
    return Object.keys(set).sort();
  }
  function aggregateBy(rows, keyFn, qtyFn) {
    const map = {};
    rows.forEach(function (r) {
      const k = keyFn(r) || '-';
      if (!map[k]) map[k] = { key: k, count: 0, qty: 0 };
      map[k].count++;
      map[k].qty += qtyFn(r);
    });
    // Urut dari jumlah data (count) terbanyak dulu; kalau count-nya SAMA
    // (mis. sama-sama 1x), tiebreak pakai qty terbanyak — kalau tidak, yang
    // qty-nya jauh lebih banyak bisa nyangkut di bawah cuma gara-gara urutan
    // insersi (persis kasus "1 kali ambil 4 pcs" vs "1 kali ambil 1 pcs").
    return Object.values(map).sort(function (a, b) { return (b.count - a.count) || (b.qty - a.qty); });
  }
  // shareFn nentuin "Porsi" itu dihitung dari apa — default dari `count`
  // (jumlah transaksi/data), TAPI buat Ranking Karyawan porsinya harusnya
  // dari QTY (banyaknya barang yang didapat), bukan jumlah transaksi — kalau
  // tidak, orang yang cuma 1x ambil 4 Pcs kelihatan "sama porsinya" kayak
  // yang 1x ambil 1 Pcs doang (sama-sama "1 transaksi").
  function rankTableHtml(agg, keyLabel, shareFn) {
    shareFn = shareFn || function (a) { return a.count; };
    if (!agg.length) return '<div class="empty-state">Tidak ada data sesuai filter.</div>';
    const total = agg.reduce(function (a, x) { return a + shareFn(x); }, 0);
    const { pageRows, totalPages, totalRows } = paginate(agg);
    const offset = (state.page - 1) * PAGE_SIZE;
    return '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>#</th><th>' + keyLabel + '</th><th>Jumlah Data</th><th>Total Qty</th><th>Porsi</th></tr></thead>' +
      '<tbody>' + pageRows.map(function (a, i) {
        const share = total ? Math.round((shareFn(a) / total) * 100) : 0;
        return '<tr><td>' + (offset + i + 1) + '</td><td style="font-weight:600">' + esc(a.key) + '</td>' +
          '<td>' + a.count + '</td><td>' + a.qty + '</td><td>' + share + '%</td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows);
  }

  // Tabel khusus Ranking Karyawan — beda dari rankTableHtml() generik (dipakai
  // Ranking Vendor/Status di WH/IN): sekalian nampilin Departemen & rincian
  // status Baru/Hilang/Tukar/Habis per orang, buat laporan ke atasan (bukan
  // cuma qty polos — kelihatan juga berapa yang ditukar/hilang).
  function karyawanRankTableHtml(agg) {
    if (!agg.length) return '<div class="empty-state">Tidak ada data sesuai filter.</div>';
    const total = agg.reduce(function (a, x) { return a + x.qty; }, 0);
    const { pageRows, totalPages, totalRows } = paginate(agg);
    const offset = (state.page - 1) * PAGE_SIZE;
    return '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>#</th><th>Karyawan</th><th>Departemen</th><th>Jumlah Distribusi</th><th>Total Qty</th><th>Porsi</th><th>Status</th></tr></thead>' +
      '<tbody>' + pageRows.map(function (a, i) {
        const share = total ? Math.round((a.qty / total) * 100) : 0;
        const statusText = DIST_STATUS_OPTIONS.map(function (s) {
          return a.statusCount[s] ? s + ': ' + a.statusCount[s] : null;
        }).filter(Boolean).map(function (t) {
          const badge = t.indexOf('Hilang') === 0 ? 'badge-rejected' : t.indexOf('Tukar') === 0 ? 'badge-inspection' : t.indexOf('Habis') === 0 ? 'badge-draft' : 'badge-approved';
          return '<span class="badge ' + badge + '" style="margin:0.125rem"><span class="badge-dot"></span>' + t + '</span>';
        }).join('') || '<span class="muted">-</span>';
        return '<tr><td>' + (offset + i + 1) + '</td><td style="font-weight:600">' + esc(a.key) + '</td>' +
          '<td style="font-size:0.8125rem;color:var(--slate-600)">' + esc(a.department) + '</td>' +
          '<td>' + a.count + '</td><td>' + a.qty + '</td><td>' + share + '%</td>' +
          '<td>' + statusText + '</td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows);
  }
  // Modal "barang apa saja yang dibeli" per WH/IN — pola sama dengan
  // detailModal di sisi WH/OUT (Rincian Distribusi): buka/tutup TANPA fetch
  // ulang ke server, cukup render ulang pakai snapshot data terakhir.
  let inDetailModal = null; // = row penerimaan_barang yang lagi dibuka
  let lastAllRowsIn = [];
  let lastSparepartsIn = []; // master spareparts (buat lookup harga di view Ringkas)
  let lastGabunganIn = [], lastGabunganOut = [];
  // Sudah pernah berhasil narik data buat masing2 sumber (gabungan/wh-in/wh-out)
  // di sesi ini? Dipakai render() buat stale-while-revalidate (lihat di bawah).
  const everLoaded = { gabungan: false, 'wh-in': false, 'wh-out': false };
  function renderNowIn() { renderWhIn(document.getElementById('app'), lastAllRowsIn, lastSparepartsIn); }
  function openInDetailModal(id) {
    const r = lastAllRowsIn.find(function (x) { return x.id === id; });
    if (!r) return;
    inDetailModal = r;
    renderNowIn();
  }
  function closeInDetailModal() { inDetailModal = null; renderNowIn(); }

  function inDetailModalHtml() {
    if (!inDetailModal) return '';
    const r = inDetailModal;
    const waiting = r.status === 'Draft';
    const items = r.items || [];
    const rows = items.map(function (it) {
      const qty = waiting ? (it.qty_po || 0) : (it.qty_received || 0);
      return '<tr><td style="font-weight:600">' + esc(it.product_name || '-') + '</td>' +
        '<td>' + esc(it.sku || '-') + '</td>' +
        '<td>' + qty + ' ' + esc(it.uom || '') + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="empty-state">Tidak ada data item.</td></tr>';
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.laporan.closeInDetailModal()">' +
      '<div class="modal slide-up modal-xl" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.laporan.closeInDetailModal()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title">Barang Dibeli</p>' +
        '<p style="font-size:1rem;font-weight:700;color:var(--slate-800);margin-top:0.25rem">#' + esc(r.po_number) +
          ' <span style="font-weight:500;color:var(--slate-400);font-size:0.8125rem">[' + esc(r.wh_in_ref || '-') + ']</span></p>' +
        '<p style="font-size:0.9375rem;font-weight:600;color:var(--slate-600);margin-top:0.25rem">Vendor : ' + esc(r.vendor_name) + '</p>' +
        '<p class="modal-sub" style="margin-top:0.5rem">' + fmtDate(displayDateOfIn(r)) + ' — ' + categoryBadgeHtml(categoryOf(r)) + '</p>' +
        '<div class="table-wrap" style="margin-top:0.75rem"><table class="table">' +
          '<thead><tr><th>Nama Barang</th><th>SKU</th><th>Qty' + (waiting ? ' (PO)' : ' (Diterima)') + '</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
      '</div>' +
    '</div>';
  }

  function allDataTableHtmlIn(rows) {
    if (!rows.length) return '<div class="empty-state">Tidak ada data sesuai filter.</div>';
    const { pageRows, totalPages, totalRows } = paginate(rows);
    return '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>No PO</th><th>WH/IN</th><th>Vendor</th><th>Tanggal</th><th>Status</th><th>Qty</th><th></th></tr></thead>' +
      '<tbody>' + pageRows.map(function (r) {
        return '<tr class="row-click" onclick="SPB.laporan.openInDetailModal(\'' + r.id + '\')">' +
          '<td style="font-weight:600">#' + esc(r.po_number) + '</td>' +
          '<td>' + esc(r.wh_in_ref || '-') + '</td>' +
          '<td>' + esc(r.vendor_name) + '</td>' +
          '<td>' + fmtDate(displayDateOfIn(r)) + '</td>' +
          '<td>' + categoryBadgeHtml(categoryOf(r)) + '</td>' +
          '<td>' + itemQtyIn(r) + '</td>' +
          '<td class="text-right"><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();SPB.laporan.openInDetailModal(\'' + r.id + '\')">' +
            '<i data-lucide="eye" class="icon-sm"></i>Detail</button></td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows) +
    inDetailModalHtml();
  }

  // Lookup harga per SKU dari master spareparts (di-set odoo-pull-stock,
  // sekalian tarik harga SEMUA sparepart bukan cuma ATK — lihat komentar di
  // supabase/functions/odoo-pull-stock/index.ts).
  function sparepartPriceMap(spareparts) {
    const map = {};
    (spareparts || []).forEach(function (sp) {
      if (sp.sku) map[sp.sku.toLowerCase()] = Number(sp.sales_price || 0);
    });
    return map;
  }
  function priceOfSku(map, sku) {
    const v = map[(sku || '').toLowerCase()];
    return v == null ? null : v;
  }

  // View "Ringkas" WH/IN — SENGAJA cuma 4 kolom sesuai diminta: Tanggal,
  // Produk, Petugas (penerima barang), Harga. Beda dari "Seluruh Data" yang
  // per-transaksi (header), ini per-BARANG (flatten semua item lintas
  // transaksi yang lolos filter tanggal/vendor).
  function ringkasInHtml(rows, priceMap) {
    const flat = [];
    rows.forEach(function (r) {
      const petugas = r.receiver_name && r.receiver_name !== '-' ? r.receiver_name : '-';
      (r.items || []).forEach(function (it) {
        flat.push({ tanggal: displayDateOfIn(r), product: it.product_name || '-', sku: it.sku, petugas: petugas });
      });
    });
    flat.sort(function (a, b) { return new Date(b.tanggal) - new Date(a.tanggal); });

    if (!flat.length) return '<div class="empty-state">Tidak ada data sesuai filter.</div>';
    const { pageRows, totalPages, totalRows } = paginate(flat);
    return '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>Tanggal</th><th>Produk</th><th>Petugas Penerima Barang</th><th>Harga</th></tr></thead>' +
      '<tbody>' + pageRows.map(function (it) {
        const price = priceOfSku(priceMap, it.sku);
        return '<tr><td>' + fmtDate(it.tanggal) + '</td>' +
          '<td style="font-weight:600">' + esc(it.product) + '</td>' +
          '<td>' + esc(it.petugas) + '</td>' +
          '<td>' + (price == null ? '<span class="muted">-</span>' : fmtRupiah(price)) + '</td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows);
  }
  function fmtRupiah(v) { return 'Rp' + Number(v || 0).toLocaleString('id-ID'); }

  function renderWhIn(app, allRows, spareparts) {
    lastAllRowsIn = allRows;
    lastSparepartsIn = spareparts || [];
    const rows = applyFiltersIn(allRows);
    const vendors = vendorList(allRows);
    const priceMap = sparepartPriceMap(lastSparepartsIn);

    const totalRecords = rows.length;
    // "Total Qty" (jumlah mentah semua item) dihapus — itu njumlahin qty
    // lintas satuan yang beda-beda (pcs + meter + kg + dus dst digabung
    // mentah), hasilnya angka besar & ganjil (mis. 230313.76) yang nggak
    // berarti apa-apa buat dibaca sekilas. Diganti "Jenis Barang" — hitung
    // SKU unik, angka bulat & jelas maknanya (sama pola kayak Gabungan).
    const skuSet = {};
    rows.forEach(function (r) { (r.items || []).forEach(function (it) { if (it.sku) skuSet[it.sku] = true; }); });
    const totalSku = Object.keys(skuSet).length;
    const totalVendors = vendorList(rows).length;
    const doneCount = rows.filter(function (r) { return categoryOf(r) === 'Sudah Datang'; }).length;

    let bodyHtml;
    if (state.view === 'vendor') {
      const agg = aggregateBy(rows, function (r) { return r.vendor_name || '-'; }, itemQtyIn);
      bodyHtml = reportCard('bar-chart-3', 'Ranking Vendor',
        rankBarsHtml(agg, function () { return 'var(--brand-500)'; }) +
        rankTableHtml(agg, 'Vendor'));
    } else if (state.view === 'status') {
      const agg = aggregateBy(rows, categoryOf, itemQtyIn);
      bodyHtml = reportCard('pie-chart', 'Ranking Status',
        rankBarsHtml(agg, function (a) { return CATEGORY_COLOR[a.key] || 'var(--slate-400)'; }) +
        rankTableHtml(agg, 'Status'));
    } else if (state.view === 'ringkas') {
      bodyHtml = reportCard('receipt', 'Laporan Ringkas', ringkasInHtml(rows, priceMap));
    } else {
      bodyHtml = reportCard('table', 'Seluruh Data', allDataTableHtmlIn(rows));
    }

    app.innerHTML = window.SPB.ui.layout('laporan',
      pageHeadHtml() +
      sourceTabsHtml() +
      '<div class="report-filters">' +
        '<div class="report-view-tabs">' +
          reportTab('all', 'table', 'Semua Data', "SPB.laporan.setView('all')") +
          reportTab('ringkas', 'receipt', 'Ringkas', "SPB.laporan.setView('ringkas')") +
          reportTab('vendor', 'bar-chart-3', 'Ranking Vendor', "SPB.laporan.setView('vendor')") +
          reportTab('status', 'pie-chart', 'Ranking Status', "SPB.laporan.setView('status')") +
        '</div>' +
        '<div class="report-filter-fields">' +
          '<div><label class="field-label">Periode</label>' +
          '<select class="select-input" onchange="SPB.laporan.setPeriodPreset(this.value)">' +
            '<option value=""' + (state.periodPreset === '' ? ' selected' : '') + '>Semua Waktu</option>' +
            '<option value="7"' + (state.periodPreset === '7' ? ' selected' : '') + '>7 Hari Terakhir</option>' +
            '<option value="14"' + (state.periodPreset === '14' ? ' selected' : '') + '>2 Minggu Terakhir</option>' +
            '<option value="30"' + (state.periodPreset === '30' ? ' selected' : '') + '>1 Bulan Terakhir</option>' +
            '<option value="90"' + (state.periodPreset === '90' ? ' selected' : '') + '>3 Bulan Terakhir</option>' +
            '<option value="custom"' + (state.periodPreset === 'custom' ? ' selected' : '') + '>Kustom...</option>' +
          '</select></div>' +
          (state.periodPreset === 'custom'
            ? '<div><label class="field-label">Dari Tanggal</label>' +
              '<input type="date" class="input" value="' + esc(state.dateFrom) + '" onchange="SPB.laporan.setFilter(\'dateFrom\', this.value)"></div>' +
              '<div><label class="field-label">Sampai Tanggal</label>' +
              '<input type="date" class="input" value="' + esc(state.dateTo) + '" onchange="SPB.laporan.setFilter(\'dateTo\', this.value)"></div>'
            : '') +
          '<div><label class="field-label">Vendor</label>' +
          '<select class="select-input" onchange="SPB.laporan.setFilter(\'vendor\', this.value)">' +
            '<option value="">Semua Vendor</option>' +
            vendors.map(function (v) {
              return '<option value="' + esc(v) + '"' + (state.vendor === v ? ' selected' : '') + '>' + esc(v) + '</option>';
            }).join('') +
          '</select></div>' +
          (state.periodPreset || state.vendor
            ? '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.laporan.resetFilters()">' +
              '<i data-lucide="x" class="icon-sm"></i>Reset Filter</button>'
            : '') +
        '</div>' +
      '</div>' +
      '<div class="grid-stats">' +
        statCard('list-checks', 'sky', 'Total Data', totalRecords, 'sesuai filter') +
        statCard('package', 'emerald', 'Jenis Barang', totalSku, 'SKU unik') +
        statCard('truck', 'amber', 'Total Vendor', totalVendors, 'vendor unik') +
        statCard('package-check', 'indigo', 'Sudah Datang', doneCount, 'dari total data') +
      '</div>' +
      trendLineHtml(rows, displayDateOfIn, itemQtyIn, { color: 'var(--brand-600)', label: 'Tren Qty Penerimaan' }) +
      bodyHtml +
      whInLegendHtml()
    );
    window.SPB.ui.afterRender();
  }

  function whInLegendHtml() {
    return '<div class="callout" style="margin-top:1.25rem"><i data-lucide="info" class="icon-md"></i>' +
      '<div class="status-legend">' +
        '<div class="status-legend-item"><span class="badge badge-draft"><span class="badge-dot"></span>Draft</span>' +
          '<span class="status-legend-text">Selama masih status Draft (belum ditandai "barang datang" di SPB), data seperti No PO/vendor/tanggal masih otomatis ikut ter-update kalau diubah di Odoo.</span></div>' +
        '<div class="status-legend-item"><span class="badge badge-approved"><span class="badge-dot"></span>Sudah Diproses</span>' +
          '<span class="status-legend-text">Begitu sudah diproses di SPB (bukan Draft lagi), data itu terkunci — perubahan di Odoo setelahnya TIDAK ikut ke-update, supaya riwayat kerja yang sudah dilakukan tim gudang tidak berubah sendiri.</span></div>' +
      '</div></div>';
  }

  /* =========================================================
     TAMPILAN AWAL: Gabungan WH/IN + WH/OUT (BARU)
     Landing sebelum pilih sumber spesifik — 3 grafik ranking "mewah":
     Vendor Terbanyak (WH/IN), Karyawan Paling Sering Mengambil (WH/OUT,
     dari employee_name/"diambil oleh", BUKAN penerima distribusi), dan
     Barang ATK Paling Sering Diminta (WH/OUT). Read-only murni, tidak ada
     filter/export di sini — cuma sekilas pandang, detailnya tetap di tab
     WH/IN / WH/OUT masing-masing.
     ========================================================= */
  function itemsQtyOut(r) {
    return (r.items || []).reduce(function (a, it) { return a + Number(it.qty_actual ?? it.qty_demand ?? 0); }, 0);
  }
  function aggregateOutItems(outRows) {
    const map = {};
    outRows.forEach(function (r) {
      (r.items || []).forEach(function (it) {
        const k = it.product_name || it.sku || '-';
        if (!map[k]) map[k] = { key: k, qty: 0, count: 0 };
        map[k].qty += Number(it.qty_actual ?? it.qty_demand ?? 0);
        map[k].count++;
      });
    });
    return Object.values(map).sort(function (a, b) { return b.qty - a.qty; });
  }

  function renderGabungan(app, inRows, outRows) {
    const totalIn = inRows.length;
    const totalOut = outRows.length;
    // "Total Qty Masuk" (jumlah mentah semua item WH/IN) dihapus dari sini —
    // itu njumlahin qty lintas satuan yang beda-beda (pcs + meter + kg + dus
    // dst digabung mentah), hasilnya angka besar & ganjil (mis. 230313.76)
    // yang nggak berarti apa-apa buat dibaca sekilas. Diganti "Jenis Barang
    // Diterima" — hitung SKU unik, angka bulat & jelas maknanya.
    const skuDiterimaSet = {};
    inRows.forEach(function (r) {
      (r.items || []).forEach(function (it) { if (it.sku) skuDiterimaSet[it.sku] = true; });
    });
    const totalSkuIn = Object.keys(skuDiterimaSet).length;
    const totalQtyOut = outRows.reduce(function (a, r) { return a + itemsQtyOut(r); }, 0);

    const vendorAgg = aggregateBy(inRows, function (r) { return r.vendor_name || '-'; }, itemQtyIn)
      .slice(0, 8).map(function (a) { return { key: a.key, value: a.count, sub: a.qty + ' item' }; });
    const karyawanAgg = aggregateBy(outRows, function (r) { return r.employee_name || '-'; }, itemsQtyOut)
      .slice(0, 8).map(function (a) { return { key: a.key, value: a.count, sub: a.qty + ' item diambil' }; });
    const barangAgg = aggregateOutItems(outRows)
      .slice(0, 8).map(function (a) { return { key: a.key, value: a.qty, sub: a.count + 'x diminta' }; });

    app.innerHTML = window.SPB.ui.layout('laporan',
      pageHeadHtml() +
      sourceTabsHtml() +
      '<div class="grid-stats" style="margin-top:1.25rem">' +
        statCard('truck', 'amber', 'Total WH/IN', totalIn, 'transaksi penerimaan') +
        statCard('package', 'emerald', 'Jenis Barang Diterima', totalSkuIn, 'SKU unik, WH/IN') +
        statCard('share-2', 'sky', 'Total WH/OUT', totalOut, 'transaksi pengeluaran') +
        statCard('boxes', 'indigo', 'Total Qty Keluar', totalQtyOut, 'seluruh item WH/OUT') +
      '</div>' +
      '<div class="grid-charts">' +
        trendLineHtml(inRows, function (r) { return r.arrival_date || r.order_date || r.created_at; }, itemQtyIn, { color: 'var(--brand-600)', label: 'Tren Qty Masuk (WH/IN)' }) +
        trendLineHtml(outRows, function (r) { return r.arrival_date || r.created_at; }, itemsQtyOut, { color: 'var(--sky-600)', label: 'Tren Qty Keluar (WH/OUT)' }) +
      '</div>' +
      '<div class="grid-charts">' +
        reportCard('bar-chart-3', 'Vendor Terbanyak (WH/IN)', rankListHtml(vendorAgg, 'var(--brand-500)', 'x')) +
        reportCard('users', 'Karyawan Paling Sering Mengambil (WH/OUT)', rankListHtml(karyawanAgg, 'var(--amber-500)', 'x')) +
      '</div>' +
      reportCard('star', 'Barang ATK Paling Sering Diminta (WH/OUT)', rankListHtml(barangAgg, 'var(--sky-600)', ''))
    );
    window.SPB.ui.afterRender();
  }

  /* =========================================================
     SUMBER: WH/OUT — distribusi ATK ke karyawan (BARU)
     ========================================================= */
  function distDate(d) { return ymd(d.created_at); }
  function applyFiltersOut(rows) {
    return rows.filter(function (d) {
      const day = distDate(d);
      if (state.dateFrom && (!day || day < state.dateFrom)) return false;
      if (state.dateTo && (!day || day > state.dateTo)) return false;
      // Pencarian (substring, bukan cocok persis) — biar "budi" nemu "Budi
      // Santoso" juga, nggak wajib ketik nama lengkap.
      if (state.karyawan && (d.karyawan_name || '').toLowerCase().indexOf(state.karyawan.toLowerCase()) === -1) return false;
      if (state.divisi && divisiOfDept(d.department) !== state.divisi) return false;
      if (state.distStatus && (d.status || 'Baru') !== state.distStatus) return false;
      return true;
    });
  }
  function karyawanListFromDist(rows) {
    const set = {};
    rows.forEach(function (d) { if (d.karyawan_name) set[d.karyawan_name] = true; });
    return Object.keys(set).sort();
  }
  function divisiListFromDist(rows) {
    const set = {};
    rows.forEach(function (d) { const v = divisiOfDept(d.department); if (v) set[v] = true; });
    return Object.keys(set).sort();
  }
  // divisiOfDept sendiri didefinisikan belakangan di file ini (dipakai juga
  // oleh rankingDivisiHtml) — aman dipanggil di sini walau urutannya duluan,
  // karena function declaration di-hoist ke atas scope-nya.
  function whOutRefOf(d) { return (d.pengeluaran && d.pengeluaran.wh_out_ref) || '-'; }
  function pengambilOf(d) { return (d.pengeluaran && d.pengeluaran.employee_name) || '-'; }
  function pengambilDeptOf(d) { return (d.pengeluaran && d.pengeluaran.department) || '-'; }
  function petugasOf(d) {
    const p = d.pengeluaran && d.pengeluaran.receiver_name;
    return p && p !== '-' ? p : '-';
  }
  function productOf(d) { return (d.detail && d.detail.product_name) || '-'; }
  function skuOf(d) { return (d.detail && d.detail.sku) || '-'; }
  function uomOf(d) { return (d.detail && d.detail.uom) || ''; }

  // Tampilan awal tabel "Semua Distribusi" itu PER BARANG (per detail_id) —
  // identitas utamanya "diambil oleh" (employee_name = orang yang ambil
  // barang di Odoo/gudang), BUKAN daftar karyawan yang kebagian. Rincian
  // "barang ini dibagi ke siapa aja & berapa" baru muncul di popup pas
  // barisnya diklik (detailModal), sumbernya tetap distribusi_pengeluaran.
  let detailModal = null; // { title, whOutRef, entries: [{karyawan_name, department, qty}] }
  function groupByDetail(rows) {
    const map = {};
    rows.forEach(function (d) {
      const k = d.detail_id;
      if (!map[k]) {
        map[k] = {
          detail_id: k, tanggal: d.created_at, product: productOf(d), sku: skuOf(d), uom: uomOf(d),
          whOutRef: whOutRefOf(d), pengambil: pengambilOf(d), department: pengambilDeptOf(d), petugas: petugasOf(d),
          totalQty: 0, entries: [],
        };
      }
      map[k].totalQty += Number(d.qty);
      map[k].entries.push({
        id: d.id, karyawan_name: d.karyawan_name, department: d.department, qty: d.qty,
        status: d.status || 'Baru', keterangan: d.keterangan || '',
      });
      if (d.created_at < map[k].tanggal) map[k].tanggal = d.created_at;
    });
    return Object.values(map).sort(function (a, b) { return new Date(b.tanggal) - new Date(a.tanggal); });
  }

  function openDetailModal(detailId) {
    const groups = groupByDetail(applyFiltersOut(lastAllRows));
    const g = groups.find(function (x) { return x.detail_id === detailId; });
    if (!g) return;
    detailModal = g;
    renderNow();
  }
  function closeDetailModal() { detailModal = null; renderNow(); }
  // Snapshot data mentah terakhir (di-set tiap renderWhOut jalan) — dipakai
  // buka/tutup modal detail tanpa fetch ulang ke server, cuma render ulang
  // pakai data yang sudah ada di memori.
  let lastAllRows = [];
  let lastStokOut = []; // snapshot stok_barang (buat lookup harga di view Ringkas)
  function renderNow() { renderWhOut(document.getElementById('app'), lastAllRows, lastStokOut); }

  // Simpan status Hilang/Tukar / keterangan per baris distribusi — update
  // langsung ke server, lalu MUTASI lokal (lastAllRows + detailModal.entries)
  // supaya modal & tabel di baliknya ikut update tanpa fetch ulang.
  function updateDistStatus(id, status) {
    window.SPB.dbDistribusi.updateStatus(id, status).then(function () {
      const row = lastAllRows.find(function (r) { return r.id === id; });
      if (row) row.status = status;
      const entry = detailModal && detailModal.entries.find(function (e) { return e.id === id; });
      if (entry) entry.status = status;
      window.SPB.ui.toast('Status diperbarui', '', 'success');
      renderNow();
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal update status', err.message, 'error');
    });
  }
  function updateDistKeterangan(id, keterangan) {
    window.SPB.dbDistribusi.updateKeterangan(id, keterangan).then(function () {
      const row = lastAllRows.find(function (r) { return r.id === id; });
      if (row) row.keterangan = keterangan;
      const entry = detailModal && detailModal.entries.find(function (e) { return e.id === id; });
      if (entry) entry.keterangan = keterangan;
    }).catch(function (err) {
      window.SPB.ui.toast('Gagal simpan keterangan', err.message, 'error');
    });
  }

  const DIST_STATUS_OPTIONS = ['Baru', 'Hilang', 'Tukar', 'Habis'];
  const DIST_STATUS_BADGE = { Baru: 'badge-approved', Hilang: 'badge-rejected', Tukar: 'badge-inspection', Habis: 'badge-draft' };

  function detailModalHtml() {
    if (!detailModal) return '';
    const rows = detailModal.entries.map(function (e) {
      return '<tr>' +
        '<td style="font-weight:600">' + esc(e.karyawan_name) + '</td>' +
        '<td>' + esc(e.department || '-') + '</td>' +
        '<td>' + e.qty + ' ' + esc(detailModal.uom || '') + '</td>' +
        '<td><select class="select-input" style="font-size:0.75rem;padding:0.25rem 0.5rem" onchange="SPB.laporan.updateDistStatus(\'' + e.id + '\', this.value)">' +
          DIST_STATUS_OPTIONS.map(function (s) {
            return '<option value="' + s + '"' + (e.status === s ? ' selected' : '') + '>' + s + '</option>';
          }).join('') +
        '</select></td>' +
        '<td><input type="text" class="input" style="font-size:0.75rem;padding:0.25rem 0.5rem" placeholder="Catatan (opsional)" value="' + esc(e.keterangan) + '" ' +
          'onchange="SPB.laporan.updateDistKeterangan(\'' + e.id + '\', this.value)"></td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="5" class="empty-state">Belum ada rincian distribusi.</td></tr>';
    return '<div class="modal-backdrop" onclick="if(event.target===this)SPB.laporan.closeDetailModal()">' +
      '<div class="modal slide-up modal-xl" role="dialog" aria-modal="true">' +
        '<button type="button" class="modal-close-btn" onclick="SPB.laporan.closeDetailModal()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>' +
        '<p class="modal-title">Rincian Distribusi</p>' +
        '<p style="font-size:1rem;font-weight:700;color:var(--slate-800);margin-top:0.25rem">' + esc(detailModal.product) +
          ' <span style="font-weight:500;color:var(--slate-400);font-size:0.8125rem">[' + esc(detailModal.sku) + ']</span></p>' +
        '<p class="modal-sub" style="margin-top:0.25rem">' + esc(detailModal.whOutRef) + '</p>' +
        '<p class="modal-sub" style="margin-top:0.5rem">Diambil oleh <b>' + esc(detailModal.pengambil) + '</b> — total dibagi ' + detailModal.totalQty + ' ' + esc(detailModal.uom || '') + '</p>' +
        '<div class="table-wrap" style="margin-top:0.75rem"><table class="table">' +
          '<thead><tr><th>Karyawan Penerima</th><th>Departemen</th><th>Qty</th><th>Status</th><th>Keterangan</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
        '<p class="chart-foot" style="margin-top:0.75rem">Tandai <b>Hilang</b>/<b>Tukar</b> kalau belakangan ketahuan barangnya nggak dipakai normal — isi Keterangan buat catat alasannya.</p>' +
      '</div>' +
    '</div>';
  }

  function allDataTableHtmlOut(rows) {
    const groups = groupByDetail(rows);
    if (!groups.length) return '<div class="empty-state">Tidak ada data sesuai filter.</div>';
    const { pageRows, totalPages, totalRows } = paginate(groups);
    return '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>Tanggal</th><th>Barang</th><th>WH/OUT</th><th>Diambil Oleh</th><th>Total Qty Dibagi</th><th></th></tr></thead>' +
      '<tbody>' + pageRows.map(function (g) {
        return '<tr class="row-click" onclick="SPB.laporan.openDetailModal(\'' + g.detail_id + '\')">' +
          '<td>' + fmtDate(g.tanggal) + '</td>' +
          '<td>' + esc(g.product) + ' <span style="color:var(--slate-400)">[' + esc(g.sku) + ']</span></td>' +
          '<td>' + esc(g.whOutRef) + '</td>' +
          '<td style="font-weight:600">' + esc(g.pengambil) + '</td>' +
          '<td>' + g.totalQty + ' ' + esc(g.uom || '') + ' <span style="color:var(--slate-400)">(' + g.entries.length + ' penerima)</span>' +
            (g.entries.some(function (e) { return e.status && e.status !== 'Baru'; })
              ? ' <span class="badge badge-rejected" style="margin-left:0.25rem"><span class="badge-dot"></span>Ada Hilang/Tukar/Habis</span>'
              : '') +
          '</td>' +
          '<td class="text-right"><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();SPB.laporan.openDetailModal(\'' + g.detail_id + '\')">' +
            '<i data-lucide="eye" class="icon-sm"></i>Detail</button></td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows) +
    detailModalHtml();
  }

  /* Ringkasan per periode (mingguan/bulanan) — dipakai buat jawab "berapa
     barang keluar dalam 1/2 minggu, 1/3 bulan dst". Grouping-nya berdasar
     Senin-Minggu (mingguan) atau YYYY-MM (bulanan), lalu tiap periode
     ditambah "top requester" (karyawan yang paling banyak minta qty di
     periode itu) supaya langsung kelihatan siapa saja yang minta. */
  function periodKey(dateStr, granularity) {
    const d = new Date(dateStr + 'T00:00:00');
    if (granularity === 'month') {
      return dateStr.slice(0, 7); // YYYY-MM
    }
    const day = d.getDay(); // 0=Minggu..6=Sabtu
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    return monday.toISOString().slice(0, 10); // key = tanggal Senin minggu itu
  }
  function periodLabel(key, granularity) {
    if (granularity === 'month') {
      const d = new Date(key + '-01T00:00:00');
      return d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    }
    const monday = new Date(key + 'T00:00:00');
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return monday.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) + ' – ' +
      sunday.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function periodeSummary(rows, granularity) {
    const map = {};
    rows.forEach(function (d) {
      const day = distDate(d);
      if (!day) return;
      const k = periodKey(day, granularity);
      if (!map[k]) map[k] = { key: k, qty: 0, count: 0, byKaryawan: {} };
      map[k].qty += Number(d.qty);
      map[k].count++;
      map[k].byKaryawan[d.karyawan_name] = (map[k].byKaryawan[d.karyawan_name] || 0) + Number(d.qty);
    });
    return Object.values(map)
      .map(function (p) {
        const top = Object.entries(p.byKaryawan).sort(function (a, b) { return b[1] - a[1]; });
        return {
          key: p.key, label: periodLabel(p.key, granularity), qty: p.qty, count: p.count,
          karyawanUnik: top.length,
          topRequesters: top.slice(0, 3).map(function (t) { return t[0] + ' (' + t[1] + ')'; }).join(', '),
        };
      })
      .sort(function (a, b) { return b.key < a.key ? -1 : 1; }); // terbaru dulu
  }
  function periodeHtml(rows) {
    const summary = periodeSummary(rows, state.granularity);
    const granToggle =
      '<div class="report-view-tabs" style="margin-bottom:1rem">' +
        '<button type="button" class="report-tab' + (state.granularity === 'week' ? ' active' : '') + '" ' +
          'onclick="SPB.laporan.setGranularity(\'week\')">Mingguan</button>' +
        '<button type="button" class="report-tab' + (state.granularity === 'month' ? ' active' : '') + '" ' +
          'onclick="SPB.laporan.setGranularity(\'month\')">Bulanan</button>' +
      '</div>';

    if (!summary.length) {
      return reportCard('calendar-range', 'Ringkasan Periode', granToggle +
        '<div class="empty-state">Tidak ada data sesuai filter.</div>');
    }

    // Grafik selalu dari 12 periode TERBARU (biar bar chart-nya tetap
    // ringkas & terbaca), tapi tabel di bawahnya tetap dipaginasi dari
    // SELURUH periode (bukan cuma 12) — supaya periode lama tidak hilang.
    const chartAgg = summary.slice(0, 12).slice().reverse().map(function (p) { return { key: p.label, count: p.qty }; });
    const { pageRows, totalPages, totalRows } = paginate(summary);
    const table = '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>Periode</th><th>Total Distribusi</th><th>Total Qty Keluar</th><th>Karyawan Unik</th><th>Peminta Terbanyak</th></tr></thead>' +
      '<tbody>' + pageRows.map(function (p) {
        return '<tr><td style="font-weight:600">' + esc(p.label) + '</td>' +
          '<td>' + p.count + '</td><td>' + p.qty + '</td><td>' + p.karyawanUnik + '</td>' +
          '<td style="font-size:0.8125rem;color:var(--slate-600)">' + esc(p.topRequesters || '-') + '</td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows);

    return reportCard('calendar-range', 'Ringkasan Periode', granToggle +
      rankBarsHtml(chartAgg, function () { return 'var(--amber-500)'; }) + table);
  }

  // View "Ringkas" WH/OUT — SENGAJA cuma 4 kolom sesuai diminta: Tanggal,
  // Barang, nama perwakilan karyawan yang AMBIL (bukan penerima distribusi),
  // Harga (lookup dari stok_barang by SKU). Pakai groupByDetail() yang sudah
  // ada (1 baris per barang, bukan per penerima).
  function ringkasOutHtml(rows, priceMap) {
    const groups = groupByDetail(rows);
    if (!groups.length) return '<div class="empty-state">Tidak ada data sesuai filter.</div>';
    const { pageRows, totalPages, totalRows } = paginate(groups);
    return '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>Tanggal</th><th>Barang</th><th>Diambil Oleh</th><th>Harga</th></tr></thead>' +
      '<tbody>' + pageRows.map(function (g) {
        const price = priceOfSku(priceMap, g.sku);
        return '<tr><td>' + fmtDate(g.tanggal) + '</td>' +
          '<td style="font-weight:600">' + esc(g.product) + ' <span style="color:var(--slate-400)">[' + esc(g.sku) + ']</span></td>' +
          '<td>' + esc(g.pengambil) + '</td>' +
          '<td>' + (price == null ? '<span class="muted">-</span>' : fmtRupiah(price)) + '</td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows);
  }

  // Deteksi pemakaian TIMPANG — bukan cuma ranking total qty, tapi FREKUENSI
  // (berapa kali ambil per bulan). Karyawan yang frekuensinya jauh di atas
  // rata-rata (>1.5x) ditandai "Timpang" — sesuai keluhan kepala gudang:
  // "1 orang ambil 6x sebulan, yang lain cuma 2-3x".
  // "Analisis Barang" — deteksi ketimpangan pemakaian per SATU SKU spesifik
  // (bukan digabung semua barang jadi 1 angka per orang, itu salah — request
  // aslinya: "berapa orang yang boleh pakai LAKBAN, dan kenapa 1 orang ambil
  // 7x sementara yang lain cuma 3-4-5x, padahal harusnya rata kalau pemakaian
  // operator, selisih paling 1"). Jadi filter dulu ke 1 SKU, baru ranking
  // per-karyawan DALAM SKU itu saja.
  function skuOptionsFromRows(rows) {
    const map = {};
    rows.forEach(function (d) {
      const sku = skuOf(d);
      if (sku && sku !== '-' && !map[sku]) map[sku] = productOf(d);
    });
    return Object.keys(map).sort().map(function (sku) { return { sku: sku, name: map[sku] }; });
  }
  // Level ketimpangan berjenjang — dinilai dari SELISIH QTY (bukan jumlah
  // pengambilan/frekuensi) terhadap rata-rata qty per orang, dalam PERSEN.
  // Kenapa persen (bukan angka mentah kayak dulu): 2 orang yang sama-sama
  // cuma 1x ambil tapi qty-nya beda jauh (mis. 1 Pcs vs 4 Pcs) itu TETAP
  // timpang meski "jumlah pengambilan"-nya sama persis — itu yang kelewat di
  // versi sebelumnya (nilainya dihitung dari frekuensi, bukan dari qty-nya).
  // Angka mentah nggak bisa dipakai buat qty karena skalanya beda-beda per
  // barang (barang yang lazimnya dipesan ratusan pcs vs yang cuma 1-2 pcs),
  // makanya dipersenkan dulu terhadap rata-rata baru dibandingkan.
  function timpangLevel(pctDiff) {
    const abs = Math.abs(pctDiff);
    if (abs >= 100) return { key: 'tinggi', label: 'Warning Tinggi', badge: 'badge-rejected' };
    if (abs >= 50) return { key: 'warning', label: 'Warning', badge: 'badge-rejected' };
    if (abs >= 20) return { key: 'perhatian', label: 'Perlu Diperhatikan', badge: 'badge-inspection' };
    return { key: 'wajar', label: 'Wajar', badge: 'badge-approved' };
  }

  function analisisBarangHtml(rows) {
    const skuOptions = skuOptionsFromRows(rows);
    if (!skuOptions.length) {
      return reportCard('search', 'Analisis Barang', '<div class="empty-state">Tidak ada data sesuai filter.</div>');
    }
    // Nggak lagi auto-pilih SKU pertama — biarin kosong dulu ("-- Pilih
    // Barang --") sampai user beneran milih, biar nggak salah kesan analisis
    // barang tertentu udah aktif padahal itu cuma kepilih otomatis.
    if (state.analisisSku && !skuOptions.some(function (s) { return s.sku === state.analisisSku; })) {
      state.analisisSku = '';
    }
    const picker = '<select class="select-input" onchange="SPB.laporan.setAnalisisSku(this.value)">' +
      '<option value=""' + (state.analisisSku ? '' : ' selected') + '>-- Pilih Barang --</option>' +
      skuOptions.map(function (s) {
        return '<option value="' + esc(s.sku) + '"' + (state.analisisSku === s.sku ? ' selected' : '') + '>' +
          esc(s.sku) + ' — ' + esc(s.name) + '</option>';
      }).join('') +
    '</select>';

    if (!state.analisisSku) {
      return reportCard('search', 'Analisis Barang', picker +
        '<div class="empty-state" style="margin-top:1rem">Pilih barang dulu buat lihat analisis ketimpangan pemakaiannya.</div>');
    }

    const skuRows = rows.filter(function (d) { return skuOf(d) === state.analisisSku; });
    if (!skuRows.length) {
      return reportCard('search', 'Analisis Barang', picker +
        '<div class="empty-state" style="margin-top:1rem">Belum ada distribusi buat barang ini sesuai filter tanggal.</div>');
    }

    const byKaryawan = {};
    skuRows.forEach(function (d) {
      const name = d.karyawan_name || '-';
      if (!byKaryawan[name]) byKaryawan[name] = { count: 0, qty: 0 };
      byKaryawan[name].count++;
      byKaryawan[name].qty += Number(d.qty);
    });
    const entries = Object.keys(byKaryawan).map(function (name) {
      return { name: name, count: byKaryawan[name].count, qty: byKaryawan[name].qty };
    });
    // Rata-rata & ketimpangan dihitung dari QTY (bukan jumlah pengambilan) —
    // 2 orang yang sama-sama 1x ambil tapi qty-nya beda jauh (1 Pcs vs 4 Pcs)
    // tetap dianggap timpang, karena yang dibandingkan itu BANYAKNYA barang
    // yang didapat, bukan berapa KALI dia dateng ambil.
    const avgQty = entries.reduce(function (a, e) { return a + e.qty; }, 0) / entries.length;
    entries.sort(function (a, b) { return b.qty - a.qty; });

    // Chart cuma nampilin top 12 (biar tetap kebaca kalau karyawan-nya
    // ratusan), tapi TABEL di bawahnya dipaginasi lengkap — semua karyawan
    // tetap bisa dicek, cuma dipecah per halaman.
    const chartAgg = entries.slice(0, 12).map(function (e) { return { key: e.name, count: e.qty }; });
    const { pageRows, totalPages, totalRows } = paginate(entries);

    function pctDiffOf(e) {
      const selisih = e.qty - avgQty;
      return avgQty > 0 ? (selisih / avgQty) * 100 : (e.qty > 0 ? 100 : 0);
    }
    const levels = entries.map(function (e) { return timpangLevel(pctDiffOf(e)); });
    const timpangCount = levels.filter(function (l) { return l.key !== 'wajar'; }).length;
    const tinggiEntries = entries.filter(function (e, i) { return levels[i].key === 'tinggi'; });

    const banner = tinggiEntries.length
      ? '<div class="alert-banner alert-banner-danger" style="margin-top:1rem">' +
          '<i data-lucide="alert-triangle" class="icon-md"></i>' +
          '<div><strong>Warning: qty yang didapat sangat jomplang antar orang.</strong><br>' +
          tinggiEntries.map(function (e) {
            const selisih = e.qty - avgQty;
            const pct = pctDiffOf(e);
            return esc(e.name) + ' dapat ' + e.qty + ' (selisih ' + (selisih > 0 ? '+' : '') + selisih.toFixed(1) +
              ' / ' + (pct > 0 ? '+' : '') + pct.toFixed(0) + '% dari rata-rata ' + avgQty.toFixed(1) + ')';
          }).join(', ') + '.</div>' +
        '</div>'
      : '';

    const table = '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
      '<thead><tr><th>Karyawan</th><th>Jumlah Pengambilan</th><th>Total Qty</th><th>Selisih dari Rata-rata</th><th>Status</th></tr></thead>' +
      '<tbody>' + pageRows.map(function (e) {
        const selisih = e.qty - avgQty;
        const pct = pctDiffOf(e);
        const level = timpangLevel(pct);
        return '<tr' + (level.key === 'tinggi' ? ' style="background:var(--red-50)"' : '') + '><td style="font-weight:600">' + esc(e.name) + '</td>' +
          '<td>' + e.count + 'x</td>' +
          '<td>' + e.qty + '</td>' +
          '<td>' + (selisih > 0 ? '+' : '') + selisih.toFixed(1) + ' (' + (pct > 0 ? '+' : '') + pct.toFixed(0) + '%)</td>' +
          '<td><span class="badge ' + level.badge + '"><span class="badge-dot"></span>' + level.label + '</span></td></tr>';
      }).join('') + '</tbody>' +
    '</table></div>' +
    paginationHtml(state.page, totalPages, totalRows);

    return reportCard('search', 'Analisis Barang — Ketimpangan Pemakaian',
      picker +
      banner +
      '<div class="grid-stats" style="grid-template-columns:repeat(4,1fr);margin:1rem 0 0">' +
        statCard('users', 'sky', 'Karyawan Terdaftar', entries.length, 'pernah ambil barang ini') +
        statCard('list-checks', 'indigo', 'Total Pengambilan', skuRows.length, 'kali, sesuai filter tanggal') +
        statCard('bar-chart-3', 'amber', 'Rata-rata Qty / Orang', avgQty.toFixed(1), 'patokan kewajaran') +
        statCard('alert-triangle', 'red', 'Timpang', timpangCount, 'dari ' + entries.length + ' karyawan') +
      '</div>' +
      '<div style="margin-top:1rem">' + rankBarsHtml(chartAgg, function () { return 'var(--brand-500)'; }) + '</div>' +
      (entries.length > 12 ? '<p class="chart-foot">Grafik cuma nampilin top 12 — tabel di bawah tetap lengkap semua ' + entries.length + ' karyawan.</p>' : '') +
      table +
      '<p class="chart-foot">Dinilai dari selisih QTY (bukan jumlah pengambilan) terhadap rata-rata: 20–49% = Perlu Diperhatikan, 50–99% = Warning, 100% ke atas = Warning Tinggi (langsung ditandai banner di atas).</p>');
  }

  // "Ranking Barang per Divisi/Sub Divisi/Pos" — kebalikan dari Analisis
  // Barang: di sini pilih DULU divisi/sub-divisi/pos-nya (dari department si
  // PENERIMA, bukan si pengambil), baru lihat barang apa yang paling sering
  // keluar ke situ. department formatnya "DIVISI / SUB DIVISI / POS" — sama
  // parsing-nya kayak karyawan.js, ditambah 1 tingkat (Pos).
  function divisiOfDept(dept) { return ((dept || '').split(' / ')[0] || '').trim(); }
  function subDivisiOfDept(dept) { return ((dept || '').split(' / ')[1] || '').trim(); }
  function posOfDept(dept) { return ((dept || '').split(' / ')[2] || '').trim(); }

  // Grouping "Ringkasan per Barang" — persis format variant 1 di catatan
  // tangan: 1 baris per SKU+Divisi (bukan cuma per SKU, soalnya kalau
  // filternya "Semua Divisi" 1 SKU bisa kepakai di lebih dari 1 divisi),
  // isinya SIAPA AJA yang ambil digabung 1 sel ("Distribusi Karyawan"),
  // plus Keterangan (kalau ada yang diisi manual).
  function groupBySkuDivisi(filtered) {
    const groups = {};
    filtered.forEach(function (d) {
      const sku = skuOf(d);
      const div = divisiOfDept(d.department) || '-';
      const key = sku + '|' + div;
      if (!groups[key]) groups[key] = { sku: sku, div: div, product: productOf(d), uom: uomOf(d), entries: [], qty: 0, keterangan: [] };
      groups[key].entries.push({ name: d.karyawan_name || '-', qty: Number(d.qty) });
      groups[key].qty += Number(d.qty);
      if (d.keterangan && groups[key].keterangan.indexOf(d.keterangan) === -1) groups[key].keterangan.push(d.keterangan);
    });
    return Object.values(groups).sort(function (a, b) { return b.qty - a.qty; });
  }

  // Label breadcrumb "Divisi / Sub Divisi / Pos" — DIAMBIL DARI DATA hasil
  // filter, bukan cuma dari state.rankDivisi/rankSubDivisi/rankPos yang
  // eksplisit dipilih. Soalnya user bisa aja langsung pilih Sub Divisi tanpa
  // milih Divisi-nya duluan (dropdown Sub Divisi/Pos nggak mewajibkan itu) —
  // kalau labelnya cuma ngandelin state, bagian yang nggak dipilih eksplisit
  // jadi kosong ("/ SPAREPART" doang), padahal DATA yang kefilter sebenarnya
  // cuma dari 1 Divisi/Pos tertentu juga (jadi seharusnya bisa dilengkapi).
  function rankingScopeLabel(filteredRows) {
    function distinctLevel(fn) {
      const set = {};
      filteredRows.forEach(function (d) { const v = fn(d); if (v) set[v] = true; });
      const keys = Object.keys(set);
      return keys.length === 1 ? keys[0] : null;
    }
    const dDivisi = state.rankDivisi || distinctLevel(function (d) { return divisiOfDept(d.department); });
    const dSub = state.rankSubDivisi || distinctLevel(function (d) { return subDivisiOfDept(d.department); });
    const dPos = state.rankPos || distinctLevel(function (d) { return posOfDept(d.department); });
    return [dDivisi, dSub, dPos].filter(Boolean).join(' / ') || 'Semua Divisi';
  }

  function rankingDivisiHtml(rows) {
    const divisis = {};
    rows.forEach(function (d) { const v = divisiOfDept(d.department); if (v) divisis[v] = true; });
    const divisiOptions = Object.keys(divisis).sort();

    const subDivisis = {};
    rows.forEach(function (d) {
      if (state.rankDivisi && divisiOfDept(d.department) !== state.rankDivisi) return;
      const v = subDivisiOfDept(d.department);
      if (v) subDivisis[v] = true;
    });
    const subDivisiOptions = Object.keys(subDivisis).sort();

    const poss = {};
    rows.forEach(function (d) {
      if (state.rankDivisi && divisiOfDept(d.department) !== state.rankDivisi) return;
      if (state.rankSubDivisi && subDivisiOfDept(d.department) !== state.rankSubDivisi) return;
      const v = posOfDept(d.department);
      if (v) poss[v] = true;
    });
    const posOptions = Object.keys(poss).sort();

    const picker =
      '<div style="display:flex;gap:0.5rem;flex-wrap:wrap">' +
        '<select class="select-input" onchange="SPB.laporan.setRankDivisi(this.value)">' +
          '<option value="">Semua Divisi</option>' +
          divisiOptions.map(function (v) { return '<option value="' + esc(v) + '"' + (state.rankDivisi === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
        '</select>' +
        '<select class="select-input" onchange="SPB.laporan.setRankSubDivisi(this.value)">' +
          '<option value="">Semua Sub Divisi</option>' +
          subDivisiOptions.map(function (v) { return '<option value="' + esc(v) + '"' + (state.rankSubDivisi === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
        '</select>' +
        '<select class="select-input" onchange="SPB.laporan.setRankPos(this.value)">' +
          '<option value="">Semua Pos</option>' +
          posOptions.map(function (v) { return '<option value="' + esc(v) + '"' + (state.rankPos === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
        '</select>' +
      '</div>';

    let filtered = rows;
    if (state.rankDivisi) filtered = filtered.filter(function (d) { return divisiOfDept(d.department) === state.rankDivisi; });
    if (state.rankSubDivisi) filtered = filtered.filter(function (d) { return subDivisiOfDept(d.department) === state.rankSubDivisi; });
    if (state.rankPos) filtered = filtered.filter(function (d) { return posOfDept(d.department) === state.rankPos; });

    if (!filtered.length) {
      return reportCard('trophy', 'Ranking Barang per Divisi/Sub Divisi/Pos', picker +
        '<div class="empty-state" style="margin-top:1rem">Tidak ada distribusi sesuai divisi/sub divisi/pos & filter tanggal yang dipilih.</div>');
    }

    const bySku = {};
    filtered.forEach(function (d) {
      const sku = skuOf(d);
      if (!bySku[sku]) bySku[sku] = { sku: sku, product: productOf(d), uom: uomOf(d), count: 0, qty: 0 };
      bySku[sku].count++;
      bySku[sku].qty += Number(d.qty);
    });
    const entries = Object.values(bySku).sort(function (a, b) { return b.qty - a.qty; });
    const chartAgg = entries.slice(0, 12).map(function (e) { return { key: e.sku, count: e.qty }; });

    // 2 format tabel — toggle sesuai catatan: "Ringkasan per Barang" (1 baris
    // per SKU, jumlah pengambilan digabung) atau "Detail per Karyawan" (1
    // baris per orang yang ambil, sekalian harganya).
    const modeToggle = '<div class="report-view-tabs" style="margin-top:0.75rem">' +
      '<button type="button" class="report-tab' + (state.rankMode !== 'detail' ? ' active' : '') + '" onclick="SPB.laporan.setRankMode(\'ringkasan\')">' +
        '<i data-lucide="layers" class="icon-sm"></i>Ringkasan per Barang</button>' +
      '<button type="button" class="report-tab' + (state.rankMode === 'detail' ? ' active' : '') + '" onclick="SPB.laporan.setRankMode(\'detail\')">' +
        '<i data-lucide="list" class="icon-sm"></i>Detail per Karyawan</button>' +
    '</div>';

    let table;
    if (state.rankMode === 'detail') {
      const priceMap = sparepartPriceMap(lastStokOut);
      // Urut dari qty terbesar dulu (bukan alfabetis) — biar yang paling
      // banyak diambil langsung kelihatan di baris paling atas.
      const flat = filtered.slice().sort(function (a, b) { return Number(b.qty) - Number(a.qty); });
      const paged = paginate(flat);
      // "Nama Pengambil" (pengambilOf) = orang yang FISIK ambil barangnya di
      // gudang/Odoo, 1 orang per WH/OUT — belum tentu buat dia sendiri.
      // "Distribusi Karyawan" (d.karyawan_name) = orang yang BENERAN nerima
      // stelah dibagi — bisa beda dari yang ambil di gudang. Dua kolom
      // terpisah biar jelas bedanya, bukan cuma 1 kolom "Nama Pengambil"
      // yang isinya penerima (mengecoh — kelihatannya cuma 1 orang padahal
      // itu hasil pembagian).
      table = '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
        '<thead><tr><th>#</th><th>SKU</th><th>Div</th><th>Barang</th><th>Nama Pengambil</th><th>Distribusi Karyawan</th><th>Total Qty Diambil</th><th>Harga</th></tr></thead>' +
        '<tbody>' + paged.pageRows.map(function (d, i) {
          const offset = (state.page - 1) * PAGE_SIZE;
          const price = priceOfSku(priceMap, skuOf(d));
          return '<tr><td>' + (offset + i + 1) + '</td>' +
            '<td style="font-weight:600">' + esc(skuOf(d)) + '</td>' +
            '<td>' + esc(divisiOfDept(d.department)) + '</td>' +
            '<td>' + esc(productOf(d)) + '</td>' +
            '<td>' + esc(pengambilOf(d)) + '</td>' +
            '<td>' + esc(d.karyawan_name || '-') + '</td>' +
            '<td>' + d.qty + ' ' + esc(uomOf(d) || '') + '</td>' +
            '<td>' + (price == null ? '-' : fmtRupiah(price)) + '</td></tr>';
        }).join('') + '</tbody>' +
      '</table></div>' +
      paginationHtml(state.page, paged.totalPages, paged.totalRows);
    } else {
      // Variant 1 dari catatan tangan: No, SKU, Div, Barang, Distribusi
      // Karyawan (semua nama+qty digabung 1 sel), Total Qty (satuan), Ket.
      const skuDivisiGroups = groupBySkuDivisi(filtered);
      const { pageRows, totalPages, totalRows } = paginate(skuDivisiGroups);
      table = '<div class="table-wrap" style="margin-top:1rem"><table class="table">' +
        '<thead><tr><th>#</th><th>SKU</th><th>Div</th><th>Barang</th><th>Distribusi Karyawan</th><th>Total Qty</th><th>Ket</th></tr></thead>' +
        '<tbody>' + pageRows.map(function (g, i) {
          const offset = (state.page - 1) * PAGE_SIZE;
          const dist = g.entries.map(function (e) { return esc(e.name) + ' (' + e.qty + (g.uom ? ' ' + esc(g.uom) : '') + ')'; }).join('<br>');
          return '<tr><td>' + (offset + i + 1) + '</td>' +
            '<td style="font-weight:600">' + esc(g.sku) + '</td>' +
            '<td>' + esc(g.div) + '</td>' +
            '<td>' + esc(g.product) + '</td>' +
            '<td>' + dist + '</td>' +
            '<td>' + g.qty + ' ' + esc(g.uom || '') + '</td>' +
            '<td>' + (g.keterangan.length ? esc(g.keterangan.join('; ')) : '-') + '</td></tr>';
        }).join('') + '</tbody>' +
      '</table></div>' +
      paginationHtml(state.page, totalPages, totalRows);
    }

    const scopeLabel = rankingScopeLabel(filtered);

    return reportCard('trophy', 'Ranking Barang Paling Sering Keluar — ' + esc(scopeLabel),
      picker +
      modeToggle +
      '<div class="grid-stats" style="grid-template-columns:repeat(3,1fr);margin:1rem 0 0">' +
        statCard('package', 'indigo', 'Jenis Barang', entries.length, 'SKU berbeda') +
        statCard('list-checks', 'sky', 'Total Pengambilan', filtered.length, 'kali, sesuai filter') +
        statCard('boxes', 'amber', 'Total Qty Keluar', filtered.reduce(function (a, d) { return a + Number(d.qty); }, 0), 'gabungan semua satuan') +
      '</div>' +
      '<div style="margin-top:1rem">' + rankBarsHtml(chartAgg, function () { return 'var(--sky-600)'; }) + '</div>' +
      (entries.length > 12 ? '<p class="chart-foot">Grafik cuma nampilin top 12 — tabel di bawah tetap lengkap semua ' + entries.length + ' SKU.</p>' : '') +
      table);
  }

  function renderWhOut(app, allRows, stok) {
    lastAllRows = allRows;
    lastStokOut = stok || [];
    const rows = applyFiltersOut(allRows);
    const karyawanOptions = karyawanListFromDist(allRows);
    const divisiOptions = divisiListFromDist(allRows);
    const priceMap = sparepartPriceMap(lastStokOut);

    const totalDistribusi = rows.length;
    const totalQty = rows.reduce(function (a, d) { return a + Number(d.qty); }, 0);
    const karyawanUnik = karyawanListFromDist(rows).length;
    const whOutUnik = new Set(rows.map(function (d) { return d.pengeluaran_id; })).size;

    let bodyHtml;
    if (state.view === 'karyawan') {
      // Filter umum (Periode/Cari Karyawan/Divisi/Status) disembunyikan buat
      // tab ini (lihat report-filter-fields di bawah) — pakai allRows APA
      // ADANYA, bukan `rows` yang udah kesaring, biar rankingnya nggak
      // kefilter diam-diam sama filter yang nyangkut dari tab lain sebelumnya
      // padahal UI-nya nggak kelihatan lagi di sini.
      // Agregasi sendiri (bukan aggregateBy() generik) — sekalian nangkep
      // Departemen & rincian status (Baru/Hilang/Tukar/Habis) per orang,
      // diurut dari QTY terbesar (bukan jumlah transaksi).
      const byName = {};
      allRows.forEach(function (d) {
        const name = d.karyawan_name || '-';
        if (!byName[name]) byName[name] = { key: name, count: 0, qty: 0, department: d.department || '-', statusCount: {} };
        byName[name].count++;
        byName[name].qty += Number(d.qty);
        const st = d.status || 'Baru';
        byName[name].statusCount[st] = (byName[name].statusCount[st] || 0) + 1;
      });
      const aggAll = Object.values(byName).sort(function (a, b) { return b.qty - a.qty; });
      const agg = state.karyawan
        ? aggAll.filter(function (a) { return a.key.toLowerCase().indexOf(state.karyawan.toLowerCase()) !== -1; })
        : aggAll;
      const searchBox = '<div style="margin-bottom:1rem">' +
        '<input type="text" class="input wo-karyawan-search" placeholder="Cari nama karyawan..." ' +
          'value="' + esc(state.karyawan) + '" oninput="SPB.laporan.setKaryawanSearch(this.value)"></div>';
      bodyHtml = reportCard('users', 'Ranking Karyawan — Paling Banyak Mengambil',
        searchBox +
        (agg.length
          ? rankBarsHtml(agg, function () { return 'var(--brand-500)'; }, function (a) { return a.qty; }) +
            karyawanRankTableHtml(agg)
          : '<div class="empty-state">Tidak ada karyawan yang cocok dengan pencarian.</div>'));
    } else if (state.view === 'analisis') {
      bodyHtml = analisisBarangHtml(rows);
    } else if (state.view === 'rankingDivisi') {
      bodyHtml = rankingDivisiHtml(allRows); // sama alasannya — punya picker Divisi/Sub Divisi/Pos sendiri
    } else if (state.view === 'periode') {
      bodyHtml = periodeHtml(rows);
    } else if (state.view === 'ringkas') {
      bodyHtml = reportCard('receipt', 'Laporan Ringkas', ringkasOutHtml(rows, priceMap));
    } else {
      bodyHtml = reportCard('table', 'Semua Distribusi', allDataTableHtmlOut(rows));
    }

    app.innerHTML = window.SPB.ui.layout('laporan',
      pageHeadHtml() +
      sourceTabsHtml() +
      '<div class="report-filters">' +
        '<div class="report-view-tabs">' +
          reportTab('all', 'table', 'Semua Distribusi', "SPB.laporan.setView('all')") +
          reportTab('ringkas', 'receipt', 'Ringkas', "SPB.laporan.setView('ringkas')") +
          reportTab('karyawan', 'users', 'Ranking Karyawan', "SPB.laporan.setView('karyawan')") +
          reportTab('analisis', 'search', 'Analisis Barang', "SPB.laporan.setView('analisis')") +
          reportTab('rankingDivisi', 'trophy', 'Ranking per Divisi', "SPB.laporan.setView('rankingDivisi')") +
          reportTab('periode', 'calendar-range', 'Ringkasan Periode', "SPB.laporan.setView('periode')") +
        '</div>' +
        // Ranking Karyawan & Ranking per Divisi punya filternya sendiri-sendiri
        // di dalam kartunya (Ranking per Divisi malah udah ada picker Divisi/
        // Sub Divisi/Pos sendiri) — filter umum (Periode/Cari Karyawan/Divisi/
        // Status) di sini nggak perlu dobel ditampilin buat 2 tab itu.
        (state.view === 'karyawan' || state.view === 'rankingDivisi' ? '' :
        '<div class="report-filter-fields">' +
          '<div><label class="field-label">Periode</label>' +
          '<select class="select-input" onchange="SPB.laporan.setPeriodPreset(this.value)">' +
            '<option value=""' + (state.periodPreset === '' ? ' selected' : '') + '>Semua Waktu</option>' +
            '<option value="7"' + (state.periodPreset === '7' ? ' selected' : '') + '>7 Hari Terakhir</option>' +
            '<option value="14"' + (state.periodPreset === '14' ? ' selected' : '') + '>2 Minggu Terakhir</option>' +
            '<option value="30"' + (state.periodPreset === '30' ? ' selected' : '') + '>1 Bulan Terakhir</option>' +
            '<option value="90"' + (state.periodPreset === '90' ? ' selected' : '') + '>3 Bulan Terakhir</option>' +
            '<option value="custom"' + (state.periodPreset === 'custom' ? ' selected' : '') + '>Kustom...</option>' +
          '</select></div>' +
          (state.periodPreset === 'custom'
            ? '<div><label class="field-label">Dari Tanggal</label>' +
              '<input type="date" class="input" value="' + esc(state.dateFrom) + '" onchange="SPB.laporan.setFilter(\'dateFrom\', this.value)"></div>' +
              '<div><label class="field-label">Sampai Tanggal</label>' +
              '<input type="date" class="input" value="' + esc(state.dateTo) + '" onchange="SPB.laporan.setFilter(\'dateTo\', this.value)"></div>'
            : '') +
          '<div><label class="field-label">Cari Karyawan</label>' +
          '<input type="text" class="input wo-karyawan-search" list="wo-karyawan-datalist" placeholder="Ketik nama..." ' +
            'value="' + esc(state.karyawan) + '" oninput="SPB.laporan.setKaryawanSearch(this.value)"></div>' +
          '<datalist id="wo-karyawan-datalist">' +
            karyawanOptions.map(function (k) { return '<option value="' + esc(k) + '">'; }).join('') +
          '</datalist>' +
          '<div><label class="field-label">Departemen/Divisi</label>' +
          '<select class="select-input" onchange="SPB.laporan.setFilter(\'divisi\', this.value)">' +
            '<option value="">Semua Divisi</option>' +
            divisiOptions.map(function (v) {
              return '<option value="' + esc(v) + '"' + (state.divisi === v ? ' selected' : '') + '>' + esc(v) + '</option>';
            }).join('') +
          '</select></div>' +
          '<div><label class="field-label">Status</label>' +
          '<select class="select-input" onchange="SPB.laporan.setFilter(\'distStatus\', this.value)">' +
            '<option value="">Semua Status</option>' +
            DIST_STATUS_OPTIONS.map(function (s) {
              return '<option value="' + s + '"' + (state.distStatus === s ? ' selected' : '') + '>' + s + '</option>';
            }).join('') +
          '</select></div>' +
          (state.periodPreset || state.karyawan || state.divisi || state.distStatus
            ? '<button type="button" class="btn btn-outline btn-sm" onclick="SPB.laporan.resetFilters()">' +
              '<i data-lucide="x" class="icon-sm"></i>Reset Filter</button>'
            : '') +
        '</div>') +
      '</div>' +
      '<div class="grid-stats">' +
        statCard('list-checks', 'sky', 'Total Distribusi', totalDistribusi, 'sesuai filter') +
        statCard('boxes', 'emerald', 'Total Qty Keluar', totalQty, 'gabungan semua satuan') +
        statCard('users', 'amber', 'Karyawan Unik', karyawanUnik, 'penerima distribusi') +
        statCard('package-check', 'indigo', 'WH/OUT Terlibat', whOutUnik, 'transaksi unik') +
      '</div>' +
      trendLineHtml(rows, function (d) { return d.created_at; }, function (d) { return Number(d.qty); }, {
        color: 'var(--sky-600)',
        label: 'Tren Qty Distribusi',
        seriesKeyFn: state.trendSplitLevel === 'divisi' ? function (d) { return divisiOfDept(d.department) || '-'; }
          : state.trendSplitLevel === 'subdivisi' ? function (d) { return subDivisiOfDept(d.department) || '-'; }
          : state.trendSplitLevel === 'pos' ? function (d) { return posOfDept(d.department) || '-'; }
          : null,
        selectedSeries: state.trendSelectedSeries,
        onToggleSeries: 'SPB.laporan.toggleTrendSeries',
        extraControls:
          '<select class="select-input select-input-sm" onchange="SPB.laporan.setTrendSplitLevel(this.value)">' +
            '<option value=""' + (state.trendSplitLevel === '' ? ' selected' : '') + '>Gabungan</option>' +
            '<option value="divisi"' + (state.trendSplitLevel === 'divisi' ? ' selected' : '') + '>Per Divisi</option>' +
            '<option value="subdivisi"' + (state.trendSplitLevel === 'subdivisi' ? ' selected' : '') + '>Per Sub Divisi</option>' +
            '<option value="pos"' + (state.trendSplitLevel === 'pos' ? ' selected' : '') + '>Per Pos</option>' +
          '</select>',
      }) +
      bodyHtml +
      whOutLegendHtml()
    );
    window.SPB.ui.afterRender();
  }

  function whOutLegendHtml() {
    const items = [
      { label: 'Diambil Oleh', text: 'Nama karyawan yang mengambil barang langsung di gudang/Odoo (1 orang per WH/OUT) — belum tentu barang itu buat dia sendiri.' },
      { label: 'Karyawan Unik', text: 'Jumlah PENERIMA akhir yang berbeda dari hasil pembagian (bisa lebih dari 1 orang per barang, dilihat lewat popup "Detail") — beda dari "Diambil Oleh".' },
      { label: 'Total Qty Keluar', text: 'Gabungan qty dari semua satuan (pcs, dus, rim, dll) dijumlah mentah — bukan berarti semuanya satuan yang sama.' },
    ];
    return '<div class="callout" style="margin-top:1.25rem"><i data-lucide="info" class="icon-md"></i>' +
      '<div class="status-legend">' +
        items.map(function (it) {
          return '<div class="status-legend-item"><span class="badge badge-draft"><span class="badge-dot"></span>' + it.label + '</span>' +
            '<span class="status-legend-text">' + it.text + '</span></div>';
        }).join('') +
      '</div></div>';
  }

  /* ---------- Chrome bersama (page head, tab sumber) ---------- */
  function pageHeadHtml() {
    const subtitle = state.source === 'gabungan'
      ? 'Ringkasan gabungan WH/IN & WH/OUT — pilih tab di bawah buat lihat detail & ekspor.'
      : state.source === 'wh-in'
        ? 'Rekap penerimaan barang — bisa difilter, diekspor ke Excel atau PDF.'
        : 'Rekap distribusi ATK ke karyawan — siapa ambil apa, kapan, dan berapa banyak.';
    return '<div class="page-head">' +
      '<div><h1 class="page-title">Laporan</h1>' +
      '<p class="page-sub">' + subtitle + '</p></div>' +
      (state.source === 'gabungan' ? '' :
        '<div class="page-head-actions">' +
          '<button type="button" class="btn btn-outline" onclick="SPB.laporan.exportExcel()">' +
            '<i data-lucide="file-spreadsheet" class="icon-sm"></i>Export Excel</button>' +
          '<button type="button" class="btn btn-primary" onclick="SPB.laporan.exportPdf()">' +
            '<i data-lucide="file-down" class="icon-sm"></i>Export PDF</button>' +
        '</div>') +
    '</div>';
  }
  function sourceTabsHtml() {
    return '<div class="source-tabs">' +
      '<button type="button" class="source-tab' + (state.source === 'gabungan' ? ' active' : '') + '" ' +
        'onclick="SPB.laporan.setSource(\'gabungan\')"><i data-lucide="sparkles" class="icon-sm"></i>Semua — Ringkasan</button>' +
      '<button type="button" class="source-tab' + (state.source === 'wh-in' ? ' active' : '') + '" ' +
        'onclick="SPB.laporan.setSource(\'wh-in\')"><i data-lucide="truck" class="icon-sm"></i>WH/IN — Penerimaan</button>' +
      '<button type="button" class="source-tab' + (state.source === 'wh-out' ? ' active' : '') + '" ' +
        'onclick="SPB.laporan.setSource(\'wh-out\')"><i data-lucide="share-2" class="icon-sm"></i>WH/OUT — Distribusi</button>' +
    '</div>';
  }

  /* ---------- Render utama ---------- */
  // Stale-while-revalidate: kalau sumber data ini (gabungan/wh-in/wh-out)
  // sudah pernah berhasil dimuat di sesi ini, langsung tampil pakai data lama
  // itu TANPA spinner (instan), sambil diam-diam ambil data terbaru di
  // belakang layar dan ganti begitu datang — jadi "Memuat..." cuma muncul
  // sekali per sumber, bukan tiap kali balik ke Laporan / ganti tab sumber.
  function render() {
    const app = document.getElementById('app');
    const src = state.source;
    const alreadyLoaded = everLoaded[src];

    if (alreadyLoaded) {
      if (src === 'gabungan') renderGabungan(app, lastGabunganIn, lastGabunganOut);
      else if (src === 'wh-out') renderWhOut(app, lastAllRows, lastStokOut);
      else renderWhIn(app, lastAllRowsIn, lastSparepartsIn);
    } else {
      app.innerHTML = window.SPB.ui.layout('laporan',
        '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>');
      window.SPB.ui.afterRender();
    }

    // Masih di Laporan DAN masih di tab sumber yang sama kayak pas fetch ini
    // mulai? Dicek sebelum nulis ke #app — kalau tidak, kejadian begini: user
    // klik pindah ke halaman lain (atau ganti tab sumber) pas fetch masih
    // jalan, begitu fetch itu selesai dia nimpa balik layar yang sekarang
    // ditampilin, seolah klik pindah halaman/tabnya "tidak ngefek".
    function stillHere() { return location.hash.replace(/^#/, '') === '/laporan' && state.source === src; }

    if (src === 'gabungan') {
      Promise.all([window.SPB.db.list(), window.SPB.dbWhOut.list()])
        .then(function (res) {
          lastGabunganIn = res[0] || []; lastGabunganOut = res[1] || []; everLoaded.gabungan = true;
          if (stillHere()) renderGabungan(app, lastGabunganIn, lastGabunganOut);
        })
        .catch(function (err) { if (stillHere()) window.SPB.ui.toast('Gagal memuat', err.message, 'error'); });
    } else if (src === 'wh-out') {
      Promise.all([window.SPB.dbDistribusi.listAll(), window.SPB.dbStokBarang.list().catch(function () { return []; })])
        .then(function (res) {
          lastAllRows = res[0] || []; lastStokOut = res[1] || []; everLoaded['wh-out'] = true;
          if (stillHere()) renderWhOut(app, lastAllRows, lastStokOut);
        })
        .catch(function (err) { if (stillHere()) window.SPB.ui.toast('Gagal memuat', err.message, 'error'); });
    } else {
      Promise.all([window.SPB.db.list(), window.SPB.db.spareparts().catch(function () { return []; })])
        .then(function (res) {
          lastAllRowsIn = res[0] || []; lastSparepartsIn = res[1] || []; everLoaded['wh-in'] = true;
          if (stillHere()) renderWhIn(app, lastAllRowsIn, lastSparepartsIn);
        })
        .catch(function (err) { if (stillHere()) window.SPB.ui.toast('Gagal memuat', err.message, 'error'); });
    }
  }

  // Dipanggil diam-diam sekali begitu app.js selesai boot (BUKAN saat user
  // buka halaman ini) — narik data KETIGA sumber (Gabungan, WH/IN, WH/OUT) di
  // belakang layar, supaya apapun tab yang dipilih user pas beneran buka
  // Laporan, render() lewat jalur stale-while-revalidate dan tampil instan
  // tanpa "Memuat...". Fetch WH/IN (penerimaan_barang) dipakai bareng buat
  // Gabungan & tab WH/IN sendiri — cukup 1x, bukan 2x round-trip terpisah.
  function prefetch() {
    const whInPromise = window.SPB.db.list().catch(function () { return null; });

    if (!everLoaded.gabungan) {
      Promise.all([whInPromise, window.SPB.dbWhOut.list().catch(function () { return null; })])
        .then(function (res) {
          if (res[0] === null || res[1] === null) return; // salah satu gagal — biar render() biasa yang nanggung nanti
          lastGabunganIn = res[0]; lastGabunganOut = res[1]; everLoaded.gabungan = true;
        });
    }
    if (!everLoaded['wh-in']) {
      Promise.all([whInPromise, window.SPB.db.spareparts().catch(function () { return []; })])
        .then(function (res) {
          if (res[0] === null) return;
          lastAllRowsIn = res[0]; lastSparepartsIn = res[1] || []; everLoaded['wh-in'] = true;
        });
    }
    if (!everLoaded['wh-out']) {
      Promise.all([window.SPB.dbDistribusi.listAll(), window.SPB.dbStokBarang.list().catch(function () { return []; })])
        .then(function (res) {
          lastAllRows = res[0] || []; lastStokOut = res[1] || []; everLoaded['wh-out'] = true;
        })
        .catch(function () { /* diam-diam gagal juga gapapa — render() biasa yang nanggung kalau user beneran buka tab WH/OUT */ });
    }
  }

  /* ---------- Interaksi ---------- */
  // Ganti filter/tab/halaman itu TIDAK perlu fetch ulang ke server — datanya
  // sudah ada di memori (lastAllRowsIn/lastSparepartsIn buat WH/IN,
  // lastAllRows/lastStokOut buat WH/OUT), cukup render ulang pakai itu.
  // render() (fetch + tampilkan "Memuat...") CUMA dipakai buat load awal
  // halaman dan pas ganti sumber data (WH/IN <-> WH/OUT <-> Gabungan).
  function rerender() {
    const app = document.getElementById('app');
    if (state.source === 'wh-out') renderWhOut(app, lastAllRows, lastStokOut);
    else if (state.source === 'wh-in') renderWhIn(app, lastAllRowsIn, lastSparepartsIn);
    else render();
  }
  function setSource(source) {
    state.source = source;
    state.view = 'all';
    state.dateFrom = ''; state.dateTo = ''; state.vendor = ''; state.karyawan = ''; state.divisi = ''; state.distStatus = ''; state.periodPreset = ''; state.page = 1;
    detailModal = null; inDetailModal = null;
    render();
  }
  function setView(view) { state.view = view; state.page = 1; detailModal = null; inDetailModal = null; rerender(); }
  function setGranularity(g) { state.granularity = g; state.page = 1; rerender(); }
  function setAnalisisSku(sku) { state.analisisSku = sku; rerender(); }
  function setRankDivisi(v) { state.rankDivisi = v; state.rankSubDivisi = ''; state.rankPos = ''; state.page = 1; rerender(); }
  function setRankSubDivisi(v) { state.rankSubDivisi = v; state.rankPos = ''; state.page = 1; rerender(); }
  function setRankPos(v) { state.rankPos = v; state.page = 1; rerender(); }
  function setRankMode(v) { state.rankMode = v; state.page = 1; rerender(); }
  function setTrendGranularity(v) { state.trendGranularity = v; rerender(); }
  function setTrendSplitLevel(v) { state.trendSplitLevel = v; state.trendSelectedSeries = []; rerender(); }
  function toggleTrendSeries(name) {
    const i = state.trendSelectedSeries.indexOf(name);
    if (i === -1) state.trendSelectedSeries.push(name); else state.trendSelectedSeries.splice(i, 1);
    rerender();
  }
  function setFilter(key, value) { state[key] = value; state.page = 1; rerender(); }

  // Kotak pencarian karyawan (oninput, tiap ketikan) — beda dari setFilter()
  // biasa yang dipakai select/date (onchange, sekali klik): innerHTML diganti
  // total tiap render, jadi fokus & posisi kursor input ilang kalau tidak
  // disimpan & dikembalikan manual. Pola sama persis dengan applyFilter() di
  // stokBarang.js.
  function setKaryawanSearch(value) {
    state.karyawan = value;
    state.page = 1;
    const active = document.activeElement;
    const isSearchBox = active && active.classList.contains('wo-karyawan-search');
    const caret = isSearchBox ? active.selectionStart : null;
    rerender();
    if (isSearchBox) {
      const el = document.querySelector('.wo-karyawan-search');
      if (el) {
        el.focus();
        const pos = caret == null ? el.value.length : caret;
        el.setSelectionRange(pos, pos);
      }
    }
  }
  // Dropdown periode: preset apa aja langsung isi dateFrom/dateTo; "custom"
  // munculin 2 input tanggal manual (dirender di renderWhOut); "" (Semua
  // Waktu) bersihin filter tanggal sama sekali.
  function setPeriodPreset(value) {
    state.periodPreset = value;
    if (value === 'custom') {
      // Biarkan dateFrom/dateTo apa adanya (kalau sebelumnya kosong, user
      // tinggal isi manual di 2 input yang baru muncul).
    } else if (value === '') {
      state.dateFrom = ''; state.dateTo = '';
    } else {
      state.dateFrom = daysAgoYmd(Number(value)); state.dateTo = todayYmd();
    }
    state.page = 1;
    rerender();
  }
  function resetFilters() {
    state.dateFrom = ''; state.dateTo = ''; state.vendor = ''; state.karyawan = ''; state.divisi = ''; state.distStatus = ''; state.periodPreset = ''; state.page = 1;
    rerender();
  }
  function goToPage(page) { state.page = page; rerender(); }

  /* ---------- Export ---------- */
  // Daftar nama barang + qty per transaksi, digabung 1 sel (baris baru per
  // barang) — biar laporan PDF/Excel-nya kejawab "beli apa aja" per PO,
  // bukan cuma total qty tanpa rincian.
  function itemListTextIn(r) {
    const draft = r.status === 'Draft';
    return (r.items || []).map(function (it) {
      const qty = draft ? (it.qty_po || 0) : (it.qty_received || 0);
      return (it.product_name || it.sku || '-') + ' (' + qty + (it.uom ? ' ' + it.uom : '') + ')';
    }).join('\n') || '-';
  }
  function reportRowsForExportIn(rows) {
    return rows.map(function (r) {
      return {
        'No PO': r.po_number || '-',
        'WH/IN': r.wh_in_ref || '-',
        'Vendor': r.vendor_name || '-',
        'Tanggal': fmtDate(displayDateOfIn(r)),
        'Status': categoryOf(r),
        'Petugas': r.receiver_name && r.receiver_name !== '-' ? r.receiver_name : '-',
        'Barang': itemListTextIn(r),
        'Qty': itemQtyIn(r),
      };
    });
  }
  function reportRowsForExportOut(rows) {
    return rows.map(function (d) {
      return {
        'Tanggal': fmtDate(d.created_at),
        'Karyawan': d.karyawan_name || '-',
        'Departemen': d.department || '-',
        'Barang': productOf(d),
        'SKU': skuOf(d),
        'WH/OUT': whOutRefOf(d),
        'Qty': d.qty,
        'Satuan': uomOf(d),
      };
    });
  }

  // Pakai snapshot harga yang sudah ke-load pas render() (lastSparepartsIn /
  // lastStokOut) — tidak fetch ulang, karena user sudah pasti pernah lihat
  // halamannya (jadi datanya sudah ada) sebelum klik tombol export.
  function reportRowsForExportRingkasIn(rows) {
    const priceMap = sparepartPriceMap(lastSparepartsIn);
    const flat = [];
    rows.forEach(function (r) {
      const petugas = r.receiver_name && r.receiver_name !== '-' ? r.receiver_name : '-';
      (r.items || []).forEach(function (it) {
        const price = priceOfSku(priceMap, it.sku);
        flat.push({
          'Tanggal': fmtDate(displayDateOfIn(r)),
          'Produk': it.product_name || '-',
          'Petugas Penerima Barang': petugas,
          'Harga': price == null ? '-' : price,
        });
      });
    });
    return flat;
  }
  function reportRowsForExportRingkasOut(rows) {
    const priceMap = sparepartPriceMap(lastStokOut);
    return groupByDetail(rows).map(function (g) {
      const price = priceOfSku(priceMap, g.sku);
      return {
        'Tanggal': fmtDate(g.tanggal),
        'Barang': g.product + ' [' + g.sku + ']',
        'Diambil Oleh': g.pengambil,
        'Harga': price == null ? '-' : price,
      };
    });
  }

  // Ranking Karyawan — sama persis dengan agregasi di renderWhOut() (qty-based,
  // BUKAN jumlah transaksi) supaya Porsi di export sama dengan yang kelihatan
  // di layar. Ditambah kolom "Status" — rincian Baru/Hilang/Tukar/Habis dari
  // seluruh barang yang pernah diterima orang itu, biar laporan ke atasan
  // sekalian kelihatan ada berapa yang ditukar/hilang, bukan cuma qty polos.
  function reportRowsForExportKaryawan(rows) {
    const byKaryawan = {};
    rows.forEach(function (d) {
      const name = d.karyawan_name || '-';
      if (!byKaryawan[name]) byKaryawan[name] = { count: 0, qty: 0, department: d.department || '-', statusCount: {} };
      byKaryawan[name].count++;
      byKaryawan[name].qty += Number(d.qty);
      const st = d.status || 'Baru';
      byKaryawan[name].statusCount[st] = (byKaryawan[name].statusCount[st] || 0) + 1;
    });
    const entries = Object.keys(byKaryawan).map(function (name) {
      return { name: name, department: byKaryawan[name].department, count: byKaryawan[name].count, qty: byKaryawan[name].qty, statusCount: byKaryawan[name].statusCount };
    });
    const totalQty = entries.reduce(function (a, e) { return a + e.qty; }, 0);
    entries.sort(function (a, b) { return b.qty - a.qty; });
    return entries.map(function (e) {
      const share = totalQty ? Math.round((e.qty / totalQty) * 100) : 0;
      const statusText = DIST_STATUS_OPTIONS.map(function (s) {
        return e.statusCount[s] ? s + ': ' + e.statusCount[s] : null;
      }).filter(Boolean).join(', ') || '-';
      return {
        'Karyawan': e.name,
        'Departemen': e.department,
        'Jumlah Distribusi': e.count,
        'Total Qty': e.qty,
        'Porsi': share + '%',
        'Status': statusText,
      };
    });
  }

  // Reuse agregasi yang sama persis dengan analisisBarangHtml() / rankingDivisiHtml()
  // supaya data yang diexport = data yang lagi kelihatan di layar.
  function reportRowsForExportAnalisis(rows) {
    const skuRows = rows.filter(function (d) { return skuOf(d) === state.analisisSku; });
    const byKaryawan = {};
    skuRows.forEach(function (d) {
      const name = d.karyawan_name || '-';
      if (!byKaryawan[name]) byKaryawan[name] = { count: 0, qty: 0 };
      byKaryawan[name].count++;
      byKaryawan[name].qty += Number(d.qty);
    });
    const entries = Object.keys(byKaryawan).map(function (name) {
      return { name: name, count: byKaryawan[name].count, qty: byKaryawan[name].qty };
    });
    const avgQty = entries.length ? entries.reduce(function (a, e) { return a + e.qty; }, 0) / entries.length : 0;
    entries.sort(function (a, b) { return b.qty - a.qty; });
    return entries.map(function (e) {
      const selisih = e.qty - avgQty;
      const pct = avgQty > 0 ? (selisih / avgQty) * 100 : (e.qty > 0 ? 100 : 0);
      return {
        'Karyawan': e.name,
        'Jumlah Pengambilan': e.count,
        'Total Qty': e.qty,
        'Selisih dari Rata-rata': (selisih > 0 ? '+' : '') + selisih.toFixed(1) + ' (' + (pct > 0 ? '+' : '') + pct.toFixed(0) + '%)',
        'Status': timpangLevel(pct).label,
      };
    });
  }
  function reportRowsForExportRankingDivisi(rows) {
    let filtered = rows;
    if (state.rankDivisi) filtered = filtered.filter(function (d) { return divisiOfDept(d.department) === state.rankDivisi; });
    if (state.rankSubDivisi) filtered = filtered.filter(function (d) { return subDivisiOfDept(d.department) === state.rankSubDivisi; });
    if (state.rankPos) filtered = filtered.filter(function (d) { return posOfDept(d.department) === state.rankPos; });

    // Ikutin toggle "Ringkasan per Barang" / "Detail per Karyawan" yang lagi
    // aktif di layar — biar hasil export sama persis dengan yang kelihatan.
    if (state.rankMode === 'detail') {
      const priceMap = sparepartPriceMap(lastStokOut);
      return filtered.slice().sort(function (a, b) { return Number(b.qty) - Number(a.qty); }).map(function (d) {
        const price = priceOfSku(priceMap, skuOf(d));
        return {
          'SKU': skuOf(d),
          'Div': divisiOfDept(d.department),
          'Nama Barang': productOf(d),
          'Nama Pengambil': pengambilOf(d),
          'Distribusi Karyawan': d.karyawan_name || '-',
          'Total Qty Diambil': d.qty,
          'Satuan': uomOf(d) || '-',
          'Harga': price == null ? '-' : price,
        };
      });
    }

    // Variant 1 dari catatan tangan: No, SKU, Div, Barang, Distribusi
    // Karyawan (nama+qty digabung 1 sel), Total Qty, Ket.
    return groupBySkuDivisi(filtered).map(function (g) {
      return {
        'SKU': g.sku,
        'Div': g.div,
        'Nama Barang': g.product,
        'Distribusi Karyawan': g.entries.map(function (e) { return e.name + ' (' + e.qty + (g.uom ? ' ' + g.uom : '') + ')'; }).join(', '),
        'Total Qty': g.qty,
        'Satuan': g.uom || '-',
        'Ket': g.keterangan.length ? g.keterangan.join('; ') : '-',
      };
    });
  }

  function currentFilteredRows() {
    if (state.source === 'wh-out') {
      // Ranking Karyawan & Ranking per Divisi nggak nampilin filter umum di
      // layarnya (lihat renderWhOut) — export-nya ikutin itu, jangan diam-diam
      // kefilter sama state filter yang nyangkut dari tab lain.
      if (state.view === 'karyawan' || state.view === 'rankingDivisi') return window.SPB.dbDistribusi.listAll();
      return window.SPB.dbDistribusi.listAll().then(applyFiltersOut);
    }
    return window.SPB.db.list().then(applyFiltersIn);
  }

  function filterSummaryText() {
    const bits = [];
    if (state.dateFrom) bits.push('dari ' + state.dateFrom);
    if (state.dateTo) bits.push('sampai ' + state.dateTo);
    if (state.source === 'wh-in' && state.vendor) bits.push('vendor ' + state.vendor);
    if (state.source === 'wh-out' && state.karyawan) bits.push('karyawan ' + state.karyawan);
    if (state.source === 'wh-out' && state.divisi) bits.push('divisi ' + state.divisi);
    if (state.source === 'wh-out' && state.distStatus) bits.push('status ' + state.distStatus);
    return bits.length ? bits.join(', ') : 'semua data';
  }

  function exportExcel() {
    if (!window.XLSX) {
      window.SPB.ui.toast('Gagal export', 'Library Excel belum termuat, coba refresh halaman.', 'error');
      return;
    }
    currentFilteredRows().then(function (rows) {
      if (!rows.length) {
        window.SPB.ui.toast('Tidak ada data', 'Tidak ada data sesuai filter untuk diekspor.', 'error');
        return;
      }
      const data = state.source === 'wh-out' && state.view === 'analisis' ? reportRowsForExportAnalisis(rows)
        : state.source === 'wh-out' && state.view === 'rankingDivisi' ? reportRowsForExportRankingDivisi(rows)
        : state.source === 'wh-out' && state.view === 'karyawan' ? reportRowsForExportKaryawan(rows)
        : state.view === 'ringkas'
          ? (state.source === 'wh-out' ? reportRowsForExportRingkasOut(rows) : reportRowsForExportRingkasIn(rows))
          : (state.source === 'wh-out' ? reportRowsForExportOut(rows) : reportRowsForExportIn(rows));
      const ws = window.XLSX.utils.json_to_sheet(data);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Laporan');
      const fname = 'Laporan-SPB-' + (state.source === 'wh-out' ? 'WHOUT-' : 'WHIN-') + new Date().toISOString().slice(0, 10) + '.xlsx';
      window.XLSX.writeFile(wb, fname);
      window.SPB.ui.toast('Excel terunduh', fname, 'success');
    });
  }

  function exportPdf() {
    const JsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDFCtor) {
      window.SPB.ui.toast('Gagal export', 'Library PDF belum termuat, coba refresh halaman.', 'error');
      return;
    }
    currentFilteredRows().then(function (rows) {
      if (!rows.length) {
        window.SPB.ui.toast('Tidak ada data', 'Tidak ada data sesuai filter untuk diekspor.', 'error');
        return;
      }
      const doc = new JsPDFCtor({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const company = (window.SPB_CONFIG && window.SPB_CONFIG.COMPANY) || {};
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const BRAND = [13, 148, 136];       // brand-600
      const BRAND_DARK = [15, 118, 110];  // brand-700 — buat aksen garis bawah header
      const HEADER_H = 78;

      // ---- Kop laporan — SEMUA teks di dalam band teal ini pakai warna putih/
      // hampir-putih, supaya kontrasnya cukup (sebelumnya "Dicetak/Filter/
      // Tampilan" pakai abu-abu gelap di atas teal — nyaris tidak kebaca). ----
      doc.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
      doc.rect(0, 0, pageW, HEADER_H, 'F');
      doc.setFillColor(BRAND_DARK[0], BRAND_DARK[1], BRAND_DARK[2]);
      doc.rect(0, HEADER_H - 3, pageW, 3, 'F'); // aksen garis bawah header, sedikit lebih gelap

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18); doc.setFont(undefined, 'bold');
      doc.text(company.name || 'Laporan SPB', 40, 32);
      doc.setFontSize(9.5); doc.setFont(undefined, 'normal');
      doc.setTextColor(224, 251, 247); // brand-50-ish, tetap kontras tapi beda dari judul
      doc.text((company.department || 'Gudang Sparepart') + (company.address ? ' · ' + company.address : ''), 40, 48);
      doc.setFont(undefined, 'bold'); doc.setFontSize(10.5);
      doc.setTextColor(255, 255, 255);
      doc.text(state.source === 'wh-out' ? 'LAPORAN DISTRIBUSI ATK' : 'LAPORAN PENERIMAAN BARANG', 40, 65);

      doc.setFont(undefined, 'normal'); doc.setFontSize(8.5);
      doc.setTextColor(224, 251, 247);
      doc.text('Dicetak: ' + new Date().toLocaleString('id-ID'), pageW - 40, 26, { align: 'right' });
      doc.text('Filter: ' + filterSummaryText(), pageW - 40, 40, { align: 'right' });
      doc.setFont(undefined, 'bold'); doc.setFontSize(9.5);
      doc.setTextColor(255, 255, 255);
      doc.text('Tampilan: ' + viewLabelForPdf(rows), pageW - 40, 56, { align: 'right' });

      let startY = HEADER_H + 20;
      let head, body, foot = null;

      if (state.source === 'wh-out') {
        if (state.view === 'analisis') {
          head = [['Karyawan', 'Jumlah Pengambilan', 'Total Qty', 'Selisih dari Rata-rata', 'Status']];
          body = reportRowsForExportAnalisis(rows).map(function (r) {
            return [r['Karyawan'], r['Jumlah Pengambilan'] + 'x', r['Total Qty'], r['Selisih dari Rata-rata'], r['Status']];
          });
        } else if (state.view === 'rankingDivisi') {
          if (state.rankMode === 'detail') {
            head = [['#', 'SKU', 'Div', 'Nama Barang', 'Nama Pengambil', 'Distribusi Karyawan', 'Total Qty Diambil', 'Satuan', 'Harga']];
            body = reportRowsForExportRankingDivisi(rows).map(function (r, i) {
              return [i + 1, r['SKU'], r['Div'], r['Nama Barang'], r['Nama Pengambil'], r['Distribusi Karyawan'], r['Total Qty Diambil'], r['Satuan'], r['Harga'] === '-' ? '-' : fmtRupiah(r['Harga'])];
            });
          } else {
            head = [['#', 'SKU', 'Div', 'Barang', 'Distribusi Karyawan', 'Total Qty', 'Ket']];
            body = reportRowsForExportRankingDivisi(rows).map(function (r, i) {
              return [i + 1, r['SKU'], r['Div'], r['Nama Barang'], r['Distribusi Karyawan'], r['Total Qty'] + ' ' + r['Satuan'], r['Ket']];
            });
          }
        } else if (state.view === 'karyawan') {
          head = [['#', 'Karyawan', 'Departemen', 'Jumlah Distribusi', 'Total Qty', 'Porsi', 'Status']];
          body = reportRowsForExportKaryawan(rows).map(function (r, i) {
            return [i + 1, r['Karyawan'], r['Departemen'], r['Jumlah Distribusi'], r['Total Qty'], r['Porsi'], r['Status']];
          });
        } else if (state.view === 'periode') {
          const summary = periodeSummary(rows, state.granularity);
          head = [['Periode', 'Total Distribusi', 'Total Qty Keluar', 'Karyawan Unik', 'Peminta Terbanyak']];
          body = summary.map(function (p) { return [p.label, p.count, p.qty, p.karyawanUnik, p.topRequesters || '-']; });
        } else if (state.view === 'ringkas') {
          head = [['Tanggal', 'Barang', 'Diambil Oleh', 'Harga']];
          body = reportRowsForExportRingkasOut(rows).map(function (r) {
            return [r['Tanggal'], r['Barang'], r['Diambil Oleh'], r['Harga'] === '-' ? '-' : fmtRupiah(r['Harga'])];
          });
        } else {
          // Per barang (bukan per penerima) — "Diambil Oleh" itu orang yang
          // ambil barangnya di gudang/Odoo, "Petugas" yang memproses WH/OUT-
          // nya di SPB, kolom "Distribusi Karyawan" isinya rincian dibagi ke
          // siapa aja & berapa (digabung 1 sel, sesuai permintaan user).
          const groups = groupByDetail(rows);
          head = [['Tanggal', 'Barang', 'SKU', 'WH/OUT', 'Diambil Oleh', 'Petugas', 'Distribusi Karyawan', 'Total Qty']];
          body = groups.map(function (g) {
            const dist = g.entries.map(function (e) {
              return e.karyawan_name + ' (' + e.qty + (g.uom ? ' ' + g.uom : '') + ')';
            }).join('\n');
            return [fmtDate(g.tanggal), g.product, g.sku, g.whOutRef, g.pengambil, g.petugas, dist || '-', g.totalQty + ' ' + (g.uom || '')];
          });
          // Baris total di paling bawah — gabungan Total Qty seluruh barang
          // yang keluar sesuai filter (satuan dicampur mentah, sama pola
          // dengan stat "Total Qty Keluar" yang udah ada di layar).
          const grandTotalQty = groups.reduce(function (a, g) { return a + Number(g.totalQty); }, 0);
          // colSpan biar labelnya 1 sel gede ngerangkum 7 kolom pertama —
          // bukan banyak sel kosong kosong berjejer kayak sebelumnya.
          foot = [[{ content: 'TOTAL QTY KELUAR', colSpan: 7, styles: { halign: 'center' } }, grandTotalQty]];
        }
      } else if (state.view === 'vendor' || state.view === 'status') {
        const agg = aggregateBy(rows, state.view === 'vendor'
          ? function (r) { return r.vendor_name || '-'; }
          : categoryOf, itemQtyIn);
        const total = agg.reduce(function (a, x) { return a + x.count; }, 0);
        head = [['#', state.view === 'vendor' ? 'Vendor' : 'Status', 'Jumlah Data', 'Total Qty', 'Porsi']];
        body = agg.map(function (a, i) {
          const share = total ? Math.round((a.count / total) * 100) : 0;
          return [i + 1, a.key, a.count, a.qty, share + '%'];
        });
      } else if (state.view === 'ringkas') {
        head = [['Tanggal', 'Produk', 'Petugas Penerima Barang', 'Harga']];
        body = reportRowsForExportRingkasIn(rows).map(function (r) {
          return [r['Tanggal'], r['Produk'], r['Petugas Penerima Barang'], r['Harga'] === '-' ? '-' : fmtRupiah(r['Harga'])];
        });
      } else {
        head = [['No PO', 'WH/IN', 'Vendor', 'Tanggal', 'Status', 'Petugas', 'Barang', 'Qty']];
        body = reportRowsForExportIn(rows).map(function (r) {
          return [r['No PO'], r['WH/IN'], r['Vendor'], r['Tanggal'], r['Status'], r['Petugas'], r['Barang'], r['Qty']];
        });
      }

      // Kolom "Status" (Ranking Karyawan) — tiap Baru/Hilang/Tukar/Habis dikasih
      // warna & bold sendiri (bukan teks polos), sama palet sama badge di layar.
      // autotable nggak dukung multi-warna dalam 1 sel bawaan, jadi teks default
      // di cell ini di-tutup ulang (fill background + border-nya digambar ulang)
      // terus digambar manual per potongan status pakai warna masing-masing.
      const STATUS_PDF_COLOR = { Baru: [5, 150, 105], Hilang: [220, 38, 38], Tukar: [217, 119, 6], Habis: [100, 116, 139] };
      const isKaryawanStatusCol = function (data) {
        return state.source === 'wh-out' && state.view === 'karyawan' && data.section === 'body' && data.column.index === 6;
      };

      doc.autoTable({
        head: head, body: body, foot: foot || undefined, startY: startY,
        theme: 'grid',
        headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold', fontSize: 9.5, cellPadding: 8 },
        footStyles: { fillColor: [15, 118, 110], textColor: 255, fontStyle: 'bold', fontSize: 9.5, cellPadding: 8 }, // brand-700 — beda dari header tapi tetap senada
        alternateRowStyles: { fillColor: [246, 253, 252] }, // brand-50 pudar
        bodyStyles: { textColor: [51, 65, 85] }, // slate-700 — pasti kontras di baris putih/pudar
        styles: { fontSize: 9, cellPadding: 7, lineColor: [226, 232, 240], lineWidth: 0.5 },
        margin: { left: 40, right: 40, bottom: 50 },
        didDrawCell: function (data) {
          if (!isKaryawanStatusCol(data)) return;
          const raw = data.cell.text.join(' ');
          if (!raw || raw === '-') return;

          // Tutup ulang teks polos yang udah kegambar default (fill + border
          // lagi, biar rapi nyambung sama grid tabel di sekitarnya).
          const bg = data.row.index % 2 === 1 ? [246, 253, 252] : [255, 255, 255];
          doc.setFillColor(bg[0], bg[1], bg[2]);
          doc.setDrawColor(226, 232, 240);
          doc.setLineWidth(0.5);
          doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, 'FD');

          const parts = raw.split(', ');
          let x = data.cell.x + data.cell.padding('left');
          const y = data.cell.y + data.cell.height / 2 + 3;
          doc.setFontSize(8.5);
          parts.forEach(function (p) {
            const name = p.split(':')[0];
            const c = STATUS_PDF_COLOR[name] || [51, 65, 85];
            doc.setFont(undefined, 'bold');
            doc.setTextColor(c[0], c[1], c[2]);
            doc.text(p, x, y);
            x += doc.getTextWidth(p) + 8;
          });
          doc.setFont(undefined, 'normal');
          doc.setTextColor(51, 65, 85);
          doc.setFontSize(9);
        },
        // Footer tiap halaman: garis aksen tipis + nomor halaman kanan bawah,
        // supaya laporan berhalaman-halaman tetap kelihatan rapi & profesional.
        didDrawPage: function () {
          doc.setDrawColor(BRAND[0], BRAND[1], BRAND[2]);
          doc.setLineWidth(1.5);
          doc.line(40, pageH - 34, pageW - 40, pageH - 34);
          doc.setFont(undefined, 'normal'); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
          doc.text('Dibuat otomatis oleh Sistem Penerimaan Barang (SPB)', 40, pageH - 20);
          doc.text('Halaman ' + doc.internal.getCurrentPageInfo().pageNumber + ' dari {total_pages}', pageW - 40, pageH - 20, { align: 'right' });
        },
      });
      if (typeof doc.putTotalPages === 'function') doc.putTotalPages('{total_pages}');

      const finalY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || startY;
      doc.setFont(undefined, 'bold'); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139);
      // body.length (BUKAN rows.length) — rows itu jumlah SEBELUM difilter
      // divisi/sub divisi/pos (kalau lagi di tab Ranking per Divisi), jadi
      // kalau dipakai malah nggak nyambung sama jumlah baris yang beneran
      // muncul di tabelnya.
      doc.text(body.length + ' baris data total', 40, finalY + 22);

      const fname = 'Laporan-SPB-' + (state.source === 'wh-out' ? 'WHOUT-' : 'WHIN-') + new Date().toISOString().slice(0, 10) + '.pdf';
      doc.save(fname);
      window.SPB.ui.toast('PDF terunduh', fname, 'success');
    });
  }

  function viewLabelForPdf(rows) {
    if (state.source === 'wh-out') {
      if (state.view === 'karyawan') return 'Ranking Karyawan';
      if (state.view === 'periode') return 'Ringkasan Periode (' + (state.granularity === 'month' ? 'Bulanan' : 'Mingguan') + ')';
      if (state.view === 'ringkas') return 'Laporan Ringkas';
      if (state.view === 'analisis') return 'Analisis Barang (' + state.analisisSku + ')';
      if (state.view === 'rankingDivisi') {
        // Sama pola dengan rankingScopeLabel() di layar — DIAMBIL DARI DATA
        // hasil filter, bukan cuma dari state yang eksplisit dipilih.
        let filtered = rows || [];
        if (state.rankDivisi) filtered = filtered.filter(function (d) { return divisiOfDept(d.department) === state.rankDivisi; });
        if (state.rankSubDivisi) filtered = filtered.filter(function (d) { return subDivisiOfDept(d.department) === state.rankSubDivisi; });
        if (state.rankPos) filtered = filtered.filter(function (d) { return posOfDept(d.department) === state.rankPos; });
        const scope = rankingScopeLabel(filtered);
        return 'Ranking Barang per Divisi — ' + scope + ' (' + (state.rankMode === 'detail' ? 'Detail per Karyawan' : 'Ringkasan per Barang') + ')';
      }
      return 'Semua Distribusi';
    }
    if (state.view === 'ringkas') return 'Laporan Ringkas';
    return state.view === 'vendor' ? 'Ranking Vendor' : state.view === 'status' ? 'Ranking Status' : 'Semua Data';
  }

  window.SPB = window.SPB || {};
  window.SPB.laporan = {
    render: render,
    prefetch: prefetch,
    setSource: setSource,
    goToPage: goToPage,
    setView: setView,
    setGranularity: setGranularity,
    setAnalisisSku: setAnalisisSku,
    setRankDivisi: setRankDivisi,
    setRankSubDivisi: setRankSubDivisi,
    setRankPos: setRankPos,
    setRankMode: setRankMode,
    setTrendGranularity: setTrendGranularity,
    setTrendSplitLevel: setTrendSplitLevel,
    toggleTrendSeries: toggleTrendSeries,
    setFilter: setFilter,
    setKaryawanSearch: setKaryawanSearch,
    setPeriodPreset: setPeriodPreset,
    resetFilters: resetFilters,
    openDetailModal: openDetailModal,
    closeDetailModal: closeDetailModal,
    updateDistStatus: updateDistStatus,
    updateDistKeterangan: updateDistKeterangan,
    openInDetailModal: openInDetailModal,
    closeInDetailModal: closeInDetailModal,
    exportExcel: exportExcel,
    exportPdf: exportPdf,
  };
})();
