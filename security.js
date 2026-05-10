// ================================================================
//  🔐 SECURITY LAYER — Frontend Integration
//  طبقة الحماية للـ frontend — أضفها في index.html قبل أي script آخر
//
//  كيفية الاستخدام:
//    1. أضف هذا الملف في <head> بعد Telegram SDK
//    2. استبدل كل fetch مباشر بـ _dbCall(action, data)
//    3. استدعِ initSecureApp() عند بدء التطبيق
//    4. استخدم _getUser() للوصول لبيانات المستخدم
//
//  ⚠️ قواعد صارمة:
//    - لا تخزن balance/points في localStorage
//    - لا تقبل أي قيمة مكافأة من العميل
//    - كل البيانات تأتي من السيرفر فقط
//    - الـ sessionId في الذاكرة فقط (لا localStorage)
// ================================================================

(function() {
  'use strict';

  // ── API Base URL — غيّره لـ URL مشروعك ──
  const API_BASE = window.__API_BASE__ || 'https://your-project.vercel.app';

  // ── State (in memory only — لا localStorage أبداً) ──
  let _sessionId  = null;
  let _userData   = null;
  let _fpCache    = null;

  // ================================================================
  //  DEVICE FINGERPRINT — Multi-Signal (نفس منطق المشروع الأصلي)
  // ================================================================
  async function _buildFingerprint() {
    if (_fpCache) return _fpCache;

    // Signal 1: Canvas fingerprint
    let canvasHash = '';
    try {
      const c   = document.createElement('canvas');
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Cwm fjordbank glyphs vext quiz', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('Cwm fjordbank glyphs vext quiz', 4, 17);
      canvasHash = c.toDataURL().slice(-40);
    } catch (_) { canvasHash = 'canvas_blocked'; }

    // Signal 2: WebGL
    let webglInfo = '';
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        webglInfo = ext
          ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) + '|' + gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
          : gl.getParameter(gl.RENDERER);
      }
    } catch (_) { webglInfo = 'webgl_blocked'; }

    // Signal 3: Audio
    let audioHash = '';
    try {
      const ac   = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
      const osc  = ac.createOscillator();
      const an   = ac.createAnalyser();
      const gain = ac.createGain();
      gain.gain.value = 0;
      osc.connect(an); an.connect(gain); gain.connect(ac.destination);
      osc.start(0);
      const buf = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(buf);
      osc.stop();
      await ac.close();
      audioHash = buf.slice(0, 8).reduce((s, v) => s + Math.abs(v).toFixed(2), '');
    } catch (_) { audioHash = 'audio_blocked'; }

    // Signals 4-9: Platform
    const hw       = [navigator.hardwareConcurrency || 0, navigator.deviceMemory || 0].join('x');
    const touch    = [navigator.maxTouchPoints || 0, 'ontouchstart' in window ? 1 : 0].join('');
    const platform = [
      navigator.userAgent || '',
      navigator.language  || '',
      (navigator.languages || []).join(','),
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      new Date().getTimezoneOffset(),
      (Intl.DateTimeFormat().resolvedOptions().timeZone || '')
    ].join('|');
    const plugins = navigator.plugins?.length || 0;
    const media   = [
      window.matchMedia('(prefers-color-scheme:dark)').matches ? 'D' : 'L',
      (window.devicePixelRatio || 1).toFixed(1),
    ].join('');

    const raw = [canvasHash, webglInfo, audioHash, hw, touch, platform, plugins, media].join('§');

    // djb2 double hash
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      h1 = (Math.imul(h1, 31) ^ c) >>> 0;
      h2 = (Math.imul(h2, 33) ^ c) >>> 0;
    }
    const fpHash = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');

    _fpCache = JSON.stringify({
      fp:          fpHash,
      user_agent:  navigator.userAgent         || '',
      lang:        navigator.language          || '',
      screen:      `${screen.width}x${screen.height}`,
      tz_offset:   new Date().getTimezoneOffset(),
      hw_cores:    navigator.hardwareConcurrency || 0,
      hw_mem:      navigator.deviceMemory        || 0,
      touch_pts:   navigator.maxTouchPoints      || 0,
      tz_name:     Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      canvas_sig:  canvasHash,
      webgl_sig:   (webglInfo || '').slice(0, 60),
      audio_sig:   audioHash,
      dpr:         (window.devicePixelRatio || 1).toFixed(2),
      color_depth: screen.colorDepth || 0,
    });

    return _fpCache;
  }

  // ================================================================
  //  NONCE GENERATOR — per request (مانع replay attack)
  // ================================================================
  function _genNonce() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('') + '_' + Date.now();
  }

  // ================================================================
  //  CREATE SESSION — يُستدعى مرة واحدة مع initData
  // ================================================================
  async function _createSession() {
    const tg       = window.Telegram?.WebApp;
    const initData = tg?.initData || '';

    if (!initData) {
      console.warn('[ZT] No initData — dev mode');
      return false;
    }

    try {
      const fpStr = await _buildFingerprint();
      const res   = await fetch(API_BASE + '/api', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'X-Init-Data':   initData,
          'X-Fingerprint': fpStr,
        },
        body: JSON.stringify({ action: 'create_session', data: {} })
      });

      const result = await res.json();

      if (result.is_banned) {
        _showSecurityWall();
        return false;
      }

      if (result.ok && result.session_id) {
        _sessionId = result.session_id;
        console.log('[ZT] Session created ✅');
        return true;
      }

      console.warn('[ZT] Session failed:', result.error);
      return false;
    } catch (e) {
      console.warn('[ZT] Session error:', e.message);
      return false;
    }
  }

  // ================================================================
  //  CENTRAL REQUEST FUNCTION — كل الطلبات تمر من هنا
  // ================================================================
  async function _dbCall(action, data = {}) {
    // ضمان وجود session
    if (!_sessionId && action !== 'create_session') {
      const ok = await _createSession();
      if (!ok) return { ok: false, error: 'auth_failed' };
    }

    // Actions التي لا تحتاج nonce
    const skipNonce = ['get_state', 'load', 'reward_ad', 'start_ad'].includes(action);

    try {
      const fpStr    = await _buildFingerprint();
      const tg       = window.Telegram?.WebApp;
      const initData = tg?.initData || '';

      const headers = {
        'Content-Type':  'application/json',
        'X-Fingerprint': fpStr,
      };

      if (initData)   headers['X-Init-Data']  = initData;
      if (_sessionId) headers['X-Session-Id'] = _sessionId;

      // Nonce لكل طلب يُعدّل البيانات
      if (!skipNonce) {
        headers['X-Nonce'] = _genNonce();
      }

      console.log(`[ZT] ${action} | session=${_sessionId?.slice(0, 8) || 'none'}`);

      const res = await fetch(API_BASE + '/api', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, data })
      });

      // تجديد Session عند 401
      if (res.status === 401) {
        console.warn('[ZT] 401 — renewing session for:', action);
        _sessionId = null;
        const renewed = await _createSession();
        if (renewed) return _dbCall(action, data); // nonce جديد تلقائياً
        return { ok: false, error: 'auth_failed' };
      }

      const json = await res.json();

      // فحص ban من أي رد
      if (json.is_banned === true) {
        _showSecurityWall();
      }

      return json;
    } catch (e) {
      console.warn('[ZT]', action, 'error:', e.message);
      return { ok: false };
    }
  }

  // ================================================================
  //  AD REWARD FLOW — الإعلانات
  //  المستخدم يطلب nonce من السيرفر، يشاهد الإعلان، يُرسل الـ nonce
  // ================================================================
  async function _startAdAndGetNonce() {
    if (!_sessionId) {
      const ok = await _createSession();
      if (!ok) return null;
    }
    try {
      const result = await _dbCall('start_ad', {});
      if (result.ok && result.ad_nonce) return result.ad_nonce;
      return null;
    } catch (e) {
      console.warn('[AD] start_ad failed:', e.message);
      return null;
    }
  }

  async function _claimAdReward(adNonce) {
    if (!adNonce) return { ok: false, error: 'No nonce' };
    // ✅ nonce يأتي من السيرفر — لا يُولَّد هنا أبداً
    return await _dbCall('reward_ad', { ad_nonce: adNonce });
  }

  // ================================================================
  //  SECURITY WALL — يُظهر شاشة الحظر
  // ================================================================
  function _showSecurityWall() {
    // أزل جميع التفاعلات
    document.body.style.pointerEvents = 'none';

    // أنشئ الجدار إذا لم يكن موجوداً
    if (!document.getElementById('__security_wall__')) {
      const wall = document.createElement('div');
      wall.id = '__security_wall__';
      wall.style.cssText = `
        position:fixed;inset:0;z-index:999999;
        background:linear-gradient(135deg,#0a0010,#000);
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:32px;text-align:center;
      `;
      wall.innerHTML = `
        <div style="font-size:48px;margin-bottom:20px;">🔒</div>
        <div style="font-family:sans-serif;font-size:22px;font-weight:900;color:#fff;margin-bottom:12px;">
          Account Suspended
        </div>
        <div style="font-family:sans-serif;font-size:14px;color:rgba(255,255,255,0.5);max-width:280px;line-height:1.6;">
          Your account has been flagged for suspicious activity.
          Contact support if you believe this is a mistake.
        </div>
        <div style="margin-top:24px;font-size:11px;color:rgba(255,255,255,0.2);">
          ${new Date().toISOString()}
        </div>
      `;
      document.body.appendChild(wall);
    }
  }

  // ================================================================
  //  APPLY USER DATA — تطبيق بيانات المستخدم القادمة من السيرفر
  //  ⚠️ لا تعدّل balance/points محلياً — أعد جلب البيانات من السيرفر
  // ================================================================
  function _applyUser(u) {
    if (!u) return;
    _userData = u;

    // أُطلق حدث لإبلاغ بقية الـ JS بالبيانات الجديدة
    window.dispatchEvent(new CustomEvent('userDataUpdated', { detail: u }));
  }

  function _getUser() {
    return _userData;
  }

  // ================================================================
  //  INIT — نقطة البداية الإلزامية
  // ================================================================
  async function initSecureApp(onSuccess, onError) {
    try {
      // إنشاء session
      const sessionOk = await _createSession();
      if (!sessionOk) {
        console.warn('[ZT] No session — running limited');
      }

      // تحميل بيانات المستخدم
      const tg = window.Telegram?.WebApp;
      const refParam = tg?.initDataUnsafe?.start_param || '';
      const refId    = refParam.startsWith('ref_') ? refParam.slice(4) : null;

      const result = await _dbCall('load', {
        referral_by: refId ? parseInt(refId) : undefined,
      });

      if (!result.ok || !result.user) {
        if (onError) onError(result.error || 'load_failed');
        return;
      }

      _applyUser(result.user);
      if (onSuccess) onSuccess(result.user);

    } catch (e) {
      console.error('[ZT] initSecureApp error:', e.message);
      if (onError) onError(e.message);
    }
  }

  // ================================================================
  //  PUBLIC API — ما يُعرَض للـ index.html
  // ================================================================
  window.ZT = {
    // التهيئة الإلزامية
    init:           initSecureApp,

    // طلب عام موثّق
    call:           _dbCall,

    // flow الإعلانات
    startAd:        _startAdAndGetNonce,
    claimAdReward:  _claimAdReward,

    // بيانات المستخدم (read-only — من السيرفر فقط)
    getUser:        _getUser,
    applyUser:      _applyUser,

    // مساعدات
    genNonce:       _genNonce,
  };

})(); // IIFE — لا تلوّث النطاق العالمي
