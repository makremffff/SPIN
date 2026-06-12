/* ══════════════════════════════════════════════════════
   api.js — Unified API gateway
   Usage: fetchApi({ type: 'actionName', data: { ... } })
══════════════════════════════════════════════════════ */

async function fetchApi({ type, data = {} }) {
  try {
    const res = await fetch('/api', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        data,
        initData: window.Telegram?.WebApp?.initData || ''
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[fetchApi] ${type} failed:`, err);
    return { ok: false, error: err.message };
  }
}
