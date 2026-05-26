'use strict';

// ── Environment ───────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-env';
const IP_SALT      = process.env.IP_SALT      || 'rebh_ip_salt_2025';
const IS_DEV       = process.env.NODE_ENV !== 'production';

// ═══════════════════════════════════════════════════════════════════
// DYNAMIC CONFIG — Single source of truth
// Any change here reflects immediately in GET /config
// ═══════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  withdraw: {
    first_min:    3000,
    normal_min:   20000,
    normal_level: 5,
  },
  rewards: {
    referral:          100,
    telegram_task:     200,
    adsgram_task:      50,
    daily_ads_10:      200,
    daily_ads_25:      300,
    daily_referrals_3: 1000,
    points_per_ad:     50,
  },
  telegram: {
    channel_url: 'https://t.me/botbababab',
  },
  ads: {
    daily_limit:       20,
    cooldown_ms:       30 * 1000,
    min_duration_ms:   14 * 1000,
  },

  // ══════════════════════════════════════════════════════
  // SESSION QUALITY — نظام جودة الجلسة الذكي
  // يُطبَّق على handleRewardAd فقط (الإعلانات اليومية)
  // ══════════════════════════════════════════════════════
  session_quality: {
    // حد التصنيف الجزئي: 30-31 ثانية → 50% من المكافأة
    partial_min_ms:   30 * 1000,   // 30s
    partial_max_ms:   31 * 1000,   // 31s (حد أعلى لنطاق الجزئي)
    partial_ratio:    0.5,         // 50%
    // حد التصنيف الكامل: 32 ثانية فأكثر → مكافأة كاملة
    full_min_ms:      32 * 1000,   // 32s+
    // ضرورة ضغط زر Play للحصول على مكافأة كاملة
    require_play_click: true,
  },

  // Progressive cooldown بين الإعلانات المتتالية
  // [0]=أول إعلان، [1]=ثاني، [2+=ثالث فأكثر]
  progressive_cooldown: {
    steps_ms: [60000, 90000, 120000],  // 60s → 90s → 120s
  },

  adsgram_task: {
    cooldown_ms:       180 * 1000,
    min_watch_ms:      0,
    daily_limit:       20,
    title_ar:          'بلاي غيم تو غيت تون',
    title_en:          'Play Game to Get TON',
    block_id:          'task-30166',
  },
  daily_gift: {
    rewards: [100, 150, 200, 250, 300, 400, 750, 800, 900, 1000],
    titles_ar: [
      'اليوم الأول', 'اليوم الثاني', 'اليوم الثالث', 'اليوم الرابع',
      'اليوم الخامس', 'اليوم السادس', 'اليوم السابع',
      'اليوم الثامن', 'اليوم التاسع', 'اليوم العاشر'
    ],
    descs_ar: [
      'مبروك! بداية رائعة معنا.\nاستمر يومياً لتضاعف مكافآتك!',
      'يومان متتاليان!\nالمثابرة هي مفتاح النجاح.',
      'ثلاثة أيام متتالية!\nمكافأة خاصة بانتظارك.',
      'أسبوعك يقترب!\nاستمر في التحدي.',
      'خمسة أيام!\nأنت من الملتزمين الحقيقيين.',
      'يوم واحد ويكتمل أسبوعك!\nلا تتوقف.',
      'أسبوع كامل!\nمكافأة ضخمة بانتظارك.',
      'تجاوزت الأسبوع!\nمكافأة استثنائية.',
      'تسعة أيام!\nأنت أسطورة.',
      'عشرة أيام متتالية!\nمكافأة الأبطال.'
    ],
  },
  referral: {
    min_active_ads:    10,
    min_active_pts:    500,
  },
});

// ── Internal CFG (backward compat) ───────────────────────────────
const CFG = {
  POINTS_PER_AD:         CONFIG.rewards.points_per_ad,
  POINTS_PER_REFERRAL:   CONFIG.rewards.referral,
  POINTS_PER_TG_TASK:    CONFIG.rewards.telegram_task,
  ADS_DAILY_LIMIT:       CONFIG.ads.daily_limit,
  WITHDRAW_MIN_PTS:      CONFIG.withdraw.normal_min,
  WITHDRAW_MIN_LEVEL:    CONFIG.withdraw.normal_level,
  WITHDRAW_FIRST_MIN:    CONFIG.withdraw.first_min,
  PTS_PER_TON:           100000,

  NONCE_TTL_MS:              5  * 60 * 1000,
  AD_NONCE_TTL_MS:           3  * 60 * 1000,
  AD_COOLDOWN_MS:            CONFIG.ads.cooldown_ms,
  AD_MIN_DURATION_MS:        CONFIG.ads.min_duration_ms,
  ADSGRAM_TASK_COOLDOWN_MS:  CONFIG.adsgram_task.cooldown_ms,
  ADSGRAM_TASK_POINTS:       CONFIG.rewards.adsgram_task,
  ADSGRAM_TASK_MIN_WATCH_MS: CONFIG.adsgram_task.min_watch_ms,
  ADSGRAM_TASK_DAILY_LIMIT:  CONFIG.adsgram_task.daily_limit,

  // Session Quality
  SQ_PARTIAL_MIN_MS:     CONFIG.session_quality.partial_min_ms,
  SQ_PARTIAL_MAX_MS:     CONFIG.session_quality.partial_max_ms,
  SQ_PARTIAL_RATIO:      CONFIG.session_quality.partial_ratio,
  SQ_FULL_MIN_MS:        CONFIG.session_quality.full_min_ms,
  SQ_REQUIRE_PLAY:       CONFIG.session_quality.require_play_click,
  SQ_COOLDOWN_STEPS:     CONFIG.progressive_cooldown.steps_ms,

  SESSION_TTL_MS:        7  * 24 * 60 * 60 * 1000,
  RATE_WINDOW_MS:        60 * 1000,
  RATE_MAX:              30,
  RATE_WRITE_MAX:        15,

  RISK_BAN:              100,
  RISK_SHADOW:           60,

  ACCOUNT_AGE_PROTECTION_MS: 24 * 60 * 60 * 1000,

  MULTI_ACCT: {
    MAX_PER_IP: 3,
    MAX_PER_FP: 2,
    IP_WHITELIST: new Set([]),
  },

  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],
  GIFT_REWARDS:     CONFIG.daily_gift.rewards,
};

module.exports = { BOT_TOKEN, ADMIN_SECRET, IP_SALT, IS_DEV, CONFIG, CFG };
