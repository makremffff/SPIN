'use strict';

const { CFG } = require('./config');
const { sql } = require('./db');
const { genRawNonce, constantTimeCompare, logRisk, logShadow, logFingerprintChange } = require('./utils');

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

    // Check account age — new accounts get extra grace
    const userRow = (await sql(`SELECT created_at FROM users WHERE id=$1`, [session.user_id]))[0];
    const accountAgeMs = userRow ? Date.now() - new Date(userRow.created_at).getTime() : 999999999;
    const isNewAccount = accountAgeMs < CFG.ACCOUNT_AGE_PROTECTION_MS;

    if (!isNewAccount) {
      // Soft risk increment — not immediate ban
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
      await writeAudit(session.user_id, sid, 'session_validate', 'fp_mismatch_grace', ipHash, fpHash, {
        fingerprint_change_reason: 'new_account_grace_period',
        is_new_account: true,
        account_age_ms: accountAgeMs,
      });
    }
    // Do NOT revoke session — just increment risk
  }

  await sql(`UPDATE sessions SET last_active=NOW() WHERE id=$1`, [sid]);
  return session;
}

async function issueAdNonce(sessionId) {
  const nonce = genRawNonce(32);
  const exp   = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();
  const r = await sql(
    `UPDATE sessions
     SET ad_nonce=$1, ad_nonce_exp=$2, ad_nonce_used=FALSE
     WHERE id=$3 AND is_revoked=FALSE
     RETURNING id`,
    [nonce, exp, sessionId]
  );
  return r.length ? nonce : null;
}

async function issueNonce(sessionId, userId, ipHash, fpHash, action) {
  const nonce = genRawNonce(32);
  const exp   = new Date(Date.now() + CFG.NONCE_TTL_MS).toISOString();
  await sql(
    `INSERT INTO nonces(nonce, session_id, user_id, ip_hash, fp_hash, action, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [nonce, sessionId, userId, ipHash, fpHash, action, exp]
  );
  return nonce;
}

async function consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, action) {
  if (!rawNonce) return 'missing';
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
  if (n.action && n.action !== action) { await addRisk(userId, 'nonce_action_mismatch', ipHash, fpHash, 15); return 'action_mismatch'; }
  if (!constantTimeCompare(n.fp_hash || fpHash, fpHash)) {
    await addRisk(userId, 'nonce_fp_mismatch', ipHash, fpHash, 15);
    return 'fp_mismatch';
  }
  const consumed = await sql(
    `UPDATE nonces SET used=TRUE WHERE id=$1 AND used=FALSE RETURNING id`,
    [n.id]
  );
  if (!consumed.length) return 'race';
  return 'ok';
}

async function consumeAdNonce(sessionId, _ignoredClientNonce, userId, ipHash, fpHash) {
  // الـ nonce يُقرأ من DB مباشرة — لا يُقبل أي قيمة من الكليانت
  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp, ad_nonce_used
     FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) return 'invalid';
  const { ad_nonce, ad_nonce_exp, ad_nonce_used } = rows[0];

  if (!ad_nonce) {
    await addRisk(userId, 'reward_ad_no_nonce_issued', ipHash, fpHash, 15);
    return 'not_issued'; // لم يتم start_ad أصلاً
  }
  if (ad_nonce_used) {
    await addRisk(userId, 'reward_ad_nonce_reuse', ipHash, fpHash, 30);
    return 'replay';
  }
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(`UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`, [sessionId]);
    return 'expired';
  }

  // atomic consume — بدون مقارنة client value
  const consumed = await sql(
    `UPDATE sessions
     SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE
     WHERE id=$1 AND ad_nonce IS NOT NULL AND ad_nonce_used=FALSE
     RETURNING id`,
    [sessionId]
  );
  if (!consumed.length) {
    await addRisk(userId, 'reward_ad_race_condition', ipHash, fpHash, 10);
    return 'race';
  }
  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG + RISK
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
// MULTI-ACCOUNT DETECTION — relaxed limits + new account protection
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
    // Hard ban — strong evidence only for older accounts
    logRisk('multi_account_fp_hard_ban', userId, { fpCnt, ipCnt, accountAgeMs });
    return { flagged: true, reason: 'multi_fp', ban: true };
  }

  if (fpViolation && isNewAccount) {
    // New account + FP match — soft risk only, wait for evidence
    await addRisk(userId, 'multi_account_fp_new_account', ipHash, fpHash, 10,
      { fpCnt, note: 'New account grace — soft risk only' });
    logRisk('multi_account_fp_new_grace', userId, { fpCnt, isNewAccount: true });
    return { flagged: false, warned: true };
  }

  if (ipViolation) {
    // IP violation — warning only (shared NAT/WiFi)
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
  validateSession, issueAdNonce, issueNonce, consumeNonce, consumeAdNonce,
  writeAudit, addRisk, checkMultiAccount,
};
