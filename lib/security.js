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
const NONCE_HMAC_SECRET = process.env.NONCE_SECRET || '3236f0d000882cbd9297e86b98166946e9b284c60badeea7c0e6e42937035b4f09616a87ee17db5f6403d03d538a8f1b';

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
  if (new Date(n.expires_at) < new Date()) return 'expired';  // لا risk — انتهاء طبيعي
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

  // [4] FP binding — soft check (VPN أو تغيير شبكة لا يستوجب risk عالي)
  if (!constantTimeCompare(n.fp_hash || fpHash, fpHash)) {
    await addRisk(userId, 'nonce_fp_mismatch', ipHash, fpHash, 5);
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
// EXPIRED NONCE ABUSE DETECTOR
// المستخدم الطبيعي قد يرسل nonce منتهي الصلاحية مرة أو مرتين
// لكن 30+ مرة في ساعة = محاولة استغلال → risk حقيقي
// ═══════════════════════════════════════════════════════════════════
async function _trackExpiredNonce(userId, ipHash, fpHash) {
  try {
    // سجّل المحاولة بـ delta=0 (لا يؤثر على الـ score — للعد فقط)
    await sql(
      `INSERT INTO risk_events(user_id, event_type, ip_hash, fp_hash, score_delta, meta)
       VALUES($1,'ad_nonce_expired_attempt',$2,$3,0,'{}')`,
      [userId, ipHash, fpHash]
    );
    // عدّ المحاولات في آخر ساعة
    const r = await sql(
      `SELECT COUNT(*) AS cnt FROM risk_events
       WHERE user_id=$1
         AND event_type='ad_nonce_expired_attempt'
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId]
    );
    const cnt = parseInt(r[0]?.cnt) || 0;
    if (cnt >= CFG.NONCE_EXPIRED_ABUSE_THRESHOLD) {
      // وصل للحد — يُضاف risk فقط مرة واحدة عند كل مضاعف للـ threshold
      const isNewMultiple = (cnt % CFG.NONCE_EXPIRED_ABUSE_THRESHOLD) === 0;
      if (isNewMultiple) {
        await addRisk(userId, 'nonce_expired_abuse', ipHash, fpHash, 25, {
          expired_count_1h: cnt,
        });
      }
    }
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// CONSUME AD NONCE — مع HMAC verification + IP binding
// ═══════════════════════════════════════════════════════════════════
async function consumeAdNonce(sessionId, signedNonce, userId, ipHash, fpHash) {
  if (!signedNonce) {
    // missing nonce — قد يكون race condition طبيعي (المستخدم ضغط بسرعة)
    // لا نضيف risk هنا — السيرفر يرفض الطلب فقط
    return 'missing';
  }

  // [1] Parse
  const parsed = parseSignedNonce(signedNonce);
  if (!parsed) {
    // malformed — signature فاسدة حقيقياً (تلاعب)
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

  if (!ad_nonce) {
    // لا يوجد nonce — race condition طبيعي (المستخدم أعاد الفتح)
    return 'not_issued';
  }
  if (ad_nonce_used) {
    // replay حقيقي — نفس الـ nonce مرتين
    await addRisk(userId, 'reward_ad_nonce_reuse', ipHash, fpHash, 30);
    return 'replay';
  }
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    // انتهت صلاحية الـ nonce — طبيعي جداً (المستخدم انتظر أكثر من 3 دقائق)
    // نتتبع العدد فقط — لا risk إلا عند إساءة الاستخدام المتكررة
    await sql(`UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`, [sessionId]);
    await _trackExpiredNonce(userId, ipHash, fpHash);
    return 'expired';
  }

  // [3] Verify raw nonce matches DB
  if (!constantTimeCompare(rawNonce, ad_nonce)) {
    // nonce مختلف تماماً — تلاعب حقيقي
    await addRisk(userId, 'reward_ad_nonce_mismatch', ipHash, fpHash, 40);
    return 'mismatch';
  }

  // [4] Verify HMAC signature
  const expectedSig = signNonce(ad_nonce, sessionId, userId, 'reward_ad', new Date(ad_nonce_exp).toISOString());
  if (!constantTimeCompare(clientSig, expectedSig)) {
    // signature غلط — تلاعب حقيقي
    await addRisk(userId, 'reward_ad_signature_invalid', ipHash, fpHash, 40);
    return 'invalid_signature';
  }

  // [5] Atomic consume
  const consumed = await sql(
    `UPDATE sessions
     SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE
     WHERE id=$1 AND ad_nonce=$2 AND ad_nonce_used=FALSE
     RETURNING id`,
    [sessionId, ad_nonce]
  );
  if (!consumed.length) {
    // race condition — طلبان متزامنان — لا risk
    return 'race';
  }
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
  issueAdNonce, issueNonce,
  consumeNonce, consumeAdNonce,
  writeAudit, addRisk, checkMultiAccount,
  // Export for testing
  signNonce, buildSignedNonce, parseSignedNonce,
};
