'use strict';

const { CFG, ADMIN_SECRET } = require('./config');
const { rateLimitMap, ensureBootstrap } = require('./db');
const { hashIp, hashFp, getIp, verifyTg, rateLimit } = require('./utils');
const { validateSession, issueNonce, writeAudit } = require('./security');
const {
  handleGetConfig, handleCreateSession, handleLoad, handleGetState,
  handleStartAd, handleRewardAd, handleStartAdsgramTask, handleClaimAdsgramTask,
  handleClaimDailyMission, handleClaimGift, handleGetChannels,
  handleVerifyChannelTask, handleVerifyTgTask, handleSubmitWithdraw,
  handleGetReferrals, handleTrackAdEvent, handleAdmin, handleAdsgramCallback,
} = require('./services');

module.exports = async function handler(req, res) {
  // ── Ensure DB is bootstrapped before handling any request ─────
  try { await ensureBootstrap(); } catch (_) {}

  // ── GET /config — Dynamic Config ──────────────────────────────
  if (req.method === 'GET' && (req.url || '').includes('/config')) {
    res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).json(handleGetConfig());
  }

  // ── Adsgram Server Callback ────────────────────────────────────
  if (req.method === 'GET' && (req.url || '').includes('adsgram-reward')) {
    return handleAdsgramCallback(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Init-Data, X-Fingerprint, X-Nonce, X-Admin-Secret, X-Session-Id, X-Session-ID'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') body = {};

  const type = body?.type || '';
  if (!type) return res.status(400).json({ error: 'missing_type' });

  // ── Session extraction ─────────────────────────────────────────
  const cookieHeader = req.headers['cookie'] || '';
  const sidMatch     = cookieHeader.match(/(?:^|;)\s*sid=([^;]+)/);
  const sessionFromCookie = sidMatch ? decodeURIComponent(sidMatch[1]) : '';
  const sessionFromHeader = req.headers['x-session-id'] || req.headers['x-session-Id'] || '';
  const sessionId = sessionFromCookie || sessionFromHeader;

  const fpRaw    = req.headers['x-fingerprint']  || '{}';
  const rawNonce = req.headers['x-nonce']        || '';
  const adminKey = req.headers['x-admin-secret'] || '';

  const ipHash = hashIp(getIp(req));
  let fpData = {};
  try { fpData = JSON.parse(fpRaw); } catch (_) {}
  const fpHash = hashFp(fpData);

  // ── Rate limit per IP ──────────────────────────────────────────
  const isWrite = !['load', 'get_state', 'create_session', 'get_referrals', 'track_ad_event', 'start_ad'].includes(type);
  if (!rateLimit(`ip_${ipHash}_${type}`, isWrite ? CFG.RATE_WRITE_MAX : CFG.RATE_MAX)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  try {
    // ── Admin ─────────────────────────────────────────────────────
    if (type === 'admin') {
      if (adminKey !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.status(200).json(await handleAdmin(body?.action, body));
    }

    // ── Issue Nonce (for client to use in write operations) ───────
    if (type === 'get_nonce') {
      if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });
      const session = await validateSession(sessionId, ipHash, fpHash);
      if (!session) return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
      const action = body?.data?.action || 'general';
      const nonce = await issueNonce(sessionId, session.user_id, ipHash, fpHash, action);
      return res.status(200).json({ ok: true, nonce });
    }

    // ── Create Session ────────────────────────────────────────────
    if (type === 'create_session') {
      const result = await handleCreateSession(body, ipHash, fpHash);
      if (result._sid) {
        const maxAge  = Math.floor(CFG.SESSION_TTL_MS / 1000);
        const isHttps = req.headers['x-forwarded-proto'] === 'https'
          || req.connection?.encrypted
          || process.env.NODE_ENV === 'production';
        const sameSite = isHttps ? 'None' : 'Lax';
        const secure   = isHttps ? '; Secure' : '';
        res.setHeader('Set-Cookie',
          `sid=${encodeURIComponent(result._sid)}; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=${maxAge}; Path=/`
        );
        result._session_token = result._sid;
        delete result._sid;
      }
      return res.status(result.status || 200).json(result);
    }

    // ── Session validation ─────────────────────────────────────────
    if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });
    const session = await validateSession(sessionId, ipHash, fpHash);
    if (!session)  return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
    if (session.is_banned || session.cluster_ban) {
      return res.status(403).json({ ok: false, is_banned: true });
    }

    const userId = session.user_id;

    // ── Rate limit per User ────────────────────────────────────────
    if (!rateLimit(`u_${userId}_${type}`, isWrite ? 10 : 20)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    let result;
    switch (type) {
      case 'load':
        result = await handleLoad(userId);
        break;
      case 'get_state':
        result = await handleGetState(userId);
        break;
      case 'start_ad':
        result = await handleStartAd(userId, sessionId, ipHash, fpHash);
        break;
      case 'reward_ad':
        result = await handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce);
        break;
      case 'start_adsgram_task':
        result = await handleStartAdsgramTask(userId, sessionId, ipHash, fpHash);
        break;
      case 'claim_adsgram_task':
        result = await handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash, rawNonce);
        break;
      case 'claim_daily_mission':
        result = await handleClaimDailyMission(userId, body, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'claim_gift':
        result = await handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'verify_tg_task':
        result = await handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'submit_withdraw':
        result = await handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'get_channels':
        result = await handleGetChannels(userId);
        break;
      case 'verify_channel_task':
        result = await handleVerifyChannelTask(userId, body, rawNonce, sessionId, fpHash, ipHash);
        break;
      case 'get_referrals':
        result = await handleGetReferrals(userId);
        break;
      case 'track_ad_event':
        result = await handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash);
        break;
      default:
        console.warn(`[UNKNOWN_ACTION] type=${type} userId=${userId}`);
        await writeAudit(userId, sessionId, type, 'unknown_action', ipHash, fpHash, { type });
        result = { ok: false, error: 'unknown_action' };
    }

    // ✅ Shadow ban: نُرجع honest response — لا fake success
    // (تمت المعالجة داخل كل handler بشكل منفصل)

    return res.status(200).json(result);

  } catch (e) {
    console.error(`[${type}] Error:`, e.message, e.stack?.split('\n')[1]);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      detail: e.message,   // ✅ دائماً — لتسهيل debugging في production
      type,
    });
  }
};
