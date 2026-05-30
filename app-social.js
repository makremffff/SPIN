/**
 * app-social.js — Social Tasks Page Logic
 * يعمل مستقل لا يمس باقي الملفات
 */

'use strict';

/* ─── State ─── */
const SOCIAL = {
  tasks: [],
  loading: false,
  cardState: {},    // { taskId: 'idle' | 'upload' | 'pending' | 'approved' | 'rejected' }
  pendingFiles: {}, // FIX-1: per-task file storage — كان متغير واحد مشترك يسبب تضارب الصور
};

/* ─── API base (نفس نمط المشروع) ─── */
const _SOCIAL_API = '/api';

async function _socialFetch(body) {
  const sid = window._APP_SESSION || localStorage.getItem('_sid') || '';
  const r = await fetch(_SOCIAL_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sid,
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  return r.json();
}

/* ─── Load tasks from server ─── */
async function socialLoadTasks() {
  const wrap = document.getElementById('social-cards-wrap');
  if (!wrap) return;

  // skeleton
  wrap.innerHTML = `
    <div class="sc-skeleton">
      <div class="sc-skel-row"></div>
      <div class="sc-skel-row" style="width:70%;margin-top:8px;opacity:.6"></div>
    </div>
    <div class="sc-skeleton" style="margin-top:10px">
      <div class="sc-skel-row"></div>
      <div class="sc-skel-row" style="width:60%;margin-top:8px;opacity:.6"></div>
    </div>`;

  try {
    const res = await _socialFetch({ type: 'social_get_tasks' });
    SOCIAL.tasks = res.tasks || [];
    // FIX-2: مزامنة حالة الكروت مع السيرفر — كان يُتجاهل user_status فتظهر المهام المنجزة من جديد
    for (const t of SOCIAL.tasks) {
      if (t.user_status && t.user_status !== 'idle' && !SOCIAL.cardState[t.id]) {
        SOCIAL.cardState[t.id] = t.user_status; // 'pending' | 'approved' | 'rejected'
      }
    }
    _socialRenderCards();
  } catch (e) {
    wrap.innerHTML = `<div class="sc-empty">تعذّر تحميل المهام — حاول مجدداً</div>`;
  }
}

/* ─── Render cards ─── */
function _socialRenderCards() {
  const wrap = document.getElementById('social-cards-wrap');
  if (!wrap) return;

  if (!SOCIAL.tasks.length) {
    wrap.innerHTML = `<div class="sc-empty">لا توجد مهام متاحة الآن</div>`;
    return;
  }

  wrap.innerHTML = SOCIAL.tasks.map((t, i) => _socialCardHTML(t, i)).join('');
}

function _socialCardHTML(task, idx) {
  const state = SOCIAL.cardState[task.id] || 'idle';
  const iconSVG = _socialIcon(task.icon);
  const delay = 60 + idx * 80;

  return `
<div class="sc-card sc-anim" style="animation-delay:${delay}ms" id="sc-card-${task.id}">
  <div class="sc-card-head">
    <div class="sc-card-ico sc-ico-${task.icon || 'default'}">${iconSVG}</div>
    <div class="sc-card-meta">
      <div class="sc-card-title">${_esc(task.title)}</div>
      <div class="sc-card-desc">${_esc(task.description || '')}</div>
    </div>
    <div class="sc-reward-chip">
      <img src="asesst/coins.png" width="15" height="15" style="object-fit:contain">
      ${Number(task.reward).toLocaleString('ar')}
    </div>
  </div>
  <div class="sc-card-body">
    ${state === 'idle'     ? _socialStepIdle(task)     : ''}
    ${state === 'upload'   ? _socialStepUpload(task)   : ''}
    ${state === 'pending'  ? _socialStepPending(task)  : ''}
    ${state === 'approved' ? _socialStepApproved(task) : ''}
    ${state === 'rejected' ? _socialStepRejected(task) : ''}
  </div>
</div>`;
}

function _socialStepIdle(task) {
  const noteHTML = task.note
    ? `<div class="sc-note-box">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(42,171,238,.85)" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/></svg>
        <p>${_esc(task.note)}</p>
       </div>` : '';

  const promoHTML = task.promo_text
    ? `<div class="sc-promo-box">
        <div class="sc-promo-top">
          <span class="sc-promo-lbl">المنشور الترويجي</span>
          <button class="sc-copy-btn" onclick="socialCopyPromo(${task.id})">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            نسخ
          </button>
        </div>
        <div class="sc-promo-txt" id="sc-promo-${task.id}">${_esc(task.promo_text)}</div>
       </div>` : '';

  const btnLabel = task.proof_required ? 'ابدأ المهمة' : 'إنجاز المهمة';

  return `
    ${noteHTML}
    ${promoHTML}
    <button class="sc-btn sc-btn-main" onclick="socialStartTask(${task.id}, '${_esc(task.task_url || '')}', ${!!task.proof_required})">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z"/></svg>
      ${btnLabel}
    </button>`;
}

function _socialStepUpload(task) {
  return `
    <div class="sc-proof-lbl">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/></svg>
      أرسل لقطة شاشة تُثبت التنفيذ
    </div>
    <div class="sc-upload-preview" id="sc-prev-${task.id}">
      <img id="sc-prev-img-${task.id}" src="" alt="">
    </div>
    <div class="sc-upload-zone" id="sc-zone-${task.id}" onclick="document.getElementById('sc-file-${task.id}').click()">
      <div class="sc-upload-ico">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/></svg>
      </div>
      <div class="sc-upload-txt" id="sc-zone-txt-${task.id}">اختر صورة من المعرض</div>
      <div class="sc-upload-sub">JPG أو PNG — حتى 10MB</div>
    </div>
    <input type="file" id="sc-file-${task.id}" accept="image/*" onchange="socialHandleFile(event, ${task.id})">
    <button class="sc-btn sc-btn-main" id="sc-submit-${task.id}" onclick="socialSubmitProof(${task.id})" disabled>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
      إرسال للمراجعة
    </button>
    <button class="sc-btn sc-btn-ghost" onclick="socialCancelUpload(${task.id})">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      إلغاء
    </button>`;
}

function _socialStepPending(task) {
  return `
    <div class="sc-pending-wrap">
      <div class="sc-pending-ico">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--sc-amber)" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
      <div class="sc-pending-title">قيد المراجعة</div>
      <div class="sc-pending-sub">تم إرسال صورتك إلى المشرف<br>سيُضاف <span class="sc-pending-pts">${Number(task.reward).toLocaleString('ar')} نقطة</span> فور الموافقة</div>
    </div>`;
}

// FIX-5: إضافة حالتَي approved و rejected — كانتا مدعومتَين في السيرفر لكن لا تُعرضان في الواجهة
function _socialStepApproved(task) {
  return `
    <div class="sc-pending-wrap">
      <div class="sc-pending-ico">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
      <div class="sc-pending-title" style="color:#22c55e">تمت الموافقة ✓</div>
      <div class="sc-pending-sub">تم إضافة <span class="sc-pending-pts">${Number(task.reward).toLocaleString('ar')} نقطة</span> إلى رصيدك</div>
    </div>`;
}

function _socialStepRejected(task) {
  return `
    <div class="sc-pending-wrap">
      <div class="sc-pending-ico">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
      <div class="sc-pending-title" style="color:#ef4444">تم رفض الإثبات</div>
      <div class="sc-pending-sub">لم يتم قبول الصورة المرسلة<br>
        <button class="sc-btn sc-btn-ghost" style="margin-top:10px" onclick="socialRetryTask(${task.id}, '${_esc(task.task_url || '')}', ${!!task.proof_required})">
          إعادة المحاولة
        </button>
      </div>
    </div>`;
}

/* ─── Icon helper ─── */
function _socialIcon(name) {
  const icons = {
    facebook: `<svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(42,171,238,.85)"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
    twitter:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(42,171,238,.85)"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.261 5.635zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
    tiktok:   `<svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(42,171,238,.85)"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.18 8.18 0 004.78 1.52V6.76a4.86 4.86 0 01-1.01-.07z"/></svg>`,
    telegram: `<svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(42,171,238,.85)"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.236 7.262l-1.69 7.966c-.127.567-.461.706-.934.44l-2.582-1.903-1.246 1.2c-.138.137-.253.253-.52.253l.185-2.641 4.8-4.336c.209-.185-.045-.288-.324-.103l-5.932 3.732-2.554-.797c-.555-.173-.567-.554.116-.82l9.97-3.843c.463-.168.868.103.711.852z"/></svg>`,
    instagram:`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(42,171,238,.85)" stroke-width="1.8"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1.2" fill="rgba(42,171,238,.85)" stroke="none"/></svg>`,
    youtube:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(42,171,238,.85)"><path d="M21.543 6.498C22 8.28 22 12 22 12s0 3.72-.457 5.502c-.254.985-.997 1.76-1.938 2.022C17.896 20 12 20 12 20s-5.893 0-7.605-.476c-.945-.266-1.687-1.04-1.938-2.022C2 15.72 2 12 2 12s0-3.72.457-5.502c.254-.985.997-1.76 1.938-2.022C6.107 4 12 4 12 4s5.896 0 7.605.476c.945.266 1.687 1.04 1.938 2.022zM10 15.5l6-3.5-6-3.5v7z"/></svg>`,
    default:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(42,171,238,.85)" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"/></svg>`,
  };
  return icons[name] || icons.default;
}

/* ─── Actions ─── */
function socialStartTask(taskId, url, proofRequired) {
  if (url) {
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(url);
    } else {
      window.open(url, '_blank');
    }
  }
  if (proofRequired) {
    SOCIAL.cardState[taskId] = 'upload';
    _socialRefreshCard(taskId);
    _socialToast('📋 أكمل المهمة ثم أرسل لقطة الإثبات');
  } else {
    socialSubmitNoProof(taskId);
  }
}

function socialCancelUpload(taskId) {
  SOCIAL.cardState[taskId] = 'idle';
  _socialRefreshCard(taskId);
}

// FIX-5: إعادة المحاولة بعد الرفض — يُعيد ضبط الحالة المحلية فقط (السيرفر يسمح بإعادة الإرسال)
function socialRetryTask(taskId, url, proofRequired) {
  delete SOCIAL.pendingFiles[taskId];
  SOCIAL.cardState[taskId] = 'idle';
  _socialRefreshCard(taskId);
  socialStartTask(taskId, url, proofRequired);
}

function socialHandleFile(e, taskId) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { _socialToast('⚠️ الصورة أكبر من 10MB'); return; }
  const reader = new FileReader();
  reader.onload = r => {
    const img  = document.getElementById(`sc-prev-img-${taskId}`);
    const prev = document.getElementById(`sc-prev-${taskId}`);
    const zone = document.getElementById(`sc-zone-${taskId}`);
    const txt  = document.getElementById(`sc-zone-txt-${taskId}`);
    const btn  = document.getElementById(`sc-submit-${taskId}`);
    if (img)  img.src = r.target.result;
    if (prev) prev.style.display = 'block';
    if (zone) zone.classList.add('has');
    if (txt)  txt.textContent = '✓ ' + file.name;
    if (btn)  btn.disabled = false;
    // FIX-1: حفظ الصورة لكل مهمة منفصلة — كان متغير واحد يُستبدل فتُرسل صورة مهمة أخرى
    SOCIAL.pendingFiles[taskId] = { file, dataUrl: r.target.result };
  };
  reader.readAsDataURL(file);
}

async function socialSubmitProof(taskId) {
  const btn = document.getElementById(`sc-submit-${taskId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="sc-btn-spin"></div> جارٍ الإرسال...'; }
  _socialToast('📤 جارٍ إرسال الصورة...');

  try {
    // FIX-1: قراءة الصورة الخاصة بهذه المهمة تحديداً
    const fileData = SOCIAL.pendingFiles[taskId]?.dataUrl || '';
    const res = await _socialFetch({
      type: 'social_submit_proof',
      task_id: taskId,
      proof_image: fileData,
    });
    if (res.ok) {
      SOCIAL.cardState[taskId] = 'pending';
      delete SOCIAL.pendingFiles[taskId]; // FIX-1: تنظيف الصورة بعد الإرسال الناجح
      _socialRefreshCard(taskId);
      _socialToast('✅ تم الإرسال — بانتظار موافقة المشرف');
    } else {
      if (btn) { btn.disabled = false; btn.innerHTML = 'إرسال للمراجعة'; }
      _socialToast('⚠️ ' + (res.error || 'خطأ في الإرسال'));
    }
  } catch {
    if (btn) { btn.disabled = false; btn.innerHTML = 'إرسال للمراجعة'; }
    _socialToast('⚠️ تعذّر الإرسال');
  }
}

// FIX-4: لا تُرسل المهمة كمنجزة إذا لم يكن هناك رابط يُفتح فعلياً
async function socialSubmitNoProof(taskId) {
  const task = SOCIAL.tasks.find(t => t.id === taskId);
  if (!task?.task_url) {
    // لا رابط = لا إجراء حقيقي — لا نعدّها منجزة
    _socialToast('⚠️ لا يوجد رابط لهذه المهمة');
    return;
  }
  try {
    const res = await _socialFetch({ type: 'social_submit_proof', task_id: taskId, proof_image: '' });
    if (res.ok) {
      SOCIAL.cardState[taskId] = 'pending';
      _socialRefreshCard(taskId);
      _socialToast('✅ تم تسجيل إنجاز المهمة');
    }
  } catch { _socialToast('⚠️ تعذّر التسجيل'); }
}

function socialCopyPromo(taskId) {
  const el = document.getElementById(`sc-promo-${taskId}`);
  if (!el) return;
  navigator.clipboard?.writeText(el.textContent).then(() => _socialToast('✅ تم نسخ المنشور'));
}

/* ─── Re-render single card ─── */
function _socialRefreshCard(taskId) {
  const task = SOCIAL.tasks.find(t => t.id === taskId);
  if (!task) return;
  const card = document.getElementById(`sc-card-${taskId}`);
  if (!card) return;
  const idx = SOCIAL.tasks.indexOf(task);
  card.outerHTML = _socialCardHTML(task, idx);
}

/* ─── Toast ─── */
let _scToastTimer;
function _socialToast(msg) {
  // reuse app toast if available, else use own
  if (typeof window.showToast === 'function') { window.showToast(msg); return; }
  let el = document.getElementById('sc-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sc-toast';
    el.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%) translateY(14px);background:rgba(18,18,18,.95);border:1px solid rgba(255,255,255,.11);border-radius:30px;padding:9px 20px;font-family:Tajawal,sans-serif;font-size:13px;font-weight:700;color:#fff;white-space:nowrap;pointer-events:none;z-index:9999;opacity:0;transition:opacity .3s,transform .3s;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(_scToastTimer);
  _scToastTimer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(14px)';
  }, 2800);
}

/* ─── Escape helper ─── */
function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── Init when social page is shown ─── */
function initSocialPage() {
  if (!SOCIAL.tasks.length) socialLoadTasks();
}

// expose to global
window.socialStartTask    = socialStartTask;
window.socialCancelUpload = socialCancelUpload;
window.socialRetryTask    = socialRetryTask;
window.socialHandleFile   = socialHandleFile;
window.socialSubmitProof  = socialSubmitProof;
window.socialCopyPromo    = socialCopyPromo;
window.initSocialPage     = initSocialPage;
