/* ══════════════════════════════════════════════════════
   game.js — Coin Rain mini-game (Game tab)
   Depends on: config.js (ADSGRAM_BLOCK_ID), api.js (fetchApi),
               notifications.js (showToast)
   Started/stopped by pages.js via gameStart()/gameStop()
   whenever the user enters/leaves the "game" nav tab.

   🛡️ API rules:
   - تذاكر الجولة تُجمع بالكامل على العميل أثناء اللعب —
     لا يوجد أي نداء API لكل تذكرة يتم صيدها.
   - نداء واحد فقط (gameRoundEnd) يُرسل عند انتهاء الجولة
     فعلياً (الضغط على Play Again أو مغادرة تبويب اللعبة
     بعد ظهور بطاقة النهاية).
   - زر "Double Tickets" يضاعف التذاكر محلياً فور إكمال
     الإعلان فقط — بدون أي شروط أو نداء سيرفر إضافي.
══════════════════════════════════════════════════════ */

(function () {

  /* ── Assets ──────────────────────────────────────── */
  const TICKET_IMG = new Image();
  TICKET_IMG.src = 'https://meme.crypto-apps.center/images/5247ad..png';

  const BASKET_IMG = new Image();
  BASKET_IMG.src = 'asesst/basket.png'; // اختياري — عند عدم توفره تُرسم سلة بديلة تلقائياً (fallback أدناه)

  /* ── Canvas ──────────────────────────────────────── */
  const canvas = document.getElementById('canvas');
  const ctx    = canvas.getContext('2d');
  let W, H;

  function setupCanvas() {
    const wrap = document.getElementById('game-canvas-wrap');
    W = canvas.width  = wrap.clientWidth  || window.innerWidth;
    H = canvas.height = wrap.clientHeight || window.innerHeight;
  }

  /* ── State ───────────────────────────────────────── */
  const DURATION = 40;
  let roundScore, timeLeft, items, popups, spawnCd, lastTs, animId, running;
  let basketX;
  const BW = 92, BH = 26, BY_OFF = 80;
  let cdToken = 0;             // يُلغي أي countdown قديم عند مغادرة/إعادة دخول صفحة اللعبة

  // 🛡️ جلسة الجولة — تُنشأ من السيرفر حصراً، مخفية عن المستخدم
  let _sessionToken = null;   // token معتم من السيرفر (لا يظهر في UI أو console)
  let _roundEnded   = false;  // true فقط عند انتهاء العداد فعلاً
  let _seqRng       = null;   // PRNG محدد بـ seed من السيرفر
  let _seqIndex     = 0;      // مؤشر التسلسل — يتزامن مع السيرفر
  let _caughtIds    = [];     // مؤشرات العناصر المصيدة — تُرسَل في gameRoundEnd
  // 🛡️ anti-bot: سجل موقع السلة كل 500ms — تحقق مكاني على السيرفر
  let _basketLog    = [];     // [x/W normalized 0-1, ...]
  let _basketLogTimer = null;
  let _burstFired   = false;  // تم إطلاق انفجار آخر 5 ثواني؟

  const TYPES = [
    { type: 'ticket', w: 58, val: 4,  r: 20, rare: false },
    { type: 'ticket', w: 20, val: 16, r: 20, rare: true  },
    { type: 'bomb',   w: 22, val: -3, r: 18              },
  ];
  const GAME_TOTAL_W = TYPES.reduce((a, t) => a + t.w, 0); // 100

  // Mulberry32 — نفس PRNG المستخدم في السيرفر (يجب أن يبقيا متطابقين)
  function _makePrng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickType() {
    // استهلاك 1: نوع العنصر (seeded — يتطابق مع السيرفر)
    let r = _seqRng() * GAME_TOTAL_W;
    const idx = _seqIndex++;
    for (const t of TYPES) { r -= t.w; if (r <= 0) return { ...t, _idx: idx }; }
    return { ...TYPES[0], _idx: idx };
  }

  /* ── 🛡️ إرسال نتيجة الجولة ───────────────────────────────────────────
     يُرسَل: token معتم + مؤشرات الصيد + عدد العناصر التي ظهرت.
     السيرفر يعيد حساب النتيجة من التسلسل المخزّن لديه. */
  function submitRound() {
    if (!_sessionToken || !_roundEnded) return;
    const tok  = _sessionToken;
    const ids  = _caughtIds.slice();
    const n    = _seqIndex;
    const bLog = _basketLog.slice(); // 🛡️ سجل موقع السلة للتحقق المكاني
    _sessionToken = null;   // يمنع الإرسال المزدوج
    _roundEnded   = false;
    _caughtIds    = [];
    _basketLog    = [];

    fetchApi({ type: 'gameRoundEnd', data: { _t: tok, c: ids, n, bLog } }).then(res => {
      if (!res?.ok) return;
      if (typeof refreshState === 'function') refreshState();
      if (typeof showToast === 'function') {
        const tickets = (res.awarded || 0).toLocaleString();
        const msg = res.doubled
          ? `🎉 Doubled! You earned ${tickets} 🎟`
          : `You earned ${tickets} 🎟`;
        showToast({ type: 'success', title: 'Round Over!', msg, duration: 4000 });
      }
    }).catch(() => {});
  }

  /* ── Countdown → Start ──────────────────────────── */
  async function startCountdown() {
    const wrap = document.getElementById('game-canvas-wrap');
    wrap.classList.add('active');
    document.getElementById('end-overlay').classList.remove('active');
    setupCanvas();

    roundScore = 0; items = []; popups = [];
    document.getElementById('scoreVal').textContent = '0';
    document.getElementById('timerNum').textContent = DURATION;
    document.getElementById('timerNum').classList.remove('urgent');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, W, H);

    // 🛡️ طلب جلسة + seed من السيرفر
    _sessionToken = null;
    _roundEnded   = false;
    _seqRng       = null;
    _seqIndex     = 0;
    _caughtIds    = [];
    const startRes = await fetchApi({ type: 'gameRoundStart' });
    if (!startRes?.ok) {
      wrap.classList.remove('active');
      if (typeof showToast === 'function') {
        const msg = startRes?.waitSec
          ? `Please wait ${startRes.waitSec}s before a new round`
          : 'Could not start round, try again';
        showToast({ type: 'error', title: 'Error', msg, duration: 3500 });
      }
      return;
    }
    _sessionToken = startRes._t;              // token معتم — لا يُعرض في أي مكان
    _seqRng       = _makePrng(startRes.seed); // PRNG محدد بـ seed من السيرفر

    cdToken++;
    const myToken = cdToken;

    let n = 3;
    const el = document.getElementById('cd-num');
    const ov = document.getElementById('cd-overlay');
    ov.style.display = 'flex';

    const tick = () => {
      if (myToken !== cdToken) return; // countdown ملغى (المستخدم غادر الصفحة)
      el.textContent = n > 0 ? n : 'GO!';
      el.classList.remove('cdpop');
      void el.offsetWidth;
      el.classList.add('cdpop');
      if (n > 0) { n--; setTimeout(tick, 820); }
      else setTimeout(() => {
        if (myToken !== cdToken) return;
        ov.style.display = 'none';
        startGame();
      }, 680);
    };
    tick();
  }

  function startGame() {
    roundScore = 0; timeLeft = DURATION; items = []; popups = []; spawnCd = 0; lastTs = null; running = true;
    _roundEnded = false;
    _caughtIds  = [];
    _basketLog  = [];
    _burstFired = false;
    basketX = W / 2;
    // 🛡️ سجّل موقع السلة كل 500ms — يُرسَل للسيرفر للتحقق المكاني
    if (_basketLogTimer) clearInterval(_basketLogTimer);
    _basketLogTimer = setInterval(() => {
      if (running) _basketLog.push(+(basketX / W).toFixed(3));
    }, 500);
    updateHUD();
    animId = requestAnimationFrame(loop);
  }

  function loop(ts) {
    if (!running) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, .05);
    lastTs = ts;

    timeLeft -= dt;
    if (timeLeft <= 0) { timeLeft = 0; endGame(); return; }

    spawnCd -= dt;
    if (spawnCd <= 0) {
      spawnItem(); // spawnCd يُحدَّث داخل spawnItem بـ seeded roll
    }

    // 🛡️ انفجار قنابل في آخر 5 ثواني — يهلك السلة الثابتة في المنتصف
    if (timeLeft <= 5 && !_burstFired) {
      _burstFired = true;
      _spawnBombBurst();
    }

    items = items.filter(it => {
      it.y   += it.speed * dt;
      it.x   += it.wobble;
      it.ang += .022;
      if (it.x < it.r)     { it.x = it.r;     it.wobble = Math.abs(it.wobble); }
      if (it.x > W - it.r) { it.x = W - it.r; it.wobble = -Math.abs(it.wobble); }
      if (caught(it)) {
        if (!it._burst) _caughtIds.push(it._idx);  // 🛡️ قنابل الانفجار غير مُتتبَّعة
        roundScore = Math.max(0, roundScore + it.val);
        const col = it.val > 0 ? (it.val >= 3 ? '#a78bfa' : '#f5c840') : '#ff5555';
        popups.push({ x: it.x, y: H - BY_OFF - 30, txt: (it.val > 0 ? '+' : '') + it.val + ' 🎟', col, alpha: 1, vy: -2 });
        updateHUD();
        return false;
      }
      return it.y < H + it.r + 10;
    });

    popups = popups.filter(p => { p.y += p.vy; p.alpha -= .028; return p.alpha > 0; });

    updateHUD();
    draw();
    animId = requestAnimationFrame(loop);
  }

  function spawnItem() {
    const t       = pickType();   // استهلاك seeded call #1 — نوع العنصر
    const cdRnd   = _seqRng();   // استهلاك seeded call #2 — spawnCd
    const xRnd    = _seqRng();   // استهلاك seeded call #3 — موقع X (seeded — يتطابق مع السيرفر)
    const biasRnd = _seqRng();   // استهلاك seeded call #4 — center bias (مُستهلَك دائماً)

    const m    = t.r + 14;
    const prog = 1 - timeLeft / DURATION;

    // 🛡️ قنابل: 80% تنزل في المنتصف (30%–70% عرض الشاشة)
    let spawnX;
    if (t.type === 'bomb') {
      spawnX = biasRnd < 0.80
        ? W * 0.30 + xRnd * (W * 0.40)  // zone مركزية
        : m + xRnd * (W - m * 2);         // عشوائي كامل
    } else {
      spawnX = m + xRnd * (W - m * 2);   // تذاكر: عشوائي كامل
    }

    Object.assign(t, {
      x:      spawnX,
      y:      -t.r,
      speed:  120 + prog * 200 + Math.random() * 70,
      wobble: (Math.random() - .5) * 1.4,
      ang:    0,
    });
    items.push(t);
    spawnCd = Math.max(.3, .85 - prog * .5) + cdRnd * .2;
  }

  // 🛡️ انفجار 10 قنابل سريعة في المنتصف — مخصص لآخر 5 ثواني
  // غير مُتتبَّعة في _caughtIds (تأثير بصري + عقوبة محلية فقط)
  function _spawnBombBurst() {
    for (let i = 0; i < 10; i++) {
      setTimeout(() => {
        if (!running) return;
        const bomb = { ...TYPES[2], _idx: -1, _burst: true };
        Object.assign(bomb, {
          x:      W * 0.22 + Math.random() * (W * 0.56), // مركز 22%–78%
          y:      -bomb.r,
          speed:  360 + Math.random() * 80,
          wobble: (Math.random() - .5) * 0.5,
          ang:    0,
        });
        items.push(bomb);
      }, i * 160); // قنبلة كل 160ms
    }
  }

  function caught(it) {
    const catchY = H - BY_OFF + BH / 2;
    const halfW  = BW / 2 + 28;
    const halfH  = 32;
    return Math.abs(it.x - basketX) <= halfW + it.r * 0.3
        && Math.abs(it.y - catchY)  <= halfH + it.r * 0.3;
  }

  /* ── Draw ──────────────────────────────────────────── */
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(245,200,64,.025)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

    items.forEach(drawItem);
    drawBasket();
    popups.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.col;
      ctx.shadowColor = p.col; ctx.shadowBlur = 8;
      ctx.font = 'bold 17px Permanent Marker,cursive';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.txt, p.x, p.y);
      ctx.restore();
    });
  }

  function drawBasket() {
    const y = H - BY_OFF;
    if (BASKET_IMG.complete && BASKET_IMG.naturalWidth) {
      const w = BW + 24;
      const h = w * (BASKET_IMG.naturalHeight / BASKET_IMG.naturalWidth);
      ctx.save();
      ctx.shadowColor = 'rgba(245,200,64,.45)';
      ctx.shadowBlur = 18;
      ctx.drawImage(BASKET_IMG, basketX - w / 2, y - h * 0.3, w, h);
      ctx.restore();
      return;
    }
    // fallback vector basket while asesst/basket.png يتم تحميله أو إن لم يكن موجوداً
    const hw = BW / 2, gap = 16;
    ctx.save();
    ctx.shadowColor = 'rgba(245,200,64,.4)'; ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.moveTo(basketX - hw - gap / 2, y);
    ctx.lineTo(basketX + hw + gap / 2, y);
    ctx.lineTo(basketX + hw, y + BH);
    ctx.lineTo(basketX - hw, y + BH);
    ctx.closePath();
    const g = ctx.createLinearGradient(basketX, y, basketX, y + BH);
    g.addColorStop(0, 'rgba(245,200,64,.18)');
    g.addColorStop(1, 'rgba(245,200,64,.04)');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = '#f5c840'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(basketX - hw - gap / 2 + 5, y + 3);
    ctx.lineTo(basketX + hw + gap / 2 - 5, y + 3);
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  function drawItem(it) {
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(it.ang);

    if (it.type === 'bomb') {
      ctx.shadowColor = 'rgba(255,60,60,.45)'; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, 2, it.r, 0, Math.PI * 2);
      const bg = ctx.createRadialGradient(-5, -5, 2, 0, 0, it.r);
      bg.addColorStop(0, '#4B5563'); bg.addColorStop(1, '#0D0D0D');
      ctx.fillStyle = bg; ctx.fill();
      ctx.strokeStyle = '#6B7280'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(1, -it.r + 2); ctx.quadraticCurveTo(9, -it.r - 8, 5, -it.r - 14);
      ctx.strokeStyle = '#92400E'; ctx.lineWidth = 2.5; ctx.shadowBlur = 0; ctx.stroke();
      ctx.beginPath(); ctx.arc(5, -it.r - 14, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#FCD34D'; ctx.shadowColor = '#FCD34D'; ctx.shadowBlur = 10; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = it.r + 'px serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('💀', 0, 3);
    } else {
      const img = TICKET_IMG;
      const s = it.r * 2;
      if (it.rare) {
        ctx.shadowColor = '#a78bfa'; ctx.shadowBlur = 18;
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, it.r + 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(167,139,250,0.25)'; ctx.fill();
        ctx.restore();
      } else {
        ctx.shadowColor = 'rgba(245,200,64,.6)'; ctx.shadowBlur = 14;
      }
      if (img.complete && img.naturalWidth) {
        ctx.drawImage(img, -s / 2, -s / 2, s, s);
      } else {
        ctx.beginPath(); ctx.arc(0, 0, it.r, 0, Math.PI * 2);
        ctx.fillStyle = it.rare ? '#a78bfa' : '#f5c840'; ctx.fill();
      }
      if (it.rare) {
        ctx.shadowBlur = 0;
        ctx.font = `bold ${it.r * .6}px Permanent Marker,cursive`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText('x4', 0, it.r + 10);
      }
    }
    ctx.restore();
  }

  function updateHUD() {
    document.getElementById('scoreVal').textContent = roundScore;
    const secs = Math.ceil(timeLeft);
    const el = document.getElementById('timerNum');
    el.textContent = secs;
    el.classList.toggle('urgent', secs <= 5);
  }

  /* ── Input ─────────────────────────────────────────── */
  canvas.addEventListener('touchstart', e => { basketX = e.touches[0].clientX; }, { passive: true });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); basketX = e.touches[0].clientX; }, { passive: false });
  canvas.addEventListener('mousemove',  e => { basketX = e.clientX; });

  /* ── End of round ──────────────────────────────────── */
  function endGame() {
    running = false;
    cancelAnimationFrame(animId);
    if (_basketLogTimer) { clearInterval(_basketLogTimer); _basketLogTimer = null; }
    _roundEnded = true; // ← الجولة اكتملت، جاهز للإرسال عند الضغط أو مغادرة الصفحة

    document.getElementById('finalScore').textContent = roundScore.toLocaleString();
    const btn = document.getElementById('adBtn');
    btn.textContent   = ' Double Tickets';
    btn.disabled      = false;
    btn.style.opacity = '1';
    const cb = document.getElementById('claimBtn');
    cb.textContent = '✓ Claim Tickets';
    cb.disabled    = false;
    setTimeout(() => document.getElementById('end-overlay').classList.add('active'), 200);
  }

  /* ── Claim directly (no ad) ────────────────────────── */
  function claimRound() {
    if (!_sessionToken || !_roundEnded) return;
    const cb = document.getElementById('claimBtn');
    const ab = document.getElementById('adBtn');
    cb.disabled    = true;
    ab.disabled    = true;
    ab.style.opacity = '.4';
    cb.textContent = '⏳ Claiming...';
    submitRound();
  }

  /* ── Double via ad ─────────────────────────────────────
     بعد إكمال الإعلان → يتحقق من تأكيد Adsgram S2S على السيرفر
     ويُفعّل المضاعفة داخلياً على الجلسة (بدون إرسال أي قيمة). ── */
  let _gameAdsController = null;
  function getGameAdsController() {
    if (!_gameAdsController && window.Adsgram) {
      _gameAdsController = window.Adsgram.init({ blockId: ADSGRAM_BLOCK_ID });
    }
    return _gameAdsController;
  }

  async function _verifyGameAdWithRetry(tok, maxRetries = 8) {
    for (let i = 0; i < maxRetries; i++) {
      const res = await fetchApi({ type: 'gameAdVerify', data: { _t: tok } });
      if (res?.ok) return true;
      if (res?.error === 'pending_confirmation') {
        await new Promise(r => setTimeout(r, res.retryAfterMs || 1500));
        continue;
      }
      return false;
    }
    return false;
  }

  async function onWatchAd() {
    const btn = document.getElementById('adBtn');
    if (btn.disabled) return;
    if (!_sessionToken || !_roundEnded) return; // لا توجد جولة منتهية

    const adController = getGameAdsController();
    if (!adController) {
      if (typeof showToast === 'function') showToast({ type: 'error', title: 'Error', msg: 'Ad SDK not loaded', duration: 3000 });
      return;
    }

    btn.disabled = true;
    btn.style.opacity = '.6';
    btn.textContent = '⏳ Verifying...';
    document.getElementById('claimBtn').disabled = true; // يمنع claim أثناء الإعلان

    // 1. Complete the ad (SDK)
    try {
      await adController.show();
    } catch {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = ' Double Tickets';
      document.getElementById('claimBtn').disabled = false;
      if (typeof showToast === 'function') showToast({ type: 'error', title: 'Ad Skipped', msg: 'Watch the full ad to double your tickets', duration: 3000 });
      return;
    }

    // 2. Verify Adsgram S2S confirmation on server (with retry)
    btn.textContent = '⏳ Confirming...';
    const verified = await _verifyGameAdWithRetry(_sessionToken);

    if (verified) {
      btn.textContent = '✅ Activated!';
      if (typeof showToast === 'function') showToast({ type: 'success', title: '🎉 Double Ready!', msg: 'Your tickets will be doubled automatically', duration: 2000 });
      setTimeout(() => claimRound(), 900); // auto-claim بعد لحظة
    } else {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = ' Double Tickets';
      document.getElementById('claimBtn').disabled = false;
      if (typeof showToast === 'function') showToast({ type: 'error', title: 'Confirmation Failed', msg: 'Ad not confirmed by server, try again', duration: 3500 });
    }
  }

  function playAgain() {
    submitRound(); // 🛡️ يرسل الجلسة الحالية إلى السيرفر قبل إنشاء جلسة جديدة
    document.getElementById('end-overlay').classList.remove('active');
    startCountdown();
  }

  /* ── Stop (leaving the Game tab) ─────────────────────── */
  function stopGame() {
    running = false;
    if (animId) cancelAnimationFrame(animId);
    if (_basketLogTimer) { clearInterval(_basketLogTimer); _basketLogTimer = null; }
    cdToken++;
    document.getElementById('cd-overlay').style.display = 'none';
    submitRound(); // يرسل الجلسة لو كانت الجولة انتهت قبل أن يغادر المستخدم
    document.getElementById('end-overlay').classList.remove('active');
  }

  /* ── Expose entry points ─────────────────────────────── */
  window.gameStart  = startCountdown; // يُستدعى من pages.js عند دخول تبويب اللعبة
  window.gameStop   = stopGame;       // يُستدعى من pages.js عند مغادرة تبويب اللعبة
  window.onWatchAd  = onWatchAd;      // onclick في index.html
  window.playAgain  = playAgain;      // onclick في index.html
  window.claimRound = claimRound;     // onclick في index.html — كانت مفقودة

})();
