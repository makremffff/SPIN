/**
 * app-social.js — Social Tasks Page Logic (new design)
 * كل تصميم الكروت والشيت من النسخة الجديدة
 */

'use strict';

/* ─── State ─── */
const SOCIAL = {
  tasks: [],
  loading: false,
  loadError: false,
  cardState: {},    // { taskId: 'idle' | 'upload' | 'pending' | 'approved' | 'rejected' }
  pendingFiles: {}, // per-task file storage
};

/* ─── SVG icons (new design — per platform color) ─── */
const _SC_ICONS = {
  facebook: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
  twitter:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.261 5.635zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  tiktok:   `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.18 8.18 0 004.78 1.52V6.76a4.86 4.86 0 01-1.01-.07z"/></svg>`,
  youtube:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.543 6.498C22 8.28 22 12 22 12s0 3.72-.457 5.502c-.254.985-.997 1.76-1.938 2.022C17.896 20 12 20 12 20s-5.893 0-7.605-.476c-.945-.266-1.687-1.04-1.938-2.022C2 15.72 2 12 2 12s0-3.72.457-5.502c.254-.985.997-1.76 1.938-2.022C6.107 4 12 4 12 4s5.896 0 7.605.476c.945.266 1.687 1.04 1.938 2.022zM10 15.5l6-3.5-6-3.5v7z"/></svg>`,
  instagram:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  telegram: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.236 7.262l-1.69 7.966c-.127.567-.461.706-.934.44l-2.582-1.903-1.246 1.2c-.138.137-.253.253-.52.253l.185-2.641 4.8-4.336c.209-.185-.045-.288-.324-.103l-5.932 3.732-2.554-.797c-.555-.173-.567-.554.116-.82l9.97-3.843c.463-.168.868.103.711.852z"/></svg>`,
  default:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"/></svg>`,
};

/* platform → CSS class suffix (matches new design p-fb / p-tw …) */
const _SC_PCLS = {
  facebook:'fb', twitter:'tw', tiktok:'tt', youtube:'yt', instagram:'ig', telegram:'tg',
};
function _scPlatName(key) {
  const t = typeof window._t === 'function' ? window._t : function(k){ return k; };
  return t('sc_plat_' + key) || key;
}

/* ─── API ─── */
const _SOCIAL_API = '/api';
async function _socialFetch(body) {
  const sid = window._APP_SESSION || localStorage.getItem('_sid') || '';
  const r = await fetch(_SOCIAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  return r.json();
}

/* ─── i18n helper shortcut ─── */
function _st(key) {
  return typeof window._t === 'function' ? window._t(key) : key;
}

/* ─── Load tasks ─── */
async function socialLoadTasks() {
  const wrap = document.getElementById('social-cards-wrap');
  if (!wrap) return;

  wrap.innerHTML = `
    <div class="sc-skeleton"><div class="sc-skel-row"></div><div class="sc-skel-row" style="width:70%;margin-top:8px;opacity:.6"></div></div>
    <div class="sc-skeleton" style="margin-top:10px"><div class="sc-skel-row"></div><div class="sc-skel-row" style="width:60%;margin-top:8px;opacity:.6"></div></div>`;

  try {
    const res = await _socialFetch({ type: 'social_get_tasks' });
    SOCIAL.tasks = res.tasks || [];
    SOCIAL.loadError = false;
    for (const t of SOCIAL.tasks) {
      if (t.user_status && t.user_status !== 'idle' && !SOCIAL.cardState[t.id]) {
        SOCIAL.cardState[t.id] = t.user_status;
      }
    }
    _socialRenderCards();
  } catch (e) {
    SOCIAL.loadError = true;
    wrap.innerHTML = `<div class="sc-empty">${_st('sc_load_err')}</div>`;
  }
}

/* ─── Render cards list ─── */
function _socialRenderCards() {
  const wrap = document.getElementById('social-cards-wrap');
  if (!wrap) return;
  if (!SOCIAL.tasks.length) {
    wrap.innerHTML = `<div class="sc-empty">${_st('sc_no_tasks')}</div>`;
    return;
  }
  wrap.innerHTML = SOCIAL.tasks.map((t, i) => _scCardHTML(t, i)).join('');
}

/* ─── Card HTML (new design) ─── */
function _scCardHTML(task, idx) {
  const state   = SOCIAL.cardState[task.id] || 'idle';
  const pcls    = _SC_PCLS[task.icon] || 'default';
  const icon    = _SC_ICONS[task.icon] || _SC_ICONS.default;
  const delay   = 60 + idx * 65;
  const isDone  = state === 'approved';
  const clickable = !isDone;

  return `
<div class="task-card p-${pcls} sc-anim" style="animation-delay:${delay}ms;${isDone?'opacity:.65;pointer-events:none':''}" id="sc-card-${task.id}" ${clickable ? `onclick="_scOpenSheet(${task.id})"` : ''}>
  <div class="c-icon p-${pcls}">${icon}</div>
  <div class="c-body">
    <div class="c-title">${_esc(task.title)}</div>
    <div class="c-desc">${_esc(task.description || '')}</div>
  </div>
  <div id="sc-startbtn-${task.id}">${_scStartBtn(task.id, task.reward)}</div>
</div>`;
}

/* start button states (new design) */
function _scStartBtn(taskId, reward) {
  const state = SOCIAL.cardState[taskId] || 'idle';
  if (state === 'approved') {
    return `<div class="c-start state-done">
      <div class="done-check"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
      <span class="start-lbl">${_st('sc_done')}</span>
    </div>`;
  }
  if (state === 'pending') {
    return `<div class="c-start state-review">
      <div class="review-pulse"></div>
      <span class="start-lbl">${_st('sc_reviewing')}</span>
    </div>`;
  }
  if (state === 'rejected') {
    return `<div class="c-start" style="background:linear-gradient(135deg,rgba(239,68,68,.18),rgba(239,68,68,.08));border-color:rgba(239,68,68,.3);cursor:pointer">
      <span class="start-pts" style="color:#f87171;font-size:11px">${_st('sc_rejected_short')}</span>
    </div>`;
  }
  // idle / upload — عرض التذاكر بدل النقاط
  return `<div class="c-start">
    <span class="start-pts">${Number(reward).toLocaleString()}<img class="coin-img" src="asesst/dollar.png" alt="" onerror="this.src='asesst/dollar.png'"></span>
    <span class="start-lbl">${_st('sc_start_lbl')}</span>
  </div>`;
}

/* ─── Sheet open ─── */
function _scOpenSheet(taskId) {
  const task = SOCIAL.tasks.find(t => t.id === taskId);
  if (!task) return;
  const state = SOCIAL.cardState[taskId] || 'idle';
  const pcls  = _SC_PCLS[task.icon] || 'default';
  const icon  = _SC_ICONS[task.icon] || _SC_ICONS.default;

  /* note block */
  const noteHTML = task.note ? `
    <div class="sheet-section">
      <div class="sheet-sec-lbl">${_st('sc_task_instr')}</div>
      <div class="note-box">${_esc(task.note)}</div>
    </div>` : `
    <div class="sheet-section">
      <div class="sheet-sec-lbl">${_st('sc_task_instr')}</div>
      <div class="note-box">${_esc(task.description || '')}</div>
    </div>`;

  /* promo block */
  const promoHTML = task.promo_text ? `
    <div class="sheet-section">
      <div class="sheet-sec-lbl">${_st('sc_promo_lbl')}</div>
      <div class="promo-box">
        <div class="promo-box-top">
          <div class="promo-text" id="sc-promo-${task.id}">${_esc(task.promo_text)}</div>
          <button class="btn-copy" id="sc-copybtn-${task.id}" onclick="socialCopyPromo(${task.id})">
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            ${_st('sc_copy_btn')}
          </button>
        </div>
      </div>
    </div>` : '';

  /* action block based on state */
  let actionHTML = '';
  if (state === 'pending') {
    actionHTML = `
      <div class="sheet-section">
        <div class="review-banner">
          <div class="review-banner-dot"></div>
          <div>
            <div class="review-banner-txt">${_st('sc_under_review')}</div>
            <div class="review-banner-sub">${_st('sc_review_sub')}</div>
          </div>
        </div>
      </div>`;
  } else if (state === 'approved') {
    actionHTML = `
      <div class="sheet-section">
        <div class="review-banner" style="background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.2)">
          <div class="done-check" style="flex-shrink:0"><svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div>
            <div class="review-banner-txt" style="color:#4ade80">${_st('sc_approved')}</div>
            <div class="review-banner-sub" style="color:rgba(74,222,128,.5)">${_st('sc_approved_sub')}</div>
          </div>
        </div>
      </div>`;
  } else if (state === 'rejected') {
    actionHTML = `
      <div class="sheet-section">
        <div class="review-banner" style="background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.2)">
          <div>
            <div class="review-banner-txt" style="color:#f87171">${_st('sc_rejected')}</div>
            <div class="review-banner-sub" style="color:rgba(248,113,113,.5)">${_st('sc_rejected_sub')}</div>
          </div>
        </div>
        <button class="btn-submit" id="sc-retry-btn-${task.id}" style="margin-top:10px" onclick="scRetryTask(${task.id})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          ${_st('sc_retry')}
        </button>
      </div>`;
  } else if (state === 'upload') {
    actionHTML = `
      <div class="sheet-section">
        <div class="sheet-sec-lbl">${_st('sc_proof_lbl')}</div>
        <div class="upload-area" id="sc-uploadArea-${task.id}">
          <input type="file" accept="image/*" id="sc-file-${task.id}" onchange="socialHandleFile(event,${task.id})">
          <img class="preview-img" id="sc-prev-img-${task.id}" alt="preview">
          <div class="upload-placeholder" id="sc-uploadPH-${task.id}">
            <div class="upload-svg-wrap">
              <svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" width="60" height="60">
                <circle cx="30" cy="30" r="29" stroke="rgba(59,130,246,0.18)" stroke-width="1.2" stroke-dasharray="4 3"/>
                <circle cx="30" cy="30" r="22" fill="rgba(59,130,246,0.10)"/>
                <path d="M30 38V24" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/>
                <path d="M24 30l6-7 6 7" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M22 42h16" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
                <circle cx="18" cy="18" r="2" fill="rgba(59,130,246,0.25)"/>
                <circle cx="42" cy="18" r="2" fill="rgba(59,130,246,0.25)"/>
                <circle cx="18" cy="42" r="2" fill="rgba(59,130,246,0.25)"/>
                <circle cx="42" cy="42" r="2" fill="rgba(59,130,246,0.25)"/>
              </svg>
            </div>
            <div class="upload-lbl">${_st('sc_upload_lbl')}</div>
            <div class="upload-sub">${_st('sc_upload_sub')}</div>
          </div>
        </div>
      </div>
      <div class="sheet-section">
        <button class="btn-submit" id="sc-submitbtn-${task.id}" disabled onclick="socialSubmitProof(${task.id})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
          ${_st('sc_send_review')}
        </button>
        <button class="btn-submit" style="margin-top:8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);box-shadow:none;color:rgba(255,255,255,.45)" onclick="socialCancelUpload(${task.id})">
          ${_st('sc_cancel')}
        </button>
      </div>`;
  } else {
    /* idle — فتح مباشر بـ upload area */
    if (task.task_url) {
      if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(task.task_url);
      else window.open(task.task_url, '_blank');
    }
    actionHTML = `
      <div class="sheet-section">
        <div class="sheet-sec-lbl">${_st('sc_proof_lbl')}</div>
        <div class="upload-area" id="sc-uploadArea-${task.id}">
          <input type="file" accept="image/*" id="sc-file-${task.id}" onchange="socialHandleFile(event,${task.id})">
          <img class="preview-img" id="sc-prev-img-${task.id}" alt="preview">
          <div class="upload-placeholder" id="sc-uploadPH-${task.id}">
            <div class="upload-svg-wrap">
              <svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" width="60" height="60">
                <circle cx="30" cy="30" r="29" stroke="rgba(59,130,246,0.18)" stroke-width="1.2" stroke-dasharray="4 3"/>
                <circle cx="30" cy="30" r="22" fill="rgba(59,130,246,0.10)"/>
                <path d="M30 38V24" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/>
                <path d="M24 30l6-7 6 7" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M22 42h16" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
                <circle cx="18" cy="18" r="2" fill="rgba(59,130,246,0.25)"/>
                <circle cx="42" cy="18" r="2" fill="rgba(59,130,246,0.25)"/>
                <circle cx="18" cy="42" r="2" fill="rgba(59,130,246,0.25)"/>
                <circle cx="42" cy="42" r="2" fill="rgba(59,130,246,0.25)"/>
              </svg>
            </div>
            <div class="upload-lbl">${_st('sc_upload_lbl')}</div>
            <div class="upload-sub">${_st('sc_upload_sub')}</div>
          </div>
        </div>
      </div>
      <div class="sheet-section">
        <button class="btn-submit" id="sc-submitbtn-${task.id}" disabled onclick="socialSubmitProof(${task.id})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ${_st('sc_send_task')}
        </button>
      </div>`;
  }

  document.getElementById('sheet-content').innerHTML = `
    <div class="sheet-head">
      <div class="sheet-icon p-${pcls}" style="width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${icon}</div>
      <div class="sheet-meta">
        <div class="sheet-title">${_esc(task.title)}</div>
        <div class="sheet-plat">${_scPlatName(task.icon)}</div>
      </div>
      <div class="sheet-pts-badge">
        <span class="sheet-pts-num">${Number(task.reward).toLocaleString()}<img src="asesst/dollar.png" onerror="this.src='asesst/dollar.png'" alt="" style="width:18px;height:18px;object-fit:contain;filter:drop-shadow(0 1px 4px rgba(99,220,130,.4))"></span>
        <span class="sheet-pts-lbl">${_st('ticket_unit')}</span>
      </div>
    </div>
    ${noteHTML}
    ${promoHTML}
    ${actionHTML}`;

  document.getElementById('overlay').classList.add('open');
  document.getElementById('sheet').classList.add('open');
  document.body.style.overflow = 'hidden';
}

/* ─── Actions ─── */
function socialStartTask(taskId, url, proofRequired) {
  if (url) {
    if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(url);
    else window.open(url, '_blank');
  }
  if (proofRequired) {
    SOCIAL.cardState[taskId] = 'upload';
    _scRefreshSheet(taskId);
    _socialToast(_st('sc_upload_toast'));
  } else {
    socialSubmitNoProof(taskId);
  }
}

function socialCancelUpload(taskId) {
  SOCIAL.cardState[taskId] = 'idle';
  _scRefreshSheet(taskId);
}

/* ─── إعادة المحاولة بعد الرفض — بنيت من صفر ─────────────────── */
async function scRetryTask(taskId) {
  taskId = Number(taskId);
  const task = SOCIAL.tasks.find(t => t.id === taskId);
  if (!task) { _socialToast('⚠️ المهمة غير موجودة'); return; }

  // امسح أي ملف معلّق
  delete SOCIAL.pendingFiles[taskId];

  // افتح الرابط
  if (task.task_url) {
    try {
      if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(task.task_url);
      else window.open(task.task_url, '_blank');
    } catch (_) {}
  }

  if (task.proof_required) {
    // مهمة تتطلب إثباتاً → state=upload وأعد فتح الشيت
    SOCIAL.cardState[taskId] = 'upload';
    _scRefreshCard(taskId);
    // أغلق الشيت ثم أعد فتحه بالحالة الجديدة
    _scCloseSheet();
    setTimeout(() => _scOpenSheet(taskId), 80);
    _socialToast(_st('sc_upload_toast'));
    return;
  }

  // مهمة بدون إثبات → أرسل مباشرة للـ API
  const btn = document.getElementById('sc-retry-btn-' + taskId);
  if (btn) { btn.disabled = true; btn.textContent = _st('sc_sending_inline'); }

  try {
    const res = await _socialFetch({ type: 'social_submit_proof', task_id: taskId, proof_image: '' });
    if (res.ok) {
      SOCIAL.cardState[taskId] = res.status === 'approved' ? 'approved' : 'pending';
      _scRefreshCard(taskId);
      _scCloseSheet();
      _socialToast(res.status === 'approved' ? _st('sc_pts_added') : _st('sc_sent_review'));
    } else {
      if (btn) { btn.disabled = false; btn.textContent = _st('sc_retry'); }
      _socialToast('⚠️ ' + (res.error || 'خطأ'));
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = _st('sc_retry'); }
    _socialToast('⚠️ ' + _st('sc_load_err'));
  }
}


function socialHandleFile(e, taskId) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { _socialToast('⚠️ الصورة أكبر من 10MB'); return; }
  const reader = new FileReader();
  reader.onload = r => {
    const img  = document.getElementById(`sc-prev-img-${taskId}`);
    const ph   = document.getElementById(`sc-uploadPH-${taskId}`);
    const btn  = document.getElementById(`sc-submitbtn-${taskId}`);
    if (img) { img.src = r.target.result; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
    if (btn) btn.disabled = false;
    SOCIAL.pendingFiles[taskId] = { file, dataUrl: r.target.result };
  };
  reader.readAsDataURL(file);
}

async function socialSubmitProof(taskId) {
  const btn = document.getElementById(`sc-submitbtn-${taskId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = `<div style="display:inline-block;width:15px;height:15px;border:2.5px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite"></div> ${_st('sc_sending_inline')}`; }
  _socialToast(_st('sc_sending'));
  try {
    const fileData = SOCIAL.pendingFiles[taskId]?.dataUrl || '';
    const res = await _socialFetch({ type: 'social_submit_proof', task_id: taskId, proof_image: fileData });
    if (res.ok) {
      SOCIAL.cardState[taskId] = res.status === 'approved' ? 'approved' : 'pending';
      delete SOCIAL.pendingFiles[taskId];
      _scRefreshCard(taskId);
      _scCloseSheet();
      const msg = res.status === 'approved' ? _st('sc_pts_added') : _st('sc_sent_review');
      _socialToast(msg);
    } else {
      if (btn) { btn.disabled = false; btn.innerHTML = _st('sc_send_review'); }
      _socialToast('⚠️ ' + (typeof res.error === 'string' ? res.error : _st('sc_load_err')));
    }
  } catch {
    if (btn) { btn.disabled = false; btn.innerHTML = _st('sc_send_review'); }
    _socialToast('⚠️ ' + _st('sc_load_err'));
  }
}

async function socialSubmitNoProof(taskId) {
  const task = SOCIAL.tasks.find(t => t.id === taskId);
  if (!task?.task_url) { _socialToast('⚠️ ' + _st('sc_load_err')); return; }
  try {
    const res = await _socialFetch({ type: 'social_submit_proof', task_id: taskId, proof_image: '' });
    if (res.ok) {
      SOCIAL.cardState[taskId] = res.status === 'approved' ? 'approved' : 'pending';
      _scRefreshCard(taskId);
      _scCloseSheet();
      const msg = res.status === 'approved' ? _st('sc_pts_added') : _st('sc_sent_review');
      _socialToast(msg);
    }
  } catch { _socialToast('⚠️ ' + _st('sc_load_err')); }
}

function socialCopyPromo(taskId) {
  const el = document.getElementById(`sc-promo-${taskId}`);
  if (!el) return;
  navigator.clipboard?.writeText(el.textContent).then(() => {
    _socialToast(_st('sc_copied'));
    const btn = document.getElementById(`sc-copybtn-${taskId}`);
    if (btn) {
      btn.classList.add('copied');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg> ${_st('sc_copy_done')}`;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> ${_st('sc_copy_btn')}`;
      }, 2200);
    }
  });
}

/* ─── Refresh helpers ─── */
function _scRefreshCard(taskId) {
  const task = SOCIAL.tasks.find(t => t.id === taskId);
  if (!task) return;
  const card = document.getElementById(`sc-card-${taskId}`);
  if (!card) return;
  const idx = SOCIAL.tasks.indexOf(task);
  card.outerHTML = _scCardHTML(task, idx);
}

function _scRefreshSheet(taskId) {
  // re-open sheet with updated state
  _scOpenSheet(taskId);
}

function _scCloseSheet() {
  document.getElementById('overlay')?.classList.remove('open');
  document.getElementById('sheet')?.classList.remove('open');
  document.body.style.overflow = '';
}

/* ─── Toast ─── */
function _socialToast(msg) {
  if (typeof window.showToast === 'function') {
    if (msg.startsWith('✅')) {
      window.showToast('trophy', msg.slice(1).trim(), '', 'green', '✓');
    } else if (msg.startsWith('⚠️')) {
      window.showToast('error', msg.slice(2).trim(), '', 'gold', '!');
    } else {
      const spaceIdx = msg.indexOf(' ');
      const title = spaceIdx > -1 ? msg.slice(spaceIdx).trim() : msg;
      window.showToast('coin', title || msg, '', 'gold', '•');
    }
    return;
  }
  let el = document.getElementById('sc-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sc-toast';
    el.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%) translateY(14px);background:rgba(18,18,18,.95);border:1px solid rgba(255,255,255,.11);border-radius:30px;padding:9px 20px;font-family:Cairo,sans-serif;font-size:13px;font-weight:700;color:#fff;white-space:nowrap;pointer-events:none;z-index:9999;opacity:0;transition:opacity .3s,transform .3s;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(window._scToastTimer);
  window._scToastTimer = setTimeout(() => {
    el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(14px)';
  }, 2800);
}

/* ─── Escape ─── */
function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── Init ─── */
function initSocialPage() {
  if (!SOCIAL.tasks.length || SOCIAL.loadError) socialLoadTasks();
}

/* ─── Expose globals ─── */
window.socialStartTask    = socialStartTask;
window.socialCancelUpload = socialCancelUpload;
window.scRetryTask        = scRetryTask;
window.socialHandleFile   = socialHandleFile;
window.socialSubmitProof  = socialSubmitProof;
window.socialCopyPromo    = socialCopyPromo;
window.initSocialPage     = initSocialPage;
window._scOpenSheet       = _scOpenSheet;
