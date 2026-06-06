'use strict';
// ══════════════════════════════════════════════════════════
// api/competition.js — Weekly Ticket Competition API
// GET  /api/competition?action=leaderboard  → قائمة المتصدرين
// POST — earn_ticket مُلغى (استُبدل بـ grant_competition_tickets في api/index.js)
// ══════════════════════════════════════════════════════════

const { sql, ensureBootstrap } = require('../lib/db');
const { CFG }                  = require('../lib/config');
const { hashIp, getIp }        = require('../lib/utils');
const { validateSession }      = require('../lib/security');

// ── Bootstrap جداول المسابقة ──────────────────────────────
async function ensureCompetitionTables() {
  await sql(`
    CREATE TABLE IF NOT EXISTS competition_seasons (
      id          BIGSERIAL PRIMARY KEY,
      start_date  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      end_date    TIMESTAMPTZ NOT NULL,
      prize_text  TEXT        DEFAULT '10$',
      is_active   BOOLEAN     DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await sql(`
    CREATE TABLE IF NOT EXISTS competition_tickets (
      id         BIGSERIAL PRIMARY KEY,
      season_id  BIGINT      NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
      user_id    BIGINT      NOT NULL,
      tickets    BIGINT      DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(season_id, user_id)
    )
  `);
  // index للترتيب السريع
  await sql(`
    CREATE INDEX IF NOT EXISTS idx_comp_tickets_season_tickets
    ON competition_tickets(season_id, tickets DESC)
  `).catch(() => {});
}

// ── الحصول على الموسم النشط (أو إنشاء واحد تلقائياً) ─────
async function getActiveSeason() {
  let rows = await sql(
    `SELECT * FROM competition_seasons WHERE is_active=TRUE ORDER BY id DESC LIMIT 1`
  );
  if (rows.length === 0) {
    // أنشئ موسم افتراضي 14 يوم
    const endDate = new Date(Date.now() + 14 * 86400000);
    const ins = await sql(
      `INSERT INTO competition_seasons(end_date, prize_text, is_active)
       VALUES($1, '10$', TRUE) RETURNING *`,
      [endDate.toISOString()]
    );
    rows = ins;
  }
  return rows[0];
}

// ── Leaderboard Handler ───────────────────────────────────
async function handleLeaderboard(req, res, userId) {
  await ensureCompetitionTables();
  const season = await getActiveSeason();

  // أفضل 10
  const lb = await sql(
    `SELECT ct.user_id, ct.tickets,
            COALESCE(u.tg_first_name, u.tg_username, 'مستخدم') AS name,
            up.photo_url
     FROM competition_tickets ct
     LEFT JOIN users u ON u.id = ct.user_id
     LEFT JOIN user_photos up ON up.user_id = ct.user_id
     WHERE ct.season_id = $1
     ORDER BY ct.tickets DESC
     LIMIT 10`,
    [season.id]
  );

  // ترتيبي الشخصي
  let myRank = null;
  let myTickets = 0;
  if (userId) {
    const myRow = await sql(
      `SELECT tickets FROM competition_tickets WHERE season_id=$1 AND user_id=$2`,
      [season.id, userId]
    );
    myTickets = parseInt(myRow[0]?.tickets) || 0;

    if (myTickets > 0) {
      const rankRow = await sql(
        `SELECT COUNT(*)+1 AS rank FROM competition_tickets
         WHERE season_id=$1 AND tickets > $2`,
        [season.id, myTickets]
      );
      myRank = parseInt(rankRow[0]?.rank) || null;
    }
  }

  return res.status(200).json({
    ok: true,
    end_date:    season.end_date,
    prize_text:  season.prize_text,
    leaderboard: lb.map((r, i) => ({
      rank:      i + 1,
      name:      r.name,
      tickets:   parseInt(r.tickets) || 0,
      photo_url: r.photo_url || null,
    })),
    my_rank:    myRank,
    my_tickets: myTickets,
  });
}

// ── منح تذاكر (يُستدعى داخلياً فقط — من services.js أو index.js) ─────
// [FIX-1] إزالة الـ POST /earn_ticket العام تماماً — كان بدون مصادقة
// [FIX-3] إضافة حد يومي: MAX_TICKETS_PER_DAY
async function grantTickets(userId, count) {
  await ensureCompetitionTables();
  const season = await getActiveSeason();

  // تحقق أن الموسم لم ينته
  if (new Date(season.end_date) < new Date()) return { ok: false, error: 'season_ended' };

  // [FIX-3] التحقق من الحد اليومي للتذاكر
  const MAX_DAILY = CFG.COMPETITION_MAX_TICKETS_PER_DAY;   // من config.js
  const MAX_GRANT = CFG.COMPETITION_MAX_GRANT_PER_CALL;    // حد كل عملية منح واحدة

  // تحقق من أن الـ count ضمن الحد المسموح للعملية الواحدة
  const safeCount = Math.min(Math.max(1, parseInt(count) || 1), MAX_GRANT);

  // اعرف كم تذكرة منح اليوم للمستخدم
  const todayRow = await sql(
    `SELECT COALESCE(SUM(tickets_delta), 0) AS today_total
     FROM competition_ticket_log
     WHERE user_id=$1 AND season_id=$2 AND log_date=CURRENT_DATE`,
    [userId, season.id]
  ).catch(() => [{ today_total: 0 }]);

  const todayTotal = parseInt(todayRow[0]?.today_total) || 0;
  if (todayTotal >= MAX_DAILY) {
    return { ok: false, error: 'daily_ticket_limit_reached', today: todayTotal };
  }

  // تأكد أنك لا تعطي أكثر من الحد اليومي المتبقي
  const allowed = Math.min(safeCount, MAX_DAILY - todayTotal);
  if (allowed <= 0) return { ok: false, error: 'daily_ticket_limit_reached', today: todayTotal };

  // Upsert
  const r = await sql(
    `INSERT INTO competition_tickets(season_id, user_id, tickets)
     VALUES($1, $2, $3)
     ON CONFLICT(season_id, user_id) DO UPDATE
       SET tickets    = competition_tickets.tickets + $3,
           updated_at = NOW()
     RETURNING tickets`,
    [season.id, userId, allowed]
  );

  // سجّل في جدول اللوج اليومي (CREATE IF NOT EXISTS أول مرة يُستدعى)
  await sql(
    `CREATE TABLE IF NOT EXISTS competition_ticket_log (
       id           BIGSERIAL PRIMARY KEY,
       user_id      BIGINT      NOT NULL,
       season_id    BIGINT      NOT NULL,
       tickets_delta BIGINT     NOT NULL,
       source       TEXT        DEFAULT 'unknown',
       log_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
       created_at   TIMESTAMPTZ DEFAULT NOW()
     )`
  ).catch(() => {});
  await sql(
    `INSERT INTO competition_ticket_log(user_id, season_id, tickets_delta, source)
     VALUES($1, $2, $3, 'grant')`,
    [userId, season.id, allowed]
  ).catch(() => {});

  return { ok: true, tickets: parseInt(r[0]?.tickets) || 0, granted: allowed };
}

// ── Main Handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  try { await ensureBootstrap(); } catch (_) {}

  // [FIX-4] تقييد CORS — لا نسمح * على endpoint يُعدّل بيانات
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://yourdomain.com';
  const origin = req.headers['origin'] || '';
  res.setHeader('Access-Control-Allow-Origin', origin === allowedOrigin ? origin : allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Telegram-Init-Data, X-Session-Id, X-Session-ID'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();

  const url    = req.url || '';
  const action = url.includes('action=') ? url.split('action=')[1].split('&')[0] : '';

  // ── GET leaderboard (public) ──────────────────────────
  if (req.method === 'GET' && action === 'leaderboard') {
    // نحاول نجيب userId من initData لو موجود
    let userId = null;
    try {
      const sessionId =
        req.headers['x-session-id'] ||
        req.headers['x-session-ID'] ||
        req.headers['X-Session-Id'] ||
        '';
      if (sessionId) {
        const ipHash = hashIp(getIp(req));
        const fpHash = req.headers['x-fingerprint'] || '';
        const sess   = await validateSession(sessionId, ipHash, fpHash);
        if (sess?.user_id) userId = sess.user_id;
      }
    } catch (_) {}
    return handleLeaderboard(req, res, userId);
  }

  // [FIX-1] POST earn_ticket مُزال تماماً — لا يوجد endpoint عام لمنح تذاكر
  // التذاكر تُمنح فقط من الداخل عبر grantTickets() في index.js

  return res.status(404).json({ error: 'not_found' });
};

// ── Export grantTickets للاستخدام الداخلي فقط ──────────────
module.exports.grantTickets = grantTickets;
