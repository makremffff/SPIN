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
  REF_USDT_REWARD   : 0.1,    // USDT added to balance per referral

  /* Ad rewards */
  AD_USD_REWARD     : 0.03,   // USD per ad watch
  AD_DAILY_MAX      : 3000,   // max ads per day

  /* Withdrawal */
  WITHDRAW_MIN      : 10,     // minimum withdrawal in USD

  /* Withdraw tiers — quick-select cards on the withdraw page (fee deducted from amount) */
  WITHDRAW_TIERS: [
    { id: 'wd_1', amount: 10,  fee: 0.5 },
    { id: 'wd_2', amount: 20,  fee: 0.8 },
    { id: 'wd_3', amount: 50,  fee: 1.5 },
    { id: 'wd_4', amount: 100, fee: 2, best: true },
  ],
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
