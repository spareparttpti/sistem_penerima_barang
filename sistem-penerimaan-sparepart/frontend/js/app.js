/* =========================================================
   SPB · app.js
   Entry point:
   - state global (filters, form, spareparts)
   - hash router (#/, #/input-barang, #/penerimaan/:id)
   - layout (header + nav + main + footer)
   - toast notifications
   - init lucide icons
   ========================================================= */

(function () {
  'use strict';

  // Global error capture (debug)
  window.addEventListener('error', function (e) {
    window.SPB = window.SPB || {};
    window.SPB.__pageError = (e.message || '') + ' @ ' + (e.filename || '').split('/').pop() + ':' + (e.lineno || 0);
  });

  /* ---------- Global state ---------- */
  const state = {
    filters: { q: '', status: '', date: '' },
    form: null,
  };

  window.SPB = window.SPB || {};
  window.SPB.state = state;
  window.SPB.currentDetailId = null;

  /* ---------- Utils ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Global helper — dipakai view modules (dashboard.js, inputBarang.js, detailQc.js)
  window.esc = esc;

  function statusBadge(status) {
    const cls = status === 'Approved' ? 'badge-approved'
      : status === 'Rejected' ? 'badge-rejected'
      : status === 'In Inspection' || status === 'Menunggu Stok' ? 'badge-inspection'
      : 'badge-draft';
    return '<span class="badge ' + cls + '"><span class="badge-dot"></span>' + esc(status) + '</span>';
  }

  /* ---------- Toast ---------- */
  function toast(title, msg, type) {
    const container = document.getElementById('toasts');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML =
      '<span class="toast-icon"><i data-lucide="' + (type === 'success' ? 'check-circle-2' : type === 'error' ? 'alert-circle' : 'info') + '" class="icon-md"></i></span>' +
      '<div class="toast-body"><p class="toast-title">' + esc(title) + '</p>' +
      (msg ? '<p class="toast-msg">' + esc(msg) + '</p>' : '') + '</div>' +
      '<button class="toast-close" onclick="this.parentElement.remove()" aria-label="Tutup"><i data-lucide="x" class="icon-sm"></i></button>';
    container.appendChild(el);
    refreshIcons(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 300);
    }, 4500);
  }

  /* ---------- Layout: Sidebar ---------- */
  function sidebarItem(href, icon, label, isActive) {
    return '<a href="#' + href + '" class="sidebar-item ' + (isActive ? 'active' : '') + '" onclick="SPB.closeSidebarMobile()">' +
      '<i data-lucide="' + icon + '" class="icon-sm"></i><span>' + label + '</span></a>';
  }

  function userLabel() {
    if (window.SPB.auth && !window.SPB.auth.isDemo()) {
      return window.SPB.auth.currentUsername() || 'Tim Gudang';
    }
    return 'Tim Gudang';
  }

  async function logout() {
    await window.SPB.auth.signOut();
    if (window.SPB.login && window.SPB.login.resetState) window.SPB.login.resetState();
    location.hash = '#/login';
    render();
  }
  window.SPB.logout = logout;

  // Sidebar terbuka/tertutup diingat lewat localStorage (khusus desktop —
  // supaya preferensi user bertahan lintas kunjungan). Di mobile dipakai
  // sebagai overlay yang selalu mulai tertutup, tidak dari localStorage.
  const SIDEBAR_KEY = 'spb_sidebar_open';
  function isSidebarOpenDesktop() {
    // Preferensi localStorage cuma berlaku di layar desktop — kalau dibaca
    // apa adanya di HP, sidebar bisa nongol nutupin layar begitu halaman
    // dibuka tanpa disentuh sama sekali (rembesan preferensi dari sesi
    // desktop sebelumnya).
    if (window.innerWidth <= 900) return false;
    const v = localStorage.getItem(SIDEBAR_KEY);
    return v === null ? true : v === '1';
  }
  function toggleSidebar() {
    const shell = document.getElementById('app-shell');
    if (!shell) return;
    const nowOpen = !shell.classList.contains('sidebar-open');
    shell.classList.toggle('sidebar-open', nowOpen);
    if (window.innerWidth > 900) localStorage.setItem(SIDEBAR_KEY, nowOpen ? '1' : '0');
  }
  function closeSidebarMobile() {
    if (window.innerWidth > 900) return; // di desktop, klik menu tidak menutup sidebar
    const shell = document.getElementById('app-shell');
    if (shell) shell.classList.remove('sidebar-open');
  }
  window.SPB.toggleSidebar = toggleSidebar;
  window.SPB.closeSidebarMobile = closeSidebarMobile;

  function sidebarGroup(title, itemsHtml) {
    if (!itemsHtml) return '';
    return '<div class="sidebar-group">' +
      (title ? '<p class="sidebar-group-title">' + title + '</p>' : '') +
      itemsHtml +
    '</div>';
  }

  function layout(active, inner) {
    const isAdmin = window.SPB.auth && !window.SPB.auth.isDemo() && window.SPB.auth.isAdmin();
    const sidebarHtml =
      '<aside class="sidebar">' +
        '<div class="sidebar-brand">' +
          '<span class="brand-logo"><i data-lucide="package" class="icon-md"></i></span>' +
          '<span><span class="brand-name">SPB · Sparepart</span><br><span class="brand-sub">Sistem Penerimaan Barang</span></span>' +
        '</div>' +
        '<nav class="sidebar-nav">' +
          sidebarGroup('', '' +
            sidebarItem('/overview', 'layout-dashboard', 'Dashboard', active === 'overview')
          ) +
          sidebarGroup('WH/IN', '' +
            sidebarItem('/', 'layout-grid', 'Log Penerimaan', active === 'dashboard') +
            sidebarItem('/input-barang', 'clipboard-plus', 'Input Barang', active === 'input') +
            (isAdmin ? sidebarItem('/pengguna', 'users', 'Pengguna', active === 'users') : '')
          ) +
          sidebarGroup('WH/OUT', '' +
            sidebarItem('/wh-out', 'layout-grid', 'Log Pengeluaran', active === 'wh-out') +
            sidebarItem('/stok-barang', 'boxes', 'Stok Barang', active === 'stok-barang') +
            (isAdmin ? sidebarItem('/karyawan', 'contact', 'Karyawan', active === 'karyawan') : '')
          ) +
          sidebarGroup('PERMINTAAN BARANG', '' +
            sidebarItem('/permintaan', 'shopping-cart', 'Antrean & Riwayat', active === 'permintaan')
          ) +
          sidebarGroup('', '' +
            sidebarItem('/laporan', 'file-bar-chart', 'Laporan', active === 'laporan')
          ) +
        '</nav>' +
      '</aside>';

    return '' +
      '<div class="app-shell' + (isSidebarOpenDesktop() ? ' sidebar-open' : '') + '" id="app-shell">' +
        sidebarHtml +
        '<div class="app-content">' +
          '<header class="header">' +
            '<div class="header-inner">' +
              '<button type="button" class="icon-btn hamburger-btn" onclick="SPB.toggleSidebar()" aria-label="Buka/tutup menu">' +
                '<i data-lucide="menu" class="icon-md"></i></button>' +
              '<div class="header-actions">' +
                '<div class="user-chip">' +
                  '<span class="user-avatar"><i data-lucide="user" class="icon-sm"></i></span>' +
                  '<span class="user-name">' + esc(userLabel()) + '</span>' +
                '</div>' +
                (window.SPB.auth && !window.SPB.auth.isDemo()
                  ? '<button type="button" class="icon-btn" onclick="SPB.logout()" aria-label="Keluar" title="Keluar">' +
                    '<i data-lucide="log-out" class="icon-sm"></i></button>'
                  : '') +
              '</div>' +
            '</div>' +
          '</header>' +
          '<main class="main">' + inner + '</main>' +
          '<footer class="page-footer">SPB By Triputra Programmer</footer>' +
        '</div>' +
        '<div class="sidebar-backdrop" onclick="SPB.closeSidebarMobile()"></div>' +
      '</div>';
  }

  /* ---------- Router ---------- */
  function parseHash() {
    const h = (location.hash || '#/').replace(/^#/, '');
    const parts = h.split('/').filter(Boolean);
    if (!parts.length) return { route: '/', params: {} };
    if (parts[0] === 'login') return { route: '/login', params: {} };
    if (parts[0] === 'pengguna') return { route: '/pengguna', params: {} };
    if (parts[0] === 'penerimaan' && parts[1]) return { route: '/penerimaan/:id', params: { id: parts[1] } };
    if (parts[0] === 'input-barang') return { route: '/input-barang', params: {} };
    if (parts[0] === 'wh-out' && parts[1]) return { route: '/wh-out/:id', params: { id: parts[1] } };
    if (parts[0] === 'wh-out') return { route: '/wh-out', params: {} };
    if (parts[0] === 'overview') return { route: '/overview', params: {} };
    if (parts[0] === 'stok-barang') return { route: '/stok-barang', params: {} };
    if (parts[0] === 'karyawan') return { route: '/karyawan', params: {} };
    if (parts[0] === 'laporan') return { route: '/laporan', params: {} };
    if (parts[0] === 'permintaan') return { route: '/permintaan', params: {} };
    if (parts[0] === 'pesan' && parts[1]) return { route: '/pesan/:divisi', params: { divisi: decodeURIComponent(parts[1]) } };
    if (parts[0] === 'pesan') return { route: '/pesan', params: {} };
    if (parts[0] === 'tiket' && parts[1]) return { route: '/tiket/:id', params: { id: parts[1] } };
    return { route: '/', params: {} };
  }

  /* ---------- Icons ---------- */
  function refreshIcons(root) {
    if (window.lucide && window.lucide.createIcons) {
      try {
        window.lucide.createIcons({ root: root || document });
      } catch (e) { /* ignore */ }
    }
  }

  let iconPollStarted = false;
  function scheduleIconRefresh() {
    if (iconPollStarted) return;
    iconPollStarted = true;
    (function poll() {
      if (window.lucide && window.lucide.createIcons) {
        refreshIcons(document);
      } else {
        setTimeout(poll, 200);
      }
    })();
  }

  function afterRender() {
    refreshIcons(document.getElementById('app'));
    refreshIcons(document.getElementById('toasts'));
    scheduleIconRefresh();
  }

  // Re-render icon setelah semua asset (termasuk lucide) selesai dimuat
  window.addEventListener('load', function () {
    refreshIcons(document);
  });

  /* ---------- Boot ---------- */
  let ready = false;
  const pending = [];

  window.SPB.__ready = false;

  function whenReady(fn) {
    if (ready) { fn(); return; }
    pending.push(fn);
  }

  function render() {
    const { route, params } = parseHash();
    const run = function () {
      const auth = window.SPB.auth;

      // Portal Permintaan Barang (karyawan pesan barang) & tiket antreannya —
      // SENGAJA TANPA LOGIN sama sekali, jadi dicek PALING DULUAN, sebelum
      // nunggu status auth ke-resolve ataupun gerbang login di bawah. Rute
      // ini publik, siapa aja yang punya link-nya bisa buka.
      const isPesanRoute = (route === '/pesan' || route === '/pesan/:divisi' || route === '/tiket/:id');
      // Toast-nya digeser ke tengah layar khusus di portal ini (lihat CSS
      // body.pesan-mode .toast-container) — karyawannya awam teknologi,
      // notif di pojok kanan-atas gampang kelewat/ketutup address bar.
      document.body.classList.toggle('pesan-mode', isPesanRoute);
      if (isPesanRoute) {
        if (route === '/tiket/:id') { window.SPB.pesan.renderTiket(params.id); }
        else { window.SPB.pesan.render(params.divisi || ''); }
        return;
      }

      // Auth belum selesai dicek (baru terjadi sesaat di awal load) — tampilkan
      // status memuat, JANGAN render dashboard/data dulu sebelum tahu status login,
      // supaya tidak ada kedipan data sebelum diarahkan ke halaman login.
      if (auth && !auth.isDemo() && !auth.__ready) {
        document.getElementById('app').innerHTML =
          '<div class="loading-state"><i data-lucide="loader-2" class="icon-md spin" style="display:inline-block"></i> Memuat...</div>';
        return;
      }

      const authed = !auth || auth.isAuthed();
      if (!authed) {
        if (route !== '/login') { location.hash = '#/login'; return; }
        window.SPB.login.render();
        return;
      }
      // Habis login, langsung ke Dashboard Ringkasan (gabungan WH/IN+WH/OUT
      // sekilas pandang) — BUKAN ke Log Penerimaan (WH/IN) yang tadinya jadi
      // halaman utama default.
      if (route === '/login') { location.hash = '#/overview'; return; }

      if (route === '/penerimaan/:id') {
        window.SPB.currentDetailId = params.id;
        window.SPB.detailQc.render(params.id);
      } else if (route === '/input-barang') {
        window.SPB.inputBarang.render();
      } else if (route === '/pengguna') {
        // Menu disembunyikan untuk non-admin, tapi orang tetap bisa coba ketik
        // URL-nya manual — cegah juga di sini. Penjaga SUNGGUHAN tetap di SQL
        // (list_user_accounts menolak sendiri kalau bukan admin).
        if (!auth || auth.isDemo() || !auth.isAdmin()) { location.hash = '#/'; return; }
        window.SPB.users.render();
      } else if (route === '/wh-out/:id') {
        window.SPB.whOutDetail.render(params.id);
      } else if (route === '/wh-out') {
        window.SPB.whOut.render();
      } else if (route === '/overview') {
        window.SPB.overview.render();
      } else if (route === '/stok-barang') {
        window.SPB.stokBarang.render();
      } else if (route === '/karyawan') {
        if (!auth || auth.isDemo() || !auth.isAdmin()) { location.hash = '#/'; return; }
        window.SPB.karyawan.render();
      } else if (route === '/laporan') {
        window.SPB.laporan.render();
      } else if (route === '/permintaan') {
        window.SPB.permintaan.render();
      } else {
        window.SPB.dashboard.render();
      }
    };
    whenReady(run);
  }
  window.SPB.app = { render: render };

  window.addEventListener('hashchange', render);

  // Idempotent: jalankan render pertama (aman dipanggil berulang kali)
  function initApp() {
    if (ready) return;
    ready = true;
    window.SPB.__ready = true;
    pending.splice(0).forEach(function (fn) { fn(); });
    try { render(); } catch (e) {
      window.SPB.__bootErr = 'render: ' + e.message;
    }
  }

  // 1) Render pertama: tunggu DOM siap (bukan bergantung pada Promise async)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
  window.addEventListener('load', initApp);
  setTimeout(initApp, 800);

  // 2) Boot async: cek sesi login dulu (kalau bukan demoMode) — HARUS tahu
  //    status login sebelum render pertama (supaya tidak ada kedipan data
  //    sebelum diarahkan ke halaman login). Spareparts (dipakai Input Barang
  //    & Detail QC doang, BUKAN Dashboard yang justru halaman pertama yang
  //    kebuka) SENGAJA TIDAK ditunggu di sini lagi — dulu app nge-blank
  //    "Memuat..." sampai SEMUA spareparts kelar ditarik, padahal halaman
  //    pertama yang kebuka nggak butuh itu sama sekali. Sekarang app langsung
  //    render begitu status login diketahui; spareparts nyusul di belakang
  //    layar, dan halaman yang benar-benar butuh dia tinggal render ulang
  //    sendiri kalau kebetulan dibuka SEBELUM spareparts kelar (jarang -
  //    biasanya sudah datang duluan sebelum user sempat klik Input Barang).
  async function boot() {
    if (window.SPB.auth) await window.SPB.auth.init();
    window.SPB.spareparts = window.SPB.spareparts || [];

    if (window.SPB.auth) window.SPB.auth.onChange(render);
    initApp();
    render(); // status login sudah pasti sekarang — render ulang dengan data lengkap

    const shouldLoadData = !window.SPB.auth || window.SPB.auth.isAuthed();
    if (shouldLoadData) {
      window.SPB.db.spareparts().then(function (rows) {
        window.SPB.spareparts = rows;
        // Kalau user kebetulan lagi di halaman yang butuh spareparts (Input
        // Barang/Detail QC) pas ini baru kelar, render ulang biar datanya
        // muncul — halaman lain nggak kepengaruh sama sekali.
        const r = parseHash().route;
        if (r === '/input-barang' || r === '/penerimaan/:id') render();
      }).catch(function (e) {
        window.SPB.__bootErr = 'spareparts: ' + e.message;
      });
      schedulePrefetches();
    } else {
      window.SPB.spareparts = [];
    }
  }

  // Diam-diam narik data buat halaman yang paling sering ditengok TAPI belum
  // tentu dibuka pertama (Stok Barang, Karyawan, Laporan) — begitu boot
  // selesai, BUKAN nunggu user klik menunya. Dikasih jeda dikit (setTimeout)
  // biar nggak rebutan sama render pertama; tiap page tahu sendiri (lewat
  // flag "everLoaded"-nya masing2) buat skip kalau ternyata usernya sudah
  // duluan buka halaman itu manual sebelum prefetch ini sempat jalan.
  function schedulePrefetches() {
    setTimeout(function () {
      if (window.SPB.stokBarang && window.SPB.stokBarang.prefetch) window.SPB.stokBarang.prefetch();
      if (window.SPB.laporan && window.SPB.laporan.prefetch) window.SPB.laporan.prefetch();
      const auth = window.SPB.auth;
      const isAdmin = auth && !auth.isDemo() && auth.isAdmin();
      if (isAdmin && window.SPB.karyawan && window.SPB.karyawan.prefetch) window.SPB.karyawan.prefetch();
    }, 600);
  }

  // Auto-logout kalau nggak ada aktivitas (klik/ketik/scroll/gerak mouse)
  // selama 10 menit — dianggap "lupa logout"/ditinggal, jadi diamankan
  // sendiri balik ke halaman login. Waktu aktivitas terakhir disimpan di
  // localStorage (bukan cuma variabel di memori) supaya kecatat juga kalau
  // tab-nya ditutup terus dibuka lagi setelah lama — begitu dibuka lagi
  // langsung ketauan udah lewat 10 menit apa belum, tanpa perlu nunggu event
  // apa pun terjadi dulu.
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  const IDLE_KEY = 'spb_last_activity';
  let lastActivityWriteAt = 0;
  function markActivity() {
    try { localStorage.setItem(IDLE_KEY, String(Date.now())); } catch (e) { /* private mode dsb — biarin, fallback nggak ada auto-logout */ }
  }
  function onActivity() {
    const now = Date.now();
    if (now - lastActivityWriteAt < 5000) return; // throttle — nggak perlu nulis localStorage tiap gerakan mouse
    lastActivityWriteAt = now;
    markActivity();
  }
  function checkIdleTimeout() {
    const auth = window.SPB.auth;
    if (!auth || auth.isDemo() || !auth.isAuthed()) return; // mode demo/belum login -> nggak ada sesi buat di-timeout
    if (location.hash.replace(/^#/, '') === '/login') return;
    let last = 0;
    try { last = Number(localStorage.getItem(IDLE_KEY)) || 0; } catch (e) { /* ignore */ }
    if (!last) { markActivity(); return; } // belum pernah kecatat -> anggap baru mulai aktif dari sekarang
    if (Date.now() - last > IDLE_TIMEOUT_MS) {
      logout();
      window.SPB.ui.toast('Sesi berakhir', 'Kamu keluar otomatis karena tidak ada aktivitas selama 10 menit.', 'info');
    }
  }
  function setupIdleTimeout() {
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(function (evt) {
      window.addEventListener(evt, onActivity, { passive: true });
    });
    markActivity();
    setInterval(checkIdleTimeout, 15000);
    checkIdleTimeout(); // langsung cek pas load — nutup kemungkinan tab dibuka lagi setelah lama nganggur
  }

  window.addEventListener('unhandledrejection', function (e) {
    window.SPB.__bootErr = 'unhandled: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason));
  });

  window.SPB.ui = {
    esc: esc,
    statusBadge: statusBadge,
    toast: toast,
    layout: layout,
    afterRender: afterRender,
  };

  boot();
  // Auto-logout 10 menit DIMATIKAN SEMENTARA (bukan dihapus) — user lagi mau
  // ganti password lewat Pengaturan, jangan sampai keburu ke-logout sendiri
  // di tengah proses. Nyalain lagi tinggal un-comment baris di bawah ini.
  // setupIdleTimeout();
})();