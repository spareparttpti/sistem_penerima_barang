/* =========================================================
   SPB · config.js
   Konfigurasi global — isi dengan kredensial asli pada produksi.
   demoMode=true → memakai simulasi localStorage (tanpa backend).
   ========================================================= */

window.SPB_CONFIG = {
  // Supabase — project khusus "Penerimaan Barang" (terpisah dari spare_part)
  SUPABASE_URL: 'https://wktmnpaftmklgigewnqv.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrdG1ucGFmdG1rbGdpZ2V3bnF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMDMxMDQsImV4cCI6MjEwMjY3OTEwNH0.6-LJLwIyNt5fM7iRLNVIa4eOkYPWCFCYl9dMQjW6eHo',

  // Teamly Webhook (Edge Function / endpoint penerima notifikasi)
  TEAMLY_WEBHOOK_URL: 'https://YOUR-TEAMLY-WEBHOOK-URL',

  // true → data disimpan di localStorage (demo tanpa backend)
  // false → memakai Supabase client asli
  demoMode: false,

  // Kunci penyimpanan demo
  STORE_KEY: 'spb_penerimaan_vanilla_v1',

  // Identitas perusahaan — dicetak di kop Surat Jalan
  COMPANY: {
    name: 'PT. TRIPUTRA TEXTILE INDUSTRY',
    address: 'Bandung, Indonesia',
    phone: '',
    department: 'Gudang Sparepart',
  },

  // Nomor WA petugas gudang — dipakai di portal Permintaan Barang (pesan.js)
  // buat karyawan yang nggak nemu/nggak tahu nama barangnya, bisa langsung
  // hubungi petugas. Format bebas ('08...' atau '+62...'), non-digit
  // dibuang otomatis pas dibikin link wa.me. Kosongkan kalau belum ada.
  GUDANG_WA_NUMBER: '',
};
