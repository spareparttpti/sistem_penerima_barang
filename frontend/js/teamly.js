/* =========================================================
   SPB · teamly.js
   Payload generator + notifikasi webhook Teamly.
   ========================================================= */

(function () {
  'use strict';

  const CFG = window.SPB_CONFIG;
  const DEMO = CFG.demoMode;

  const ROLE_TAGS = {
    frontend: { label: 'Frontend Developer', mention: '<@teamly_frontend_id>' },
    backend:  { label: 'Backend Architect',  mention: '<@teamly_backend_id>' },
    devops:   { label: 'DevOps Automator',   mention: '<@teamly_devops_id>' },
    reviewer: { label: 'Code Reviewer',      mention: '<@teamly_code_reviewer>' },
  };

  const TRIGGER_ROLE = {
    ui:      'frontend',
    db:      'backend',
    server:  'devops',
    review:  'reviewer',
  };

  function buildTeamlyPayload(opts) {
    const status = (opts.status || '').toUpperCase();
    const record = opts.record || {};
    const trigger = opts.trigger;
    const triggerReason = opts.triggerReason;

    const lines = [];
    lines.push('🚨 **[ALERTA PENERIMAAN BARANG - STATUS: ' + status + ']**');
    lines.push('');
    lines.push('📌 **No PO:** #' + (record.po_number || '-'));
    lines.push('🏭 **Vendor:** ' + (record.vendor_name || '-'));
    lines.push('📦 **Catatan:** ' + (record.notes || '-'));
    if (trigger && triggerReason) lines.push('🔍 **Trigger:** ' + triggerReason);
    lines.push('');
    lines.push('👉 **Perhatian Tim:**');

    if (status === 'REJECTED' || status === 'IN INSPECTION' || trigger) {
      const add = function (role, msg) {
        if (!lines.some(function (l) { return l.indexOf(ROLE_TAGS[role].mention) !== -1; })) {
          lines.push('- ' + ROLE_TAGS[role].mention + ' ' + msg);
        }
      };
      if (trigger === 'ui' || status === 'IN INSPECTION') {
        add('frontend', 'Cek kelengkapan bukti foto fisik penerimaan.');
      }
      if (trigger === 'db' || status === 'REJECTED') {
        add('backend', 'Mohon verifikasi penyesuaian data stok.');
      }
      if (trigger === 'server') add('devops', 'Pastikan log server & webhook berjalan lancar.');
      if (trigger === 'review') add('reviewer', 'Membutuhkan masukan/verifikasi lanjutan.');
    }

    return {
      text: lines.join('\n'),
      status: opts.status,
      trigger: trigger,
      recordId: record.id || null,
      ts: new Date().toISOString(),
    };
  }

  async function sendTeamlyNotification(payload) {
    const body = JSON.stringify({ text: payload.text });
    if (DEMO) {
      return { ok: true, demo: true, payload: payload };
    }
    const res = await fetch(CFG.TEAMLY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    });
    if (!res.ok) {
      throw new Error('Teamly webhook ' + res.status);
    }
    return res.json();
  }

  window.SPB = window.SPB || {};
  window.SPB.teamly = {
    ROLE_TAGS: ROLE_TAGS,
    TRIGGER_ROLE: TRIGGER_ROLE,
    buildTeamlyPayload: buildTeamlyPayload,
    sendTeamlyNotification: sendTeamlyNotification,
  };
})();
