'use strict';
// ══════════════════════════════════════════════════════════
// api/competition.js — Weekly Ticket Competition API
// GET  /api/competition?action=leaderboard  → قائمة المتصدرين
// POST /api/competition  body: { action: 'earn_ticket', count: N }  → منح تذاكر
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

// ── منح تذاكر (يُستدعى من monetag_reward) ────────────────
async function grantTickets(userId, count) {
  await ensureCompetitionTables();
  const season = await getActiveSeason();

  // تحقق أن الموسم لم ينته
  if (new Date(season.end_date) < new Date()) return { ok: false, error: 'season_ended' };

  const r = await sql(
    `INSERT INTO competition_tickets(season_id, user_id, tickets)
     VALUES($1, $2, $3)
     ON CONFLICT(season_id, user_id) DO UPDATE
       SET tickets    = competition_tickets.tickets + $3,
           updated_at = NOW()
     RETURNING tickets`,
    [season.id, userId, count]
  );
  return { ok: true, tickets: parseInt(r[0]?.tickets) || 0 };
}

// ── Main Handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  try { await ensureBootstrap(); } catch (_) {}

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  // ── POST earn_ticket ──────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'invalid_json' }); }
    }
    if (!body) body = {};

    if (body.action === 'earn_ticket') {
      const { userId, count } = body;
      if (!userId || !count) return res.status(400).json({ error: 'missing_params' });

      const result = await grantTickets(userId, count);
      return res.status(200).json(result);
    }
  }

  return res.status(404).json({ error: 'not_found' });
};

// ── Export grantTickets للاستخدام الداخلي ─────────────────
module.exports.grantTickets = grantTickets;
