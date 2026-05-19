'use strict';

const { CONFIG, CFG, BOT_TOKEN, CHANNEL_ID, IS_DEV } = require('./config');
const { sql } = require('./db');
const {
  computeLevel, giftReward, isValidTon, logRisk, logShadow,
  logRewardBlock, logAdsgramState, hashIp, getIp,
} = require('./utils');
const {
  issueAdNonce, issueNonce, consumeNonce, consumeAdNonce,
  writeAudit, addRisk, checkMultiAccount,
} = require('./security');

// ── Telegram Bot API: check channel membership ───────────────────
async function checkTelegramMembership(telegramUserId) {
  if (!BOT_TOKEN || !CHANNEL_ID) {
    // إذا لم يُضبط BOT_TOKEN أو CHANNEL_ID → نتجاوز الفحص (dev mode)
    console.warn('[TG_MEMBER] BOT_TOKEN or CHANNEL_ID not set — skipping check');
    return { ok: true, skipped: true };
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL_ID)}&user_id=${telegramUserId}`;
    const res  = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    if (!json.ok) {
      console.warn('[TG_MEMBER] API error:', json.description);
      return { ok: false, reason: json.description || 'api_error' };
    }
    const status = json.result?.status; // member | administrator | creator | left | kicked | restricted
    const isMember = ['member', 'administrator', 'creator'].includes(status);
    return { ok: isMember, status };
  } catch (err) {
    console.error('[TG_MEMBER] fetch error:', err.message);
    return { ok: false, reason: 'network_error' };
  }
}


// ═══════════════════════════════════════════════════════════════════
// USER OPS
// ═══════════════════════════════════════════════════════════════════

async function upsertUser(tgUser, ipHash, fpHash) {
  const r = await sql(
    `INSERT INTO users(tg_id,tg_username,tg_first_name,tg_last_name,tg_language_code,tg_is_premium,ip_hash,fp_hash,last_ip_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(tg_id) DO UPDATE SET
       tg_username=EXCLUDED.tg_username,
       tg_first_name=EXCLUDED.tg_first_name,
       tg_last_name=EXCLUDED.tg_last_name,
       tg_language_code=EXCLUDED.tg_language_code,
       tg_is_premium=EXCLUDED.tg_is_premium,
       last_ip_hash=EXCLUDED.last_ip_hash,
       updated_at=NOW()
     RETURNING *`,
    [
      tgUser.id, tgUser.username || null, tgUser.first_name || null,
      tgUser.last_name || null, tgUser.language_code || 'ar',
      !!tgUser.is_premium, ipHash, fpHash, ipHash,
    ]
  );
  return r[0];
}

async function syncLevel(userId) {
  const r = await sql(`SELECT xp FROM users WHERE id=$1`, [userId]);
  if (!r.length) return;
  await sql(
    `UPDATE users SET level=$1 WHERE id=$2`,
    [computeLevel(parseInt(r[0].xp) || 0), userId]
  );
}

async function upsertTask(userId, taskType) {
  await sql(
    `INSERT INTO user_tasks(user_id, task_type, completed, completed_at, task_date)
     VALUES($1,$2,TRUE,NOW(),CURRENT_DATE)
     ON CONFLICT(user_id, task_type, task_date)
     DO UPDATE SET completed=TRUE, completed_at=NOW()`,
    [userId, taskType]
  );
}

// ── Check if referral reward can be given (referred must be active) ──
async function isReferralActive(userId) {
  const r = (await sql(`SELECT ads_watched_total, points FROM users WHERE id=$1`, [userId]))[0];
  if (!r) return false;
  const adsWatched = parseInt(r.ads_watched_total) || 0;
  const pts = parseInt(r.points) || 0;
  return adsWatched >= CONFIG.referral.min_active_ads || pts >= CONFIG.referral.min_active_pts;
}


// ═══════════════════════════════════════════════════════════════════
// GET /config — Dynamic Config Endpoint
// ═══════════════════════════════════════════════════════════════════
function handleGetConfig() {
  return {
    ok: true,
    withdraw: {
      first_min:    CONFIG.withdraw.first_min,
      normal_min:   CONFIG.withdraw.normal_min,
      normal_level: CONFIG.withdraw.normal_level,
    },
    rewards: {
      referral:          CONFIG.rewards.referral,
      telegram_task:     CONFIG.rewards.telegram_task,
      adsgram_task:      CONFIG.rewards.adsgram_task,
      daily_ads_10:      CONFIG.rewards.daily_ads_10,
      daily_ads_25:      CONFIG.rewards.daily_ads_25,
      daily_referrals_3: CONFIG.rewards.daily_referrals_3,
      points_per_ad:     CONFIG.rewards.points_per_ad,
    },
    telegram: {
      channel_url: CONFIG.telegram.channel_url,
    },
    ads: {
      daily_limit:     CONFIG.ads.daily_limit,
      cooldown_ms:     CONFIG.ads.cooldown_ms,
      min_duration_ms: CONFIG.ads.min_duration_ms,
    },
    adsgram_task: {
      title_ar:  CONFIG.adsgram_task.title_ar,
      title_en:  CONFIG.adsgram_task.title_en,
      block_id:  CONFIG.adsgram_task.block_id,
      reward:    CONFIG.rewards.adsgram_task,
      cooldown_ms: CONFIG.adsgram_task.cooldown_ms,
    },
    daily_gift: {
      rewards:   CONFIG.daily_gift.rewards,
      titles_ar: CONFIG.daily_gift.titles_ar,
      descs_ar:  CONFIG.daily_gift.descs_ar,
    },
  };
}


// ═══════════════════════════════════════════════════════════════════
// CREATE SESSION
// ═══════════════════════════════════════════════════════════════════
async function handleCreateSession(body, ipHash, fpHash) {
  const initData = body?.data?.initData || '';
  const fpData   = body?.data?.fp || {};

  const tgResult = verifyTg(initData);
  if (!tgResult.ok && !IS_DEV) {
    return { ok: false, error: 'invalid_init_data', status: 401 };
  }

  const tgUser = tgResult.data?.id
    ? tgResult.data
    : { id: 99999999, first_name: 'Dev', language_code: 'ar' };
  if (!tgUser.id) return { ok: false, error: 'no_user_id', status: 401 };

  const tid = parseInt(tgUser.id);
  const user = await upsertUser(tgUser, ipHash, fpHash);
  const accountAgeMs = Date.now() - new Date(user.created_at).getTime();
  const isNewAccount = accountAgeMs < CFG.ACCOUNT_AGE_PROTECTION_MS;

  // ── Referral processing ───────────────────────────────────────
  try {
    const sp = new URLSearchParams(initData).get('start_param') || '';
    const m  = sp.match(/^ref_(\d+)$/);
    if (m) {
      const refTgId = parseInt(m[1]);
      if (refTgId !== tid) {  // prevent self-referral
        const rr = await sql(`SELECT id FROM users WHERE tg_id=$1`, [refTgId]);
        if (rr.length) {
          const referrerId = rr[0].id;
          // Check not already registered
          const existing = await sql(
            `SELECT id FROM referrals WHERE referred_id=$1`,
            [user.id]
          );
          if (!existing.length) {
            // Store referral — reward given only when referred becomes active
            await sql(
              `INSERT INTO referrals(referrer_id, referred_id, points_given, activated)
               VALUES($1,$2,0,FALSE)
               ON CONFLICT(referred_id) DO NOTHING`,
              [referrerId, user.id]
            );
            await sql(`UPDATE users SET referrer_id=$1 WHERE id=$2 AND referrer_id IS NULL`, [referrerId, user.id]);
          }
        }
      } else {
        logRewardBlock('self_referral_prevented', user.id, { tg_id: tid });
      }
    }
  } catch (_) {}

  // ── Check hard ban ────────────────────────────────────────────
  const userRow = (await sql(
    `SELECT is_banned, is_shadow_banned, risk_score, created_at FROM users WHERE id=$1`,
    [user.id]
  ))[0];

  if (userRow?.is_banned) {
    await writeAudit(user.id, null, 'create_session', 'hard_banned', ipHash, fpHash, { tg_id: tid });
    return { ok: false, is_banned: true, ban_type: 'hard', status: 403 };
  }

  if (userRow?.is_shadow_banned) {
    await writeAudit(user.id, null, 'create_session', 'shadow_banned', ipHash, fpHash, { tg_id: tid });
    logShadow('create_session_blocked', user.id, { tg_id: tid });
    // ✅ Honest response — no fake success
    return { ok: false, error: 'account_review', is_shadow_banned: true, status: 200 };
  }

  // ── Multi-account check ───────────────────────────────────────
  try {
    const multiResult = await checkMultiAccount(user.id, ipHash, fpHash, accountAgeMs);

    if (multiResult.flagged && multiResult.ban) {
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason='multi_account', updated_at=NOW() WHERE id=$1`,
        [user.id]
      );
      try {
        await sql(
          `INSERT INTO security_logs(user_id,ip_hash,fingerprint,action,risk_score,verdict,detail)
           VALUES($1,$2,$3,'multi_account_detected',100,'deny',$4)`,
          [user.id, ipHash, fpHash, JSON.stringify({
            reason: 'multi_account_hard_ban', tg_id: tid,
          })]
        );
      } catch (_) {}
      await writeAudit(user.id, null, 'create_session', 'multi_account_banned', ipHash, fpHash, { tg_id: tid });
      return { ok: false, is_banned: true, ban_type: 'hard', status: 200 };
    }

    if (multiResult.warned) {
      await writeAudit(user.id, null, 'create_session', 'multi_account_warned', ipHash, fpHash, {
        tg_id: tid, is_new: isNewAccount,
      });
    }
  } catch (multiErr) {
    console.warn('[CREATE_SESSION] Multi-account check error (non-fatal):', multiErr.message);
  }
  // ── Revoke old sessions + create new (atomic) ─────────────────
  let sessionId;
  try {
    await sql(`UPDATE sessions SET is_revoked=TRUE WHERE user_id=$1`, [user.id]);
    sessionId = genRawNonce(32);
    const exp = new Date(Date.now() + CFG.SESSION_TTL_MS).toISOString();
    await sql(
      `INSERT INTO sessions(id, user_id, fingerprint_hash, ip_hash, expires_at)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO NOTHING`,
      [sessionId, user.id, fpHash, ipHash, exp]
    );
    console.info(`[CREATE_SESSION] Session created for userId=${user.id} tgId=${tid} isNew=${isNewAccount}`);
  } catch (sessionErr) {
    console.error('[CREATE_SESSION] Failed to create session:', sessionErr.message);
    await writeAudit(user.id, null, 'create_session', 'session_insert_error', ipHash, fpHash, {
      error: sessionErr.message, tg_id: tid,
    });
    return { ok: false, error: 'session_creation_failed', status: 500 };
  }

  // ── Save device fingerprint ───────────────────────────────────
  const fpObj = typeof fpData === 'object' ? fpData : {};
  try {
    await sql(
      `INSERT INTO device_fingerprints(fingerprint, user_id, user_agent, lang, screen, timezone_off)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(fingerprint, user_id) DO UPDATE SET last_seen=NOW()`,
      [fpHash, user.id,
       fpObj.user_agent || null, fpObj.lang || null,
       fpObj.screen || null, parseInt(fpObj.tz_offset) || 0]
    );
  } catch (fpErr) {
    // Non-fatal — session still valid
    console.warn('[CREATE_SESSION] FP save error (non-fatal):', fpErr.message);
  }
  await writeAudit(user.id, sessionId, 'create_session', 'ok', ipHash, fpHash, {
    tg_id: tid, is_new_account: isNewAccount,
  });

  try { await syncLevel(user.id); } catch (lvlErr) {
    console.warn('[CREATE_SESSION] syncLevel error (non-fatal):', lvlErr.message);
  }

  // ── Try to activate pending referral for this user ────────────
  try {
    if (await isReferralActive(user.id)) {
      await activatePendingReferral(user.id);
    }
  } catch (refErr) {
    console.warn('[CREATE_SESSION] Referral activation error (non-fatal):', refErr.message);
  }
  const finalUser = (await sql(`SELECT * FROM users WHERE id=$1`, [user.id]))[0];

  return {
    ok: true,
    _sid: sessionId,
    user: {
      points:              parseInt(finalUser.points) || 0,
      level:               parseInt(finalUser.level) || 1,
      xp:                  parseInt(finalUser.xp) || 0,
      tg_verified:         finalUser.tg_verified,
      streak_day:          finalUser.streak_day,
      last_gift_date:      finalUser.last_gift_date,
      total_referrals:     finalUser.total_referrals,
      earned_from_refs:    parseInt(finalUser.earned_from_refs) || 0,
      first_withdraw_done: !!finalUser.first_withdraw_done,
    },
  };
}

// ── Activate referral reward when referred user becomes active ────
async function activatePendingReferral(referredUserId) {
  const pendingRef = (await sql(
    `SELECT id, referrer_id FROM referrals
     WHERE referred_id=$1 AND activated=FALSE
     LIMIT 1`,
    [referredUserId]
  ))[0];

  if (!pendingRef) return;

  // Atomic activate — prevent duplicate
  const activated = await sql(
    `UPDATE referrals
     SET activated=TRUE, activated_at=NOW(), points_given=$1
     WHERE id=$2 AND activated=FALSE
     RETURNING id`,
    [CONFIG.rewards.referral, pendingRef.id]
  );

  if (!activated.length) return; // race condition — already done

  // Give reward to referrer
  await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1,
         total_referrals=total_referrals+1,
         earned_from_refs=earned_from_refs+$1,
         updated_at=NOW()
     WHERE id=$2`,
    [CONFIG.rewards.referral, pendingRef.referrer_id]
  );

  await syncLevel(pendingRef.referrer_id);

  // Check daily referral mission (3 referrals today)
  const todayRefs = (await sql(
    `SELECT COUNT(*) AS cnt FROM referrals
     WHERE referrer_id=$1
       AND activated=TRUE
       AND DATE(activated_at)=CURRENT_DATE`,
    [pendingRef.referrer_id]
  ))[0];

  if ((parseInt(todayRefs?.cnt) || 0) >= 3) {
    // Check not already claimed
    const alreadyClaimed = (await sql(
      `SELECT id FROM user_tasks
       WHERE user_id=$1 AND task_type='daily_refs_3' AND task_date=CURRENT_DATE AND reward_claimed=TRUE`,
      [pendingRef.referrer_id]
    )).length > 0;

    if (!alreadyClaimed) {
      await sql(
        `INSERT INTO user_tasks(user_id, task_type, completed, completed_at, task_date, reward_claimed)
         VALUES($1,'daily_refs_3',TRUE,NOW(),CURRENT_DATE,FALSE)
         ON CONFLICT(user_id, task_type, task_date) DO UPDATE
         SET completed=TRUE, completed_at=NOW()`,
        [pendingRef.referrer_id]
      );
    }
  }

  await writeAudit(pendingRef.referrer_id, null, 'referral_activated', 'ok', null, null, {
    referred_id: referredUserId, reward: CONFIG.rewards.referral,
  });
  console.info(`[REFERRAL] Activated — referrer=${pendingRef.referrer_id} referred=${referredUserId} reward=${CONFIG.rewards.referral}`);
}


// ═══════════════════════════════════════════════════════════════════
// LOAD — Full user data
// ═══════════════════════════════════════════════════════════════════
async function handleLoad(userId) {
  const rows = await sql(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (!rows.length) return { ok: false, error: 'user_not_found' };
  const u = rows[0];

  const adR = await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const ad  = adR[0] || { count: 0, points_earned: 0 };
  const watched = parseInt(ad.count) || 0;

  const wR = await sql(`SELECT pts,address,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
  const rR = await sql(`SELECT u.tg_first_name,u.tg_username,u.created_at FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 10`, [userId]);
  const tR = await sql(`SELECT task_type, reward_claimed FROM user_tasks WHERE user_id=$1 AND task_date=CURRENT_DATE AND completed=TRUE`, [userId]);

  // ── Adsgram state from DB ─────────────────────────────────────
  const adsgramState = buildAdsgramState(u);

  // ── Withdraw info based on first_withdraw_done ────────────────
  const firstWithdrawDone = !!u.first_withdraw_done;
  const withdrawInfo = firstWithdrawDone
    ? { withdraw_min: CONFIG.withdraw.normal_min, withdraw_level: CONFIG.withdraw.normal_level, first_withdraw_offer: false }
    : { withdraw_min: CONFIG.withdraw.first_min,  withdraw_level: 0,                            first_withdraw_offer: true };

  return {
    ok: true,
    points:       parseInt(u.points) || 0,
    level:        parseInt(u.level)  || 1,
    xp:           parseInt(u.xp)    || 0,
    usdt_balance: parseFloat(u.usdt_balance) || 0,
    tg_verified:  u.tg_verified,
    streak_day:   u.streak_day,
    last_gift_date: u.last_gift_date,
    tg_id:        u.tg_id,
    ads_total:         CFG.ADS_DAILY_LIMIT,
    ads_remaining:     Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    ads_watched_today: watched,
    earned_today:      parseInt(ad.points_earned) || 0,
    ads_watched_total: parseInt(u.ads_watched_total) || 0,
    total_referrals:   u.total_referrals,
    earned_from_refs:  parseInt(u.earned_from_refs) || 0,
    first_withdraw_done: firstWithdrawDone,
    withdraw_info: withdrawInfo,
    adsgram_task: adsgramState,
    withdrawals: wR.map(w => ({
      pts: parseInt(w.pts) || 0, address: w.address,
      method: w.method, status: w.status, ts: new Date(w.created_at).getTime(),
    })),
    referral_list: rR.map(r => ({
      name: r.tg_first_name || r.tg_username || 'مستخدم',
      ts: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
    })),
    completed_tasks: tR.map(r => ({
      task_type: r.task_type,
      reward_claimed: !!r.reward_claimed,
    })),
    config: handleGetConfig(),
  };
}

// ── Build Adsgram state from user DB row ──────────────────────────
function buildAdsgramState(u) {
  const now = Date.now();
  let status = u.adsgram_status || 'ready';

  // If watching and cooldown has passed — status = claim or ready
  if (status === 'watching' && u.adsgram_expires_at) {
    const expiresAt = new Date(u.adsgram_expires_at).getTime();
    if (now >= expiresAt) {
      status = u.adsgram_completed ? 'claim' : 'ready';
    }
  }

  // If claimed recently (60s ago), it's completed
  if (u.adsgram_claimed && u.adsgram_last_claimed_at) {
    const claimedAt = new Date(u.adsgram_last_claimed_at).getTime();
    const elapsed = now - claimedAt;
    if (elapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      status = 'cooldown';
    } else {
      status = 'ready';  // cooldown over — can watch again
    }
  }

  const remaining = (status === 'watching' && u.adsgram_expires_at)
    ? Math.max(0, Math.ceil((new Date(u.adsgram_expires_at).getTime() - now) / 1000))
    : (status === 'cooldown' && u.adsgram_last_claimed_at)
    ? Math.max(0, Math.ceil((CFG.ADSGRAM_TASK_COOLDOWN_MS - (now - new Date(u.adsgram_last_claimed_at).getTime())) / 1000))
    : 0;

  return {
    status,
    remaining_seconds: remaining,
    reward: CONFIG.rewards.adsgram_task,
    claimed: !!u.adsgram_claimed,
  };
}

// ═══════════════════════════════════════════════════════════════════
// GET STATE — lightweight polling
// ═══════════════════════════════════════════════════════════════════
async function handleGetState(userId) {
  const r = await sql(`SELECT points,level,xp,total_referrals,earned_from_refs,ad_last_reward,
    adsgram_status,adsgram_started_at,adsgram_expires_at,adsgram_completed,adsgram_claimed,adsgram_last_claimed_at
    FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };
  const u  = r[0];
  const ad = (await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0] || { count: 0, points_earned: 0 };

  let ad_cooldown_ms = 0;
  if (u.ad_last_reward) {
    const elapsed = Date.now() - new Date(u.ad_last_reward).getTime();
    ad_cooldown_ms = Math.max(0, CFG.AD_COOLDOWN_MS - elapsed);
  }

  return {
    ok: true,
    points:        parseInt(u.points) || 0,
    level:         parseInt(u.level)  || 1,
    xp:            parseInt(u.xp)    || 0,
    total_referrals:  u.total_referrals,
    earned_from_refs: parseInt(u.earned_from_refs) || 0,
    ads_watched_today: parseInt(ad.count) || 0,
    ads_remaining:     Math.max(0, CFG.ADS_DAILY_LIMIT - (parseInt(ad.count) || 0)),
    earned_today:      parseInt(ad.points_earned) || 0,
    ad_cooldown_ms,
    ads_daily_limit: CFG.ADS_DAILY_LIMIT,
    adsgram_task: buildAdsgramState(u),
  };
}


// ═══════════════════════════════════════════════════════════════════
// START AD + REWARD AD
// ═══════════════════════════════════════════════════════════════════
async function handleStartAd(userId, sessionId, ipHash, fpHash) {
  const adR = await sql(
    `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  if ((parseInt(adR[0]?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached' };
  }
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS - elapsed };
    }
  }
  const nonce = await issueAdNonce(sessionId);
  if (!nonce) return { ok: false, error: 'session_invalid' };
  await writeAudit(userId, sessionId, 'start_ad', 'ok', ipHash, fpHash, {});
  return { ok: true, ad_nonce: nonce };
}

async function handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce) {
  const clientStartedAt = parseInt(body?.data?.ad_started_at) || 0;

  // [1] Nonce verification
  const nonceResult = await consumeAdNonce(sessionId, rawNonce, userId, ipHash, fpHash);
  if (nonceResult !== 'ok') {
    logRewardBlock(`nonce_${nonceResult}`, userId, {});
    return { ok: false, error: `nonce_${nonceResult}` };
  }

  // [2] Shadow ban check — honest response
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    logShadow('reward_ad_blocked', userId, {});
    logRewardBlock('shadow_ban', userId, {});
    return { ok: false, error: 'account_review' };
  }

  // [3] Daily limit
  const adR = await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const watchedToday = parseInt(adR[0]?.count) || 0;
  if (watchedToday >= CFG.ADS_DAILY_LIMIT) {
    logRewardBlock('daily_limit', userId, { watched: watchedToday });
    return { ok: false, error: 'daily_limit_reached' };
  }

  // [4] Cooldown check
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      const waitMs = CFG.AD_COOLDOWN_MS - elapsed;
      logRewardBlock('cooldown_active', userId, { wait_ms: waitMs });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // [5] Client-side timing check
  if (clientStartedAt > 0) {
    const clientElapsed = Date.now() - clientStartedAt;
    if (clientElapsed < CFG.AD_MIN_DURATION_MS) {
      await addRisk(userId, 'ad_too_fast_client', ipHash, fpHash, 10);
      logRewardBlock('timing_invalid', userId, { elapsed_ms: clientElapsed });
      return { ok: false, error: 'ad_duration_invalid' };
    }
  }

  // [6] Replay detection
  const recentReward = await sql(
    `SELECT id FROM audit_log
     WHERE user_id=$1 AND action='reward_ad' AND status='ok'
       AND created_at > NOW() - INTERVAL '25 seconds'
     LIMIT 1`,
    [userId]
  );
  if (recentReward.length) {
    await addRisk(userId, 'reward_ad_replay', ipHash, fpHash, 15);
    logRewardBlock('replay_detected', userId, {});
    return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS };
  }

  // [7] Atomic reward — INSERT ... ON CONFLICT with count check
  const lr = await sql(
    `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
     VALUES($1, CURRENT_DATE, 1, $2)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       count         = CASE WHEN ad_logs.count < $3 THEN ad_logs.count + 1         ELSE ad_logs.count         END,
       points_earned = CASE WHEN ad_logs.count < $3 THEN ad_logs.points_earned + $2 ELSE ad_logs.points_earned END,
       updated_at    = NOW()
     RETURNING count, points_earned`,
    [userId, CFG.POINTS_PER_AD, CFG.ADS_DAILY_LIMIT]
  );
  const watched = parseInt(lr[0].count) || 0;

  await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1,
         ads_watched_total=ads_watched_total+1,
         ad_last_reward=NOW(),
         updated_at=NOW()
     WHERE id=$2`,
    [CFG.POINTS_PER_AD, userId]
  );

  await syncLevel(userId);

  // ── Daily missions completion ──────────────────────────────────
  if (watched >= 10) await upsertTask(userId, 'ads_10');
  if (watched >= 25) await upsertTask(userId, 'ads_25');

  // ── Activate pending referral if user just became active ──────
  if (watched >= CONFIG.referral.min_active_ads) {
    try { await activatePendingReferral(userId); } catch (_) {}
  }

  await writeAudit(userId, sessionId, 'reward_ad', 'ok', ipHash, fpHash, {
    watched, points_earned: CFG.POINTS_PER_AD,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return {
    ok:           true,
    remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    watchedToday: watched,
    earnedToday:  parseInt(lr[0].points_earned) || 0,
    earned:       CONFIG.rewards.ad_watch,
    points:       parseInt(ur[0]?.points) || 0,
    all_done:     watched >= CFG.ADS_DAILY_LIMIT,
    cooldown_ms:  CFG.AD_COOLDOWN_MS,
  };
}


// ═══════════════════════════════════════════════════════════════════
// ADSGRAM TASK — DB-Persistent State
// States: ready → watching → (cooldown expires) → claim → completed
// ═══════════════════════════════════════════════════════════════════

async function handleStartAdsgramTask(userId, sessionId, ipHash, fpHash) {
  const u = (await sql(
    `SELECT adsgram_status, adsgram_claimed, adsgram_last_claimed_at, adsgram_expires_at FROM users WHERE id=$1`,
    [userId]
  ))[0];

  if (!u) return { ok: false, error: 'user_not_found' };

  const now = Date.now();

  // If already in watching state and timer still active → return current state (idempotent)
  if (u.adsgram_status === 'watching' && u.adsgram_expires_at) {
    const expiresAt = new Date(u.adsgram_expires_at).getTime();
    if (now < expiresAt) {
      const remaining = Math.ceil((expiresAt - now) / 1000);
      logAdsgramState(userId, 'already_watching', { remaining });
      // أصدر task_nonce حتى لو already_watching — الكليانت يحتاجه للـ claim
      const alreadyTaskNonce = await issueNonce(sessionId, userId, ipHash, fpHash, 'claim_adsgram_task');
      return {
        ok: true,
        already_watching: true,
        task_nonce: alreadyTaskNonce,
        adsgram_task: {
          status: 'watching',
          remaining_seconds: remaining,
          reward: CONFIG.rewards.adsgram_task,
          claimed: false,
        },
      };
    }
  }

  // Check cooldown from last claim
  if (u.adsgram_claimed && u.adsgram_last_claimed_at) {
    const elapsed = now - new Date(u.adsgram_last_claimed_at).getTime();
    if (elapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      const waitMs = CFG.ADSGRAM_TASK_COOLDOWN_MS - elapsed;
      return {
        ok: false,
        error: 'cooldown_active',
        wait_ms: waitMs,
        adsgram_task: buildAdsgramState(u),
      };
    }
  }

  const nowDate = new Date();
  const expiresAt = new Date(nowDate.getTime() + CFG.ADSGRAM_TASK_MIN_WATCH_MS);

  // Set state to watching — DB persistent
  await sql(
    `UPDATE users
     SET adsgram_status='watching',
         adsgram_started_at=$1,
         adsgram_expires_at=$2,
         adsgram_completed=FALSE,
         adsgram_claimed=FALSE,
         updated_at=NOW()
     WHERE id=$3`,
    [nowDate.toISOString(), expiresAt.toISOString(), userId]
  );

  // Also update session for backward compat
  await sql(`UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`, [sessionId]);

  await writeAudit(userId, sessionId, 'start_adsgram_task', 'ok', ipHash, fpHash, {
    expires_at: expiresAt.toISOString(),
  });

  logAdsgramState(userId, 'watching', { expires_at: expiresAt.toISOString() });

  // أصدر task_nonce — يُستخدم في claim_adsgram_task كـ X-Nonce
  const taskNonce = await issueNonce(sessionId, userId, ipHash, fpHash, 'claim_adsgram_task');

  return {
    ok: true,
    task_nonce: taskNonce,
    adsgram_task: {
      status: 'watching',
      remaining_seconds: Math.ceil(CFG.ADSGRAM_TASK_MIN_WATCH_MS / 1000),
      reward: CONFIG.rewards.adsgram_task,
      claimed: false,
    },
  };
}

async function handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash, rawNonce) {
  // استهلك task_nonce أولاً
  if (!rawNonce) return { ok: false, error: 'nonce_missing' };
  const nonceResult = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_adsgram_task');
  if (nonceResult !== 'ok') return { ok: false, error: nonceResult };

  // ── Fetch current state from DB (source of truth) ─────────────
  const u = (await sql(
    `SELECT adsgram_status, adsgram_started_at, adsgram_expires_at,
            adsgram_completed, adsgram_claimed, adsgram_last_claimed_at,
            is_shadow_banned
     FROM users WHERE id=$1`,
    [userId]
  ))[0];

  if (!u) return { ok: false, error: 'user_not_found' };

  const now = Date.now();

  // [1] Check if task was started
  if (!u.adsgram_started_at) {
    logRewardBlock('adsgram_not_started', userId, {});
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'not_started', ipHash, fpHash, {
      adsgram_state: 'no_started_at',
    });
    return { ok: false, error: 'task_not_started' };
  }

  // [2] Check minimum watch time
  const startedAt = new Date(u.adsgram_started_at).getTime();
  const elapsed   = now - startedAt;
  if (elapsed < CFG.ADSGRAM_TASK_MIN_WATCH_MS) {
    const wait = CFG.ADSGRAM_TASK_MIN_WATCH_MS - elapsed;
    await addRisk(userId, 'adsgram_task_too_fast', ipHash, fpHash, 15);
    logRewardBlock('adsgram_too_fast', userId, { elapsed_ms: elapsed, wait_ms: wait });
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'too_fast', ipHash, fpHash, {
      elapsed_ms: elapsed, min_ms: CFG.ADSGRAM_TASK_MIN_WATCH_MS,
      adsgram_state: 'too_fast',
    });
    return { ok: false, error: 'task_too_fast', wait_ms: wait };
  }

  // [3] Check cooldown from last claim
  if (u.adsgram_last_claimed_at) {
    const lastClaimed = new Date(u.adsgram_last_claimed_at).getTime();
    const cooldownElapsed = now - lastClaimed;
    if (cooldownElapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      const waitMs = CFG.ADSGRAM_TASK_COOLDOWN_MS - cooldownElapsed;
      logRewardBlock('adsgram_cooldown', userId, { wait_ms: waitMs });
      await writeAudit(userId, sessionId, 'claim_adsgram_task', 'cooldown', ipHash, fpHash, {
        wait_ms: waitMs, adsgram_state: 'cooldown',
      });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // [4] Shadow ban — honest response
  if (u.is_shadow_banned) {
    logShadow('adsgram_claim_blocked', userId, {});
    logRewardBlock('shadow_ban', userId, {});
    return { ok: false, error: 'account_review' };
  }

  // [5] Atomic reward — mark as claimed first (prevent race)
  const marked = await sql(
    `UPDATE users
     SET adsgram_status='completed',
         adsgram_completed=TRUE,
         adsgram_claimed=TRUE,
         adsgram_last_claimed_at=NOW(),
         updated_at=NOW()
     WHERE id=$1
       AND (adsgram_claimed=FALSE OR adsgram_last_claimed_at < NOW() - INTERVAL '60 seconds')
     RETURNING id`,
    [userId]
  );

  if (!marked.length) {
    logRewardBlock('adsgram_duplicate_claim', userId, {});
    return { ok: false, error: 'already_claimed_today' };
  }

  // [6] Give points
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [CFG.ADSGRAM_TASK_POINTS, userId]
  );
  await sql(
    `INSERT INTO completed_tasks(user_id, task_key, completed_at)
     VALUES($1, 'adsgram_task_daily', NOW())
     ON CONFLICT DO NOTHING`,
    [userId]
  );

  await syncLevel(userId);
  await writeAudit(userId, sessionId, 'claim_adsgram_task', 'ok', ipHash, fpHash, {
    points: CFG.ADSGRAM_TASK_POINTS, adsgram_state: 'completed',
  });

  logAdsgramState(userId, 'completed', { reward: CFG.ADSGRAM_TASK_POINTS });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  const freshU = ur[0];
  return {
    ok: true,
    points: parseInt(freshU?.points) || 0,
    earned: CFG.ADSGRAM_TASK_POINTS,
    adsgram_task: {
      status: 'completed',
      remaining_seconds: 0,
      reward: CONFIG.rewards.adsgram_task,
      claimed: true,
    },
  };
}


// ═══════════════════════════════════════════════════════════════════
// CLAIM DAILY MISSION REWARD
// ═══════════════════════════════════════════════════════════════════
async function handleClaimDailyMission(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const taskType = body?.data?.task_type || '';
  const allowedMissions = {
    'ads_10':       CONFIG.rewards.daily_ads_10,
    'ads_25':       CONFIG.rewards.daily_ads_25,
    'daily_refs_3': CONFIG.rewards.daily_referrals_3,
  };

  if (!allowedMissions[taskType]) {
    return { ok: false, error: 'invalid_task_type' };
  }

  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_daily_mission');
  if (result !== 'ok') return { ok: false, error: result };

  // Check shadow ban — honest
  const uCheck = (await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]))[0];
  if (uCheck?.is_shadow_banned) {
    logShadow('daily_mission_blocked', userId, { task_type: taskType });
    return { ok: false, error: 'account_review' };
  }

  // Atomic: mark as claimed + give reward
  const taskRow = await sql(
    `UPDATE user_tasks
     SET reward_claimed=TRUE
     WHERE user_id=$1
       AND task_type=$2
       AND task_date=CURRENT_DATE
       AND completed=TRUE
       AND reward_claimed=FALSE
     RETURNING id`,
    [userId, taskType]
  );

  if (!taskRow.length) {
    logRewardBlock('daily_mission_not_completed_or_already_claimed', userId, { task_type: taskType });
    return { ok: false, error: 'task_not_completed_or_already_claimed' };
  }

  const reward = allowedMissions[taskType];
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [reward, userId]
  );
  await syncLevel(userId);
  await writeAudit(userId, sessionId, 'claim_daily_mission', 'ok', ipHash, fpHash, {
    task_type: taskType, reward,
  });

  const ur = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  return { ok: true, reward, points: parseInt(ur?.points) || 0, task_type: taskType };
}


// ═══════════════════════════════════════════════════════════════════
// CLAIM GIFT — Daily Streak (server-side CURRENT_DATE)
// ═══════════════════════════════════════════════════════════════════
async function handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_gift');
  if (result !== 'ok') return { ok: false, error: result };

  // Use CURRENT_DATE from database to prevent timezone exploits
  const r = await sql(
    `SELECT last_gift_date, streak_day,
            CURRENT_DATE AS today,
            (CURRENT_DATE - INTERVAL '1 day')::date AS yesterday
     FROM users WHERE id=$1`,
    [userId]
  );
  const u = r[0];
  if (!u) return { ok: false, error: 'user_not_found' };

  const today     = String(u.today).slice(0, 10);
  const yesterday = String(u.yesterday).slice(0, 10);
  const last      = u.last_gift_date ? String(u.last_gift_date).slice(0, 10) : '';

  if (last === today) return { ok: false, error: 'already_claimed_today' };

  const newStreak = last === yesterday ? (parseInt(u.streak_day) || 0) + 1 : 1;
  const reward    = giftReward(newStreak);

  // Atomic update — prevents double claim via idempotent condition
  const updated = await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1, streak_day=$2,
         last_gift_date=CURRENT_DATE, updated_at=NOW()
     WHERE id=$3 AND (last_gift_date IS NULL OR last_gift_date < CURRENT_DATE)
     RETURNING points, level`,
    [reward, newStreak, userId]
  );

  if (!updated.length) return { ok: false, error: 'already_claimed_today' };

  await syncLevel(userId);
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'claim_gift', 'ok', ipHash, fpHash, { reward, streak: newStreak });
  return { ok: true, reward, streak_day: newStreak, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}


// ═══════════════════════════════════════════════════════════════════
// GET CHANNELS — Dynamic channel list from DB
// ═══════════════════════════════════════════════════════════════════
async function handleGetChannels(userId) {
  const channels = await sql(
    `SELECT id, title, url, reward, max_members FROM channels
     WHERE is_active=TRUE ORDER BY sort_order ASC, id ASC`
  );

  // Check which channels this user has already verified
  const verified = await sql(
    `SELECT task_type FROM user_tasks
     WHERE user_id=$1 AND completed=TRUE
       AND task_type LIKE 'channel_%'`,
    [userId]
  );
  const verifiedSet = new Set(verified.map(r => r.task_type));

  return {
    ok: true,
    channels: channels.map(c => ({
      id:          c.id,
      title:       c.title,
      url:         c.url,
      reward:      c.reward,
      max_members: parseInt(c.max_members) || 0,
      verified:    verifiedSet.has('channel_' + c.id),
    })),
  };
}


// ═══════════════════════════════════════════════════════════════════
// VERIFY CHANNEL TASK — verify membership for a specific channel
// ═══════════════════════════════════════════════════════════════════
async function handleVerifyChannelTask(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const channelId = parseInt(body?.data?.channel_id);
  if (!channelId) return { ok: false, error: 'missing_channel_id' };

  // ✅ action مطابق للـ get_nonce الذي يرسله الكليانت: 'verify_channel_task'
  // كان 'verify_tg_task' خطأ → يسبب nonce_action_mismatch → 500
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'verify_channel_task');
  if (result !== 'ok') return { ok: false, error: result };

  const uCheck = (await sql(
    `SELECT is_shadow_banned, tg_id FROM users WHERE id=$1`,
    [userId]
  ))[0];
  if (!uCheck) return { ok: false, error: 'user_not_found' };
  if (uCheck.is_shadow_banned) {
    logShadow('channel_task_blocked', userId, {});
    return { ok: false, error: 'account_review' };
  }

  const taskKey = 'channel_' + channelId;

  // Already verified?
  const existing = (await sql(
    `SELECT id FROM user_tasks
     WHERE user_id=$1 AND task_type=$2 AND completed=TRUE`,
    [userId, taskKey]
  ));
  if (existing.length) return { ok: false, error: 'already_verified' };

  // Get channel info
  const ch = (await sql(`SELECT url, reward FROM channels WHERE id=$1 AND is_active=TRUE`, [channelId]))[0];
  if (!ch) return { ok: false, error: 'channel_not_found' };

  // Telegram membership check — extract username from URL
  const telegramId = uCheck.tg_id;
  if (telegramId && !IS_DEV && BOT_TOKEN && CHANNEL_ID) {
    // Use global CHANNEL_ID for now; can be extended per-channel
    const membership = await checkTelegramMembership(telegramId);
    if (!membership.ok && !membership.skipped) {
      return { ok: false, error: 'not_in_channel' };
    }
  }

  const reward = parseInt(ch.reward) || 2500;

  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [reward, userId]
  );
  await upsertTask(userId, taskKey);
  await syncLevel(userId);

  const fresh = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'verify_channel_task', 'ok', ipHash, fpHash, {
    channel_id: channelId, reward,
  });

  return { ok: true, reward, points: parseInt(fresh?.points) || 0 };
}


// ═══════════════════════════════════════════════════════════════════
// VERIFY TG TASK
// ═══════════════════════════════════════════════════════════════════
async function handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'verify_tg_task');
  if (result !== 'ok') return { ok: false, error: result };

  const uCheck = (await sql(`SELECT is_shadow_banned, tg_id, tg_verified FROM users WHERE id=$1`, [userId]))[0];
  if (!uCheck) return { ok: false, error: 'user_not_found' };
  if (uCheck.is_shadow_banned) {
    logShadow('tg_task_blocked', userId, {});
    return { ok: false, error: 'account_review' };
  }
  if (uCheck.tg_verified) return { ok: false, error: 'already_verified' };

  // ── فحص العضوية الفعلي عبر Bot API ─────────────────────────────
  const telegramId = uCheck.tg_id;
  if (telegramId && !IS_DEV) {
    const membership = await checkTelegramMembership(telegramId);
    if (!membership.ok && !membership.skipped) {
      console.warn(`[VERIFY_TG] user ${userId} not in channel — status: ${membership.status}`);
      return { ok: false, error: 'not_in_channel' };
    }
  }

  const reward = CONFIG.rewards.telegram_task;
  const tgUpdateRes = await sql(
    `UPDATE users SET tg_verified=TRUE, points=points+$1, xp=xp+$1, updated_at=NOW()
     WHERE id=$2 AND tg_verified=FALSE
     RETURNING id`,
    [reward, userId]
  );
  if (!tgUpdateRes.length) return { ok: false, error: 'already_verified' };
  await syncLevel(userId);
  await upsertTask(userId, 'tg_join');
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'verify_tg_task', 'ok', ipHash, fpHash, { reward });
  return { ok: true, reward, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}


// ═══════════════════════════════════════════════════════════════════
// SUBMIT WITHDRAW — First Withdraw System
// ═══════════════════════════════════════════════════════════════════
async function handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'submit_withdraw');
  if (result !== 'ok') return { ok: false, error: result };

  const address = (body?.data?.address || '').trim();
  if (!isValidTon(address)) return { ok: false, error: 'invalid_address' };

  const r = await sql(`SELECT points, level, first_withdraw_done FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };

  const pts   = parseInt(r[0].points) || 0;
  const level = parseInt(r[0].level)  || 1;
  const firstDone = !!r[0].first_withdraw_done;

  // Determine requirements based on first withdraw status
  if (!firstDone) {
    // First withdraw — lower threshold, no level requirement
    if (pts < CONFIG.withdraw.first_min) {
      return {
        ok: false,
        error: 'insufficient_balance',
        required: CONFIG.withdraw.first_min,
        have: pts,
        first_withdraw_offer: true,
      };
    }
  } else {
    // Normal withdraw — full requirements
    if (level < CONFIG.withdraw.normal_level) {
      return { ok: false, error: 'level_too_low', required_level: CONFIG.withdraw.normal_level };
    }
    if (pts < CONFIG.withdraw.normal_min) {
      return { ok: false, error: 'insufficient_balance', required: CONFIG.withdraw.normal_min, have: pts };
    }
  }

  const ton = parseFloat((pts / CFG.PTS_PER_TON).toFixed(6));
  await sql(`UPDATE users SET points=points-$1, updated_at=NOW() WHERE id=$2`, [pts, userId]);
  const wr = await sql(
    `INSERT INTO withdrawals(user_id, pts, ton_amount, address, method, status) VALUES($1,$2,$3,$4,'ton','pending') RETURNING id`,
    [userId, pts, ton, address]
  );

  // Mark first withdraw as done
  if (!firstDone) {
    await sql(`UPDATE users SET first_withdraw_done=TRUE, updated_at=NOW() WHERE id=$1`, [userId]);
  }

  const nb = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'submit_withdraw', 'ok', ipHash, fpHash, {
    pts, ton, first_withdraw: !firstDone,
  });
  return {
    ok: true,
    withdraw_id:  wr[0].id,
    pts_deducted: pts,
    ton_amount:   ton,
    new_balance:  parseInt(nb?.points) || 0,
    status:       'pending',
    first_withdraw: !firstDone,
  };
}


// ═══════════════════════════════════════════════════════════════════
// GET REFERRALS
// ═══════════════════════════════════════════════════════════════════
async function handleGetReferrals(userId) {
  const r = (await sql(`SELECT total_referrals, earned_from_refs, tg_id FROM users WHERE id=$1`, [userId]))[0];
  const rR = await sql(
    `SELECT u.tg_first_name, u.tg_username, u.created_at, ref.activated
     FROM referrals ref
     JOIN users u ON u.id=ref.referred_id
     WHERE ref.referrer_id=$1
     ORDER BY ref.created_at DESC LIMIT 20`,
    [userId]
  );
  return {
    ok: true,
    total_referrals:  r.total_referrals,
    earned_from_refs: parseInt(r.earned_from_refs) || 0,
    pts_per_referral: CONFIG.rewards.referral,
    referral_list: rR.map(x => ({
      name:      x.tg_first_name || x.tg_username || 'مستخدم',
      ts:        new Date(x.created_at).getTime(),
      activated: !!x.activated,
    })),
    tg_id: r.tg_id,
  };
}


// ═══════════════════════════════════════════════════════════════════
// TRACK AD EVENT — no rewards, just audit + timing
// ═══════════════════════════════════════════════════════════════════
async function handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash) {
  const allowed = new Set([
    'ad_requested', 'ad_loaded', 'ad_started',
    'ad_failed', 'ad_completed', 'reward_granted',
    'suspicious_activity',
  ]);
  const event   = body?.data?.event   || '';
  const ad_type = body?.data?.ad_type || 'daily_ad'; // 'adsgram_task' | 'daily_ad'
  if (!allowed.has(event)) return { ok: false, error: 'unknown_event' };

  if (event === 'ad_started' && ad_type !== 'adsgram_task') {
    await sql(`UPDATE sessions SET ad_started_at=NOW() WHERE id=$1`, [sessionId]);
  }

  // ── فصل تام: adsgram_task يُحدّث session فقط، start_adsgram_task هو المصدر الحقيقي لـ users
  if (event === 'ad_started' && ad_type === 'adsgram_task') {
    await sql(`UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`, [sessionId]);
    // لا نُحدّث users هنا — start_adsgram_task يفعل ذلك قبل widget.show()
  }

  if (event === 'suspicious_activity') {
    const reason = String(body?.data?.reason || 'client_report').slice(0, 50);
    await addRisk(userId, `client_suspicious_${reason}`, ipHash, fpHash, 10);
  }

  await writeAudit(userId, sessionId, event, 'tracked', ipHash, fpHash, {
    ad_type,
    meta: body?.data?.meta || {},
  });
  return { ok: true };
}


// ═══════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════
async function handleAdmin(action, body) {
  if (action === 'list_withdrawals') {
    const r = await sql(
      `SELECT w.id,w.user_id,u.tg_username,u.tg_first_name,w.pts,w.ton_amount,w.address,w.status,w.created_at
       FROM withdrawals w JOIN users u ON u.id=w.user_id
       WHERE w.status=$1 ORDER BY w.created_at DESC LIMIT 100`,
      [body?.status || 'pending']
    );
    return { ok: true, withdrawals: r };
  }
  if (action === 'approve_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    await sql(`UPDATE withdrawals SET status='completed', tx_hash=$1, reviewed_at=NOW() WHERE id=$2`, [body?.tx_hash || '', id]);
    return { ok: true };
  }
  if (action === 'reject_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    const wr = await sql(`SELECT user_id, pts FROM withdrawals WHERE id=$1`, [id]);
    if (wr.length) await sql(`UPDATE users SET points=points+$1 WHERE id=$2`, [wr[0].pts, wr[0].user_id]);
    await sql(`UPDATE withdrawals SET status='rejected', reviewed_at=NOW() WHERE id=$1`, [id]);
    return { ok: true };
  }
  if (action === 'ban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_banned=TRUE, ban_reason=$1 WHERE tg_id=$2`, [body?.reason || 'admin_ban', tgId]);
    return { ok: true };
  }
  if (action === 'unban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_banned=FALSE, ban_reason=NULL, risk_score=0, is_shadow_banned=FALSE WHERE tg_id=$1`, [tgId]);
    return { ok: true };
  }
  if (action === 'stats') {
    const r = (await sql(`
      SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER(WHERE created_at > NOW() - INTERVAL '1 day') AS new_today,
        SUM(points) AS total_points,
        COUNT(*) FILTER(WHERE is_banned) AS banned_users,
        COUNT(*) FILTER(WHERE is_shadow_banned) AS shadow_banned_users,
        COUNT(*) FILTER(WHERE first_withdraw_done) AS first_withdraw_done_count
      FROM users
    `))[0];
    const w = (await sql(`
      SELECT COUNT(*) AS pending_wd, COALESCE(SUM(pts),0) AS pending_pts
      FROM withdrawals WHERE status='pending'
    `))[0];
    return { ok: true, stats: { ...r, ...w } };
  }
  if (action === 'audit_log') {
    const rows = await sql(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ${parseInt(body?.limit) || 100}`
    );
    return { ok: true, logs: rows };
  }
  if (action === 'risk_log') {
    const rows = await sql(
      `SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ${parseInt(body?.limit) || 100}`
    );
    return { ok: true, logs: rows };
  }
  if (action === 'shadow_unban') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_shadow_banned=FALSE, risk_score=0 WHERE tg_id=$1`, [tgId]);
    return { ok: true };
  }
  if (action === 'set_usdt') {
    const tgId = parseInt(body?.tg_id);
    const amount = parseFloat(body?.amount);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    if (isNaN(amount) || amount < 0) return { ok: false, error: 'invalid_amount' };
    const r = await sql(
      `UPDATE users SET usdt_balance=$1, updated_at=NOW() WHERE tg_id=$2 RETURNING id, usdt_balance`,
      [amount.toFixed(6), tgId]
    );
    if (!r.length) return { ok: false, error: 'user_not_found' };
    return { ok: true, tg_id: tgId, usdt_balance: parseFloat(r[0].usdt_balance) };
  }
  if (action === 'add_usdt') {
    const tgId = parseInt(body?.tg_id);
    const amount = parseFloat(body?.amount);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    if (isNaN(amount)) return { ok: false, error: 'invalid_amount' };
    const r = await sql(
      `UPDATE users SET usdt_balance=GREATEST(0, usdt_balance+$1), updated_at=NOW() WHERE tg_id=$2 RETURNING id, usdt_balance`,
      [amount.toFixed(6), tgId]
    );
    if (!r.length) return { ok: false, error: 'user_not_found' };
    return { ok: true, tg_id: tgId, usdt_balance: parseFloat(r[0].usdt_balance) };
  }
  return { ok: false, error: 'unknown_admin_action' };
}


// ═══════════════════════════════════════════════════════════════════
// ADSGRAM SERVER-TO-SERVER REWARD CALLBACK
// GET /api/adsgram-reward?userId=[tg_id]
// ═══════════════════════════════════════════════════════════════════
async function handleAdsgramCallback(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  const rawUrl  = req.url || '';
  const qStart  = rawUrl.indexOf('?');
  const query   = qStart >= 0 ? new URLSearchParams(rawUrl.slice(qStart + 1)) : new URLSearchParams();
  const rawId   = query.get('userId') || query.get('userid') || query.get('user_id') || '';
  const tgId    = parseInt(rawId, 10);

  if (!tgId || isNaN(tgId) || tgId <= 0) {
    res.status(400).end('invalid_user');
    return;
  }
  res.status(200).end('ok');

  try {
    const ipHash = hashIp(getIp(req));
    const userRows = await sql(`SELECT id, is_shadow_banned FROM users WHERE tg_id=$1`, [tgId]);
    if (!userRows.length) {
      await writeAudit(0, 'adsgram_cb', 'adsgram_callback', 'user_not_found', ipHash, null, { tg_id: tgId });
      return;
    }
    const user   = userRows[0];
    const userId = user.id;

    if (user.is_shadow_banned) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'shadow_banned', ipHash, null, {});
      return;
    }

    const adLog = (await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0];
    if ((parseInt(adLog?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'daily_limit', ipHash, null, {});
      return;
    }

    const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
    if (coolRow?.ad_last_reward) {
      const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
      if (elapsed < CFG.AD_COOLDOWN_MS) {
        await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'cooldown', ipHash, null, { elapsed_ms: elapsed });
        return;
      }
    }

    // Replay detection
    const recentCb = await sql(
      `SELECT id FROM audit_log
       WHERE user_id=$1 AND action='adsgram_callback' AND status='ok'
         AND created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`,
      [userId]
    );
    if (recentCb.length) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'replay', ipHash, null, {});
      return;
    }

    await sql(
      `UPDATE users SET points=points+$1, xp=xp+$1, ad_last_reward=NOW(), updated_at=NOW() WHERE id=$2`,
      [CFG.POINTS_PER_AD, userId]
    );
    await sql(
      `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
       VALUES($1, CURRENT_DATE, 1, $2)
       ON CONFLICT(user_id, log_date)
       DO UPDATE SET count=ad_logs.count+1, points_earned=ad_logs.points_earned+$2`,
      [userId, CFG.POINTS_PER_AD]
    );
    await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'ok', ipHash, null, {
      tg_id: tgId, points_earned: CFG.POINTS_PER_AD,
    });
    console.info('[Adsgram CB] ✅ Reward — userId:', userId, 'tgId:', tgId);
  } catch (err) {
    console.error('[Adsgram CB] Error:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER

module.exports = {
  handleGetConfig, handleCreateSession, handleLoad, handleGetState,
  handleStartAd, handleRewardAd, handleStartAdsgramTask, handleClaimAdsgramTask,
  handleClaimDailyMission, handleClaimGift, handleGetChannels,
  handleVerifyChannelTask, handleVerifyTgTask, handleSubmitWithdraw,
  handleGetReferrals, handleTrackAdEvent, handleAdmin, handleAdsgramCallback,
};
