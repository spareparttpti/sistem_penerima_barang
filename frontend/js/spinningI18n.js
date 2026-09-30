/* =========================================================
   SPB · spinningI18n.js
   Language toggle (ID/EN) KHUSUS modul Spinning — GM-nya dari luar
   Indonesia, jadi label utama (sidebar, judul halaman, stat, tabel, tombol)
   perlu bisa dibaca dalam Bahasa Inggris. Toggle disimpan localStorage,
   per-browser (sama pola dengan tema gelap/terang), bukan per-akun.

   CAKUPAN: label-label UTAMA yang paling sering dilihat (nav, judul, stat
   card, tab, header tabel, tombol aksi, status). Teks hint/placeholder
   panjang & pesan toast BELUM diterjemahkan — nyusul kalau memang perlu,
   supaya nggak nunda rilis fitur intinya.
   ========================================================= */

(function () {
  'use strict';

  const DICT = {
    id: {
      nav_dashboard: 'Dashboard', nav_part_mesin: 'Part Mesin', nav_laporan: 'Laporan',
      nav_group_master: 'MASTER DATA', nav_group_transaksi: 'TRANSAKSI', nav_group_laporan: 'LAPORAN',
      nav_permintaan_katalog: 'Permintaan & Katalog', nav_laporan_part_mesin: 'Laporan',
      nav_supplier: 'Supplier', nav_category_part: 'Category Part Mesin', nav_inventory: 'Inventory / Stok Gudang',
      nav_satuan: 'Satuan', nav_karyawan: 'Karyawan', nav_data_mesin: 'Data Mesin',
      nav_po_supplier: 'Purchase Order', nav_pr_gudang: 'PR ke Gudang', nav_pr_supplier: 'Purchase Request', nav_gr_barang: 'Penerimaan Barang', nav_work_order: 'Data Work Order',

      mst_supplier_title: 'Master Supplier', mst_supplier_nama: 'Nama Supplier', mst_supplier_kontak: 'Kontak',
      mst_supplier_telepon: 'Telepon', mst_supplier_alamat: 'Alamat',
      mst_category_title: 'Category Part Mesin (Spare Part per Mesin / Sub Part)',
      mst_inventory_title: 'Inventory / Stok Gudang',
      mst_satuan_title: 'Master Satuan', mst_satuan_nama: 'Nama Satuan',
      mst_karyawan_title: 'Master Karyawan', mst_karyawan_kode: 'Kode', mst_karyawan_nama: 'Nama Karyawan',
      mst_karyawan_lokasi: 'Lokasi', mst_karyawan_jabatan: 'Jabatan', mst_karyawan_alamat: 'Alamat',
      mst_karyawan_telepon: 'Telepon', mst_karyawan_nik: 'NIK', mst_karyawan_mulai: 'Mulai Bekerja',

      trx_po_title: 'Purchase Order ke Supplier', trx_po_sub: 'Permintaan part yang stoknya kosong — diajukan ke supplier, notifikasi otomatis ke Admin Gudang.',
      trx_pr_title: 'Purchase Request ke Gudang', trx_pr_sub: 'Permintaan part yang stoknya tersedia — diambil langsung dari gudang.',
      trx_gr_title: 'Penerimaan Barang', trx_gr_sub: 'Catat kedatangan fisik barang dari PO sebelum diinspeksi & dimasukkan ke stok gudang.',
      trx_wo_title: 'Data Work Order', trx_wo_sub: 'Progres pengerjaan mekanik: ambil part → pasang → selesai (mesin jalan lagi).',
      trx_new: 'Buat Baru', trx_col_supplier: 'Supplier',
      pm_status_masuk_inventory: 'Masuk Inventory',
      pm_next_masuk_inventory: 'Approve Inspeksi & Masuk Inventory',
      pm_filter_wo_open: 'Belum Diambil', pm_filter_wo_progress: 'Sedang Dipasang', pm_filter_wo_done: 'Selesai',

      lap_tab_used: 'Sparepart Used', lap_tab_po_pr: 'Laporan PO & PR', lap_tab_pemakaian: 'Laporan Pemakaian per Mesin',

      dash_title: 'Dashboard Spinning', dash_sub: 'Ringkasan permintaan & repair Part Mesin.',
      dash_stat_pending: 'Permintaan Menunggu ACC', dash_stat_repair: 'Sedang Dikerjakan (Repair)',
      dash_stat_supplier: 'Menunggu Barang dari Supplier', dash_stat_done_month: 'Repair Selesai Bulan Ini',
      dash_stat_mesin: 'Mesin Terdaftar', dash_stat_part: 'Part Terdaftar', dash_activity: 'Aktivitas Terbaru',
      dash_empty: 'Belum ada aktivitas.', dash_of_total: 'dari', dash_total: 'total',

      pm_title: 'Part Mesin', pm_sub: 'Permintaan part untuk repair mesin — ambil dari gudang atau beli ke supplier.',
      pm_tab_antrean: 'Antrean', pm_tab_ajukan: 'Ajukan Permintaan', pm_tab_katalog: 'Katalog Mesin & Part',
      pm_filter_semua: 'Semua', pm_filter_menunggu: 'Menunggu ACC', pm_filter_proses: 'Diproses',
      pm_filter_selesai: 'Selesai', pm_filter_ditolak: 'Ditolak',
      pm_col_no: 'No', pm_col_tanggal: 'Tanggal', pm_col_jenis: 'Jenis', pm_col_mesin: 'No. Mesin',
      pm_col_mekanik: 'Mekanik', pm_col_part: 'Part', pm_col_status: 'Status',
      pm_jenis_gudang: 'Ambil dari Gudang', pm_jenis_supplier: 'Beli ke Supplier',
      pm_empty: 'Tidak ada data.', pm_antrean_title: 'Antrean Permintaan Part Mesin',
      pm_status_menunggu: 'Menunggu ACC', pm_status_disetujui: 'Disetujui', pm_status_ditolak: 'Ditolak',
      pm_status_diambil: 'Sudah Diambil', pm_status_repair_start: 'Repair Berjalan', pm_status_repair_end: 'Repair Selesai',
      pm_status_po_dibuat: 'PO Dibuat', pm_status_barang_datang: 'Barang Datang',
      pm_next_disetujui: 'Setujui', pm_next_diambil: 'Tandai Sudah Diambil', pm_next_repair_start: 'Mulai Repair',
      pm_next_repair_end: 'Selesaikan Repair', pm_next_po_dibuat: 'Tandai PO Dibuat', pm_next_barang_datang: 'Tandai Barang Datang',
      pm_action_tolak: 'Tolak',
      pm_form_title: 'Ajukan Permintaan Part', pm_form_jenis: 'Jenis Permintaan',
      pm_form_jenis_gudang: 'Ambil dari Gudang (stok tersedia)', pm_form_jenis_supplier: 'Beli ke Supplier (stok kosong)',
      pm_form_mesin: 'No. Mesin', pm_form_mekanik: 'Nama Mekanik', pm_form_part: 'Part',
      pm_form_pilih_part: '— Pilih Part —', pm_form_jumlah: 'Jumlah', pm_form_catatan: 'Catatan (opsional)',
      pm_form_submit: 'Ajukan', pm_form_sending: 'Mengirim...',
      pm_viewonly_ajukan: 'Akun kamu diset View Only oleh Admin Gudang — cuma bisa lihat data, tidak bisa mengajukan permintaan baru.',
      pm_viewonly_katalog: 'Akun kamu diset View Only oleh Admin Gudang — cuma bisa lihat katalog, tidak bisa menambah mesin/part.',
      pm_katalog_mesin_title: 'Daftar Mesin', pm_katalog_part_title: 'Daftar Part (dengan hierarki sub-part)',
      pm_col_nama_mesin: 'Nama Mesin', pm_col_keterangan: 'Keterangan', pm_col_category: 'Category',
      pm_col_satuan: 'Satuan', pm_col_stok: 'Stok', pm_tambah: 'Tambah',

      lap_title: 'Laporan Part Mesin', lap_sub: 'Terpisah dari Laporan ATK — riwayat permintaan, PO ke supplier, dan Repair Order.',
      lap_export: 'Export Excel',
    },
    en: {
      nav_dashboard: 'Dashboard', nav_part_mesin: 'Machine Parts', nav_laporan: 'Reports',
      nav_group_master: 'MASTER DATA', nav_group_transaksi: 'TRANSACTIONS', nav_group_laporan: 'REPORTS',
      nav_permintaan_katalog: 'Requests & Catalog', nav_laporan_part_mesin: 'Reports',
      nav_supplier: 'Supplier', nav_category_part: 'Machine Part Category', nav_inventory: 'Inventory / Warehouse Stock',
      nav_satuan: 'Unit', nav_karyawan: 'Employees', nav_data_mesin: 'Machine Data',
      nav_po_supplier: 'Purchase Order', nav_pr_gudang: 'PR to Warehouse', nav_pr_supplier: 'Purchase Request', nav_gr_barang: 'Goods Receipt', nav_work_order: 'Work Order Data',

      mst_supplier_title: 'Supplier Master', mst_supplier_nama: 'Supplier Name', mst_supplier_kontak: 'Contact',
      mst_supplier_telepon: 'Phone', mst_supplier_alamat: 'Address',
      mst_category_title: 'Machine Part Category (Spare Part per Machine / Sub Part)',
      mst_inventory_title: 'Inventory / Warehouse Stock',
      mst_satuan_title: 'Unit Master', mst_satuan_nama: 'Unit Name',
      mst_karyawan_title: 'Employee Master', mst_karyawan_kode: 'Code', mst_karyawan_nama: 'Employee Name',
      mst_karyawan_lokasi: 'Location', mst_karyawan_jabatan: 'Position', mst_karyawan_alamat: 'Address',
      mst_karyawan_telepon: 'Phone', mst_karyawan_nik: 'ID No.', mst_karyawan_mulai: 'Start Date',

      trx_po_title: 'Purchase Order to Supplier', trx_po_sub: 'Requests for out-of-stock parts — sent to a supplier, with an automatic notification to the Warehouse Admin.',
      trx_pr_title: 'Purchase Request to Warehouse', trx_pr_sub: 'Requests for parts already in stock — collected directly from the warehouse.',
      trx_gr_title: 'Goods Receipt', trx_gr_sub: 'Record the physical arrival of goods from a PO before inspection & entry into warehouse stock.',
      trx_wo_title: 'Work Order Data', trx_wo_sub: "Mechanic's progress: collect part → install → done (machine running again).",
      trx_new: 'New', trx_col_supplier: 'Supplier',
      pm_status_masuk_inventory: 'In Inventory',
      pm_next_masuk_inventory: 'Approve Inspection & Add to Inventory',
      pm_filter_wo_open: 'Not Collected', pm_filter_wo_progress: 'Installing', pm_filter_wo_done: 'Done',

      lap_tab_used: 'Sparepart Used', lap_tab_po_pr: 'PO & PR Report', lap_tab_pemakaian: 'Usage Report per Machine',

      dash_title: 'Spinning Dashboard', dash_sub: 'Overview of machine part requests & repairs.',
      dash_stat_pending: 'Requests Awaiting Approval', dash_stat_repair: 'In Progress (Repair)',
      dash_stat_supplier: 'Awaiting Supplier Delivery', dash_stat_done_month: 'Repairs Completed This Month',
      dash_stat_mesin: 'Registered Machines', dash_stat_part: 'Registered Parts', dash_activity: 'Recent Activity',
      dash_empty: 'No activity yet.', dash_of_total: 'of', dash_total: 'total',

      pm_title: 'Machine Parts', pm_sub: 'Part requests for machine repair — from warehouse stock or purchased from a supplier.',
      pm_tab_antrean: 'Queue', pm_tab_ajukan: 'New Request', pm_tab_katalog: 'Machine & Part Catalog',
      pm_filter_semua: 'All', pm_filter_menunggu: 'Awaiting Approval', pm_filter_proses: 'In Progress',
      pm_filter_selesai: 'Completed', pm_filter_ditolak: 'Rejected',
      pm_col_no: 'No', pm_col_tanggal: 'Date', pm_col_jenis: 'Type', pm_col_mesin: 'Machine No.',
      pm_col_mekanik: 'Mechanic', pm_col_part: 'Part', pm_col_status: 'Status',
      pm_jenis_gudang: 'From Warehouse', pm_jenis_supplier: 'Buy from Supplier',
      pm_empty: 'No data.', pm_antrean_title: 'Machine Part Request Queue',
      pm_status_menunggu: 'Awaiting Approval', pm_status_disetujui: 'Approved', pm_status_ditolak: 'Rejected',
      pm_status_diambil: 'Collected', pm_status_repair_start: 'Repair In Progress', pm_status_repair_end: 'Repair Completed',
      pm_status_po_dibuat: 'PO Created', pm_status_barang_datang: 'Goods Arrived',
      pm_next_disetujui: 'Approve', pm_next_diambil: 'Mark as Collected', pm_next_repair_start: 'Start Repair',
      pm_next_repair_end: 'Complete Repair', pm_next_po_dibuat: 'Mark PO Created', pm_next_barang_datang: 'Mark Goods Arrived',
      pm_action_tolak: 'Reject',
      pm_form_title: 'New Part Request', pm_form_jenis: 'Request Type',
      pm_form_jenis_gudang: 'From Warehouse (in stock)', pm_form_jenis_supplier: 'Buy from Supplier (out of stock)',
      pm_form_mesin: 'Machine No.', pm_form_mekanik: 'Mechanic Name', pm_form_part: 'Part',
      pm_form_pilih_part: '— Select Part —', pm_form_jumlah: 'Quantity', pm_form_catatan: 'Notes (optional)',
      pm_form_submit: 'Submit', pm_form_sending: 'Sending...',
      pm_viewonly_ajukan: 'Your account is set to View Only by the Warehouse Admin — you can view data but cannot submit new requests.',
      pm_viewonly_katalog: 'Your account is set to View Only by the Warehouse Admin — you can view the catalog but cannot add machines/parts.',
      pm_katalog_mesin_title: 'Machine List', pm_katalog_part_title: 'Part List (with sub-part hierarchy)',
      pm_col_nama_mesin: 'Machine Name', pm_col_keterangan: 'Notes', pm_col_category: 'Category',
      pm_col_satuan: 'Unit', pm_col_stok: 'Stock', pm_tambah: 'Add',

      lap_title: 'Machine Parts Report', lap_sub: 'Separate from the ATK Report — request history, supplier POs, and Repair Orders.',
      lap_export: 'Export Excel',
    },
  };

  function loadLang() {
    try { return localStorage.getItem('spb-spinning-lang') || 'id'; } catch (e) { return 'id'; }
  }
  let lang = loadLang();

  function t(key) {
    return (DICT[lang] && DICT[lang][key]) || DICT.id[key] || key;
  }
  function getLang() { return lang; }
  function toggleLang() {
    lang = lang === 'en' ? 'id' : 'en';
    try { localStorage.setItem('spb-spinning-lang', lang); } catch (e) { /* private mode dsb */ }
    if (window.SPB.app && window.SPB.app.render) window.SPB.app.render();
  }

  window.SPB = window.SPB || {};
  window.SPB.spinningI18n = { t: t, getLang: getLang, toggle: toggleLang };
})();
