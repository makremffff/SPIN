/* ══════════════════════════════════════════════════════
   config.js — App-wide constants & shared state
══════════════════════════════════════════════════════ */

const BOT_USERNAME = 'EarnlixBot';
let   REF_LINK     = 'https://t.me/EarnlixBot/play?startapp=ref_';

/* Single source of truth — all pages read from here */
let appState = {
  user: {
    id: null, telegram_id: null, name: 'You', photo_url: null,
    pts: 0, balance_usd: 0, referral_code: '', rank: 0
  },
  leaderboard: [],
  referral: { count: 0, earned: 0 }
};

/* Page entrance animation delay between each .reveal element */
const REVEAL_STEP = 70; // ms

/* Shared SVG snippets */
const LB_AVATAR_SVG = `<svg viewBox="0 0 24 24" stroke-width="1.5" fill="none" stroke="white"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
