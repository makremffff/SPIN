'use strict';

const { CONFIG, CFG, BOT_TOKEN, IS_DEV } = require('./config');
const { sql } = require('./db');
const {
  computeLevel, giftReward, isValidTon, logRisk, logShadow,
  logRewardBlock, logAdsgramState, hashIp, getIp, verifyTg, genRawNonce,
} = require('./utils');
const {
  issueAdNonce, issueNonce, consumeNonce, consumeAdNonce,
  writeAudit, addRisk, checkMultiAccount,
} = require('./security');

// ── Telegram Bot API: check channel membership ───────────────────
async function checkTelegramMembership(telegramUserId, chatId) {
  if (!BOT_TOKEN) {
    console.warn('[TG_MEMBER] BOT_TOKEN not set — skipping');
    return { ok: true, skipped: true };
  }
  if (!chatId) {
    console.warn('[TG_MEMBER] No chatId — skipping');
    return { ok: true, skipped: true };
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegramUserId}`;
    const res  = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    if (!json.ok) {
      const desc = (json.description || '').toLowerCase();
      const code = json.error_code;
      // إذا البوت ليس عضو أو ليس admin أو ليس لديه صلاحية — نتخطى التحقق
      // (البوت admin في القناة يعني التحقق تم)
      if (
        code === 403 || code === 400 ||
        desc.includes('bot is not a member') ||
        desc.includes('not enough rights') ||
        desc.includes('forbidden') ||
        desc.includes('administrator') ||
        desc.includes('kicked') ||
        desc.includes('chat not found')
      ) {
        console.warn('[TG_MEMBER] Bot cannot verify membership (likely admin without permission) — skipping:', json.description);
        return { ok: true, skipped: true, reason: 'bot_permission' };
      }
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

// ── Telegram Bot: إرسال رسالة لمستخدم ───────────────────────────
async function sendBotMessage(tgId, text) {
  if (!BOT_TOKEN || !tgId) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgId, text, parse_mode: 'HTML' }),
      }
    );
  } catch (e) {
    console.warn('[BOT_MSG] Failed to send:', e.message);
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
  const r = await sql(`SELECT xp, level, tg_id FROM users WHERE id=$1`, [userId]);
  if (!r.length) return;
  const oldLevel = parseInt(r[0].level) || 0;
  const newLevel = computeLevel(parseInt(r[0].xp) || 0);
  await sql(`UPDATE users SET level=$1 WHERE id=$2`, [newLevel, userId]);
  // إشعار ترقية المستوى
  if (newLevel > oldLevel && r[0].tg_id) {
    await sendBotMessage(
      r[0].tg_id,
      `🏆 <b>مبروك! وصلت للمستوى ${newLevel}</b>\n\n⬆️ تمت ترقيتك من المستوى ${oldLevel} إلى المستوى ${newLevel}.\n\nاستمر وارتقِ أكثر! 💪`
    );
  }
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
      title_ar:    CONFIG.adsgram_task.title_ar,
      title_en:    CONFIG.adsgram_task.title_en,
      block_id:    CONFIG.adsgram_task.block_id,
      reward:      CONFIG.rewards.adsgram_task,
      cooldown_ms: CONFIG.adsgram_task.cooldown_ms,
      daily_limit: CONFIG.adsgram_task.daily_limit,
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

  // ── Save / update user photo URL ─────────────────────────────
  if (tgUser.photo_url) {
    try {
      await sql(
        `INSERT INTO user_photos(user_id, photo_url, updated_at)
         VALUES($1,$2,NOW())
         ON CONFLICT(user_id) DO UPDATE SET photo_url=EXCLUDED.photo_url, updated_at=NOW()`,
        [user.id, tgUser.photo_url]
      );
    } catch (_) {}
  }
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
            // إشعار المحيل بدخول مستخدم جديد برابطه
            const newName = tgUser.first_name || tgUser.username || 'مستخدم';
            await sendBotMessage(
              refTgId,
              `🎉 انضم مستخدم جديد عبر رابط الإحالة الخاص بك!\n\n👤 <b>${newName}</b> قام بالتسجيل باستخدام رابط دعوتك.\n\n💎 استمر بدعوة المزيد من الأصدقاء لزيادة أرباحك ومكافآتك.`
            );
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
  // ── Session creation rate limit — DB level (يعمل عبر كل serverless instances) ──
  try {
    const recentSessions = await sql(
      `SELECT COUNT(*) AS cnt FROM sessions
       WHERE user_id=$1 AND created_at > NOW() - INTERVAL '5 minutes'`,
      [user.id]
    );
    const sessionCount = parseInt(recentSessions[0]?.cnt) || 0;
    if (sessionCount >= 3) {
      // 3 sessions في 5 دقائق — بوت أو أتمتة
      await addRisk(user.id, 'session_farming', ipHash, fpHash, 20, {
        sessions_in_5min: sessionCount, tg_id: tid,
      });
      await writeAudit(user.id, null, 'create_session', 'session_farming_blocked', ipHash, fpHash, {
        sessions_in_5min: sessionCount,
      });
      return { ok: false, error: 'too_many_sessions', status: 429 };
    }
  } catch (farmErr) {
    console.warn('[CREATE_SESSION] Session farm check error (non-fatal):', farmErr.message);
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

// ── Give 5% ad commission to referrer whenever referred watches an ad ──
async function giveReferralAdCommission(referredUserId, adPoints) {
  try {
    // جلب المُحيل من جدول referrals (يجب أن يكون مُفعَّلاً)
    const refRow = await sql(
      `SELECT referrer_id FROM referrals
       WHERE referred_id=$1 AND activated=TRUE
       LIMIT 1`,
      [referredUserId]
    );
    if (!refRow.length) return; // لا يوجد محيل أو الإحالة غير مفعّلة بعد

    const referrerId = refRow[0].referrer_id;
    const commission = Math.max(1, Math.floor(adPoints * 0.05)); // 5% لا تقل عن نقطة واحدة

    // جلب tg_id المحيل واسم المُحال
    const [referrerRow, referredRow] = await Promise.all([
      sql(`SELECT tg_id FROM users WHERE id=$1`, [referrerId]),
      sql(`SELECT tg_first_name, tg_username FROM users WHERE id=$1`, [referredUserId]),
    ]);

    await sql(
      `UPDATE users
       SET points=points+$1,
           xp=xp+$1,
           earned_from_refs=earned_from_refs+$1,
           updated_at=NOW()
       WHERE id=$2`,
      [commission, referrerId]
    );
    await syncLevel(referrerId);
    await writeAudit(referrerId, null, 'ref_ad_commission', 'ok', null, null, {
      referred_id: referredUserId,
      ad_points: adPoints,
      commission,
    });
    console.info(`[REF_COMMISSION] referrer=${referrerId} referred=${referredUserId} ad_pts=${adPoints} commission=${commission}`);

    // إشعار المحيل
    if (referrerRow[0]?.tg_id) {
      const referredName = referredRow[0]?.tg_first_name || referredRow[0]?.tg_username || 'إحالتك';
      await sendBotMessage(
        referrerRow[0].tg_id,
        `📺 شاهدت إحالتك <b>${referredName}</b> إعلانًا جديدًا.

💰 تمت إضافة 25% من نقاط الإعلان إلى رصيدك كمكافأة إحالة.

🚀 استمر بدعوة المزيد من الأصدقاء لزيادة أرباحك.`
      );
    }
  } catch (e) {
    console.error('[REF_COMMISSION] error:', e.message);
  }
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

  // إشعار المحيل بتفعيل مكافأة الإحالة
  const refUser = (await sql(`SELECT tg_id FROM users WHERE id=$1`, [pendingRef.referrer_id]))[0];
  if (refUser?.tg_id) {
    await sendBotMessage(
      refUser.tg_id,
      `💎 <b>تم تفعيل مكافأة الإحالة!</b>\n\nأصبح أحد أصدقائك الذين دعوتهم مستخدماً نشطاً.\n\n🎁 تم إضافة <b>${CONFIG.rewards.referral} نقطة</b> إلى رصيدك.\n\nاستمر بدعوة المزيد لتربح أكثر! 🚀`
    );
  }
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

  const monetagLogR = await sql(`SELECT count FROM monetag_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const monetagLog  = monetagLogR[0] || { count: 0 };

  const wR = await sql(`SELECT pts,address,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
  const rR = await sql(`SELECT u.tg_first_name,u.tg_username,u.created_at,r.activated,up.photo_url FROM referrals r JOIN users u ON u.id=r.referred_id LEFT JOIN user_photos up ON up.user_id=r.referred_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 10`, [userId]);
  const tR = await sql(`SELECT task_type, reward_claimed FROM user_tasks WHERE user_id=$1 AND task_date=CURRENT_DATE AND completed=TRUE`, [userId]);

  // ── Adsgram state from DB ─────────────────────────────────────
  const adsgramState = buildAdsgramState(u);
  // Today's adsgram task completion count
  const atCountRow = await sql(
    `SELECT COUNT(*)::int AS cnt FROM completed_tasks
     WHERE user_id=$1 AND task_key='adsgram_task_daily'
       AND completed_at >= NOW()::date`,
    [userId]
  );
  u.adsgram_task_today_count = atCountRow[0]?.cnt || 0;

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
    adsgram_task_today_count: parseInt(u.adsgram_task_today_count) || 0,
    adsgram_task_daily_limit: CFG.ADSGRAM_TASK_DAILY_LIMIT || CONFIG.adsgram_task.daily_limit || 3,
    monetag: {
      watched_today:  parseInt(monetagLog?.count) || 0,
      daily_limit:    CFG.MONETAG_DAILY_LIMIT,
      reward:         CFG.MONETAG_REWARD,
      cooldown_ms:    CFG.MONETAG_COOLDOWN_MS,
      zone_id:        CFG.MONETAG_ZONE_ID,
    },
    withdrawals: wR.map(w => ({
      pts: parseInt(w.pts) || 0, address: w.address,
      method: w.method, status: w.status, ts: new Date(w.created_at).getTime(),
    })),
    referral_list: rR.map(r => ({
      name: r.tg_first_name || r.tg_username || 'مستخدم',
      ts: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      activated: !!r.activated,
      photo_url: r.photo_url || null,
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
    cooldown_ms: CONFIG.adsgram_task.cooldown_ms,
  };
}

// ═══════════════════════════════════════════════════════════════════
// GET STATE — lightweight polling
// ═══════════════════════════════════════════════════════════════════
async function handleGetState(userId) {
  const r = await sql(`SELECT points,level,xp,total_referrals,earned_from_refs,ad_last_reward,
    adsgram_status,adsgram_started_at,adsgram_expires_at,adsgram_completed,adsgram_claimed,adsgram_last_claimed_at,
    ad_next_cooldown_ms
    FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };
  const u  = r[0];
  const ad = (await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0] || { count: 0, points_earned: 0 };
  const monetagLogGS = (await sql(`SELECT count FROM monetag_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0] || { count: 0 };

  let ad_cooldown_ms = 0;
  if (u.ad_last_reward) {
    const userCooldownMs = parseInt(u.ad_next_cooldown_ms) || CFG.AD_COOLDOWN_MS;
    const elapsed = Date.now() - new Date(u.ad_last_reward).getTime();
    ad_cooldown_ms = Math.max(0, userCooldownMs - elapsed);
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
    monetag_watched_today: parseInt(monetagLogGS?.count) || 0,
    monetag_remaining:     Math.max(0, CFG.MONETAG_DAILY_LIMIT - (parseInt(monetagLogGS?.count) || 0)),
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
  const coolRow = (await sql(`SELECT ad_last_reward, ad_next_cooldown_ms FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const cooldownMs = parseInt(coolRow.ad_next_cooldown_ms) || CFG.AD_COOLDOWN_MS;
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < cooldownMs) {
      return { ok: false, error: 'cooldown_active', wait_ms: cooldownMs - elapsed };
    }
  }
  const nonce = await issueAdNonce(sessionId, userId, ipHash);
  if (!nonce) return { ok: false, error: 'session_invalid' };
  await writeAudit(userId, sessionId, 'start_ad', 'ok', ipHash, fpHash, {});
  return { ok: true, ad_nonce: nonce };
}

// ── Random cooldown بين الإعلانات (35-100 ثانية) ──────────────────
function _randomAdCooldownMs() {
  const options = [35000, 40000, 55000, 60000, 90000, 100000];
  return options[Math.floor(Math.random() * options.length)];
}

async function handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce) {
  // elapsed_ms يُرسَل من الـ frontend مباشرة من controller.show() — أدق من timestamp
  const adElapsedMs = parseInt(body?.data?.ad_elapsed_ms) || 0;

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

  // [4] Cooldown check — يستخدم الـ cooldown العشوائي المخزون للمستخدم
  const coolRow = (await sql(`SELECT ad_last_reward, ad_next_cooldown_ms FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const cooldownMs = parseInt(coolRow.ad_next_cooldown_ms) || CFG.AD_COOLDOWN_MS;
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < cooldownMs) {
      const waitMs = cooldownMs - elapsed;
      logRewardBlock('cooldown_active', userId, { wait_ms: waitMs });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // [5] Timing check على elapsed_ms الحقيقي من controller.show()
  // الـ frontend يحسبه مباشرة: Date.now() بعد controller.show() - Date.now() قبله
  //   < AD_MIN_DURATION_MS  → رُفض (سريع جداً — تلاعب)
  //   30000 – 31999 ms      → إعلان عادي بدون تفاعل → 50% جائزة
  //   ≥ 32000 ms            → تفاعل كامل → جائزة كاملة
  let isPartialReward = false;
  if (adElapsedMs > 0) {
    if (adElapsedMs < CFG.AD_MIN_DURATION_MS) {
      await addRisk(userId, 'ad_too_fast_client', ipHash, fpHash, 10);
      logRewardBlock('timing_invalid', userId, { elapsed_ms: adElapsedMs });
      return { ok: false, error: 'ad_duration_invalid' };
    }
    if (adElapsedMs >= 30000 && adElapsedMs <= 31999) {
      isPartialReward = true;
    }
    // adElapsedMs >= 32000 → full reward
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
  const pointsToAward = isPartialReward
    ? Math.floor(CFG.POINTS_PER_AD / 2)
    : CFG.POINTS_PER_AD;

  const lr = await sql(
    `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
     VALUES($1, CURRENT_DATE, 1, $2)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       count         = CASE WHEN ad_logs.count < $3 THEN ad_logs.count + 1         ELSE ad_logs.count         END,
       points_earned = CASE WHEN ad_logs.count < $3 THEN ad_logs.points_earned + $2 ELSE ad_logs.points_earned END,
       updated_at    = NOW()
     RETURNING count, points_earned`,
    [userId, pointsToAward, CFG.ADS_DAILY_LIMIT]
  );
  const watched = parseInt(lr[0].count) || 0;

  const nextCooldownMs = _randomAdCooldownMs();

  await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1,
         ads_watched_total=ads_watched_total+1,
         ad_last_reward=NOW(),
         ad_next_cooldown_ms=$3,
         updated_at=NOW()
     WHERE id=$2`,
    [pointsToAward, userId, nextCooldownMs]
  );

  await syncLevel(userId);

  // ── Daily missions completion ──────────────────────────────────
  if (watched >= 10) await upsertTask(userId, 'ads_10');
  if (watched >= 25) await upsertTask(userId, 'ads_25');

  // ── Activate pending referral if user just became active ──────
  if (watched >= CONFIG.referral.min_active_ads) {
    try { await activatePendingReferral(userId); } catch (_) {}
  }
  // ── عمولة 5% للمُحيل من كل إعلان يشاهده المُحال ──────
  try { await giveReferralAdCommission(userId, pointsToAward); } catch (_) {}

  await writeAudit(userId, sessionId, 'reward_ad', 'ok', ipHash, fpHash, {
    watched, points_earned: pointsToAward, partial: isPartialReward,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return {
    ok:            true,
    partial:       isPartialReward,
    points_awarded: pointsToAward,
    remaining:     Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    watchedToday:  watched,
    earnedToday:   parseInt(lr[0].points_earned) || 0,
    earned:        CONFIG.rewards.ad_watch,
    points:        parseInt(ur[0]?.points) || 0,
    all_done:      watched >= CFG.ADS_DAILY_LIMIT,
    cooldown_ms:   nextCooldownMs,
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

  // Check daily limit for adsgram task
  const todayTaskCount = (await sql(
    `SELECT COUNT(*)::int AS cnt FROM completed_tasks
     WHERE user_id=$1 AND task_key='adsgram_task_daily'
       AND completed_at >= NOW()::date`,
    [userId]
  ))[0]?.cnt || 0;
  const dailyLimit = CFG.ADSGRAM_TASK_DAILY_LIMIT || 3;
  if (todayTaskCount >= dailyLimit) {
    return {
      ok: false,
      error: 'daily_limit_reached',
      adsgram_task_today_count: todayTaskCount,
      adsgram_task_daily_limit: dailyLimit,
    };
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
  // ── عمولة 5% للمُحيل من مهمة Adsgram للمُحال ──
  try { await giveReferralAdCommission(userId, CFG.ADSGRAM_TASK_POINTS); } catch (_) {}
  await writeAudit(userId, sessionId, 'claim_adsgram_task', 'ok', ipHash, fpHash, {
    points: CFG.ADSGRAM_TASK_POINTS, adsgram_state: 'completed',
  });

  logAdsgramState(userId, 'completed', { reward: CFG.ADSGRAM_TASK_POINTS });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  const freshU = ur[0];
  // Re-check today count after insert
  const newTodayCount = (await sql(
    `SELECT COUNT(*)::int AS cnt FROM completed_tasks
     WHERE user_id=$1 AND task_key='adsgram_task_daily'
       AND completed_at >= NOW()::date`,
    [userId]
  ))[0]?.cnt || 0;
  const dailyLimitC = CFG.ADSGRAM_TASK_DAILY_LIMIT || 3;
  return {
    ok: true,
    points: parseInt(freshU?.points) || 0,
    earned: CFG.ADSGRAM_TASK_POINTS,
    reward: CFG.ADSGRAM_TASK_POINTS,
    cooldown_ms: CFG.ADSGRAM_TASK_COOLDOWN_MS,
    adsgram_task_today_count: newTodayCount,
    adsgram_task_daily_limit: dailyLimitC,
    adsgram_task: {
      status: newTodayCount >= dailyLimitC ? 'maxed' : 'cooldown',
      remaining_seconds: Math.ceil(CFG.ADSGRAM_TASK_COOLDOWN_MS / 1000),
      reward: CONFIG.rewards.adsgram_task,
      claimed: true,
      cooldown_ms: CFG.ADSGRAM_TASK_COOLDOWN_MS,
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
  const fresh = (await sql(`SELECT points, level, tg_id FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'claim_gift', 'ok', ipHash, fpHash, { reward, streak: newStreak });

  // إشعار المكافأة اليومية
  if (fresh?.tg_id) {
    await sendBotMessage(
      fresh.tg_id,
      `🎁 <b>تم استلام مكافأتك اليومية!</b>\n\n✅ اليوم ${newStreak} على التوالي.\n💰 تم إضافة <b>${reward} نقطة</b> إلى رصيدك.\n\nتذكر العودة غداً للحفاظ على سلسلتك! 🔥`
    );
  }

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
  const ch = (await sql(`SELECT url, reward, tg_chat_id FROM channels WHERE id=$1 AND is_active=TRUE`, [channelId]))[0];
  if (!ch) return { ok: false, error: 'channel_not_found' };

  // Telegram membership check
  const telegramId = uCheck.tg_id;
  if (telegramId && !IS_DEV && BOT_TOKEN) {
    // tg_chat_id له الأولوية — يمكن أن يكون @username أو numeric -100xxx
    // إذا مافيه نستخرج @username من الـ URL (يعمل فقط مع قنوات عامة)
    let chatId = ch.tg_chat_id || null;
    if (!chatId && ch.url) {
      const slug = ch.url.split('t.me/').pop().split('?')[0].trim();
      if (!slug.startsWith('+')) chatId = '@' + slug; // invite links لا تعمل
    }
    const membership = await checkTelegramMembership(telegramId, chatId);
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
// CHECK CHANNEL MEMBERSHIP — يفحص كل القنوات المكتملة
// إذا ترك المستخدم قناة: يخصم 250 نقطة ويُعيد المهمة
// ═══════════════════════════════════════════════════════════════════
const CHANNEL_LEAVE_PENALTY = 250;

async function handleCheckChannelMembership(userId) {
  const user = (await sql(
    `SELECT tg_id, points FROM users WHERE id=$1`,
    [userId]
  ))[0];
  if (!user || !user.tg_id) return { ok: true, penalties: [] };

  // جلب كل القنوات التي أكملها المستخدم
  const completedChannels = await sql(
    `SELECT ut.task_type, c.id AS channel_id, c.title, c.tg_chat_id, c.url
     FROM user_tasks ut
     JOIN channels c ON ut.task_type = 'channel_' || c.id::text
     WHERE ut.user_id=$1 AND ut.completed=TRUE AND c.is_active=TRUE`,
    [userId]
  );

  if (!completedChannels.length) return { ok: true, penalties: [] };

  const penalties = [];

  for (const ch of completedChannels) {
    let chatId = ch.tg_chat_id || null;
    if (!chatId && ch.url) {
      const slug = ch.url.split('t.me/').pop().split('?')[0].trim();
      if (!slug.startsWith('+')) chatId = '@' + slug;
    }
    if (!chatId) continue;

    const membership = await checkTelegramMembership(user.tg_id, chatId);

    // إذا خرج من القناة (left/kicked/not member)
    if (!membership.ok && !membership.skipped) {
      // خصم 250 نقطة
      await sql(
        `UPDATE users SET points=GREATEST(0, points-$1), updated_at=NOW() WHERE id=$2`,
        [CHANNEL_LEAVE_PENALTY, userId]
      );
      // إعادة تعيين المهمة (حذف السجل حتى يقدر يعيد الانضمام ويكسب مكافأة القناة)
      await sql(
        `DELETE FROM user_tasks WHERE user_id=$1 AND task_type=$2`,
        [userId, ch.task_type]
      );
      // إرسال إشعار بوت
      const msgText =
        `⚠️ تم خصم <b>${CHANNEL_LEAVE_PENALTY}</b> نقطة من رصيدك لأنك غادرت قناة <b>${ch.title}</b>.\n\n` +
        `🔁 انضم للقناة مجدداً من قسم المهام لاسترداد نقاطها!`;
      await sendBotMessage(user.tg_id, msgText);

      penalties.push({ channel_id: ch.channel_id, title: ch.title, penalty: CHANNEL_LEAVE_PENALTY });
    }
  }

  // جلب الرصيد المحدث
  const fresh = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];

  return { ok: true, penalties, points: parseInt(fresh?.points) || 0 };
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
    const chRow = (await sql(`SELECT url, tg_chat_id FROM channels WHERE is_active=TRUE ORDER BY sort_order ASC, id ASC LIMIT 1`))[0];
    let chatId = chRow?.tg_chat_id || null;
    if (!chatId && chRow?.url) {
      const slug = chRow.url.split('t.me/').pop().split('?')[0].trim();
      if (!slug.startsWith('+')) chatId = '@' + slug;
    }
    const membership = await checkTelegramMembership(telegramId, chatId);
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

  const nb = (await sql(`SELECT points, tg_id FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'submit_withdraw', 'ok', ipHash, fpHash, {
    pts, ton, first_withdraw: !firstDone,
  });

  // إشعار البوت: طلب السحب قيد المراجعة
  if (nb?.tg_id) {
    await sendBotMessage(
      nb.tg_id,
      `⏳ تم استلام طلب السحب بنجاح\n\nتم تسجيل طلب السحب الخاص بك وإحالته إلى فريق المراجعة للتحقق والمعالجة.\n\n💰 المبلغ المطلوب: <b>${ton} TON</b>\n📋 رقم الطلب: <b>#${wr[0].id}</b>\n\nسيتم إشعارك فور الانتهاء من مراجعة الطلب واتخاذ الإجراء المناسب. نشكرك على صبرك وتفهمك.`
    );
  }

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
    `SELECT u.tg_first_name, u.tg_username, u.created_at, ref.activated,
            up.photo_url
     FROM referrals ref
     JOIN users u ON u.id=ref.referred_id
     LEFT JOIN user_photos up ON up.user_id=ref.referred_id
     WHERE ref.referrer_id=$1
     ORDER BY ref.created_at DESC LIMIT 20`,
    [userId]
  );
  // ── استخدام العدد الفعلي من جدول referrals بدل total_referrals المخزون
  // total_referrals يُحدَّث فقط عند التفعيل، لكن referral_list يشمل غير المفعّلين أيضاً
  const actualTotal = rR.length;
  const activatedCount = rR.filter(x => x.activated).length;
  return {
    ok: true,
    total_referrals:      actualTotal,
    activated_referrals:  activatedCount,
    earned_from_refs:     parseInt(r.earned_from_refs) || 0,
    pts_per_referral:     CONFIG.rewards.referral,
    referral_list: rR.map(x => ({
      name:      x.tg_first_name || x.tg_username || 'مستخدم',
      ts:        new Date(x.created_at).getTime(),
      activated: !!x.activated,
      photo_url: x.photo_url || null,
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
    const wrInfo = await sql(
      `SELECT w.ton_amount, u.tg_id FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.id=$1`,
      [id]
    );
    await sql(`UPDATE withdrawals SET status='completed', tx_hash=$1, reviewed_at=NOW() WHERE id=$2`, [body?.tx_hash || '', id]);
    // إشعار البوت: تم اعتماد السحب
    if (wrInfo.length && wrInfo[0].tg_id) {
      const txLine = body?.tx_hash ? `\n🔗 Hash: <code>${body.tx_hash}</code>` : '';
      await sendBotMessage(
        wrInfo[0].tg_id,
        `🎉 <b>مبروك! تمت الموافقة على سحبك</b>\n\n✅ تم اعتماد طلب السحب الخاص بك بنجاح.\n💰 المبلغ: <b>${parseFloat(wrInfo[0].ton_amount)} TON</b>${txLine}\n\n👛 تفقد محفظتك الآن!`
      );
    }
    return { ok: true };
  }
  if (action === 'reject_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    const wr = await sql(
      `SELECT w.user_id, w.pts, w.ton_amount, u.tg_id FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.id=$1`,
      [id]
    );
    if (wr.length) await sql(`UPDATE users SET points=points+$1 WHERE id=$2`, [wr[0].pts, wr[0].user_id]);
    await sql(`UPDATE withdrawals SET status='rejected', reviewed_at=NOW() WHERE id=$1`, [id]);
    // إشعار البوت: تم رفض السحب واسترداد الرصيد
    if (wr.length && wr[0].tg_id) {
      await sendBotMessage(
        wr[0].tg_id,
        `❌ <b>تم رفض طلب السحب</b>\n\nنأسف، تعذّر تنفيذ طلب السحب الخاص بك.\n\n💰 المبلغ المسترد: <b>${wr[0].pts} نقطة</b>\n📋 رقم الطلب: <b>#${id}</b>\n\nتم إعادة رصيدك كاملاً. يمكنك المحاولة مجدداً لاحقاً.`
      );
    }
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
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`,
      [Math.min(parseInt(body?.limit) || 100, 500)]  // ✅ parameterized — no SQL injection
    );
    return { ok: true, logs: rows };
  }
  if (action === 'risk_log') {
    const rows = await sql(
      `SELECT * FROM risk_events ORDER BY created_at DESC LIMIT $1`,
      [Math.min(parseInt(body?.limit) || 100, 500)]  // ✅ parameterized
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
  const blockId = query.get('block') || query.get('blockId') || query.get('block_id') || '';

  // ── Secret header validation — block unauthorized callbacks ────
  const ADSGRAM_SECRET = process.env.ADSGRAM_CALLBACK_SECRET || '1896d686f676921024f3eb1ea6c2a28c47adf99b4846d1617500df50b0b1a4827be96d563ce749e9f9f2907e3889d7ff';
  if (ADSGRAM_SECRET) {
    const clientSecret = req.headers['x-adsgram-secret'] || query.get('secret') || '';
    if (clientSecret !== ADSGRAM_SECRET) {
      // لا نكشف السبب — نرد 200 لمنع enumeration
      res.status(200).end('ok');
      console.warn('[Adsgram CB] Unauthorized callback — invalid secret. IP:', req.headers['x-forwarded-for'] || 'unknown');
      return;
    }
  }

  if (!tgId || isNaN(tgId) || tgId <= 0) {
    res.status(400).end('invalid_user');
    return;
  }

  // ── رفض أي callback لا ينتمي لـ block الإعلانات اليومية (30161) ──
  // task-30166 تُعطى مكافأتها عبر claim_adsgram_task فقط
  if (blockId && blockId !== '30161') {
    res.status(200).end('ok'); // نرد ok لـ Adsgram لكن نتجاهل
    await writeAudit(0, 'adsgram_cb', 'adsgram_callback', 'ignored_block', null, null, {
      tg_id: tgId, block_id: blockId,
    }).catch(()=>{});
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

    // ── تجاهل الـ callback إذا المستخدم في وضع task-30166 ──────────
    // task-30166 تُعطى مكافأتها عبر claim_adsgram_task حصراً
    // ── تجاهل الـ callback إذا ينتمي لـ task-30166 ──────────────────
    // المنطق: إذا ما في block param وآخر adsgram_last_claimed_at أقرب
    // من ad_last_reward → الـ callback من task وليس إعلان عادي
    const uCheck = (await sql(
      `SELECT adsgram_status, adsgram_last_claimed_at, ad_last_reward FROM users WHERE id=$1`,
      [userId]
    ))[0];
    // إذا المستخدم في وضع watching الآن → task callback → تجاهل
    if (uCheck?.adsgram_status === 'watching') {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'ignored_task_mode', ipHash, null, { tg_id: tgId });
      return;
    }
    // إذا ما في block param وآخر claim كان task (خلال 10 ثواني) → تجاهل
    if (!blockId && uCheck?.adsgram_last_claimed_at) {
      const taskClaimAge = Date.now() - new Date(uCheck.adsgram_last_claimed_at).getTime();
      const adRewardAge  = uCheck.ad_last_reward
        ? Date.now() - new Date(uCheck.ad_last_reward).getTime()
        : Infinity;
      if (taskClaimAge < 10000 && taskClaimAge < adRewardAge) {
        await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'ignored_task_recent', ipHash, null, { tg_id: tgId });
        return;
      }
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

// ══════════════════════════════════════════════════════════════════
// MONETAG — Rewarded Interstitial Handler
// النظام: الـ frontend يُرسل طلب الجائزة بعد مشاهدة 2 إعلانات
// الـ backend يزيد عداد الجوائز (prizes) ويمنح النقاط
// حد يومي: 250 جائزة | جائزة: 20 نقطة | cooldown: 5 ثوانٍ
// ══════════════════════════════════════════════════════════════════
async function handleMonetagReward(userId, sessionId, ipHash, fpHash, body) {
  // [1] Shadow ban
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    return { ok: false, error: 'account_review' };
  }

  // [2] Daily limit — كل "count" = جائزة واحدة (= إعلانَين)
  const adR = await sql(
    `SELECT count FROM monetag_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  const prizesToday = parseInt(adR[0]?.count) || 0;
  if (prizesToday >= CFG.MONETAG_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached', watched_today: prizesToday };
  }

  // [3] Cooldown (5 ثوانٍ بعد كل جائزة)
  const coolRow = (await sql(
    `SELECT monetag_last_reward FROM users WHERE id=$1`, [userId]
  ))[0];
  if (coolRow?.monetag_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.monetag_last_reward).getTime();
    if (elapsed < CFG.MONETAG_COOLDOWN_MS) {
      const waitMs = CFG.MONETAG_COOLDOWN_MS - elapsed;
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // [4] Replay detection (5 ثوانٍ window)
  const recentReward = await sql(
    `SELECT id FROM audit_log
     WHERE user_id=$1 AND action='monetag_reward' AND status='ok'
       AND created_at > NOW() - INTERVAL '4 seconds'
     LIMIT 1`,
    [userId]
  );
  if (recentReward.length) {
    return { ok: false, error: 'cooldown_active', wait_ms: CFG.MONETAG_COOLDOWN_MS };
  }

  // [5] Atomic insert/update — نزيد عداد الجوائز بـ 1
  const lr = await sql(
    `INSERT INTO monetag_logs(user_id, log_date, count, points_earned)
     VALUES($1, CURRENT_DATE, 1, $2)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       count         = CASE WHEN monetag_logs.count < $3 THEN monetag_logs.count + 1          ELSE monetag_logs.count         END,
       points_earned = CASE WHEN monetag_logs.count < $3 THEN monetag_logs.points_earned + $2 ELSE monetag_logs.points_earned END,
       updated_at    = NOW()
     RETURNING count, points_earned`,
    [userId, CFG.MONETAG_REWARD, CFG.MONETAG_DAILY_LIMIT]
  );
  const prizes = parseInt(lr[0].count) || 0;

  // [6] منح النقاط وتحديث آخر جائزة
  await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1,
         monetag_last_reward=NOW(),
         updated_at=NOW()
     WHERE id=$2`,
    [CFG.MONETAG_REWARD, userId]
  );

  await syncLevel(userId);

  // [7] Referral commission (5%)
  try { await giveReferralAdCommission(userId, CFG.MONETAG_REWARD); } catch (_) {}

  await writeAudit(userId, sessionId, 'monetag_reward', 'ok', ipHash, fpHash, {
    prizes, points_earned: CFG.MONETAG_REWARD,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return {
    ok:             true,
    points_awarded: CFG.MONETAG_REWARD,
    watched_today:  prizes,
    remaining:      Math.max(0, CFG.MONETAG_DAILY_LIMIT - prizes),
    cooldown_ms:    CFG.MONETAG_COOLDOWN_MS,
    points:         parseInt(ur[0]?.points) || 0,
    all_done:       prizes >= CFG.MONETAG_DAILY_LIMIT,
  };
}
// MAIN HANDLER

module.exports = {
  handleGetConfig, handleCreateSession, handleLoad, handleGetState,
  handleStartAd, handleRewardAd, handleMonetagReward, handleStartAdsgramTask, handleClaimAdsgramTask,
  handleClaimDailyMission, handleClaimGift, handleGetChannels,
  handleVerifyChannelTask, handleCheckChannelMembership, handleVerifyTgTask, handleSubmitWithdraw,
  handleGetReferrals, handleTrackAdEvent, handleAdmin, handleAdsgramCallback,
};
