'use strict';

const { CFG } = require('./config');
const { sql } = require('./db');
const {
  genRawNonce, constantTimeCompare, logRisk, logShadow, logFingerprintChange,
  sha256,
} = require('./utils');
const { createHmac } = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// HMAC NONCE SIGNING
// كل nonce يُوقَّع بـ HMAC-SHA256 ليتضمن:
//   sessionId + userId + action + expires_at
// لا يمكن تزوير nonce حتى لو شاهده المهاجم
// ═══════════════════════════════════════════════════════════════════
const NONCE_HMAC_SECRET = process.env.NONCE_SECRET;
if (!NONCE_HMAC_SECRET) throw new Error('[SECURITY] NONCE_SECRET env var is required — set it in Vercel environment variables');

function signNonce(rawNonce, sessionId, userId, action, expiresAt) {
  const payload = `${rawNonce}:${sessionId}:${userId}:${action}:${expiresAt}`;
  return createHmac('sha256', NONCE_HMAC_SECRET).update(payload).digest('hex').slice(0, 32);
}

function buildSignedNonce(rawNonce, sessionId, userId, action, expiresAt) {
  const sig = signNonce(rawNonce, sessionId, userId, action, expiresAt);
  // Format: rawNonce.sig (مرئي للمستخدم — لكن عديم الفائدة بدون السر)
  return `${rawNonce}.${sig}`;
}

function parseSignedNonce(signedNonce) {
  if (!signedNonce || typeof signedNonce !== 'string') return null;
  const dotIdx = signedNonce.lastIndexOf('.');
  if (dotIdx < 32) return null; // rawNonce يجب أن يكون 64 hex chars
  return {
    raw: signedNonce.slice(0, dotIdx),
    sig: signedNonce.slice(dotIdx + 1),
  };
}


// ═══════════════════════════════════════════════════════════════════
// SESSION VALIDATION
// ═══════════════════════════════════════════════════════════════════
async function validateSession(sid, ipHash, fpHash) {
  if (!sid) return null;
  const r = await sql(
    `SELECT s.*, u.is_banned, u.is_shadow_banned, u.cluster_ban, u.risk_score
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1
       AND s.is_revoked = FALSE
       AND s.expires_at > NOW()
     LIMIT 1`,
    [sid]
  );
  if (!r.length) return null;
  const session = r[0];

  // ── Fingerprint change — soft verification (no immediate ban) ──
  if (session.fingerprint_hash && fpHash && session.fingerprint_hash !== fpHash) {
    logFingerprintChange(session.user_id, session.fingerprint_hash, fpHash);

    const userRow = (await sql(`SELECT created_at FROM users WHERE id=$1`, [session.user_id]))[0];
    const accountAgeMs = userRow ? Date.now() - new Date(userRow.created_at).getTime() : 999999999;
    const isNewAccount = accountAgeMs < CFG.ACCOUNT_AGE_PROTECTION_MS;

    if (!isNewAccount) {
      await addRisk(session.user_id, 'session_fp_change', ipHash, fpHash, 8,
        { old_fp: session.fingerprint_hash?.slice(0,8), new_fp: fpHash?.slice(0,8) });
      await writeAudit(session.user_id, sid, 'session_validate', 'fp_mismatch_risk', ipHash, fpHash, {
        fingerprint_change_reason: 'fp_changed_soft_verify',
        old_fp: session.fingerprint_hash?.slice(0,8),
        new_fp: fpHash?.slice(0,8),
        is_new_account: false,
      });
    } else {
      console.info(`[FP_CHANGE] New account grace — no risk for userId=${session.user_id}`);
    }
  }

  await sql(`UPDATE sessions SET last_active=NOW() WHERE id=$1`, [sid]);
  return session;
}


// ═══════════════════════════════════════════════════════════════════
// AD NONCE — نفس نظام HMAC
// ═══════════════════════════════════════════════════════════════════
async function issueAdNonce(sessionId, userId, ipHash) {
  const rawNonce = genRawNonce(32);
  const exp      = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();
  const signed   = buildSignedNonce(rawNonce, sessionId, userId, 'reward_ad', exp);
  // نخزن الـ rawNonce فقط في DB (لا نخزن الـ signature)
  const r = await sql(
    `UPDATE sessions
     SET ad_nonce=$1, ad_nonce_exp=$2, ad_nonce_used=FALSE
     WHERE id=$3 AND is_revoked=FALSE
     RETURNING id`,
    [rawNonce, exp, sessionId]
  );
  return r.length ? signed : null;
}

async function issueTaddyNonce(sessionId, userId, ipHash) {
  const rawNonce = genRawNonce(32);
  const exp      = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();
  const signed   = buildSignedNonce(rawNonce, sessionId, userId, 'reward_taddy_ad', exp);
  const r = await sql(
    `UPDATE sessions
     SET taddy_nonce=$1, taddy_nonce_exp=$2, taddy_nonce_used=FALSE
     WHERE id=$3 AND is_revoked=FALSE
     RETURNING id`,
    [rawNonce, exp, sessionId]
  );
  return r.length ? signed : null;
}


// ═══════════════════════════════════════════════════════════════════
// GENERAL NONCE — للعمليات الحساسة (claim_gift, withdraw, إلخ)
// ═══════════════════════════════════════════════════════════════════
async function issueNonce(sessionId, userId, ipHash, fpHash, action) {
  // ✅ إلغاء أي nonce قديم غير مستخدم لنفس الـ action — يمنع nonce farming
  await sql(
    `UPDATE nonces SET used=TRUE
     WHERE session_id=$1 AND user_id=$2 AND action=$3 AND used=FALSE`,
    [sessionId, userId, action]
  );
  const rawNonce = genRawNonce(32);
  const exp      = new Date(Date.now() + CFG.NONCE_TTL_MS).toISOString();
  const signed   = buildSignedNonce(rawNonce, sessionId, userId, action, exp);
  await sql(
    `INSERT INTO nonces(nonce, session_id, user_id, ip_hash, fp_hash, action, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [rawNonce, sessionId, userId, ipHash, fpHash, action, exp]
  );
  return signed;
}


// ═══════════════════════════════════════════════════════════════════
// CONSUME GENERAL NONCE — مع HMAC verification
// ═══════════════════════════════════════════════════════════════════
async function consumeNonce(signedNonce, sessionId, userId, fpHash, ipHash, action) {
  if (!signedNonce) return 'missing';

  // [1] Parse signature
  const parsed = parseSignedNonce(signedNonce);
  if (!parsed) return 'invalid';
  const { raw: rawNonce, sig: clientSig } = parsed;

  // [2] Fetch from DB
  const r = await sql(
    `SELECT id, ip_hash, fp_hash, action, used, expires_at
     FROM nonces
     WHERE nonce=$1 AND session_id=$2 AND user_id=$3 AND used=FALSE
     LIMIT 1`,
    [rawNonce, sessionId, userId]
  );
  if (!r.length) return 'invalid';
  const n = r[0];

  if (n.used) { await addRisk(userId, 'nonce_replay', ipHash, fpHash, 20); return 'replay'; }
  if (new Date(n.expires_at) < new Date()) return 'expired';
  if (n.action && n.action !== action) {
    await addRisk(userId, 'nonce_action_mismatch', ipHash, fpHash, 15);
    return 'action_mismatch';
  }

  // [3] Verify HMAC signature
  const expectedSig = signNonce(rawNonce, sessionId, userId, action, new Date(n.expires_at).toISOString());
  if (!constantTimeCompare(clientSig, expectedSig)) {
    await addRisk(userId, 'nonce_signature_invalid', ipHash, fpHash, 25);
    return 'invalid_signature';
  }

  // [4] FP binding
  if (!constantTimeCompare(n.fp_hash || fpHash, fpHash)) {
    await addRisk(userId, 'nonce_fp_mismatch', ipHash, fpHash, 15);
    return 'fp_mismatch';
  }

  // [5] Atomic consume
  const consumed = await sql(
    `UPDATE nonces SET used=TRUE WHERE id=$1 AND used=FALSE RETURNING id`,
    [n.id]
  );
  if (!consumed.length) return 'race';
  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// CONSUME AD NONCE — مع HMAC verification + IP binding
// ═══════════════════════════════════════════════════════════════════
async function consumeAdNonce(sessionId, signedNonce, userId, ipHash, fpHash) {
  if (!signedNonce) {
    await addRisk(userId, 'reward_ad_no_nonce', ipHash, fpHash, 15);
    return 'missing';
  }

  // [1] Parse
  const parsed = parseSignedNonce(signedNonce);
  if (!parsed) {
    await addRisk(userId, 'reward_ad_nonce_malformed', ipHash, fpHash, 20);
    return 'invalid';
  }
  const { raw: rawNonce, sig: clientSig } = parsed;

  // [2] Fetch session
  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp, ad_nonce_used, ip_hash
     FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) return 'invalid';
  const { ad_nonce, ad_nonce_exp, ad_nonce_used, ip_hash: sessionIpHash } = rows[0];

  if (!ad_nonce) { await addRisk(userId, 'reward_ad_no_nonce_issued', ipHash, fpHash, 15); return 'not_issued'; }
  if (ad_nonce_used) { await addRisk(userId, 'reward_ad_nonce_reuse', ipHash, fpHash, 30); return 'replay'; }
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(`UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`, [sessionId]);
    return 'expired';
  }

  // [3] Verify raw nonce matches DB
  if (!constantTimeCompare(rawNonce, ad_nonce)) {
    await addRisk(userId, 'reward_ad_nonce_mismatch', ipHash, fpHash, 40);
    return 'mismatch';
  }

  // [4] Verify HMAC signature
  const expectedSig = signNonce(ad_nonce, sessionId, userId, 'reward_ad', new Date(ad_nonce_exp).toISOString());
  if (!constantTimeCompare(clientSig, expectedSig)) {
    await addRisk(userId, 'reward_ad_signature_invalid', ipHash, fpHash, 40);
    return 'invalid_signature';
  }

  // [FIX-3] Atomic consume مع SELECT FOR UPDATE لمنع race condition
  const { sql: rawSql } = require('./db');
  let consumed = [];
  try {
    await rawSql('BEGIN');
    const locked = await rawSql(
      `SELECT id FROM sessions WHERE id=$1 AND ad_nonce=$2 AND ad_nonce_used=FALSE FOR UPDATE SKIP LOCKED`,
      [sessionId, ad_nonce]
    );
    if (!locked.length) {
      await rawSql('ROLLBACK');
      await addRisk(userId, 'reward_ad_race_condition', ipHash, fpHash, 10);
      return 'race';
    }
    consumed = await rawSql(
      `UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE WHERE id=$1 RETURNING id`,
      [sessionId]
    );
    await rawSql('COMMIT');
  } catch (e) {
    try { await rawSql('ROLLBACK'); } catch (_) {}
    return 'race';
  }
  if (!consumed.length) return 'race';
  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// CONSUME TADDY NONCE
// ═══════════════════════════════════════════════════════════════════
async function consumeTaddyNonce(sessionId, signedNonce, userId, ipHash, fpHash) {
  if (!signedNonce) {
    await addRisk(userId, 'reward_taddy_no_nonce', ipHash, fpHash, 15);
    return 'missing';
  }

  const parsed = parseSignedNonce(signedNonce);
  if (!parsed) {
    await addRisk(userId, 'reward_taddy_nonce_malformed', ipHash, fpHash, 20);
    return 'invalid';
  }
  const { raw: rawNonce, sig: clientSig } = parsed;

  const rows = await sql(
    `SELECT taddy_nonce, taddy_nonce_exp, taddy_nonce_used
     FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) return 'invalid';
  const { taddy_nonce, taddy_nonce_exp, taddy_nonce_used } = rows[0];

  if (!taddy_nonce) { await addRisk(userId, 'reward_taddy_no_nonce_issued', ipHash, fpHash, 15); return 'not_issued'; }
  if (taddy_nonce_used) { await addRisk(userId, 'reward_taddy_nonce_reuse', ipHash, fpHash, 30); return 'replay'; }
  if (!taddy_nonce_exp || new Date(taddy_nonce_exp) < new Date()) {
    await sql(`UPDATE sessions SET taddy_nonce=NULL, taddy_nonce_exp=NULL, taddy_nonce_used=FALSE WHERE id=$1`, [sessionId]);
    return 'expired';
  }

  if (!constantTimeCompare(rawNonce, taddy_nonce)) {
    await addRisk(userId, 'reward_taddy_nonce_mismatch', ipHash, fpHash, 40);
    return 'mismatch';
  }

  const expectedSig = signNonce(taddy_nonce, sessionId, userId, 'reward_taddy_ad', new Date(taddy_nonce_exp).toISOString());
  if (!constantTimeCompare(clientSig, expectedSig)) {
    await addRisk(userId, 'reward_taddy_signature_invalid', ipHash, fpHash, 40);
    return 'invalid_signature';
  }

  // [FIX-3] Atomic consume مع SELECT FOR UPDATE
  const { sql: rawSql2 } = require('./db');
  let consumed2 = [];
  try {
    await rawSql2('BEGIN');
    const locked2 = await rawSql2(
      `SELECT id FROM sessions WHERE id=$1 AND taddy_nonce=$2 AND taddy_nonce_used=FALSE FOR UPDATE SKIP LOCKED`,
      [sessionId, taddy_nonce]
    );
    if (!locked2.length) {
      await rawSql2('ROLLBACK');
      await addRisk(userId, 'reward_taddy_race_condition', ipHash, fpHash, 10);
      return 'race';
    }
    consumed2 = await rawSql2(
      `UPDATE sessions SET taddy_nonce=NULL, taddy_nonce_exp=NULL, taddy_nonce_used=TRUE WHERE id=$1 RETURNING id`,
      [sessionId]
    );
    await rawSql2('COMMIT');
  } catch (e) {
    try { await rawSql2('ROLLBACK'); } catch (_) {}
    return 'race';
  }
  if (!consumed2.length) return 'race';
  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// AUDIT + RISK
// ═══════════════════════════════════════════════════════════════════
async function writeAudit(userId, sessionId, action, status, ipHash, fpHash, meta = {}) {
  try {
    await sql(
      `INSERT INTO audit_log(user_id, session_id, action, status, ip_hash, fp_hash, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [userId || null, sessionId || null, action, status, ipHash || null, fpHash || null, JSON.stringify(meta)]
    );
  } catch (_) {}
}

async function addRisk(userId, type, ipHash, fpHash, delta, meta = {}) {
  try {
    logRisk(type, userId, { delta, ...meta });
    await sql(
      `INSERT INTO risk_events(user_id, event_type, ip_hash, fp_hash, score_delta, meta)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [userId, type, ipHash, fpHash, delta, JSON.stringify(meta)]
    );
    if (delta > 0) {
      await sql(`UPDATE users SET risk_score=LEAST(risk_score+$1, 200) WHERE id=$2`, [delta, userId]);
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason='auto_risk'
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE`,
        [userId, CFG.RISK_BAN]
      );
      const shadowResult = await sql(
        `UPDATE users SET is_shadow_banned=TRUE
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE AND is_shadow_banned=FALSE
         RETURNING id`,
        [userId, CFG.RISK_SHADOW]
      );
      if (shadowResult.length) {
        logShadow('auto_risk_threshold', userId, { risk_type: type, delta });
      }
    }
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// MULTI-ACCOUNT DETECTION
// ═══════════════════════════════════════════════════════════════════
async function checkMultiAccount(userId, ipHash, fpHash, accountAgeMs) {
  const cfg = CFG.MULTI_ACCT;
  if (cfg.IP_WHITELIST.has(ipHash)) return { flagged: false };

  const isNewAccount = accountAgeMs < CFG.ACCOUNT_AGE_PROTECTION_MS;

  const ipAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.last_ip_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [ipHash, userId]
  );
  const ipCnt = parseInt(ipAccounts[0]?.cnt) || 0;

  const fpAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.fp_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [fpHash, userId]
  );
  const fpCnt = parseInt(fpAccounts[0]?.cnt) || 0;

  const ipViolation = ipCnt >= cfg.MAX_PER_IP;
  const fpViolation = fpCnt >= cfg.MAX_PER_FP;

  if (fpViolation && !isNewAccount) {
    logRisk('multi_account_fp_hard_ban', userId, { fpCnt, ipCnt, accountAgeMs });
    return { flagged: true, reason: 'multi_fp', ban: true };
  }

  if (fpViolation && isNewAccount) {
    await addRisk(userId, 'multi_account_fp_new_account', ipHash, fpHash, 10,
      { fpCnt, note: 'New account grace — soft risk only' });
    logRisk('multi_account_fp_new_grace', userId, { fpCnt, isNewAccount: true });
    return { flagged: false, warned: true };
  }

  if (ipViolation) {
    await addRisk(userId, 'multi_account_ip_warning', ipHash, fpHash, 5,
      { ipCnt, note: 'Shared IP — no ban' });
    logRisk('multi_account_ip_warning', userId, { ipCnt });
    return { flagged: false, warned: true };
  }

  const bannedOnIp = await sql(
    `SELECT COUNT(*) AS cnt FROM users WHERE last_ip_hash=$1 AND is_banned=TRUE AND id!=$2`,
    [ipHash, userId]
  );
  if ((parseInt(bannedOnIp[0]?.cnt) || 0) > 3) {
    await addRisk(userId, 'cluster_ip_banned', ipHash, fpHash, 10);
  }

  return { flagged: false };
}


module.exports = {
  validateSession,
  issueAdNonce, issueTaddyNonce, issueNonce,
  consumeNonce, consumeAdNonce, consumeTaddyNonce,
  writeAudit, addRisk, checkMultiAccount,
  // Export for testing
  signNonce, buildSignedNonce, parseSignedNonce,
};
