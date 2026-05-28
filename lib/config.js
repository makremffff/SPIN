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
    first_min:    4500,   // أول سحبة للمستخدم الجديد
    normal_min:   20000,  // السحب الطبيعي بعد أول سحبة
    normal_level: 5,      // المستوى المطلوب للسحب الطبيعي
  },
  rewards: {
    referral:          1000,   // نقاط لكل إحالة
    telegram_task:     200,   // مهمة تيليجرام
    adsgram_task:      50,    // مهمة Adsgram
    daily_ads_10:      200,   // مشاهدة 10 إعلانات
    daily_ads_25:      300,   // مشاهدة 25 إعلان
    daily_referrals_3: 1500,  // 3 إحالات يومية
    points_per_ad:     60,    // نقاط لكل إعلان
  },
  telegram: {
    channel_url: 'https://t.me/botbababab',
  },
  ads: {
    daily_limit:       7,     // الحد اليومي للإعلانات العادية
    cooldown_ms:       30 * 1000,
    min_duration_ms:   14 * 1000,
  },
  adsgram_task: {
    cooldown_ms:       180 * 1000,
    min_watch_ms:      0,      // 0 — الـ widget يتحكم بوقت المهمة، لا نحتاج حد أدنى
    daily_limit:       5,      // عدد مرات المهمة الإعلانية في اليوم
    // ✅ اسم/عنوان المهمة الديناميكي — يتغير حسب مزود الإعلان
    // غيّر هذه القيم من السيرفر فقط، الواجهة تقرأها من /config
    title_ar:          'بلاي غيم تو غيت تون',
    title_en:          'Play Game to Get TON',
    block_id:          'task-30166',
  },
  // ═══ هدية الربح اليومي — ديناميكية من السيرفر ═══
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
    min_active_ads:    10,     // الحد الأدنى للإعلانات لاعتبار المستخدم نشيطاً
    min_active_pts:    800,   // أو النقاط
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

  NONCE_TTL_MS:          5  * 60 * 1000,
  AD_NONCE_TTL_MS:       3  * 60 * 1000,  // ✅ رُفع من 30s إلى 3 دقائق — يكفي لأي إعلان
  AD_COOLDOWN_MS:        CONFIG.ads.cooldown_ms,
  AD_MIN_DURATION_MS:    CONFIG.ads.min_duration_ms,
  ADSGRAM_TASK_COOLDOWN_MS:  CONFIG.adsgram_task.cooldown_ms,
  ADSGRAM_TASK_POINTS:   CONFIG.rewards.adsgram_task,
  ADSGRAM_TASK_MIN_WATCH_MS: CONFIG.adsgram_task.min_watch_ms,
  ADSGRAM_TASK_DAILY_LIMIT:  CONFIG.adsgram_task.daily_limit,

  SESSION_TTL_MS:        7  * 24 * 60 * 60 * 1000,
  RATE_WINDOW_MS:        60 * 1000,
  RATE_MAX:              30,
  RATE_WRITE_MAX:        15,

  RISK_BAN:              100,
  RISK_SHADOW:           60,

  // ── New Account Protection ────────────────────────────────────
  ACCOUNT_AGE_PROTECTION_MS: 24 * 60 * 60 * 1000,  // 24h grace period

  // ── Multi-account — relaxed ───────────────────────────────────
  MULTI_ACCT: {
    MAX_PER_IP: 1,   // was 1 → now 3 (shared WiFi/NAT tolerance)
    MAX_PER_FP: 1,   // was 1 → now 2 (family devices)
    IP_WHITELIST: new Set([]),
  },

  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],
  GIFT_REWARDS:     CONFIG.daily_gift.rewards,
};

module.exports = { BOT_TOKEN, ADMIN_SECRET, IP_SALT, IS_DEV, CONFIG, CFG };
