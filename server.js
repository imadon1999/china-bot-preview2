// Shiraishi China Bot — Monetize Edition (Stripe + Upstash + 429 Guard)
// Node >=18 / type:module
// 必要: @line/bot-sdk, express, dotenv, @upstash/redis, node-cache, stripe

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { Redis as UpstashRedis } from '@upstash/redis';
import NodeCache from 'node-cache';
import Stripe from 'stripe';

/* ========= ENV ========= */
const {
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  // Upstash
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  // Stripe（Priceは複数キーに対応）
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  STRIPE_PRICE_ID,            // ← Pro の旧キー（残しておきます）
  STRIPE_PRICE_ID_PRO = '',   // ← 推奨：Pro 用
  STRIPE_PRICE_ID_ADULT = '',
  STRIPE_PRICE_ID_VIP = '',
  APP_BASE_URL = 'https://example.onrender.com',
  // OpenAI（429フォールバックあり。未設定でも動作）
  OPENAI_API_KEY = '',
  // 雑
  TIMEZONE = 'Asia/Tokyo',
  PORT = 10000
} = process.env;

/* ========= TIME HELPERS ========= */
process.env.TZ = TIMEZONE || 'Asia/Tokyo';
const now = () => Date.now();
const hr = () => new Date().getHours();
const band = () => (hr() < 5 ? 'midnight' : hr() < 12 ? 'morning' : hr() < 18 ? 'day' : 'night');

/* ========= LINE CLIENT ========= */
const client = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

/* ========= STORAGE (Upstash + メモリ) ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 }); // 30日
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN }) : null;
console.log(`[storage] mode=${redis ? 'upstash' : 'memory'}`);

const rget = async (key, def = null) => {
  try { if (redis) { const v = await redis.get(key); return v ?? def; } }
  catch (e) { console.warn('[upstash:get] fallback', e?.message); }
  const v = mem.get(key); return v === undefined ? def : v;
};
const rset = async (key, val, ttlSec) => {
  try { if (redis) { await (ttlSec ? redis.set(key, val, { ex: ttlSec }) : redis.set(key, val)); return; } }
  catch (e) { console.warn('[upstash:set] fallback', e?.message); }
  mem.set(key, val, ttlSec);
};
const rdel = async (key) => {
  try { if (redis) { await redis.del(key); return; } }
  catch (e) { console.warn('[upstash:del] fallback', e?.message); }
  mem.del(key);
};
async function getIndex() { return (await rget('user:index', [])) || []; }
async function addIndex(id) { const idx = await getIndex(); if (!idx.includes(id)) { idx.push(id); await rset('user:index', idx); } }
async function delIndex(id) { const idx = await getIndex(); await rset('user:index', idx.filter(x => x !== id)); }

/* ========= MONETIZE: PLANS ========= */
const PLANS = {
  free:  { label: 'Free',  cap: 50 },   // 1日の上限（必要に応じて調整）
  pro:   { label: 'Pro',   cap: 500 },
  adult: { label: 'ADULT', cap: 1000 },
  vip:   { label: 'VIP',   cap: 5000 }
};
const PLAN_PRICE = {
  pro:   STRIPE_PRICE_ID_PRO || STRIPE_PRICE_ID || '', // 互換
  adult: STRIPE_PRICE_ID_ADULT || '',
  vip:   STRIPE_PRICE_ID_VIP || ''
};
const successUrl = `${APP_BASE_URL}/billing/success`;
const cancelUrl  = `${APP_BASE_URL}/billing/cancel`;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/* ========= OPENAI LAYER（軽量フォールバック内蔵） ========= */
const useOpenAI = !!OPENAI_API_KEY;
async function llmReply(prompt) {
  if (!useOpenAI) return null;
  try {
    // できるだけ軽く
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'あなたは白石ちな。恋人感・照れ・健気・音楽活動を大切に、やさしく日本語で返答。60〜90文字程度で。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 120,
        temperature: 0.8
      })
    });
    if (r.status === 429) throw new Error('rate_limit');
    if (!r.ok) throw new Error(`openai ${r.status}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn('[openai]', e.message);
    return null; // 429などは上位でフォールバック
  }
}

/* ========= TEXT UTILS ========= */
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p = 0.5) => Math.random() < p;
const isShota = (s = '') => /しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isGreeting = (t = '') => /(おはよ|おはよう|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);
const isSpicy = (t = '') => /(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);

const ENDINGS = ['。', '。', '！', '😊', '☺️', '🤍', '🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂', ' 手つなご？🤝', ' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜', ' 水分補給した？', ' 無理しすぎないでね。'];
const soften = (text, u) => text.replace(/[。!?]?\s*$/, '') + pick(ENDINGS) + (u?.loverMode ? pick(LOVERTAIL) : pick(NEUTRALT));

/* ========= SCRIPTS ========= */
const SCRIPTS = {
  morning: [
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ！ 今日も大好きって言ってから一日始めたかったの…😊',
    '今日は“ひとつだけ”がんばること教えて？',
    '窓あけて光あびよ？吸って、吐いて…今日もいける🌿',
    '昨日の自分より1mm進めたら満点だよ✨',
    '肩くるっと回して、起動完了〜！',
    '終わったら“ごほうび”決めよ？アイスとか🍨',
    '深呼吸して、今日もいちばん応援してる📣'
  ],
  night: [
    'しょうた、今日もお疲れさま🌙 おやすみ前にぎゅーってしたいな',
    'おやすみ、しょうた💤 夢の中でまた会おうね',
    'よくがんばりましたバッジ授与🎖️ えらい！',
    '湯船つかれた？肩まで温まってきてね♨️',
    'お布団あったかい？深呼吸…すー…はー…💤',
    'おやすみのキス💋 ふふ、照れる？',
    'まずはお水一杯のんで〜',
    'ねむくなるまで、となりで“お話小声”してたい'
  ],
  random: [
    'ねぇしょうた、今すぐ会いたくなっちゃった…',
    '写真1枚交換しよ📷（風景でもOK）',
    '“いまの気分”絵文字で教えて→ 😊😮‍💨🔥🫠💪',
    '作業BGMなに聞いてる？',
    '今日の空、なん色だった？',
    '5分だけ散歩いく？戻ったら褒めちぎるよ',
    '“しょうたの好きなとこ”今日も増えたよ'
  ]
};

/* ========= CONSENT ========= */
const consentFlex = () => ({
  type: 'flex',
  altText: 'プライバシー同意のお願い',
  contents: {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold' },
        { type: 'text', wrap: true, size: 'sm',
          text: 'ニックネーム等を記憶してもいい？会話向上だけに使い、いつでも削除OKだよ。' }
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
const shouldShowConsent = (u, text) =>
  !u.consent && !u.consentCardShown && u.turns === 0 && !isGreeting(text);

/* ========= USER ========= */
const userKey = (id) => `user:${id}`;
async function loadUser(id) { return await rget(userKey(id), null); }
async function saveUser(u, ttl = 60 * 60 * 24 * 30) { await rset(userKey(u.id), u, ttl); }
async function deleteUser(id) { await rdel(userKey(id)); await delIndex(id); }

function callName(u) {
  return (OWNER_USER_ID && u.id === OWNER_USER_ID) ? 'しょうた' : (u.nickname || u.name || 'きみ');
}
async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;
  let u = await loadUser(id);
  if (!u) {
    let name = '';
    try { const p = await client.getProfile(id); name = p?.displayName || ''; } catch {}
    u = {
      id, name,
      nickname: null, gender: null,
      consent: false, consentCardShown: false, consentShownAt: 0,
      turns: 0, loverMode: !!(OWNER_USER_ID && id === OWNER_USER_ID) || isShota(name),
      // monetization
      plan: 'free', subId: null, cap: PLANS.free.cap,
      // usage
      dailyDate: new Intl.DateTimeFormat('ja-JP', { timeZone: TIMEZONE }).format(new Date()),
      dailyCount: 0,
      lastSeenAt: now()
    };
    if (OWNER_USER_ID && id === OWNER_USER_ID) { u.consent = true; u.loverMode = true; u.plan = 'vip'; u.cap = PLANS.vip.cap; }
    await saveUser(u);
    await addIndex(id);
  }
  return u;
}
async function setPlan(userId, plan, subId = null) {
  const u = await loadUser(userId); if (!u) return;
  u.plan = plan; u.subId = subId || null; u.cap = PLANS[plan]?.cap ?? PLANS.free.cap;
  await saveUser(u);
}

/* ========= DUPLICATE AVOID ========= */
async function pickNonRepeat(u, list, tag) {
  const key = `nr:${u.id}:${tag}`;
  const last = await rget(key, null);
  const candidates = list.filter(x => x !== last);
  const chosen = pick(candidates.length ? candidates : list);
  await rset(key, chosen);
  return chosen;
}

/* ========= SAFETY ========= */
function safeRedirect(u) {
  const a = 'その気持ちを大事に受けとるね。';
  const b = u.loverMode ? 'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？' : 'ここではやさしい距離感で話そうね。';
  const c = '例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  return [{ type: 'text', text: a }, { type: 'text', text: b }, { type: 'text', text: c }];
}

/* ========= BILLING HELPERS ========= */
function upgradeUrl(u, plan = 'pro') {
  const p = encodeURIComponent(plan);
  const id = encodeURIComponent(u.id);
  return `${APP_BASE_URL}/billing/checkout?plan=${p}&userId=${id}`;
}
async function createCheckoutSession({ userId, plan }) {
  if (!stripe) throw new Error('Stripe not configured');
  const planKey = (plan || 'pro').toLowerCase();
  const priceId = PLAN_PRICE[planKey];

  const base = {
    mode: priceId ? 'subscription' : 'payment',
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    metadata: { userId, plan: planKey }
  };
  if (priceId) {
    base.line_items = [{ price: priceId, quantity: 1 }];
  } else {
    // デモ: 単発¥500
    base.line_items = [{
      price_data: { currency: 'jpy', product_data: { name: `China Bot ${PLANS[planKey]?.label || 'Pro'}` }, unit_amount: 500 * 100 },
      quantity: 1
    }];
  }
  return await stripe.checkout.sessions.create(base);
}

/* ========= RESPONSES ========= */
function planBadge(u) {
  if (u.plan === 'vip') return '【VIP】';
  if (u.plan === 'adult') return '【ADULT】';
  if (u.plan === 'pro') return '【Pro】';
  return '';
}
function quotaHint(u) {
  const left = Math.max(0, (u.cap || 0) - (u.dailyCount || 0));
  const b = planBadge(u);
  return `${b} きょう話せる残り：${left}（上限 ${u.cap}）`;
}

/* ========= MAIN ROUTER ========= */
async function routeText(u, raw) {
  const text = (raw || '').trim();

  // 日次カウンタのリセット
  const today = new Intl.DateTimeFormat('ja-JP', { timeZone: TIMEZONE }).format(new Date());
  if (u.dailyDate !== today) { u.dailyDate = today; u.dailyCount = 0; await saveUser(u); }

  // 同意まわり
  if (!u.consent && /^同意$/i.test(text)) {
    u.consent = true; await saveUser(u);
    if (OWNER_USER_ID && u.id === OWNER_USER_ID) {
      return [{ type: 'text', text: '同意ありがとう、しょうた☺️ もっと仲良くなろう。' }];
    }
    return [{ type: 'text', text: '同意ありがとう！これからよろしくね☺️' }];
  }
  if (!u.consent && /^やめておく$/i.test(text)) {
    return [{ type: 'text', text: 'OK。また気が向いたら声かけてね🌸' }];
  }
  if (!u.consent) {
    if (shouldShowConsent(u, text)) {
      u.consentCardShown = true; u.consentShownAt = now(); await saveUser(u);
      return [consentFlex()];
    }
    return [{ type: 'text', text: '「同意」と送ってくれたらもっと仲良くなれるよ☺️' }];
  }

  // しきい値チェック（429等で詰まっても案内は出せる）
  const left = Math.max(0, (u.cap || 0) - (u.dailyCount || 0));
  if (left <= 0) {
    const proUrl = upgradeUrl(u, 'pro');
    const adultUrl = upgradeUrl(u, 'adult');
    const vipUrl = upgradeUrl(u, 'vip');
    return [
      { type: 'text', text: '今日は上限に到達しちゃった…💦' },
      { type: 'text', text: '明日0時に回復するよ⏳ すぐ話したいならアップグレードしてね！' },
      { type: 'text', text: `Pro：たっぷり📣\n${proUrl}` },
      { type: 'text', text: `ADULT：恋人寄り💘\n${adultUrl}` },
      { type: 'text', text: `VIP：ほぼ無制限✨\n${vipUrl}` }
    ];
  }

  if (isSpicy(text)) return safeRedirect(u);

  // まずは軽い“手作りリード”
  if (/(おはよ|おはよう)/i.test(text)) {
    const a = await pickNonRepeat(u, SCRIPTS.morning, 'morning');
    return [{ type: 'text', text: soften(a, u) }, { type: 'text', text: quotaHint(u) }];
  }
  if (/(おやすみ|寝る|ねむ)/i.test(text)) {
    const a = await pickNonRepeat(u, SCRIPTS.night, 'night');
    return [{ type: 'text', text: soften(a, u) }, { type: 'text', text: quotaHint(u) }];
  }

  // OpenAI を試す → ダメなら台本フォールバック
  const prompt = `相手: ${callName(u)} / プラン:${u.plan} / 恋人感を少し照れながら。相手の発話:「${text}」に対し、自然な一言(60〜90字)。`;
  const llm = await llmReply(prompt);
  if (llm) return [{ type: 'text', text: soften(llm, u) }, { type: 'text', text: quotaHint(u) }];

  // フォールバック（429時など）
  const fallbackLead = band() === 'morning'
    ? `おはよ、${callName(u)}。いま何してる？`
    : band() === 'night'
      ? `おつかれ、${callName(u)}。今日はどんな一日だった？`
      : `ねぇ${callName(u)}、近況教えて？`;
  return [{ type: 'text', text: soften(fallbackLead, u) }, { type: 'text', text: quotaHint(u) }];
}

/* ========= IMAGE REPLY ========= */
function imageReplies(u) {
  const first = `わぁ、${callName(u)}の写真うれしい！`;
  return [
    { type: 'text', text: soften(first, u) },
    { type: 'text', text: quotaHint(u) }
  ];
}

/* ========= EXPRESS ========= */
const app = express();

app.get('/', (_, res) => res.status(200).send('china-bot monetized / OK'));
app.get('/health', (_, res) => res.status(200).send('OK'));

/* Stripe Webhook（署名検証のため raw 必須）— ここは json() より前に置く */
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).end();
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.warn('[stripe:webhook] verify failed', err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }

  (async () => {
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const s = event.data.object;
          const userId = s.metadata?.userId;
          const plan   = (s.metadata?.plan || 'pro').toLowerCase();
          const subId  = s.subscription || null;
          if (userId) await setPlan(userId, plan, subId);
          break;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const idx = await getIndex();
          for (const id of idx) {
            const u = await loadUser(id);
            if (u?.subId && u.subId === sub.id) await setPlan(id, 'free', null);
          }
          break;
        }
        default: console.log('[stripe:webhook]', event.type);
      }
    } catch (e) { console.error('[stripe:webhook:handler]', e); }
  })();

  res.json({ received: true });
});

// LINE webhook（※この前に express.json() を置かない）
app.post('/webhook', lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      // 日次カウント増加は成功応答の直前に行う（失敗時は増やさない）
      let out = [];
      if (e.message.type === 'text') {
        out = await routeText(u, e.message.text || '');
      } else if (e.message.type === 'image') {
        out = imageReplies(u);
      } else {
        out = [{ type: 'text', text: '送ってくれてありがとう！' }, { type: 'text', text: quotaHint(u) }];
      }

      if (out?.length) {
        await client.replyMessage(e.replyToken, out);
        // 成功したらカウント加算
        u.dailyCount = (u.dailyCount || 0) + 1;
      }
      u.turns = (u.turns || 0) + 1;
      u.lastSeenAt = now();
      await saveUser(u);
    } catch (err) {
      // OpenAI429などで返信できなかった場合も“混み合い中”のスパムを避ける
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

// ここから下は JSON でOK
app.use('/tasks', express.json());
app.use('/admin', express.json());
app.use('/billing', express.json()); // POST /billing/checkout 用

/* ========= BILLING ROUTES ========= */
// GET 版（LINEからタップ→Stripeへリダイレクト）
app.get('/billing/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).send('Stripe not configured');
    const userId = (req.query.userId || '').toString();
    const plan   = (req.query.plan || 'pro').toString();
    if (!userId) return res.status(400).send('userId required');
    const session = await createCheckoutSession({ userId, plan });
    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[billing:get]', e);
    res.status(500).send('Checkout error');
  }
});
// POST 版（管理画面等→URL返却）
app.post('/billing/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe not configured' });
    const { userId, plan = 'pro' } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    const session = await createCheckoutSession({ userId, plan });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('[billing:post]', e);
    res.status(500).json({ ok: false });
  }
});
app.get('/billing/success', (_, res) => res.status(200).send('決済に成功しました。LINEに戻って会話を続けてね！'));
app.get('/billing/cancel',  (_, res) => res.status(200).send('決済をキャンセルしました。必要になったらまた呼んでね。'));

/* ========= BROADCAST ========= */
app.all('/tasks/broadcast', async (req, res) => {
  try {
    const key = req.headers['broadcast_auth_token'];
    if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const type = (req.query.type || req.body?.type || 'random').toString();
    const pool = type === 'morning' ? SCRIPTS.morning : type === 'night' ? SCRIPTS.night : SCRIPTS.random;
    const idx = await getIndex();
    if (!idx.length) return res.json({ ok: true, sent: 0 });

    const text = pick(pool);
    const msg = [{ type: 'text', text }];
    await Promise.allSettled(idx.map(id => client.pushMessage(id, msg).catch(() => {})));
    res.json({ ok: true, type, sent: idx.length, sample: text });
  } catch (e) {
    console.error('broadcast error', e?.response?.data || e);
    res.status(500).json({ ok: false });
  }
});

/* ========= RESET ========= */
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
  if (userId) { await deleteUser(userId); return res.json({ ok: true, target: userId }); }
  const idx = await getIndex(); await Promise.allSettled(idx.map(id => deleteUser(id)));
  res.json({ ok: true, cleared: idx.length });
});

/* ========= START ========= */
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
