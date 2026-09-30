/* =========================================================
   SPB · dashboard.js
   View Dashboard: stat cards (hari ini / approved / rejected),
   search + filter status, tabel log penerimaan, tombol Detail & QC.
   ========================================================= */

(function () {
  'use strict';

  const PAGE_SIZE = 15;
  let currentPage = 1;

  function isToday(iso) {
    const d = new Date(iso);
    const n = new Date();
    return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
  }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtDate(v) {
    if (!v) return '-';
    const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /* Transfer yang di Odoo sudah "Done" (selesai/divalidasi di sana) tapi belum
     pernah diproses lewat app ini (status internal masih Draft). Bukan lagi
     "menunggu kedatangan" yang sebenarnya — badge & aksinya dibedakan supaya
     petugas tidak diminta konfirmasi kedatangan untuk sesuatu yang sudah kelar
     duluan di Odoo. */
  function isOdooClosed(r) {
    return r.status === 'Draft' && r.odoo_state === 'Done';
  }

  function odooClosedBadge() {
    return '<span class="badge badge-odoo-done"><span class="badge-dot"></span>Selesai di Odoo</span>';
  }

  // Sama seperti isOdooClosed(), tapi untuk WH/IN yang dibatalkan di Odoo
  // sebelum sempat diproses lewat app ini. Odoo tidak pernah ditulisi balik
  // (integrasi read-only) — status "Cancelled" cuma ditampilkan di sini.
  function isOdooCancelled(r) {
    return r.status === 'Draft' && r.odoo_state === 'Cancelled';
  }

  function odooCancelledBadge() {
    return '<span class="badge badge-odoo-cancel"><span class="badge-dot"></span>Dibatalkan di Odoo</span>';
  }

  /* Kolom tanggal punya dua arti tergantung tahap:
     - Draft (dari Odoo, barang belum datang) → tanggal PEMESANAN
     - sudah datang                           → tanggal KEDATANGAN
     Keduanya diberi label agar tidak tertukar. */
  function dateCell(r) {
    if (r.status === 'Draft') {
      return '<p style="font-weight:500;color:var(--slate-600)">' + fmtDate(r.order_date) + '</p>' +
             '<p class="date-tag pesan">tgl pemesanan</p>';
    }
    return '<p style="font-weight:500;color:var(--slate-600)">' +
             fmtDateTime(r.arrival_date || r.created_at) + '</p>' +
           '<p class="date-tag datang">tgl barang datang</p>';
  }

  /* Nilai tanggal yang SAMA dengan yang tampil di dateCell() — dipakai juga
     untuk mengurutkan, supaya urutan tabel selalu selaras dengan yang terlihat
     (bukan diam-diam diurutkan oleh field lain yang tidak tampak). */
  function displayedDateValue(r) {
    const raw = r.status === 'Draft' ? r.order_date : (r.arrival_date || r.created_at);
    const t = raw ? new Date(raw).getTime() : NaN;
    return isNaN(t) ? 0 : t;
  }

  // Cuma hari-nya (tanpa jam) dari displayedDateValue() — order_date dari Odoo
  // sering cuma tanggal tanpa jam (dianggap 00:00), sementara arrival_date
  // punya jam beneran. Dibandingkan mentah-mentah, Draft yang baru dibuat SIANG
  // ini bisa kalah kepental ke bawah dari yang sudah Approved PAGI ini juga —
  // padahal Draft-nya lebih baru. Membandingkan cuma tanggalnya dulu, baru
  // created_at sebagai tiebreak, memperbaiki itu tanpa kehilangan urutan
  // tanggal secara umum.
  function displayedDayValue(r) {
    const t = displayedDateValue(r);
    if (!t) return 0;
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function createdAtValue(r) {
    const t = r.created_at ? new Date(r.created_at).getTime() : NaN;
    return isNaN(t) ? 0 : t;
  }

  /* Angka di ekor "WH/IN/00694" → 694. Dipakai sebagai penentu urutan kedua
     saat dua baris punya tanggal tampil yang sama persis — nomor WH/IN Odoo
     naik urut sesuai kapan transfer itu dibuat di sana, jadi lebih mewakili
     "mana yang lebih baru" dibanding urutan impor (yang sering bertumpuk di
     satu waktu yang sama kalau diimpor sekaligus). Bukan WH/IN → 0.
     */
  function whInSeq(r) {
    const m = /(\d+)\s*$/.exec(r.wh_in_ref || '');
    return m ? parseInt(m[1], 10) : 0;
  }

  /* Urutan tabel: favorit dulu, lalu tanggal tampil terbaru, lalu nomor WH/IN
     terbesar (dianggap paling baru dibuat di Odoo). Draft baru dari Odoo
     (order_date = hari ini/nanti) dan yang baru saja di-Approve (arrival_date
     hari ini) sama-sama otomatis naik ke atas lewat tanggal ini — tidak perlu
     kunci terpisah berbasis updated_at, yang rawan kacau kalau odoo-pull
     menyentuh banyak baris sekaligus (lihat catatan di set_updated_at()). */
  function compareRows(a, b) {
    const favA = a.is_favorite ? 1 : 0, favB = b.is_favorite ? 1 : 0;
    if (favA !== favB) return favB - favA;
    const dayDiff = displayedDayValue(b) - displayedDayValue(a);
    if (dayDiff !== 0) return dayDiff;
    const createdDiff = createdAtValue(b) - createdAtValue(a);
    if (createdDiff !== 0) return createdDiff;
    return whInSeq(b) - whInSeq(a);
  }

  /* Kontrol paginasi: Sebelumnya/Selanjutnya + nomor halaman. Untuk daftar
     panjang (bisa 200+ baris langsung dari Odoo), nomor ditampilkan dipotong
     di sekitar halaman aktif saja (bukan semua nomor sekaligus) supaya baris
     kontrolnya sendiri tidak ikut kepanjangan. */
  function paginationHtml(page, totalPages, totalRows) {
    if (totalRows === 0) return '';
    if (totalPages <= 1) {
      return '<div class="pagination"><span class="pagination-info">' + totalRows + ' data</span></div>';
    }

    const pages = [];
    const add = function (p) { if (pages.indexOf(p) === -1) pages.push(p); };
    add(1); add(totalPages);
    for (let p = page - 1; p <= page + 1; p++) if (p >= 1 && p <= totalPages) add(p);
    pages.sort(function (a, b) { return a - b; });

    let numbersHtml = '';
    let prev = 0;
    pages.forEach(function (p) {
      if (p - prev > 1) numbersHtml += '<span class="pagination-ellipsis">…</span>';
      numbersHtml += '<button type="button" class="pagination-num' + (p === page ? ' active' : '') +
        '" onclick="SPB.dashboard.goToPage(' + p + ')">' + p + '</button>';
      prev = p;
    });

    return '<div class="pagination">' +
      '<span class="pagination-info">' + totalRows + ' data · halaman ' + page + ' dari ' + totalPages + '</span>' +
      '<div class="pagination-controls">' +
        '<button type="button" class="pagination-arrow" ' + (page <= 1 ? 'disabled' : '') +
          ' onclick="SPB.dashboard.goToPage(' + (page - 1) + ')" aria-label="Halaman sebelumnya">' +
          '<i data-lucide="chevron-left" class="icon-sm"></i></button>' +
        numbersHtml +
        '<button type="button" class="pagination-arrow" ' + (page >= totalPages ? 'disabled' : '') +
          ' onclick="SPB.dashboard.goToPage(' + (page + 1) + ')" aria-label="Halaman berikutnya">' +
          '<i data-lucide="chevron-right" class="icon-sm"></i></button>' +
      '</div>' +
    '</div>';
  }

  function goToPage(page) {
    currentPage = page;
    render();
  }

  /* =========================================================
     Grafik (SVG/HTML manual, tanpa library — konsisten dengan arsitektur
     vanilla proyek ini). Dua grafik:
       1. Status Pengadaan  — horizontal bar, warna dipinjam dari badge status
          yang SUDAH dipakai di seluruh aplikasi (emerald/amber/slate), supaya
          "hijau" di grafik berarti sama dengan "hijau" di badge tabel.
       2. Top Vendor        — horizontal bar peringkat, satu hue (brand teal)
          karena ini perbandingan MAGNITUDE (jumlah pesanan), bukan identitas
          yang perlu dibedakan warna per vendor.
     ========================================================= */

  function statusFunnelHtml(rows) {
    // "On the way" dari Odoo tidak punya makna transit sungguhan (Odoo tidak
    // melacak perjalanan barang) — yang tersedia hanya state siap-transfer.
    // odoo_state 'Ready' dipakai sebagai proksi "sedang diproses/dikirim vendor".
    // Selesai di Odoo (odoo_state Done, tapi belum pernah diproses lewat app
    // ini) dipisah dari "menunggu vendor" — itu bukan lagi barang yang benar-
    // benar tertunda, cuma belum ditutup manual di app.
    const selesaiOdoo = rows.filter(isOdooClosed).length;
    const dibatalkanOdoo = rows.filter(isOdooCancelled).length;
    const belumDiproses = rows.filter(function (r) {
      return r.status === 'Draft' && !isOdooClosed(r) && !isOdooCancelled(r) && r.odoo_state !== 'Ready';
    }).length;
    const onTheWay = rows.filter(function (r) {
      return r.status === 'Draft' && !isOdooClosed(r) && !isOdooCancelled(r) && r.odoo_state === 'Ready';
    }).length;
    const sudahDatang = rows.filter(function (r) { return r.status !== 'Draft'; }).length;

    // filterValue dipetakan ke nilai yang sama dipahami oleh filter status di
    // tabel (lihat render() & dropdown #filter-status) — supaya klik batang
    // grafik ini benar-benar filter data yang sama, bukan kategori terpisah.
    const items = [
      { label: 'Sudah Datang', value: sudahDatang, color: 'var(--emerald-500)', icon: 'package-check', filterValue: 'SudahDatang' },
      { label: 'On The Way', value: onTheWay, color: 'var(--amber-500)', icon: 'truck', filterValue: 'OdooReady' },
      { label: 'Menunggu Vendor', value: belumDiproses, color: 'var(--slate-400)', icon: 'clock', filterValue: 'OdooWaiting' },
      { label: 'Selesai di Odoo', value: selesaiOdoo, color: 'var(--indigo-600)', icon: 'check-check', filterValue: 'OdooDone' },
      { label: 'Dibatalkan di Odoo', value: dibatalkanOdoo, color: 'var(--red-500)', icon: 'x-circle', filterValue: 'OdooCancelled' },
    ];
    const max = Math.max(1, sudahDatang, onTheWay, belumDiproses, selesaiOdoo, dibatalkanOdoo);
    const total = sudahDatang + onTheWay + belumDiproses + selesaiOdoo + dibatalkanOdoo;

    if (!total) {
      return chartCard('truck', 'Status Pengadaan Barang',
        '<div class="empty-state" style="padding:2rem 0">Belum ada data penerimaan.</div>');
    }

    const bars = items.map(function (it) {
      const pct = Math.round((it.value / max) * 100);
      const share = total ? Math.round((it.value / total) * 100) : 0;
      return '<button type="button" class="hbar-row hbar-row-clickable" ' +
        'onclick="SPB.dashboard.filterFromChart(\'' + it.filterValue + '\')" ' +
        'title="Klik untuk filter tabel ke ' + it.label + '">' +
        '<div class="hbar-label"><i data-lucide="' + it.icon + '" class="icon-sm"></i>' + it.label + '</div>' +
        '<div class="hbar-track" title="' + it.label + ': ' + it.value + ' (' + share + '%)">' +
          '<div class="hbar-fill" style="width:' + pct + '%;background:' + it.color + '"></div>' +
        '</div>' +
        '<div class="hbar-value">' + it.value + '</div>' +
      '</button>';
    }).join('');

    return chartCard('truck', 'Status Pengadaan Barang',
      '<div class="hbar-chart">' + bars + '</div>' +
      '<p class="chart-foot">' + total + ' total penerimaan aktif · diperbarui realtime</p>');
  }

  function vendorRankingHtml(rows) {
    const counts = {};
    rows.forEach(function (r) {
      const name = (r.vendor_name || '-').trim() || '-';
      counts[name] = (counts[name] || 0) + 1;
    });
    const sorted = Object.keys(counts)
      .map(function (name) { return { name: name, value: counts[name] }; })
      .sort(function (a, b) { return b.value - a.value; });

    if (!sorted.length) {
      return chartCard('bar-chart-3', 'Vendor Terbanyak',
        '<div class="empty-state" style="padding:2rem 0">Belum ada data penerimaan.</div>');
    }

    const TOP_N = 6;
    const top = sorted.slice(0, TOP_N);
    const restTotal = sorted.slice(TOP_N).reduce(function (a, x) { return a + x.value; }, 0);
    if (restTotal > 0) top.push({ name: 'Vendor lainnya', value: restTotal, other: true });

    const max = Math.max.apply(null, top.map(function (x) { return x.value; }));

    const bars = top.map(function (it) {
      const pct = Math.round((it.value / max) * 100);
      // "Vendor lainnya" itu gabungan banyak vendor sekaligus — nggak ada satu
      // nama yang bisa dicari lewat kotak pencarian, jadi baris ini sengaja
      // TIDAK diklik (beda dari baris vendor asli lainnya).
      const tag = it.other ? 'div' : 'button';
      const clickAttrs = it.other ? '' :
        ' type="button" onclick="SPB.dashboard.filterFromChartVendor(\'' + esc(it.name) + '\')"' +
        ' title="Klik untuk filter tabel ke vendor ' + esc(it.name) + '"';
      return '<' + tag + ' class="hbar-row' + (it.other ? '' : ' hbar-row-clickable') + '"' + clickAttrs + '>' +
        '<div class="hbar-label hbar-label-vendor" title="' + esc(it.name) + '">' + esc(it.name) + '</div>' +
        '<div class="hbar-track" title="' + esc(it.name) + ': ' + it.value + ' pesanan">' +
          '<div class="hbar-fill" style="width:' + pct + '%;background:' +
            (it.other ? 'var(--slate-300)' : 'var(--brand-500)') + '"></div>' +
        '</div>' +
        '<div class="hbar-value">' + it.value + '</div>' +
      '</' + tag + '>';
    }).join('');

    return chartCard('bar-chart-3', 'Vendor Terbanyak',
      '<div class="hbar-chart">' + bars + '</div>' +
      '<p class="chart-foot">Diurutkan dari jumlah penerimaan terbanyak' +
        (restTotal > 0 ? ' · ' + (sorted.length - TOP_N) + ' vendor lain digabung' : '') + '</p>');
  }

  /* Penjelasan singkat tiap kategori status yang muncul di tabel — kategori
     yang sama persis dengan grafik Status Pengadaan Barang (statusFunnelHtml())
     supaya istilahnya konsisten di seluruh Dashboard, bukan cuma warna doang. */
  function statusLegendHtml() {
    const items = [
      { badge: '<span class="badge badge-approved"><span class="badge-dot"></span>Sudah Datang</span>',
        text: 'Barang sudah dikonfirmasi tiba lewat aplikasi ini (In Inspection / Approved / Rejected).' },
      { badge: '<span class="badge badge-draft"><span class="badge-dot"></span>On The Way</span>',
        text: 'Masih Draft di sini, tapi di Odoo sudah berstatus "Ready" (stok sudah dialokasikan) — perkiraan sedang diproses/dikirim vendor.' },
      { badge: '<span class="badge badge-draft"><span class="badge-dot"></span>Menunggu Vendor</span>',
        text: 'Masih Draft di sini DAN di Odoo belum "Ready" — belum ada tanda-tanda dikonfirmasi vendor.' },
      { badge: '<span class="badge badge-odoo-done"><span class="badge-dot"></span>Selesai di Odoo</span>',
        text: 'Sudah berstatus "Done" di Odoo, tapi belum pernah ditandai datang lewat aplikasi ini — tidak perlu konfirmasi kedatangan manual lagi.' },
      { badge: '<span class="badge badge-odoo-cancel"><span class="badge-dot"></span>Dibatalkan di Odoo</span>',
        text: 'Dibatalkan di Odoo sebelum sempat ditandai datang lewat aplikasi ini.' },
    ];
    return '<div class="status-legend">' +
      items.map(function (it) {
        return '<div class="status-legend-item">' + it.badge +
          '<span class="status-legend-text">' + it.text + '</span></div>';
      }).join('') +
    '</div>';
  }

  function chartCard(icon, title, bodyHtml) {
    return '<div class="chart-card">' +
      '<p class="chart-title"><i data-lucide="' + icon + '" class="icon-md"></i>' + title + '</p>' +
      bodyHtml +
    '</div>';
  }

  function statCard(icon, iconClass, label, value, sub) {
    return '<div class="stat-card">' +
      '<div><p class="stat-label">' + label + '</p>' +
      '<p class="stat-value">' + value + '</p>' +
      (sub ? '<p class="stat-sub">' + sub + '</p>' : '') + '</div>' +
      '<div class="stat-icon ' + iconClass + '"><i data-lucide="' + icon + '" class="icon-md"></i></div>' +
    '</div>';
  }

  function render() {
    const app = document.getElementById('app');
    const state = window.SPB.state;
    const db = window.SPB.db;
    const filters = state.filters;

    db.list().then(function (rows) {
      // Barang yang BENAR-BENAR diterima hari ini (bukan Draft, arrival_date
      // hari ini) — bukan created_at, karena created_at ikut kepakai untuk
      // baris Draft baru yang barusan ke-pull dari Odoo (belum tentu barangnya
      // sudah datang secara fisik).
      const todayCount = rows.filter(function (r) {
        return r.status !== 'Draft' && isToday(r.arrival_date || r.created_at);
      }).length;
      const approvedCount = rows.filter(function (r) { return r.status === 'Approved'; }).length;
      const rejectedCount = rows.filter(function (r) { return r.status === 'Rejected'; }).length;
      // Yang sudah Done di Odoo bukan lagi benar-benar "menunggu kedatangan" —
      // dikeluarkan dari hitungan ini supaya angkanya tidak menyesatkan.
      const waitingCount = rows.filter(function (r) { return r.status === 'Draft' && !isOdooClosed(r) && !isOdooCancelled(r); }).length;

      let filtered = rows.slice();
      if (filters.q) {
        const q = filters.q.toLowerCase();
        filtered = filtered.filter(function (r) {
          return (r.po_number || '').toLowerCase().indexOf(q) !== -1 ||
                 (r.vendor_name || '').toLowerCase().indexOf(q) !== -1 ||
                 (r.receiver_name || '').toLowerCase().indexOf(q) !== -1;
        });
      }
      // Beberapa pilihan filter status merujuk ke state Odoo (odoo_state) atau
      // gabungan beberapa status internal — makanya dicek terpisah dari
      // r.status biasa. Nilai-nilai ini juga yang dipakai tombol grafik
      // Status Pengadaan Barang (lihat statusFunnelHtml() & filterFromChart()),
      // jadi harus PERSIS sama dengan cara kategori itu dihitung di sana.
      if (filters.status === 'OdooReady') {
        filtered = filtered.filter(function (r) {
          return r.status === 'Draft' && !isOdooClosed(r) && !isOdooCancelled(r) && r.odoo_state === 'Ready';
        });
      } else if (filters.status === 'OdooWaiting') {
        filtered = filtered.filter(function (r) {
          return r.status === 'Draft' && !isOdooClosed(r) && !isOdooCancelled(r) && r.odoo_state !== 'Ready';
        });
      } else if (filters.status === 'OdooDone') {
        filtered = filtered.filter(isOdooClosed);
      } else if (filters.status === 'OdooCancelled') {
        filtered = filtered.filter(isOdooCancelled);
      } else if (filters.status === 'SudahDatang') {
        filtered = filtered.filter(function (r) { return r.status !== 'Draft'; });
      } else if (filters.status) {
        filtered = filtered.filter(function (r) { return r.status === filters.status; });
      }
      if (filters.date) {
        filtered = filtered.filter(function (r) {
          // Bandingkan ke tanggal yang SAMA persis dengan yang tampil di kolom
          // Tanggal (dateCell) untuk baris ini, bukan field tanggal yang beda-beda.
          const raw = r.status === 'Draft' ? r.order_date : (r.arrival_date || r.created_at);
          if (!raw) return false;
          const ymd = String(raw).length <= 10 ? String(raw) : new Date(raw).toISOString().slice(0, 10);
          return ymd === filters.date;
        });
      }

      // Favorit dulu, lalu tanggal tampil terbaru, lalu nomor WH/IN — lihat
      // compareRows(). Urutan tabel jadi konsisten dengan bintang & tanggal
      // yang KELIHATAN, bukan diam-diam pakai field tersembunyi.
      filtered = filtered.slice().sort(compareRows);

      // Paginasi — daftar bisa ratusan baris (langsung dari Odoo), jadi
      // dipotong per halaman supaya tidak jadi satu scroll raksasa.
      const totalRows = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
      if (currentPage > totalPages) currentPage = totalPages;
      if (currentPage < 1) currentPage = 1;
      const pageStart = (currentPage - 1) * PAGE_SIZE;
      const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

      // Bintang favorit: tombol terpisah di dalam baris/kartu yang bisa diklik,
      // jadi harus stopPropagation supaya tidak ikut membuka detail.
      function starBtn(r) {
        const fav = !!r.is_favorite;
        return '<button type="button" class="star-btn ' + (fav ? 'is-fav' : '') + '" ' +
          'onclick="event.preventDefault();event.stopPropagation();SPB.dashboard.toggleFavorite(\'' + r.id + '\',' + (!fav) + ')" ' +
          'aria-label="' + (fav ? 'Lepas dari favorit' : 'Tandai favorit/urgent') + '" ' +
          'title="' + (fav ? 'Lepas dari favorit' : 'Tandai favorit/urgent') + '">' +
          '<i data-lucide="star" class="icon-sm"></i></button>';
      }

      // Seluruh baris bisa diklik — termasuk antrean dari Odoo, yang dibuka
      // untuk menandai "barang sudah datang"
      const tableRows = pageRows.map(function (r) {
        const itemsCount = r.items ? r.items.length : 0;
        const draft = r.status === 'Draft';
        const closed = isOdooClosed(r);
        const cancelled = isOdooCancelled(r);
        const inactive = closed || cancelled;
        const totalQty = r.items ? r.items.reduce(function (a, it) {
          return a + (draft ? (it.qty_po || 0) : (it.qty_received || 0));
        }, 0) : 0;

        return '<tr class="row-click' + (r.is_favorite ? ' row-fav' : '') + '" onclick="location.hash=\'#/penerimaan/' + r.id + '\'">' +
          '<td class="col-star">' + starBtn(r) + '</td>' +
          '<td><p class="font-bold" style="color:var(--slate-800)">#' + esc(r.po_number) + '</p>' +
          '<p style="font-size:0.75rem;color:var(--slate-400)">' +
            (r.wh_in_ref ? esc(r.wh_in_ref) + ' · ' : '') +
            itemsCount + ' item · ' + totalQty + (draft ? ' qty PO' : ' pcs') + '</p></td>' +
          '<td><p style="font-weight:500;color:var(--slate-700)">' + esc(r.vendor_name) + '</p>' +
          '<p style="font-size:0.75rem;color:var(--slate-400)">' +
            (cancelled ? 'dibatalkan di Odoo' : closed ? 'selesai di Odoo, bukan lewat app ini' : draft ? 'menunggu kedatangan' : 'oleh ' + esc(r.receiver_name)) + '</p></td>' +
          '<td style="font-size:0.875rem">' + dateCell(r) + '</td>' +
          '<td>' + (cancelled ? odooCancelledBadge() : closed ? odooClosedBadge() : window.SPB.ui.statusBadge(r.status)) + '</td>' +
          '<td class="text-right">' + (inactive
            ? '<a href="#/penerimaan/' + r.id + '" class="btn btn-outline btn-sm">' +
              '<i data-lucide="eye" class="icon-sm"></i>Lihat</a>'
            : '<a href="#/penerimaan/' + r.id + '" class="btn ' + (draft ? 'btn-primary' : 'btn-dark') + ' btn-sm">' +
              '<i data-lucide="' + (draft ? 'package-check' : 'search-check') + '" class="icon-sm"></i>' +
              (draft ? 'Barang Datang' : 'Detail &amp; QC') + '</a>') + '</td>' +
        '</tr>';
      }).join('');

      const mobileCards = pageRows.map(function (r) {
        const draft = r.status === 'Draft';
        const closed = isOdooClosed(r);
        const cancelled = isOdooCancelled(r);
        const inactive = closed || cancelled;
        return '<a href="#/penerimaan/' + r.id + '" class="mobile-card' + (r.is_favorite ? ' row-fav' : '') + '">' +
          '<div class="mobile-card-top"><div style="display:flex;align-items:center;gap:0.375rem">' +
          starBtn(r) +
          '<span><p class="mobile-card-po">#' + esc(r.po_number) + '</p>' +
          '<p class="mobile-card-vendor">' + esc(r.vendor_name) + '</p></span></div>' +
          (cancelled ? odooCancelledBadge() : closed ? odooClosedBadge() : window.SPB.ui.statusBadge(r.status)) + '</div>' +
          '<div class="mobile-card-bottom">' +
          '<span style="display:inline-flex;align-items:center;gap:0.25rem"><i data-lucide="calendar" class="icon-sm"></i>' +
            (draft ? 'Pesan ' + fmtDate(r.order_date) : 'Datang ' + fmtDateTime(r.arrival_date || r.created_at)) + '</span>' +
          '<span class="mobile-card-link"><i data-lucide="' + (inactive ? 'eye' : 'arrow-right') + '" class="icon-sm"></i>' +
            (inactive ? 'Lihat' : draft ? 'Barang Datang' : 'Detail &amp; QC') + '</span>' +
          '</div></a>';
      }).join('') || '<div class="empty-state">Tidak ada data sesuai filter.</div>';

      // Sengaja ditaruh di area paling bawah (bukan di atas tabel) — legend
      // di sini menggantikan catatan "Integrasi aktif" lama, bukan menumpuk
      // di atasnya.
      const demoNote = db.isDemo()
        ? '<p><b style="color:var(--slate-700)">Mode demo:</b> data disimpan di <code>localStorage</code>. Ganti <code>demoMode</code> ke <code>false</code> di <code>js/config.js</code> dan isi kredensial untuk memakai Supabase Realtime (<code>penerimaan_barang</code>).</p>' + statusLegendHtml()
        : statusLegendHtml();

      app.innerHTML = window.SPB.ui.layout('dashboard',
        '<div class="page-head">' +
          '<div><h1 class="page-title">Dashboard Penerimaan</h1>' +
          '<p class="page-sub">Pantau log penerimaan sparepart secara realtime.</p></div>' +
          '<div class="page-head-actions">' +
            '<button type="button" class="btn btn-outline" ' +
              'onclick="document.getElementById(\'odoo-file\').click()">' +
              '<i data-lucide="download-cloud" class="icon-sm"></i>Import Odoo</button>' +
            '<input type="file" id="odoo-file" class="hidden" ' +
              'accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ' +
              'onchange="SPB.dashboard.odooImport(this.files[0]); this.value=\'\'">' +
            '<a href="#/input-barang" class="btn btn-primary"><i data-lucide="plus" class="icon-sm"></i>Input Barang Baru</a>' +
          '</div>' +
        '</div>' +
        '<div class="grid-stats">' +
          statCard('truck', 'amber', 'Menunggu Kedatangan', waitingCount, 'dari Odoo') +
          statCard('package-check', 'emerald', 'Penerimaan Hari Ini', todayCount, 'transaksi masuk') +
          statCard('badge-check', 'sky', 'Barang Approved', approvedCount, 'diterima penuh') +
          statCard('badge-x', 'red', 'Barang Rejected', rejectedCount, 'perlu tindak lanjut') +
        '</div>' +
        '<div class="grid-charts">' +
          statusFunnelHtml(rows) +
          vendorRankingHtml(rows) +
        '</div>' +
        '<div class="table-card" id="table-card">' +
          '<div class="table-head">' +
            '<h2 class="table-title"><i data-lucide="list-filter" class="icon-md"></i>Log Penerimaan Realtime</h2>' +
            '<div class="table-tools">' +
              '<div class="search-box"><i data-lucide="search" class="icon-sm"></i>' +
              '<input id="filter-q" class="search-input" placeholder="Cari PO / vendor / petugas..." value="' + esc(filters.q) + '" oninput="SPB.dashboard.applyFilter(\'q\', this.value)"></div>' +
              '<select id="filter-status" class="select-input" onchange="SPB.dashboard.applyFilter(\'status\', this.value)">' +
                '<option value="">Semua Status</option>' +
                '<option value="SudahDatang"' + (filters.status === 'SudahDatang' ? ' selected' : '') + '>Sudah Datang</option>' +
                '<option value="Draft"' + (filters.status === 'Draft' ? ' selected' : '') + '>Menunggu Kedatangan (semua)</option>' +
                '<option value="OdooReady"' + (filters.status === 'OdooReady' ? ' selected' : '') + '>On The Way (Ready di Odoo)</option>' +
                '<option value="OdooWaiting"' + (filters.status === 'OdooWaiting' ? ' selected' : '') + '>Menunggu Vendor</option>' +
                '<option value="OdooDone"' + (filters.status === 'OdooDone' ? ' selected' : '') + '>Selesai di Odoo</option>' +
                '<option value="OdooCancelled"' + (filters.status === 'OdooCancelled' ? ' selected' : '') + '>Dibatalkan di Odoo</option>' +
                '<option value="In Inspection"' + (filters.status === 'In Inspection' ? ' selected' : '') + '>In Inspection</option>' +
                '<option value="Approved"' + (filters.status === 'Approved' ? ' selected' : '') + '>Approved</option>' +
                '<option value="Rejected"' + (filters.status === 'Rejected' ? ' selected' : '') + '>Rejected</option>' +
              '</select>' +
              // Cocok dengan tanggal yang TAMPIL di kolom Tanggal — order_date
              // untuk Draft, arrival_date/created_at untuk sisanya (lihat dateCell()) —
              // supaya filter selalu selaras dengan apa yang terlihat, bukan field tersembunyi.
              '<div class="date-filter-box">' +
                '<i data-lucide="calendar" class="icon-sm"></i>' +
                '<input type="date" id="filter-date" class="date-filter-input" value="' + esc(filters.date || '') +
                '" onchange="SPB.dashboard.applyFilter(\'date\', this.value)">' +
                (filters.date
                  ? '<button type="button" class="date-filter-clear" onclick="SPB.dashboard.applyFilter(\'date\', \'\')" aria-label="Hapus filter tanggal" title="Hapus filter tanggal"><i data-lucide="x" class="icon-sm"></i></button>'
                  : '') +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="table-desktop"><div class="table-wrap"><table class="table">' +
            '<thead><tr><th class="col-star"></th><th>No PO</th><th>Vendor</th><th>Tanggal</th><th>Status</th><th class="text-right">Aksi</th></tr></thead>' +
            '<tbody>' + (tableRows || '<tr><td colspan="6" class="empty-state">Tidak ada data.</td></tr>') + '</tbody>' +
          '</table></div></div>' +
          '<div class="mobile-cards">' + mobileCards + '</div>' +
          paginationHtml(currentPage, totalPages, totalRows) +
        '</div>' +
        '<div class="callout"><i data-lucide="info" class="icon-md"></i>' + demoNote + '</div>'
      );
      window.SPB.ui.afterRender();
    });
  }

  function applyFilter(key, value) {
    const state = window.SPB.state;
    state.filters[key] = value;
    currentPage = 1; // filter baru -> mulai lagi dari halaman pertama
    render();
  }

  // Klik batang di grafik Status Pengadaan Barang → filter tabel ke kategori
  // yang sama, lalu scroll ke tabelnya — supaya jelas grafiknya benar-benar
  // "hidup" (bukan cuma dekorasi) dan hasilnya langsung kelihatan.
  function filterFromChart(value) {
    applyFilter('status', value);
    const el = document.getElementById('table-card');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Sama seperti filterFromChart(), tapi buat grafik Vendor Terbanyak — pakai
  // kotak pencarian (filters.q) yang sudah ada, bukan filter status, karena
  // vendor bukan bagian dari daftar status.
  function filterFromChartVendor(vendorName) {
    applyFilter('q', vendorName);
    const el = document.getElementById('table-card');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* Import file Odoo → langsung masuk ke log penerimaan sebagai antrean
     berstatus Draft. Tidak ada penyimpanan sementara terpisah. */
  function odooImport(file) {
    if (!file) return;

    window.SPB.odoo.importFile(file).then(function (parsed) {
      if (!parsed.receipts.length) {
        window.SPB.ui.toast('Tidak ada data terbaca',
          parsed.warnings[0] || 'File tidak berisi baris WH/IN.', 'error');
        return;
      }
      return window.SPB.db.importOdoo(parsed.receipts, window.SPB.spareparts)
        .then(function (res) {
          render();

          const bits = [];
          if (res.added) bits.push(res.added + ' WH/IN baru');
          if (res.updated) bits.push(res.updated + ' diperbarui');
          if (res.locked) bits.push(res.locked + ' dilewati (sudah diproses)');
          if (res.cancelled) bits.push(res.cancelled + ' batal di Odoo');

          window.SPB.ui.toast('Data Odoo masuk ke log',
            (bits.join(', ') || 'Tidak ada perubahan') + '.',
            (res.added || res.updated) ? 'success' : 'info');

          // Tanpa kolom produk, seluruh penerimaan masuk tanpa rincian barang —
          // ini konsekuensi besar, jadi diberi toast sendiri, bukan diselipkan
          const noItems = parsed.receipts.every(function (r) { return !r.lines.length; });
          if (noItems && parsed.receipts.length) {
            window.SPB.ui.toast('Rincian barang tidak ikut terekspor',
              'Export ulang dari Odoo dengan menambahkan kolom "Operations → Product" dan ' +
              '"Operations → Demand". Data yang masih Draft akan terisi otomatis saat diimport ulang.',
              'error');
          } else if (parsed.warnings.length) {
            window.SPB.ui.toast('Catatan import', parsed.warnings[0], 'info');
          }
        });
    }).catch(function (err) {
      window.SPB.ui.toast('Import gagal', err.message, 'error');
    });
  }

  /* Sengaja TUNGGU setFavorite() selesai dulu baru render() — render() akan
     mengambil ulang data dari db.list(), jadi kalau dipanggil sebelum
     penyimpanan selesai, dia balapan dan bisa menampilkan status LAMA
     (kejadian nyata saat pertama ditulis: render duluan, baca data belum
     ter-update). Lebih aman benar sekali daripada "optimistic" tapi salah. */
  async function toggleFavorite(id, value) {
    try {
      await window.SPB.db.setFavorite(id, value);
    } catch (err) {
      window.SPB.ui.toast('Gagal menyimpan favorit', err.message, 'error');
    }
    render();
  }

  window.SPB = window.SPB || {};
  window.SPB.dashboard = {
    render: render,
    applyFilter: applyFilter,
    filterFromChart: filterFromChart,
    filterFromChartVendor: filterFromChartVendor,
    odooImport: odooImport,
    toggleFavorite: toggleFavorite,
    goToPage: goToPage,
  };
})();
