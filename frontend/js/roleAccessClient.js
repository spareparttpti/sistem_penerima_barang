/* =========================================================
   SPB · roleAccessClient.js
   Lapisan data buat role_inventory_access — aturan "role X boleh lihat
   category/SKU apa saja" di stok_barang, dikelola Admin Gudang lewat
   Manajemen Pengguna (users.js), dipakai halaman Inventory role Spinning
   (spinningMaster.js). Lihat database/stok_barang_schema.sql.
   ========================================================= */

(function () {
  'use strict';

  function sb() { return window.SPB.sb; }
  function throwIfError(error) { if (error) throw new Error(error.message || 'Terjadi kesalahan.'); }

  const dbRoleAccess = {
    listByRole: async function (role) {
      const { data, error } = await sb().from('role_inventory_access').select('*').eq('role', role).order('match_type', { ascending: true });
      throwIfError(error);
      return data || [];
    },
    add: async function (role, matchType, matchValue) {
      const username = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      const { data, error } = await sb().from('role_inventory_access').insert({
        role: role, match_type: matchType, match_value: matchValue, created_by: username,
      }).select().single();
      throwIfError(error);
      return data;
    },
    remove: async function (id) {
      const { error } = await sb().from('role_inventory_access').delete().eq('id', id);
      throwIfError(error);
    },
    // Dropdown "Category" di form tambah rule diisi dari category NYATA yang
    // ada di stok_barang, bukan ketik bebas — biar Admin Gudang nggak salah
    // ketik nama category yang nggak pernah cocok sama data.
    listDistinctCategories: async function () {
      const { data, error } = await sb().from('stok_barang').select('odoo_category').not('odoo_category', 'is', null);
      throwIfError(error);
      const set = new Set((data || []).map(function (r) { return r.odoo_category; }).filter(Boolean));
      return Array.from(set).sort();
    },
    // Cocokkan satu baris stok_barang terhadap daftar rule (dari listByRole)
    // — dipakai spinningMaster.js gantiin SPINNING_STOK_CATEGORIES lama.
    matchRules: function (stokRow, rules) {
      const cat = (stokRow.odoo_category || '').toLowerCase();
      const sku = (stokRow.sku || '').toLowerCase();
      return rules.some(function (r) {
        const v = (r.match_value || '').toLowerCase();
        if (r.match_type === 'category') return cat.indexOf(v) !== -1;
        if (r.match_type === 'sku_prefix') return sku.indexOf(v) === 0;
        return false;
      });
    },
  };

  window.SPB = window.SPB || {};
  window.SPB.dbRoleAccess = dbRoleAccess;
})();
