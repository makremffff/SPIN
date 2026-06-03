'use strict';
// ── Competition Page ─────────────────────────────────────────────────────────

let _compLoaded = false;

export async function initCompetitionPage() {
  if (_compLoaded) return;
  _compLoaded = true;
  await _loadCompetition();
}

async function _loadCompetition() {
  try {
    const { postAPI } = await import('./app-core.js');
    const data = await postAPI({ type: 'get_competition' });
    if (!data?.ok) return;

    if (!data.competition) {
      document.getElementById('comp-loading')?.remove();
      return;
    }

    // countdown
    _startCountdown(new Date(data.competition.ends_at));

    // prizes
    _el('comp-prize-1').textContent = data.competition.prize_1;
    _el('comp-prize-2').textContent = data.competition.prize_2;
    _el('comp-prize-3').textContent = data.competition.prize_3;

    // leaderboard
    const lb = data.leaderboard || [];
    _renderPodium(lb, data.competition);
    _renderList(lb);

    // my rank card
    if (data.my_rank) {
      const card = _el('comp-my-rank-card');
      if (card) {
        card.style.display = 'flex';
        _el('comp-my-rank-num').textContent  = '#' + data.my_rank;
        _el('comp-my-tickets-num').textContent = (data.my_tickets || 0).toLocaleString('ar');
      }
    }

    document.getElementById('comp-loading')?.remove();
    document.getElementById('comp-content').style.display = 'block';

  } catch (e) {
    console.error('[Competition]', e);
  }
}

function _el(id) { return document.getElementById(id); }

const AV_CLASSES  = ['av-purple','av-teal','av-rose','av-amber','av-sky','av-green','av-indigo'];
const AV_COLORS   = ['#7c6fff','#2dd4bf','#f472b6','#fbbf24','#38bdf8','#4ade80','#818cf8'];
const AV_GLOWS    = ['rgba(124,111,255,0.15)','rgba(45,212,191,0.12)','rgba(244,114,182,0.12)',
                     'rgba(251,191,36,0.12)','rgba(56,189,248,0.12)','rgba(74,222,128,0.12)','rgba(129,140,248,0.12)'];

function _nameInitial(name) { return name ? [...name][0] : '؟'; }

function _avatarSVG(color, init, size=46) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 46 46" fill="none">
    <circle cx="23" cy="18" r="9"  fill="${color}25"/>
    <ellipse cx="23" cy="40" rx="16" ry="11" fill="${color}25"/>
    <circle cx="23" cy="18" r="7"  fill="${color}80"/>
    <ellipse cx="23" cy="39" rx="12" ry="9"  fill="${color}80"/>
    <text x="23" y="22" text-anchor="middle" dominant-baseline="middle"
      font-family="Tajawal,sans-serif" font-size="11" font-weight="800" fill="${color}">${init}</text>
  </svg>`;
}

function _renderPodium(lb, comp) {
  const wrap = _el('comp-podium');
  if (!wrap) return;

  // top 3
  const p1 = lb.find(r => r.rank === 1);
  const p2 = lb.find(r => r.rank === 2);
  const p3 = lb.find(r => r.rank === 3);

  function podHTML(p, rankCls, prizeKey) {
    if (!p) return `<div class="pod-item ${rankCls}"><div class="pod-face" style="width:60px;height:60px;background:#111;border-radius:50%;"></div></div>`;
    const idx  = (p.rank - 1) % AV_CLASSES.length;
    const cls  = AV_CLASSES[idx];
    const col  = AV_COLORS[idx];
    const init = _nameInitial(p.name);
    const prize = comp[prizeKey];
    return `
      <div class="pod-item ${rankCls}">
        <div class="crown-wrap">${rankCls === 'rank-1-item' ? _crown1() : _crownSmall(rankCls)}</div>
        <div class="pod-ring">
          <div class="pod-inner">
            <div class="pod-face ${cls}">${_avatarSVG(col, init, rankCls === 'rank-1-item' ? 78 : 60)}</div>
          </div>
        </div>
        <div class="pod-name">${_esc(p.name)}</div>
        <div class="pod-ticket-badge">
          <img src="asesst/ticket.jpg" alt="t"/>
          <span class="num">${p.tickets.toLocaleString('ar')}</span>
        </div>
        <div class="pod-prize">${prize}</div>
      </div>`;
  }

  wrap.innerHTML =
    podHTML(p2, 'rank-2-item', 'prize_2') +
    podHTML(p1, 'rank-1-item', 'prize_1') +
    podHTML(p3, 'rank-3-item', 'prize_3');
}

function _renderList(lb) {
  const wrap = _el('comp-lb-list');
  if (!wrap) return;
  const rest = lb.filter(r => r.rank > 3);
  if (!rest.length) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = rest.map((u, i) => {
    const idx  = i % AV_CLASSES.length;
    const c    = AV_COLORS[idx];
    const cg   = AV_GLOWS[idx];
    const init = _nameInitial(u.name);
    return `
    <div class="lc" style="animation-delay:${i*0.06}s;--c:${c};--c-glow:${cg};">
      <div class="lc-stripe"></div>
      <div class="lc-rank-wrap"><div class="lc-rank">${u.rank}</div></div>
      <div class="lc-av-wrap">
        <div class="lc-av ${AV_CLASSES[idx]}">${_avatarSVG(c, init, 46)}</div>
      </div>
      <div class="lc-info">
        <div class="lc-name">${_esc(u.name)}</div>
        <div class="lc-ticket-row">
          <div class="lc-ticket-img-wrap"><img src="asesst/ticket.jpg" alt="ticket" draggable="false"/></div>
          <div class="lc-count" style="color:${c}">${u.tickets.toLocaleString('ar')}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Countdown ────────────────────────────────────────────────────────────────
function _startCountdown(end) {
  function pad2(n) { return String(n).padStart(2,'0'); }
  function setBox(id, val) {
    const el = _el(id); if (!el) return;
    const v = pad2(val);
    if (el.textContent !== v) {
      el.classList.remove('flipping'); void el.offsetWidth; el.classList.add('flipping');
      el.textContent = v;
    }
  }
  (function tick() {
    const d = end - Date.now();
    if (d <= 0) return ['comp-cd-days','comp-cd-hours','comp-cd-mins','comp-cd-secs'].forEach(x => setBox(x, 0));
    setBox('comp-cd-days',  Math.floor(d / 86400000));
    setBox('comp-cd-hours', Math.floor((d % 86400000) / 3600000));
    setBox('comp-cd-mins',  Math.floor((d % 3600000) / 60000));
    setBox('comp-cd-secs',  Math.floor((d % 60000) / 1000));
    setTimeout(tick, 1000);
  })();
}

// ── Crown images ─────────────────────────────────────────────────────────────
function _crown1() {
  return `<img src="asesst/frst.png" alt="🥇" draggable="false" style="width:116px;height:92px;object-fit:contain;display:block;"/>`;
}
function _crownSmall(cls) {
  const src = cls === 'rank-2-item' ? 'asesst/sec.png' : 'asesst/thrd.png';
  return `<img src="${src}" alt="🏅" draggable="false" style="width:76px;height:60px;object-fit:contain;display:block;"/>`;
}
