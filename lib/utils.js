'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('crypto');
const { CFG, BOT_TOKEN, IP_SALT, IS_DEV } = require('./config');
const { rateLimitMap } = require('./db');

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

function genRawNonce(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function constantTimeCompare(a, b) {
  try {
    const sA = String(a || '');
    const sB = String(b || '');
    const bufA = Buffer.from(sha256(sA), 'hex');
    const bufB = Buffer.from(sha256(sB), 'hex');
    const match = timingSafeEqual(bufA, bufB);
    return match && sA === sB;
  } catch (_) { return false; }
}

function hashIp(ip) {
  return sha256((ip || '') + IP_SALT).slice(0, 32);
}

function hashFp(fp, sessionId) {
  try {
    const data = typeof fp === 'string' ? fp : JSON.stringify(fp);
  return sha256(data + (sessionId || '') + IP_SALT).slice(0, 40);
  } catch (_) { return 'unknown'; }
}

function computeLevel(xp) {
  const t = CFG.LEVEL_THRESHOLDS;
  for (let i = t.length - 1; i >= 0; i--) if (xp >= t[i]) return i;
  return 1;
}

function giftReward(day) {
  return CFG.GIFT_REWARDS[Math.min(day - 1, CFG.GIFT_REWARDS.length - 1)] || 100;
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || '0.0.0.0';
}

function isValidTon(addr) {
  const a = (addr || '').trim();
  return (a.startsWith('EQ') || a.startsWith('UQ') || a.startsWith('0:')) && a.length >= 48;
}

function verifyTg(initData) {
  if (!initData || !BOT_TOKEN) {
    return IS_DEV
      ? { ok: true, data: { id: 99999999, first_name: 'Dev', language_code: 'ar' } }
      : { ok: false };
  }
  try {
    const p = new URLSearchParams(initData), hash = p.get('hash');
    if (!hash) return { ok: false };
    p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const sk  = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (createHmac('sha256', sk).update(str).digest('hex') !== hash) return { ok: false };
    if (Math.floor(Date.now() / 1000) - parseInt(p.get('auth_date') || '0') > 300) return { ok: false };
    return { ok: true, data: JSON.parse(p.get('user') || '{}') };
  } catch (_) { return { ok: false }; }
}

function rateLimit(key, max = CFG.RATE_MAX) {
  const now = Date.now();
  let e = rateLimitMap.get(key);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + CFG.RATE_WINDOW_MS };
    rateLimitMap.set(key, e);
  }
  return ++e.count <= max;
}

// ── Structured logging helpers ────────────────────────────────────
function logRisk(reason, userId, extra = {}) {
  console.warn(`[RISK] reason=${reason} userId=${userId}`, JSON.stringify(extra));
}
function logShadow(reason, userId, extra = {}) {
  console.warn(`[SHADOW_BAN] reason=${reason} userId=${userId}`, JSON.stringify(extra));
}
function logRewardBlock(reason, userId, extra = {}) {
  console.info(`[REWARD_BLOCK] reason=${reason} userId=${userId}`, JSON.stringify(extra));
}
function logFingerprintChange(userId, oldFp, newFp) {
  console.info(`[FP_CHANGE] userId=${userId} old=${oldFp?.slice(0,8)} new=${newFp?.slice(0,8)}`);
}
function logAdsgramState(userId, state, extra = {}) {
  console.info(`[ADSGRAM] userId=${userId} state=${state}`, JSON.stringify(extra));
}


module.exports = {
  sha256, genRawNonce, constantTimeCompare,
  hashIp, hashFp, computeLevel, giftReward,
  getIp, isValidTon, verifyTg, rateLimit,
  logRisk, logShadow, logRewardBlock, logFingerprintChange, logAdsgramState,
};
