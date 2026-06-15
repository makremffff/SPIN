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
        initData: window.Telegram?.WebApp?.initData || '',
        fp: typeof secFingerprint === 'function' ? secFingerprint() : null
      })
    });

    // 🛡️ ما عاد نرمي على status غير 2xx — السيرفر برجع body مفيد
    // (error, waitSec, retryAfterMs...) حتى على 400/401/403/429.
    // كان `if (!res.ok) throw` يبلع هذا الـ body كامل ويحوله لـ "HTTP 429" عام.
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!body || typeof body !== 'object') {
      return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    }

    if (body.ok === undefined) body.ok = res.ok;
    body.status = res.status;
    return body;
  } catch (err) {
    console.error(`[fetchApi] ${type} failed:`, err);
    return { ok: false, error: 'Network error', status: 0 };
  }
}
