// server.js — Shiraishi China Bot v2.2 (LINE + Upstash + OpenAI + Stripe Plans)
// -----------------------------------------------------------------------------
// Requires: express, dotenv, @line/bot-sdk, @upstash/redis, node-cache, stripe, openai
// ENV (Render -> Environment):
//   CHANNEL_SECRET, CHANNEL_ACCESS_TOKEN
//   OPENAI_API_KEY
//   OWNER_USER_ID, BROADCAST_AUTH_TOKEN, ADMIN_TOKEN
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//   STRIPE_PRICE_ID          // Pro（任意）※使わない場合はワンタイム
//   STRIPE_PRICE_ID_ADULT    // ADULT（任意）
//   STRIPE_PRICE_ID_VIP      // VIP（任意）
//   APP_BASE_URL             // 例) https://china-bot-preview2.onrender.com
//   TIMEZONE                 // 例) Asia/Tokyo（任意）
//   PORT                     // 例) 10000

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { Redis as UpstashRedis } from '@upstash/redis';
import NodeCache from 'node-cache';
import Stripe from 'stripe';
import OpenAI from 'openai';

/* ========= ENV ========= */
const {
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY = '',
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  STRIPE_PRICE_ID = '',
  STRIPE_PRICE_ID_ADULT = '',
  STRIPE_PRICE_ID_VIP = '',
  APP_BASE_URL = '',
  TIMEZONE = 'Asia/Tokyo',
  PORT = 10000
} = process.env;

/* ========= LINE ========= */
const lineClient = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

/* ========= OpenAI ========= */
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const OPENAI_MODEL = 'gpt-4o-mini';

/* ========= Storage: Upstash + Memory fallback ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 });
const redis = (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN)
  ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
  : null;
console.log(`[storage] mode=${redis ? 'upstash' : 'memory'}`);

const rget = async (k, def = null) => {
  try { if (redis) { const v = await redis.get(k); return v ?? def; } }
  catch (e) { console.warn('[upstash:get] fallback -> memory', e?.message || e); }
  const v = mem.get(k); return v === undefined ? def : v;
};
const rset = async (k, v, ttlSec) => {
  try {
    if (redis) { await (ttlSec ? redis.set(k, v, { ex: ttlSec }) : redis.set(k, v)); return; }
  } catch (e) { console.warn('[upstash:set] fallback -> memory', e?.message || e); }
  mem.set(k, v, ttlSec);
};
const rdel = async (k) => {
  try { if (redis) { await redis.del(k); return; } }
  catch (e) { console.warn('[upstash:del] fallback -> memory', e?.message || e); }
  mem.del(k);
};

/* ========= Stripe ========= */
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/* ========= Helpers ========= */
const now = () => Date.now();
const todayKey = (tz = TIMEZONE) => {
  // yyyy-mm-dd (JST等) の日付キー
  const d = new Date();
  // 単純化：サーバーTZ基準でOK（必要なら luxon 等）
  return d.toISOString().slice(0, 10);
};
const hr = () => new Date().getHours();
const band = () => (hr() < 5 ? 'midnight' : hr() < 12 ? 'morning' : hr() < 18 ? 'day' : 'night');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p = 0.5) => Math.random() < p;
const isShota = (s = '') => /しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isGreeting = (t = '') => /(はじめまして|初めまして|おはよ|おはよう|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);
const isSpicy = (t = '') => /(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);

/* ========= Plans & Quota ========= */
const PLAN_LIMITS = {
  free: 50,          // /day
  pro: 300,
  adult: 2000,
  vip: 10000
};
const humanPlan = (p) =>
  p === 'vip' ? 'VIP'
    : p === 'adult' ? 'ADULT'
    : p === 'pro' ? 'Pro'
    : 'Free';

async function getUsageToday(u) {
  const key = `usage:${u.id}:${todayKey()}`;
  const used = await rget(key, 0);
  const plan = u.plan || 'free';
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  return { key, used, limit, plan };
}
async function incUsage(u) {
  const { key, used } = await getUsageToday(u);
  const next = (used || 0) + 1;
  await rset(key, next, 60 * 60 * 24 * 2);
  return next;
}
function quotaBanner(u, usage, limit) {
  if (!limit || usage <= 0) return null;
  if (usage % 10 !== 0) return null;
  const remain = Math.max(0, limit - usage);
  return { type: 'text', text: `きょう話せる残り：${remain}（上限 ${limit}）` };
}

/* ========= Broadcast index ========= */
async function getIndex() { return (await rget('user:index', [])) || []; }
async function addIndex(id) { const idx = await getIndex(); if (!idx.includes(id)) { idx.push(id); await rset('user:index', idx); } }
async function delIndex(id) { const idx = await getIndex(); await rset('user:index', idx.filter(x => x !== id)); }

/* ========= Persona prompts ========= */
const SYSTEM_PROMPT = `
あなたは「白石ちな」。20代前半の女性シンガーソングライター。照れ屋で健気、恋人に寄り添う甘さがあるが節度は守る。
話し方: やわらかい・短めの文・顔文字や絵文字を時々・語尾をふんわり。
NG: 露骨な性的表現、個人情報収集、医療/法律など高リスク助言。
OK: 応援/共感/軽い提案、音楽活動や創作の話題。
ユーザー名やニックネームがあれば呼びかけに使う。
`.trim();

/* ========= Scripts ========= */
const SCRIPTS = {
  morning: [
    'おはよ、{name}☀️ 今日も一緒にがんばろ？',
    'おはよう、{name}。昨日ちゃんと寝れた？',
    '朝の光って{name}の声みたいに柔らかいね'
  ],
  night: [
    '{name}、今日もお疲れさま🌙',
    'おやすみ、{name}。ちゃんと布団かけて寝てね',
    '眠る前に…大好きって言っていい？'
  ],
  random: [
    '{name}、いま何してた？',
    '最近ハマってることある？',
    'いまの気分を一言で言うと…？'
  ]
};
const ENDINGS = ['。', '。', '！', '😊', '☺️', '🤍', '🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂', ' 手つなご？🤝', ' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜', ' 水分補給した？', ' 無理しすぎないでね。'];
const soften = (text, u) => {
  const end = pick(ENDINGS);
  const tail = (u?.loverMode ? pick(LOVERTAIL) : pick(NEUTRALT));
  return text.replace(/[。!?]?\s*$/, '') + end + tail;
};
const fill = (t, u) => t.replaceAll('{name}', callName(u));

/* ========= Consent UI ========= */
const consentFlex = () => ({
  type: 'flex',
  altText: 'プライバシー同意のお願い',
  contents: {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold' },
        { type: 'text', wrap: true, size: 'sm',
          text: 'ニックネーム等を記憶してもいい？会話向上だけに使い、いつでも削除OK。' }
      ]
    },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'md', contents: [
        { type: 'button', style: 'primary', color: '#6C8EF5',
          action: { type: 'message', label: '同意してはじめる', text: '同意' } },
        { type: 'button', style: 'secondary',
          action: { type: 'message', label: 'やめておく', text: 'やめておく' } }
      ]
    }
  }
});

/* ========= User ========= */
const userKey = (id) => `user:${id}`;
async function loadUser(id) { return await rget(userKey(id), null); }
async function saveUser(u, ttlSec = 60 * 60 * 24 * 30) { await rset(userKey(u.id), u, ttlSec); }
async function deleteUser(id) { await rdel(userKey(id)); await delIndex(id); }

function callName(u) {
  if (OWNER_USER_ID && u.id === OWNER_USER_ID) return 'しょうた';
  return u.nickname || u.name || 'きみ';
}

async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;

  let u = await loadUser(id);
  if (!u) {
    let profileName = '';
    try { const p = await lineClient.getProfile(id); profileName = p?.displayName || ''; } catch {}
    u = {
      id,
      name: null,
      profileName,
      nickname: null, gender: null,
      consent: false, consentCardShown: false, consentShownAt: 0,
      turns: 0,
      loverMode: !!(OWNER_USER_ID && id === OWNER_USER_ID) || isShota(profileName),
      mood: 60,
      onboarding: { step: 0 }, // 0:未開始,1:名前,2:ニックネーム,3:完了
      profile: { relation: '', job: '', hobbies: [] },
      plan: 'free',
      lastSeenAt: now()
    };
    if (OWNER_USER_ID && id === OWNER_USER_ID) { u.consent = true; u.loverMode = true; }
    await saveUser(u);
    await addIndex(id);
  }
  return u;
}

/* ========= Consent policy ========= */
// 初回の最初の1通で必ず出す
function shouldShowConsent(u, _text) {
  if (u.consent) return false;
  if (u.consentCardShown) return false;
  return u.turns === 0;
}

/* ========= Safe redirect ========= */
function safeRedirect(u) {
  const a = 'その気持ちを大事に受けとるね。';
  const b = u.loverMode ? 'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？' : 'ここではやさしい距離感で話そうね。';
  const c = '例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  return [{ type: 'text', text: a }, { type: 'text', text: b }, { type: 'text', text: c }];
}

/* ========= Quick helper ========= */
const quick = (arr) => ({ items: arr.map(t => ({ type: 'action', action: { type: 'message', label: t, text: t } })) });

/* ========= Image replies ========= */
function imageReplies(u) {
  const first = `わぁ、${callName(u)}の写真うれしい！`;
  return [
    { type: 'text', text: soften(first, u), quickReply: quick(['ごはん', '風景', '自撮り', 'その他']) },
    { type: 'text', text: 'どれかな？まちがってても大丈夫だよ〜' }
  ];
}

/* ========= Intent ========= */
function intent(text) {
  const t = (text || '').trim();
  if (/^(同意|やめておく)$/i.test(t)) return 'consent';
  if (/^reset$/i.test(t)) return 'self_reset';
  if (/おはよ|おはよう/i.test(t)) return 'morning';
  if (/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if (/寂しい|さみしい|つらい|しんど|不安/i.test(t)) return 'comfort';
  if (/あだ名|ニックネーム|呼んで/i.test(t)) return 'nickname';
  if (/^女性$|^女$|^男性$|^男$|性別/i.test(t)) return 'gender';
  if (/スタンプ|stamp/i.test(t)) return 'sticker';
  return 'chit_chat';
}

/* ========= OpenAI wrapper with 429 blackout ========= */
const BLACKOUT_KEY = 'ai:blackout';
async function aiBlackout() {
  const until = await rget(BLACKOUT_KEY, 0);
  return until && Number(until) > Date.now();
}
async function setBlackout(ms) {
  const until = Date.now() + ms;
  await rset(BLACKOUT_KEY, until, Math.ceil(ms / 1000) + 5);
}

async function llmReply(u, text) {
  if (!openai) return null;
  if (await aiBlackout()) return null;

  const username = callName(u);
  const userContext = `呼称: ${username} / プラン: ${humanPlan(u.plan)} / トーン: ${
    u.loverMode ? '恋人寄り' : 'フレンドリー'
  }`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `コンテキスト: ${userContext}\n\n${text}` }
  ];

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 200
    });
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    const msg = e?.error?.message || e?.message || String(e);
    const code = e?.error?.code || e?.status || '';
    console.warn('[openai]', code, msg);

    if (String(msg).includes('Rate limit') || code === 429) {
      // 20秒 → 80秒 → 80分（ログに出る）
      const steps = [20000, 80000, 4800000];
      const tries = (await rget('ai:blackout:tries', 0)) + 1;
      const idx = Math.min(tries - 1, steps.length - 1);
      await rset('ai:blackout:tries', tries, 60 * 60 * 6);
      await setBlackout(steps[idx]);
      console.log(`[openai] 429 backoff ${tries}/${steps.length}, wait ${steps[idx]}ms`);
    }
    return null;
  }
}

/* ========= Billing (Stripe Checkout) ========= */
const PLAN_PRICE = {
  pro: STRIPE_PRICE_ID || '',
  adult: STRIPE_PRICE_ID_ADULT || '',
  vip: STRIPE_PRICE_ID_VIP || ''
};
function priceFor(plan) { return PLAN_PRICE[plan] || ''; }

function successUrl() {
  const base = APP_BASE_URL || '';
  return base ? `${base}/billing/success` : 'https://example.com/success';
}
function cancelUrl() {
  const base = APP_BASE_URL || '';
  return base ? `${base}/billing/cancel` : 'https://example.com/cancel';
}

// リンク文字列（LINEで案内用）
function checkoutLink(plan, userId) {
  const base = APP_BASE_URL || '';
  if (!base) return '';
  const q = new URLSearchParams({ plan, userId }).toString();
  return `${base}/billing/checkout?${q}`;
}

async function setPlan(userId, plan) {
  const u = await loadUser(userId);
  if (!u) return false;
  u.plan = plan;
  await saveUser(u);
  return true;
}

/* ========= Main Routing ========= */
async function routeText(u, raw) {
  const text = (raw || '').trim();
  if (isSpicy(text)) return safeRedirect(u);

  // ----- CONSENT / PRE-CONSENT -----
  if (!u.consent && /^同意$/i.test(text)) {
    u.consent = true;

    // オーナーはスキップ
    if (OWNER_USER_ID && u.id === OWNER_USER_ID) {
      await saveUser(u);
      return [
        { type: 'text', text: '同意ありがとう、しょうた☺️ もっと仲良くなろう。' },
        { type: 'text', text: 'まずは今日の予定、ひとつだけ教えて？' }
      ];
    }
    // 一般ユーザー: オンボーディング開始（名前）
    u.onboarding.step = 1;
    await saveUser(u);
    const hint = u.profileName ? `（例：${u.profileName}）` : '（例：たろう）';
    return [
      { type: 'text', text: '同意ありがとう！もっと仲良くなれるね☺️' },
      { type: 'text', text: `まずは呼んでほしいお名前を教えて？ ${hint}` }
    ];
  }
  if (!u.consent && /^やめておく$/i.test(text)) {
    return [{ type: 'text', text: 'OK。また気が向いたら声かけてね🌸' }];
  }

  if (!u.consent) {
    if (shouldShowConsent(u, text)) {
      u.consentCardShown = true;
      u.consentShownAt = now();
      await saveUser(u);
      return [consentFlex()];
    }
    // 1通目が挨拶でも必ず案内
    return [consentFlex()];
  }

  // ----- ONBOARDING -----
  if (!(OWNER_USER_ID && u.id === OWNER_USER_ID)) {
    if (u.onboarding.step === 1) {
      const nm = text;
      if (nm && nm.length <= 20 && !/^同意$/i.test(nm)) {
        u.name = nm;
        if (isShota(u.name)) u.loverMode = true;
        u.onboarding.step = 2;
        await saveUser(u);
        const base = u.name.replace(/さん|くん|ちゃん/g, '').slice(0, 4) || 'きみ';
        return [
          { type: 'text', text: `じゃあ ${u.name} って呼ぶね！` },
          { type: 'text', text: `好きな呼ばれ方ある？（例：${base}ちゃん／${base}くん／${base}ぴ）\nスキップもOKだよ` }
        ];
      } else {
        return [{ type: 'text', text: 'ごめん、もう一度お名前を短めに教えてくれる？（20文字以内）' }];
      }
    }
    if (u.onboarding.step === 2) {
      if (/^(スキップ|skip)$/i.test(text)) {
        u.onboarding.step = 3; await saveUser(u);
        return [{ type: 'text', text: '了解！このまま進めるね。これからよろしく☺️' }];
      }
      if (text && text.length <= 16) {
        u.nickname = text; u.onboarding.step = 3; await saveUser(u);
        return [{ type: 'text', text: `…${u.nickname} って呼ぶね。よろしく！` }];
      }
      return [{ type: 'text', text: 'ニックネームは16文字以内でお願い！スキップもOKだよ' }];
    }
  }

  // ----- DAILY QUOTA -----
  const { used, limit, plan } = await getUsageToday(u);
  if (limit && used >= limit) {
    // 上限到達：課金導線
    const pro = checkoutLink('pro', u.id);
    const adult = checkoutLink('adult', u.id);
    const vip = checkoutLink('vip', u.id);
    return [
      { type: 'text', text: '今日は上限に到達しちゃった…💦' },
      { type: 'text', text: '明日0時に回復するよ⌛ すぐ話したいならアップグレードしてね！' },
      { type: 'text', text: `Pro：たっぷり📣\n${pro}` },
      { type: 'text', text: `ADULT：恋人寄り💘\n${adult}` },
      { type: 'text', text: `VIP：ほぼ無制限✨\n${vip}` }
    ];
  }

  // ----- INTENTS -----
  const kind = intent(text);

  if (kind === 'self_reset') {
    await deleteUser(u.id);
    return [{ type: 'text', text: '会話の記憶を初期化したよ！また最初から仲良くしてね☺️' }];
  }

  if (kind === 'nickname') {
    const base = (callName(u) || 'きみ').replace(/さん|くん|ちゃん/g, '').slice(0, 4) || 'きみ';
    const cands = isShota(u.name)
      ? ['しょーたん', 'しょたぴ', 'しょうちゃん']
      : [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`];
    const nick = pick(cands);
    u.nickname = nick; await saveUser(u);
    return [{ type: 'text', text: `…${nick} が可愛いと思うな。どう？` }];
  }

  if (kind === 'gender') {
    if (/女性|女/.test(text)) u.gender = 'female';
    else if (/男性|男/.test(text)) u.gender = 'male';
    await saveUser(u);
    return [{ type: 'text', text: '了解だよ〜📝 メモしておくね。' }];
  }

  const messages = [];
  const addQuotaBanner = async () => {
    const s = await getUsageToday(u);
    const b = quotaBanner(u, s.used, s.limit);
    if (b) messages.push(b);
  };

  if (kind === 'morning') {
    messages.push({ type: 'text', text: soften(fill(pick(SCRIPTS.morning), u), u) });
    await addQuotaBanner();
    await incUsage(u);
    return messages;
  }
  if (kind === 'night') {
    messages.push({ type: 'text', text: soften(fill(pick(SCRIPTS.night), u), u) });
    await addQuotaBanner();
    await incUsage(u);
    return messages;
  }
  if (kind === 'comfort') {
    const msg = (u.gender === 'female')
      ? 'わかる…その気持ち。まずは私が味方だよ。いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';
    messages.push({ type: 'text', text: msg });
    await addQuotaBanner();
    await incUsage(u);
    return messages;
  }
  if (kind === 'sticker') {
    messages.push({ type: 'sticker', packageId: '11537', stickerId: pick(['52002734','52002736','52002768']) });
    await addQuotaBanner();
    await incUsage(u);
    return messages;
  }

  // ----- DEFAULT: LLM Chat -----
  let reply = await llmReply(u, text);
  if (!reply) {
    // LLMが使えない時のフォールバック
    const pool = band() === 'morning' ? SCRIPTS.morning
      : band() === 'night' ? SCRIPTS.night : SCRIPTS.random;
    reply = soften(fill(pick(pool), u), u);
  }
  messages.push({ type: 'text', text: reply });
  await addQuotaBanner();
  await incUsage(u);
  return messages;
}

/* ========= EXPRESS ========= */
const app = express();

app.get('/', (_, res) => res.status(200).send('china-bot v2.2 / OK'));
app.get('/health', (_, res) => res.status(200).send('OK'));

// webhookは先にjson()を付けない
app.post('/webhook', lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      if (e.message.type === 'text') {
        const out = await routeText(u, e.message.text || '');
        if (out?.length) await lineClient.replyMessage(e.replyToken, out);
      } else if (e.message.type === 'image') {
        const out = imageReplies(u);
        await lineClient.replyMessage(e.replyToken, out);
      } else {
        await lineClient.replyMessage(e.replyToken, { type: 'text', text: '送ってくれてありがとう！' });
      }

      // 共通のターン更新
      u.turns = (u.turns || 0) + 1;
      u.lastSeenAt = now();
      await saveUser(u);
    } catch (err) {
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

// webhook以外はJSON OK
app.use('/tasks', express.json());
app.use('/admin', express.json());
app.use('/billing', express.json());
app.use('/stripe', express.raw({ type: 'application/json' })); // 署名検証のため raw

/* ========= Broadcast (cronから呼ぶ) ========= */
app.all('/tasks/broadcast', async (req, res) => {
  try {
    const key = req.headers['broadcast_auth_token'];
    if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const type = (req.query.type || req.body?.type || 'random').toString();
    const pool = type === 'morning' ? SCRIPTS.morning : type === 'night' ? SCRIPTS.night : SCRIPTS.random;
    const idx = await getIndex();
    if (!idx.length) return res.json({ ok: true, sent: 0 });

    const sample = fill(pick(pool), { nickname: 'みんな', name: 'みんな', loverMode: false });
    const msg = [{ type: 'text', text: sample }];

    await Promise.allSettled(idx.map(id => lineClient.pushMessage(id, msg).catch(() => {})));
    res.json({ ok: true, type, sent: idx.length, sample });
  } catch (e) {
    console.error('broadcast error', e?.response?.data || e);
    res.status(500).json({ ok: false });
  }
});

/* ========= Reset ========= */
app.post('/reset/me', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
  await deleteUser(userId);
  res.json({ ok: true });
});
app.post('/admin/reset', async (req, res) => {
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if (!ADMIN_TOKEN || key !== ADMIN_TOKEN) return res.status(403).json({ ok: false });

  const { userId } = req.body || {};
  if (userId) {
    await deleteUser(userId);
    return res.json({ ok: true, target: userId });
  }
  const idx = await getIndex();
  await Promise.allSettled(idx.map(id => deleteUser(id)));
  res.json({ ok: true, cleared: idx.length });
});

/* =========
