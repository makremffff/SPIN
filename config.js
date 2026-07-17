/* ══════════════════════════════════════════════════════
   config.js — App-wide constants & shared state
══════════════════════════════════════════════════════ */

const BOT_USERNAME = 'EarnlixBot';
let   REF_LINK     = 'https://t.me/EarnlixBot/play?startapp=ref_';

// ⚠️ غيّره بالـ blockId الحقيقي من partner.adsgram.ai (Get blockId section)
const ADSGRAM_BLOCK_ID = '35167';

// ⚠️ غيّر يوزرنيم قناتك هنا — يُستخدم في زر "Join Channel" بالأونبوردنغ وبصفحة السحب
// ⚠️ لازم يطابق نفس اليوزرنيم في متغير البيئة CHANNEL_USERNAME على السيرفر (api/index.js)
const CHANNEL_LINK = 'https://t.me/withdrawlProof2026';

// ⚠️ غيّره بدومينك الحقيقي بعد رفع المشروع — لازم ترفع ملف tonconnect-manifest.json
// (مرفق في التسليم) في جذر نفس الدومين بحيث يكون متاح على /tonconnect-manifest.json
const TONCONNECT_MANIFEST_URL = 'https://spin-snowy.vercel.app/tonconnect-manifest.json';

// عنوان محفظة الاستلام (Treasury) — كل ايداعات التذاكر تُرسل هنا مباشرة عبر TonConnect SDK
const TREASURY_WALLET_ADDRESS = 'UQABsMMUakTi2iRO5pox4DDR--0J7uqsULYqHDv4Zo3w0E-T';

/* ══════════════════════════════════════════════════════
   APP_CONFIG — Single source of truth for all values
   Edit here and everything (frontend + backend) stays in sync.
   Backend reads these via the init API response (appState.config).
══════════════════════════════════════════════════════ */
const APP_CONFIG = {
  /* Referral rewards */
  REF_TICKET_REWARD : 5000,   // competition tickets per referral
  REF_USDT_REWARD   : 0.01,  // USDT added to balance per referral

  /* Ad rewards */
  AD_USD_REWARD     : 0.001,  // USD per ad watch
  AD_DAILY_MAX      : 3000,     // max ads per day

  /* Withdrawal */
  WITHDRAW_MIN      : 0.01,   // minimum withdrawal in USD

  /* Withdraw tiers — quick-select cards on the withdraw page (fee deducted from amount) */
  WITHDRAW_TIERS: [
    { id: 'wd_1', amount: 0.01, fee: 0.001 },
    { id: 'wd_2', amount: 0.15, fee: 0.015 },
    { id: 'wd_3', amount: 0.35, fee: 0.04 },
    { id: 'wd_4', amount: 0.60, fee: 0.03, best: true },
  ],

  /* Deposit — شراء تذاكر مقابل TON عبر TonConnect (يُستبدل بقيمة السرفر) */
  TICKET_PACKAGES: [
    { id: 'pkg_1',  tickets: 15000,  ton: 0.1  },
    { id: 'pkg_2',  tickets: 35000,  ton: 0.25 },
    { id: 'pkg_3',  tickets: 90000,  ton: 0.5  },
    { id: 'pkg_4',  tickets: 200000, ton: 1    },
  ],

  /* Podium prizes (contest page) */
  PODIUM_PRIZES: {
    first  : 25,   // $
    second : 10,   // $
    third  :  7,   // $
  },

  /* Leaderboard badge label */
  LB_PRIZE_LABEL : 'Each $1',

  /* توقيت المسابقة — يُستبدل بقيمة السرفر فور وصول init response */
  COMPETITION_END_MS: Date.now() + 20 * 24 * 60 * 60 * 1000,
};

/* Single source of truth — all pages read from here */
let appState = {
  user: {
    id: null, telegram_id: null, name: 'You', photo_url: null,
    pts: 0, balance_usd: 0, referral_code: '', rank: 0
  },
  leaderboard: [],
  referral: { count: 0, earned: 0 },
  config: APP_CONFIG   // overwritten by server response on init
};

/* Page entrance animation delay between each .reveal element */
const REVEAL_STEP = 70; // ms

/* Shared SVG snippets */
const LB_AVATAR_SVG = `<svg viewBox="0 0 24 24" stroke-width="1.5" fill="none" stroke="white"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
