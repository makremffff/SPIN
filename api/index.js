/**
 * الربح عربي — Server-Side API
 * Vercel Serverless · Neon PostgreSQL · Telegram Mini App
 */

'use strict';

const { createHash, createHmac, randomBytes } = require('crypto');
const { neon }                                = require('@neondatabase/serverless');

const _db = neon(process.env.DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-env';
const IS_DEV       = process.env.NODE_ENV !== 'production';

const CFG = {
  POINTS_PER_AD:         50,
  POINTS_PER_REFERRAL:   500,
  POINTS_PER_TG_TASK:    2500,
  ADS_DAILY_LIMIT:       10,
  AD_NONCE_TTL_SEC:      120,
  WITHDRAW_MIN_PTS:      50000,
  WITHDRAW_MIN_LEVEL:    5,
  PTS_PER_TON:           100000,
  SESSION_TTL_MS:        7 * 24 * 60 * 60 * 1000,
  NONCE_TTL_MS:          5 * 60 * 1000,
  RATE_WINDOW_MS:        60 * 1000,
  RATE_MAX:              30,
  RATE_WRITE_MAX:        15,
  RISK_BAN:              100,
  RISK_SHADOW:           60,
  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],
  GIFT_REWARDS:     [100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000],
};

const rateLimitMap = new Map();

// Bootstrap — يشتغل عند cold start خارج الـ handler
let _bootstrapped = false;
async function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    await sql(`CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY, tg_id BIGINT UNIQUE NOT NULL,
      tg_username TEXT, tg_first_name TEXT, tg_last_name TEXT,
      tg_language_code TEXT DEFAULT 'ar', tg_is_premium BOOLEAN DEFAULT FALSE,
      points BIGINT DEFAULT 0, level INT DEFAULT 1, xp BIGINT DEFAULT 0,
      is_banned BOOLEAN DEFAULT FALSE, is_shadow_banned BOOLEAN DEFAULT FALSE,
      ban_reason TEXT, risk_score INT DEFAULT 0, referrer_id BIGINT,
      tg_verified BOOLEAN DEFAULT FALSE, streak_day INT DEFAULT 0,
      last_gift_date DATE, ads_watched_total BIGINT DEFAULT 0,
      total_referrals INT DEFAULT 0, earned_from_refs BIGINT DEFAULT 0,
      ip_hash TEXT, fp_hash TEXT, cluster_ban BOOLEAN DEFAULT FALSE,
      last_ip_hash TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id BIGINT NOT NULL,
      fingerprint_hash TEXT, ip_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), last_active TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL, is_revoked BOOLEAN DEFAULT FALSE
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY, user_id BIGINT NOT NULL,
      type TEXT DEFAULT 'general', used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS ad_nonces (
      nonce TEXT PRIMARY KEY, user_id BIGINT NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS ad_logs (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
      log_date DATE NOT NULL DEFAULT CURRENT_DATE,
      count INT DEFAULT 0, points_earned BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, log_date)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
      pts BIGINT NOT NULL, ton_amount NUMERIC(18,6),
      address TEXT NOT NULL, method TEXT DEFAULT 'ton',
      status TEXT DEFAULT 'pending', tx_hash TEXT, notes TEXT,
      reviewed_at TIMESTAMPTZ, reviewed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS user_tasks (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
      task_type TEXT NOT NULL, completed BOOLEAN DEFAULT FALSE,
      completed_at TIMESTAMPTZ, task_date DATE DEFAULT CURRENT_DATE,
      UNIQUE(user_id, task_type, task_date)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY, referrer_id BIGINT NOT NULL,
      referred_id BIGINT NOT NULL, points_given BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(referred_id)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS risk_events (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT,
      event_type TEXT NOT NULL, ip_hash TEXT, fp_hash TEXT,
      score_delta INT DEFAULT 0, meta JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const idxs = [
      `CREATE INDEX IF NOT EXISTS idx_s_user  ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_exp   ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_n_user  ON nonces(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_al_ud   ON ad_logs(user_id, log_date)`,
      `CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_ref ON referrals(referrer_id)`,
    ];
    for (const q of idxs) { try { await sql(q); } catch(_) {} }
    console.log('[DB] bootstrap OK');
  } catch(e) {
    console.error('[DB] bootstrap error:', e.message);
  }
}
bootstrap();

setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces    WHERE expires_at < NOW()`);
    await sql(`DELETE FROM ad_nonces WHERE expires_at < NOW()`);
    await sql(`DELETE FROM sessions  WHERE expires_at < NOW()`);
  } catch(_) {}
}, 60 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function sha256(s) { return createHash('sha256').update(String(s)).digest('hex'); }
function genToken(b=32) { return randomBytes(b).toString('hex'); }
function hashIp(ip) { return sha256((ip||'')+'rebh_ip_salt_2025').slice(0,32); }
function hashFp(fp) { try { return sha256(typeof fp==='string'?fp:JSON.stringify(fp)).slice(0,40); } catch(_) { return 'unknown'; } }
function computeLevel(xp) { const t=CFG.LEVEL_THRESHOLDS; for(let i=t.length-1;i>=0;i--) if(xp>=t[i]) return i; return 1; }
function giftReward(day) { return CFG.GIFT_REWARDS[Math.min(day-1,CFG.GIFT_REWARDS.length-1)]||100; }
function getIp(req) { return req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.headers['x-real-ip']||'0.0.0.0'; }
function isValidTon(addr) { const a=(addr||'').trim(); return (a.startsWith('EQ')||a.startsWith('UQ')||a.startsWith('0:'))&&a.length>=48; }

function verifyTg(initData) {
  if (!initData||!BOT_TOKEN) return IS_DEV?{ok:true,data:{id:99999999,first_name:'Dev',language_code:'ar'}}:{ok:false};
  try {
    const p=new URLSearchParams(initData), hash=p.get('hash');
    if(!hash) return {ok:false};
    p.delete('hash');
    const str=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
    const sk=createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    if(createHmac('sha256',sk).update(str).digest('hex')!==hash) return {ok:false};
    if(Math.floor(Date.now()/1000)-parseInt(p.get('auth_date')||'0')>86400) return {ok:false};
    return {ok:true,data:JSON.parse(p.get('user')||'{}')};
  } catch(_) { return {ok:false}; }
}

function rateLimit(key, max=CFG.RATE_MAX) {
  const now=Date.now(); let e=rateLimitMap.get(key);
  if(!e||now>e.resetAt){e={count:0,resetAt:now+CFG.RATE_WINDOW_MS};rateLimitMap.set(key,e);}
  return ++e.count<=max;
}

// ── DB ops ────────────────────────────────────────────────────────────────────
async function validateSession(sid) {
  if(!sid) return null;
  const r=await sql(`SELECT s.*,u.is_banned,u.is_shadow_banned,u.cluster_ban FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.is_revoked=FALSE AND s.expires_at>NOW() LIMIT 1`,[sid]);
  if(!r.length) return null;
  await sql(`UPDATE sessions SET last_active=NOW() WHERE id=$1`,[sid]);
  return r[0];
}

async function createSessionRow(userId, fpHash, ipHash) {
  const id=genToken(32), exp=new Date(Date.now()+CFG.SESSION_TTL_MS).toISOString();
  await sql(`INSERT INTO sessions(id,user_id,fingerprint_hash,ip_hash,expires_at) VALUES($1,$2,$3,$4,$5)`,[id,userId,fpHash,ipHash,exp]);
  return id;
}

async function issueNonce(userId) {
  const n=genToken(24), exp=new Date(Date.now()+CFG.NONCE_TTL_MS).toISOString();
  await sql(`INSERT INTO nonces(nonce,user_id,expires_at) VALUES($1,$2,$3)`,[n,userId,exp]);
  return n;
}

async function consumeNonce(nonce, userId) {
  if(!nonce) return false;
  const r=await sql(`UPDATE nonces SET used=TRUE WHERE nonce=$1 AND user_id=$2 AND used=FALSE AND expires_at>NOW() RETURNING nonce`,[nonce,userId]);
  return r.length>0;
}

async function issueAdNonce(userId) {
  const n='ad_'+genToken(20), exp=new Date(Date.now()+CFG.AD_NONCE_TTL_SEC*1000).toISOString();
  await sql(`INSERT INTO ad_nonces(nonce,user_id,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[n,userId,exp]);
  return n;
}

async function consumeAdNonce(nonce, userId) {
  if(!nonce) return false;
  const r=await sql(`UPDATE ad_nonces SET used=TRUE WHERE nonce=$1 AND user_id=$2 AND used=FALSE AND expires_at>NOW() RETURNING nonce`,[nonce,userId]);
  return r.length>0;
}

async function upsertUser(tgUser, ipHash, fpHash) {
  const r=await sql(`INSERT INTO users(tg_id,tg_username,tg_first_name,tg_last_name,tg_language_code,tg_is_premium,ip_hash,fp_hash,last_ip_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tg_id) DO UPDATE SET tg_username=EXCLUDED.tg_username,tg_first_name=EXCLUDED.tg_first_name,tg_last_name=EXCLUDED.tg_last_name,tg_language_code=EXCLUDED.tg_language_code,tg_is_premium=EXCLUDED.tg_is_premium,last_ip_hash=EXCLUDED.last_ip_hash,updated_at=NOW() RETURNING *`,
    [tgUser.id,tgUser.username||null,tgUser.first_name||null,tgUser.last_name||null,tgUser.language_code||'ar',!!tgUser.is_premium,ipHash,fpHash,ipHash]);
  return r[0];
}

async function syncLevel(userId) {
  const r=await sql(`SELECT xp FROM users WHERE id=$1`,[userId]);
  if(!r.length) return;
  await sql(`UPDATE users SET level=$1 WHERE id=$2`,[computeLevel(parseInt(r[0].xp)||0),userId]);
}

async function addRisk(userId, type, ipHash, fpHash, delta) {
  try {
    await sql(`INSERT INTO risk_events(user_id,event_type,ip_hash,fp_hash,score_delta) VALUES($1,$2,$3,$4,$5)`,[userId,type,ipHash,fpHash,delta]);
    if(delta>0){
      await sql(`UPDATE users SET risk_score=LEAST(risk_score+$1,200) WHERE id=$2`,[delta,userId]);
      await sql(`UPDATE users SET is_banned=TRUE,ban_reason='auto_risk' WHERE id=$1 AND risk_score>=$2`,[userId,CFG.RISK_BAN]);
      await sql(`UPDATE users SET is_shadow_banned=TRUE WHERE id=$1 AND risk_score>=$2 AND is_banned=FALSE`,[userId,CFG.RISK_SHADOW]);
    }
  } catch(_) {}
}

async function upsertTask(userId, taskType) {
  await sql(`INSERT INTO user_tasks(user_id,task_type,completed,completed_at,task_date) VALUES($1,$2,TRUE,NOW(),CURRENT_DATE) ON CONFLICT(user_id,task_type,task_date) DO UPDATE SET completed=TRUE,completed_at=NOW()`,[userId,taskType]);
}

// ── Handlers ──────────────────────────────────────────────────────────────────
async function handleCreateSession(body, ipHash, fpHash) {
  const initData=body?.data?.initData||'';
  const tgResult=verifyTg(initData);
  if(!tgResult.ok&&!IS_DEV) return {ok:false,error:'invalid_init_data',status:401};

  const tgUser=tgResult.data?.id?tgResult.data:{id:99999999,first_name:'Dev',language_code:'ar'};
  if(!tgUser.id) return {ok:false,error:'no_user_id',status:401};

  let referrerId=null;
  try {
    const sp=new URLSearchParams(initData).get('start_param')||'';
    const m=sp.match(/^ref_(\d+)$/);
    if(m){const rr=await sql(`SELECT id FROM users WHERE tg_id=$1`,[parseInt(m[1])]);if(rr.length)referrerId=rr[0].id;}
  } catch(_) {}

  const user=await upsertUser(tgUser,ipHash,fpHash);
  if(user.is_banned) return {ok:false,is_banned:true,status:403};

  const isNew=(Date.now()-new Date(user.created_at).getTime())<5000;
  if(isNew&&referrerId&&referrerId!==user.id){
    try {
      await sql(`INSERT INTO referrals(referrer_id,referred_id,points_given) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[referrerId,user.id,CFG.POINTS_PER_REFERRAL]);
      await sql(`UPDATE users SET points=points+$1,xp=xp+$1,total_referrals=total_referrals+1,earned_from_refs=earned_from_refs+$1,updated_at=NOW() WHERE id=$2`,[CFG.POINTS_PER_REFERRAL,referrerId]);
      await sql(`UPDATE users SET referrer_id=$1 WHERE id=$2`,[referrerId,user.id]);
      await syncLevel(referrerId);
    } catch(_) {}
  }

  const cl=await sql(`SELECT COUNT(*) AS cnt FROM users WHERE last_ip_hash=$1 AND is_banned=TRUE AND id!=$2`,[ipHash,user.id]);
  if(parseInt(cl[0]?.cnt)>3) await addRisk(user.id,'cluster_ip',ipHash,fpHash,15);

  const sessionId=await createSessionRow(user.id,fpHash,ipHash);
  await syncLevel(user.id);
  const fresh=(await sql(`SELECT * FROM users WHERE id=$1`,[user.id]))[0];

  return {
    ok:true, session_id:sessionId,
    user:{
      points:parseInt(fresh.points)||0, level:parseInt(fresh.level)||1,
      xp:parseInt(fresh.xp)||0, tg_verified:fresh.tg_verified,
      streak_day:fresh.streak_day, last_gift_date:fresh.last_gift_date,
      total_referrals:fresh.total_referrals, earned_from_refs:parseInt(fresh.earned_from_refs)||0,
    },
  };
}

async function handleLoad(userId) {
  const rows=await sql(`SELECT * FROM users WHERE id=$1`,[userId]);
  if(!rows.length) return {ok:false,error:'user_not_found'};
  const u=rows[0];
  const adR=await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,[userId]);
  const ad=adR[0]||{count:0,points_earned:0};
  const watched=parseInt(ad.count)||0;
  const wR=await sql(`SELECT pts,address,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,[userId]);
  const rR=await sql(`SELECT u.tg_first_name,u.tg_username,u.created_at FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 10`,[userId]);
  const tR=await sql(`SELECT task_type FROM user_tasks WHERE user_id=$1 AND task_date=CURRENT_DATE AND completed=TRUE`,[userId]);
  return {
    ok:true,
    points:parseInt(u.points)||0, level:parseInt(u.level)||1, xp:parseInt(u.xp)||0,
    tg_verified:u.tg_verified, streak_day:u.streak_day, last_gift_date:u.last_gift_date, tg_id:u.tg_id,
    ads_total:CFG.ADS_DAILY_LIMIT, ads_remaining:Math.max(0,CFG.ADS_DAILY_LIMIT-watched),
    ads_watched_today:watched, earned_today:parseInt(ad.points_earned)||0,
    total_referrals:u.total_referrals, earned_from_refs:parseInt(u.earned_from_refs)||0,
    withdrawals:wR.map(w=>({pts:parseInt(w.pts)||0,address:w.address,method:w.method,status:w.status,ts:new Date(w.created_at).getTime()})),
    referral_list:rR.map(r=>({name:r.tg_first_name||r.tg_username||'مستخدم',ts:new Date(r.created_at).getTime()})),
    completed_tasks:tR.map(r=>r.task_type),
    config:{ads_daily_limit:CFG.ADS_DAILY_LIMIT,pts_per_ton:CFG.PTS_PER_TON,withdraw_min_pts:CFG.WITHDRAW_MIN_PTS,withdraw_min_level:CFG.WITHDRAW_MIN_LEVEL,pts_per_referral:CFG.POINTS_PER_REFERRAL},
  };
}

async function handleGetState(userId) {
  const r=await sql(`SELECT points,level,xp,total_referrals,earned_from_refs FROM users WHERE id=$1`,[userId]);
  if(!r.length) return {ok:false,error:'user_not_found'};
  const u=r[0];
  const ad=(await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,[userId]))[0]||{count:0,points_earned:0};
  return {ok:true,points:parseInt(u.points)||0,level:parseInt(u.level)||1,xp:parseInt(u.xp)||0,
    total_referrals:u.total_referrals,earned_from_refs:parseInt(u.earned_from_refs)||0,
    ads_watched_today:parseInt(ad.count)||0,ads_remaining:Math.max(0,CFG.ADS_DAILY_LIMIT-(parseInt(ad.count)||0)),
    earned_today:parseInt(ad.points_earned)||0};
}

async function handleStartAd(userId) {
  const r=await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,[userId]);
  if((parseInt(r[0]?.count)||0)>=CFG.ADS_DAILY_LIMIT) return {ok:false,error:'daily_limit_reached'};
  return {ok:true,ad_nonce:await issueAdNonce(userId)};
}

async function handleWatchAd(userId, body, ipHash, fpHash) {
  const adNonce=body?.data?.ad_nonce;
  if(!await consumeAdNonce(adNonce,userId)){await addRisk(userId,'invalid_ad_nonce',ipHash,fpHash,10);return {ok:false,error:'invalid_ad_nonce'};}
  const lr=await sql(`INSERT INTO ad_logs(user_id,log_date,count,points_earned) VALUES($1,CURRENT_DATE,1,$2) ON CONFLICT(user_id,log_date) DO UPDATE SET count=CASE WHEN ad_logs.count<$3 THEN ad_logs.count+1 ELSE ad_logs.count END,points_earned=CASE WHEN ad_logs.count<$3 THEN ad_logs.points_earned+$2 ELSE ad_logs.points_earned END,updated_at=NOW() RETURNING count,points_earned`,[userId,CFG.POINTS_PER_AD,CFG.ADS_DAILY_LIMIT]);
  const watched=parseInt(lr[0].count)||0;
  await sql(`UPDATE users SET points=points+$1,xp=xp+$1,ads_watched_total=ads_watched_total+1,updated_at=NOW() WHERE id=$2`,[CFG.POINTS_PER_AD,userId]);
  await syncLevel(userId);
  if(watched>=10) await upsertTask(userId,'ads_10');
  if(watched>=25) await upsertTask(userId,'ads_25');
  const ur=await sql(`SELECT points FROM users WHERE id=$1`,[userId]);
  return {ok:true,remaining:Math.max(0,CFG.ADS_DAILY_LIMIT-watched),watchedToday:watched,earnedToday:parseInt(lr[0].points_earned)||0,points:parseInt(ur[0]?.points)||0,all_done:watched>=CFG.ADS_DAILY_LIMIT};
}

async function handleClaimGift(userId, nonce) {
  if(!await consumeNonce(nonce,userId)) return {ok:false,error:'invalid_nonce'};
  const r=await sql(`SELECT last_gift_date,streak_day FROM users WHERE id=$1`,[userId]);
  const u=r[0];
  const today=new Date().toISOString().slice(0,10);
  const last=u.last_gift_date?String(u.last_gift_date).slice(0,10):'';
  if(last===today) return {ok:false,error:'already_claimed_today'};
  const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const newStreak=last===yesterday?(parseInt(u.streak_day)||0)+1:1;
  const reward=giftReward(newStreak);
  await sql(`UPDATE users SET points=points+$1,xp=xp+$1,streak_day=$2,last_gift_date=$3::date,updated_at=NOW() WHERE id=$4`,[reward,newStreak,today,userId]);
  await syncLevel(userId);
  const fresh=(await sql(`SELECT points,level FROM users WHERE id=$1`,[userId]))[0];
  return {ok:true,reward,streak_day:newStreak,points:parseInt(fresh?.points)||0,level:fresh?.level};
}

async function handleVerifyTgTask(userId, nonce) {
  if(!await consumeNonce(nonce,userId)) return {ok:false,error:'invalid_nonce'};
  const r=await sql(`SELECT tg_verified FROM users WHERE id=$1`,[userId]);
  if(r[0]?.tg_verified) return {ok:false,error:'already_verified'};
  await sql(`UPDATE users SET tg_verified=TRUE,points=points+$1,xp=xp+$1,updated_at=NOW() WHERE id=$2 AND tg_verified=FALSE`,[CFG.POINTS_PER_TG_TASK,userId]);
  await syncLevel(userId);
  await upsertTask(userId,'tg_join');
  const fresh=(await sql(`SELECT points,level FROM users WHERE id=$1`,[userId]))[0];
  return {ok:true,reward:CFG.POINTS_PER_TG_TASK,points:parseInt(fresh?.points)||0,level:fresh?.level};
}

async function handleSubmitWithdraw(userId, body, nonce) {
  if(!await consumeNonce(nonce,userId)) return {ok:false,error:'invalid_nonce'};
  const address=(body?.data?.address||'').trim();
  if(!isValidTon(address)) return {ok:false,error:'invalid_address'};
  const r=await sql(`SELECT points,level FROM users WHERE id=$1`,[userId]);
  if(!r.length) return {ok:false,error:'user_not_found'};
  const pts=parseInt(r[0].points)||0, level=parseInt(r[0].level)||1;
  if(level<CFG.WITHDRAW_MIN_LEVEL) return {ok:false,error:'level_too_low',required_level:CFG.WITHDRAW_MIN_LEVEL};
  if(pts<CFG.WITHDRAW_MIN_PTS)    return {ok:false,error:'insufficient_balance',required:CFG.WITHDRAW_MIN_PTS,have:pts};
  const ton=parseFloat((pts/CFG.PTS_PER_TON).toFixed(6));
  await sql(`UPDATE users SET points=points-$1,updated_at=NOW() WHERE id=$2`,[pts,userId]);
  const wr=await sql(`INSERT INTO withdrawals(user_id,pts,ton_amount,address,method,status) VALUES($1,$2,$3,$4,'ton','pending') RETURNING id`,[userId,pts,ton,address]);
  const nb=(await sql(`SELECT points FROM users WHERE id=$1`,[userId]))[0];
  return {ok:true,withdraw_id:wr[0].id,pts_deducted:pts,ton_amount:ton,new_balance:parseInt(nb?.points)||0,status:'pending'};
}

async function handleGetReferrals(userId) {
  const r=(await sql(`SELECT total_referrals,earned_from_refs,tg_id FROM users WHERE id=$1`,[userId]))[0];
  const rR=await sql(`SELECT u.tg_first_name,u.tg_username,u.created_at FROM referrals ref JOIN users u ON u.id=ref.referred_id WHERE ref.referrer_id=$1 ORDER BY ref.created_at DESC LIMIT 20`,[userId]);
  return {ok:true,total_referrals:r.total_referrals,earned_from_refs:parseInt(r.earned_from_refs)||0,pts_per_referral:CFG.POINTS_PER_REFERRAL,referral_list:rR.map(x=>({name:x.tg_first_name||x.tg_username||'مستخدم',ts:new Date(x.created_at).getTime()})),tg_id:r.tg_id};
}

async function handleAdmin(action, body) {
  if(action==='list_withdrawals'){
    const r=await sql(`SELECT w.id,w.user_id,u.tg_username,u.tg_first_name,w.pts,w.ton_amount,w.address,w.status,w.created_at FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status=$1 ORDER BY w.created_at DESC LIMIT 100`,[body?.status||'pending']);
    return {ok:true,withdrawals:r};
  }
  if(action==='approve_withdrawal'){
    const id=parseInt(body?.withdraw_id); if(!id) return {ok:false,error:'missing_id'};
    await sql(`UPDATE withdrawals SET status='completed',tx_hash=$1,reviewed_at=NOW() WHERE id=$2`,[body?.tx_hash||'',id]);
    return {ok:true};
  }
  if(action==='reject_withdrawal'){
    const id=parseInt(body?.withdraw_id); if(!id) return {ok:false,error:'missing_id'};
    const wr=await sql(`SELECT user_id,pts FROM withdrawals WHERE id=$1`,[id]);
    if(wr.length) await sql(`UPDATE users SET points=points+$1 WHERE id=$2`,[wr[0].pts,wr[0].user_id]);
    await sql(`UPDATE withdrawals SET status='rejected',reviewed_at=NOW() WHERE id=$1`,[id]);
    return {ok:true};
  }
  if(action==='ban_user'){
    const tgId=parseInt(body?.tg_id); if(!tgId) return {ok:false,error:'missing_tg_id'};
    await sql(`UPDATE users SET is_banned=TRUE,ban_reason=$1 WHERE tg_id=$2`,[body?.reason||'admin_ban',tgId]);
    return {ok:true};
  }
  if(action==='unban_user'){
    const tgId=parseInt(body?.tg_id); if(!tgId) return {ok:false,error:'missing_tg_id'};
    await sql(`UPDATE users SET is_banned=FALSE,ban_reason=NULL,risk_score=0 WHERE tg_id=$1`,[tgId]);
    return {ok:true};
  }
  if(action==='stats'){
    const r=(await sql(`SELECT COUNT(*) AS total_users,COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '1 day') AS new_today,SUM(points) AS total_points,COUNT(*) FILTER(WHERE is_banned) AS banned_users FROM users`))[0];
    const w=(await sql(`SELECT COUNT(*) AS pending_wd,COALESCE(SUM(pts),0) AS pending_pts FROM withdrawals WHERE status='pending'`))[0];
    return {ok:true,stats:{...r,...w}};
  }
  return {ok:false,error:'unknown_admin_action'};
}

// ── Main Handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Init-Data, X-Session-Id, X-Fingerprint, X-Nonce, X-Admin-Secret');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST')    return res.status(405).json({error:'method_not_allowed'});

  let body=req.body;
  if(typeof body==='string'){try{body=JSON.parse(body);}catch(_){return res.status(400).json({error:'invalid_json'});}}
  if(!body||typeof body!=='object') body={};

  const type=body?.type||'';
  if(!type) return res.status(400).json({error:'missing_type'});

  const initData  = req.headers['x-init-data']   ||'';
  const sessionId = req.headers['x-session-id']  ||'';
  const fpRaw     = req.headers['x-fingerprint'] ||'{}';
  const nonce     = req.headers['x-nonce']       ||'';
  const adminKey  = req.headers['x-admin-secret']||'';

  const ipHash=hashIp(getIp(req));
  let fpData={}; try{fpData=JSON.parse(fpRaw);}catch(_){}
  const fpHash=hashFp(fpData);

  const isWrite=!['load','get_state','get_nonce','create_session','get_referrals'].includes(type);
  if(!rateLimit(`ip_${ipHash}_${type}`,isWrite?CFG.RATE_WRITE_MAX:CFG.RATE_MAX))
    return res.status(429).json({ok:false,error:'rate_limited'});

  try {
    if(type==='admin'){
      if(adminKey!==ADMIN_SECRET) return res.status(403).json({ok:false,error:'forbidden'});
      return res.status(200).json(await handleAdmin(body?.action,body));
    }

    if(type==='create_session'){
      const result=await handleCreateSession(body,ipHash,fpHash);
      return res.status(result.status||200).json(result);
    }

    if(!sessionId) return res.status(401).json({ok:false,error:'session_required'});
    const session=await validateSession(sessionId);
    if(!session)   return res.status(401).json({ok:false,error:'session_invalid_or_expired'});
    if(session.is_banned||session.cluster_ban) return res.status(403).json({ok:false,is_banned:true});

    const userId=session.user_id;
    if(!rateLimit(`u_${userId}_${type}`,isWrite?10:20))
      return res.status(429).json({ok:false,error:'rate_limited'});

    let result;
    switch(type){
      case 'get_nonce':       result=await issueNonce(userId).then(n=>({ok:true,nonce:n})); break;
      case 'load':            result=await handleLoad(userId);                              break;
      case 'get_state':       result=await handleGetState(userId);                          break;
      case 'start_ad':        result=await handleStartAd(userId);                           break;
      case 'watch_ad':        result=await handleWatchAd(userId,body,ipHash,fpHash);        break;
      case 'claim_gift':      result=await handleClaimGift(userId,nonce);                   break;
      case 'verify_tg_task':  result=await handleVerifyTgTask(userId,nonce);                break;
      case 'submit_withdraw': result=await handleSubmitWithdraw(userId,body,nonce);         break;
      case 'get_referrals':   result=await handleGetReferrals(userId);                      break;
      default: result={ok:false,error:'unknown_action'};
    }

    if(session.is_shadow_banned&&isWrite&&!result.ok) result={ok:true};
    return res.status(200).json(result);

  } catch(e) {
    console.error(`[${type}]`,e.message);
    return res.status(500).json({ok:false,error:'internal_server_error',detail:e.message});
  }
};
