/* =========================================================
   SPB · rolePermissionsClient.js
   Lapisan data buat user_permissions — matriks PER PENGGUNA (bukan per
   role) x modul x aksi. Lihat database/auth_setup.sql. Dipakai modal Edit
   Permissions di halaman Manajemen Pengguna (users.js), admin-only.
   ========================================================= */

(function () {
  'use strict';

  function sb() { return window.SPB.sb; }
  function throwIfError(error) { if (error) throw new Error(error.message || 'Terjadi kesalahan.'); }

  const dbUserPermissions = {
    listByUsername: async function (username) {
      const { data, error } = await sb().from('user_permissions').select('*').eq('username', username);
      throwIfError(error);
      return data || [];
    },
    // Ganti SELURUH matriks 1 pengguna sekaligus (hapus baris lama, insert
    // baris yang allowed=true saja) — lebih sederhana & aman daripada upsert
    // per-checkbox satu-satu dari UI matriks besar.
    saveMatrix: async function (username, allowedPairs) {
      const admin = (window.SPB.auth && window.SPB.auth.currentUsername && window.SPB.auth.currentUsername()) || null;
      const { error: eDel } = await sb().from('user_permissions').delete().eq('username', username);
      throwIfError(eDel);
      if (!allowedPairs.length) return;
      const rows = allowedPairs.map(function (p) {
        return { username: username, module: p.module, action: p.action, allowed: true, updated_by: admin };
      });
      const { error: eIns } = await sb().from('user_permissions').insert(rows);
      throwIfError(eIns);
    },
  };

  window.SPB = window.SPB || {};
  window.SPB.dbUserPermissions = dbUserPermissions;
})();
