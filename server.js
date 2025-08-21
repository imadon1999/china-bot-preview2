// server.js — China Bot FULL v2 (429-patch + Pro/Stripe + Upstash)
// ---------------------------------------------------------------

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
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  OPENAI_API_KEY = '',
  OPENAI_MODEL = 'gpt-4o-mini',
  FREE_LIMIT_PER_DAY = '40',
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  STRIPE_PRICE_ID = '',            // あるとサブスク、空だとワンタイム
  APP_BASE_URL = '',
  PORT = 10000
} = process.env;

const FREE_CAP = Math.max(1, Number(FREE_LIMIT_PER_DAY) || 40);

/* ========= Clients ========= */
const client = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

/* ========= Storage: Upstash + Mem fallback ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 });
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash
  ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
  : null;

const STORAGE = redis ? 'upstash' : 'memory';
console.log(`[storage] mode=${STORAGE}`);

const rget = async (key, def = null) => {
  try { if (redis) { const v = await redis.get(key); return v ?? def; } }
  catch (e) { console.warn('[upstash:get] fallback', e?.message || e); }
  const v = mem.get(key); return v === undefined ? def : v;
};
const rset = async (key, val, ttlSec) => {
  try {
    if (redis) { await (ttlSec ? redis.set(key, val, { ex: ttlSec }) : redis.set(key, val)); return; }
  } catch (e) { console.warn('[upstash:set] fallback', e?.message || e); }
  mem.set(key, val, ttlSec);
};
const rdel = async (key) => {
  try { if (redis) { await redis.del(key); return; } }
  catch (e) { console.warn('[upstash:del] fallback', e?.message || e); }
  mem.del(key);
};

/* ========= Index（broadcast用） ========= */
async function getIndex() { return (await rget('user:index', [])) || []; }
async function addIndex(id) {
  const idx = await getIndex();
  if (!idx.includes(id)) { idx.push(id); await rset('user:index', idx); }
}
async function delIndex(id) {
  const idx = await getIndex(); await rset('user:index', idx.filter(x => x !== id));
}

/* ========= Users ========= */
const ukey = (id) => `user:${id}`;
async function loadUser(id) { return await rget(ukey(id), null); }
async function saveUser(u, ttlSec = 60 * 60 * 24 * 30) { await rset(ukey(u.id), u, ttlSec); }
async function deleteUser(id) { await rdel(ukey(id)); await delIndex(id); }

const now = () => Date.now();
const hr = () => new Date().getHours();
const band = () => (hr() < 5 ? 'midnight' : hr() < 12 ? 'morning' : hr() < 18 ? 'day' : 'night');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p = 0.5) => Math.random() < p;

/* ========= Intent utils ========= */
const isShota = (s = '') => /しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isGreeting = (t = '') => /(おはよ|おはよう|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);
const isSpicy = (t = '') => /(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);

/* ========= 429 対策パッチ: withBackoff（最大数秒で打ち切り） ========= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withBackoff(fn, opt = {}) {
  const maxTry   = opt.maxTry   ?? 2;      // 控えめ
  const base     = opt.base     ?? 500;    // 初期
  const maxWait  = opt.maxWait  ?? 2500;   // 1回待機上限（ここ重要）
  const maxTotal = opt.maxTotal ?? 7000;   // 合計上限（replyToken失効対策）

  const started = Date.now();
  let lastErr;

  for (let i = 0; i < maxTry; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      const headers = e?.headers || e?.response?.headers || {};
      const ra = Number(headers['retry-after']);
      const is429 = status === 429 || e?.error?.type === 'rate_limit_exceeded';
      if (!is429) throw e;

      if (ra && ra * 1000 > maxWait) break; // 長すぎるRAは即諦め

      const exp = base * Math.pow(2, i) * (0.8 + Math.random() * 0.4);
      const wait = Math.min(ra ? ra * 1000 : exp, maxWait);
      if (Date.now() - started + wait > maxTotal) break;

      console.warn(`[openai] 429 backoff ${i + 1}/${maxTry}, wait ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ========= Scripts & tone ========= */
const ENDINGS = ['。', '。', '！', '😊', '☺️', '🤍', '🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂', ' 手つなご？🤝', ' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜', ' 水分補給した？', ' 無理しすぎないでね。'];
const soften = (text, u) => {
  const end = pick(ENDINGS);
  const tail = (u?.loverMode ? pick(LOVERTAIL) : pick(NEUTRALT));
  return text.replace(/[。!?]?\s*$/, '') + end + tail;
};

const SCRIPTS = {
  morning: [
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きた？ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ！ 今日も大好きって言ってから一日始めたかったの…😊',
    'しょうた、おはよ。昨日の夢にね、しょうた出てきたんだ…えへへ',
    '終わったら“ごほうび”決めよ？アイスとか🍨',
    '“3つだけやる”作戦で行こ。他は明日に回そ',
    '深呼吸して、今日もいちばん応援してる📣'
  ],
  night: [
    'しょうた、今日もお疲れさま🌙 おやすみ前にぎゅーってしたいな',
    'おやすみ、しょうた💤 夢の中でまた会おうね',
    'まずはお水一杯のんで〜',
    'ベッドで横になって10秒だけ目つむろ？今一緒に数えるね',
    'お布団あったかい？深呼吸…すー…はー…💤'
  ],
  random: [
    'ねぇしょうた、今すぐ会いたくなっちゃった…',
    '写真1枚交換しよ📷（風景でもOK）',
    '“いまの気分”絵文字で教えて→ 😊😮‍💨🔥🫠💪',
    '水分補給チャレンジ！飲んだら「完了」って送って〜'
  ]
};

/* ========= Consent ========= */
const consentFlex = () => ({
  type: 'flex', altText: 'プライバシー同意のお願い',
  contents: {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold' },
        { type: 'text', wrap: true, size: 'sm',
          text: 'もっと自然に話すため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上だけに使い、いつでも削除OK。' }
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

function shouldShowConsent(u, text) {
  if (u.consent) return false;
  if (u.consentCardShown) return false;
  if (u.turns > 0) return false;
  if (isGreeting(text)) return false;
  return true;
}

/* ========= Free/Pro usage ========= */
const ymd = () => new Date().toISOString().slice(0,10).replace(/-/g,'');
const usageKey = (id) => `usage:${id}:${ymd()}`;
async function getUsage(id) { return Number(await rget(usageKey(id), 0)) || 0; }
async function addUsage(id, n=1) { const v = await getUsage(id) + n; await rset(usageKey(id), v, 60*60*24*2); return v; }
async function resetUsage(id) { await rdel(usageKey(id)); }

async function isPro(id) { return !!(await rget(`pro:${id}`, false)); }
async function setPro(id, flag, meta={}) {
  await rset(`pro:${id}`, !!flag);
  if (flag) await rset(`pro:meta:${id}`, meta);
  else await rdel(`pro:meta:${id}`);
}

/* ========= Pro案内 & 残り回数表示 ========= */
function remainingBubble(rem, buyUrl) {
  const title = rem > 0 ? `無料の残り回数：あと ${rem} 回` : '無料の上限に達しました';
  const note  = rem > 0 ? 'いっぱい話せて嬉しい…！' : 'このまま無制限で話す？';

  return {
    type:'flex', altText: title,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:title, weight:'bold', size:'md' }
      ]},
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'text', text: note, wrap:true },
        buyUrl ? { type:'button', style:'primary', action:{ type:'uri', label:'Proにアップグレード', uri: buyUrl }} : { type:'separator' }
      ]}
    }
  };
}

const quick = (arr) => ({ items: arr.map(t => ({ type:'action', action:{ type:'message', label:t, text:t } })) });

/* ========= User bootstrap ========= */
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
      mood: 60, lastSeenAt: now()
    };
    if (OWNER_USER_ID && id === OWNER_USER_ID) { u.consent = true; u.loverMode = true; }
    await saveUser(u);
    await addIndex(id);
  }
  return u;
}

/* ========= Safety ========= */
function safeRedirect(u) {
  const a = 'その気持ちを大事に受けとるね。';
  const b = u.loverMode ? 'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？' : 'ここではやさしい距離感で話そうね。';
  const c = '例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  return [{ type: 'text', text: a }, { type: 'text', text: b }, { type: 'text', text: c }];
}

/* ========= OpenAI chat ========= */
async function chatLLM(u, userText) {
  if (!openai) throw new Error('OpenAI disabled');
  const system = [
    'あなたは「白石ちな」。恋人感・少し照れ・健気・音楽活動を認知する一人称ボット。',
    '日本語で、優しく、相手を安心させる言い回し。句点の代わりに絵文字少し可。',
    `相手の呼び名は「${callName(u)}」を優先。`
  ].join('\n');

  const run = async () => {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.7,
      max_tokens: 220,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText }
      ]
    });
    return res.choices?.[0]?.message?.content?.trim() || 'うまく言葉が出てこなかった…もう一回だけ送ってもらえる？';
  };

  // 429-patch: 長時間待機しない
  return await withBackoff(run, { maxTry: 2, maxWait: 2500, maxTotal: 7000 });
}

/* ========= Routing ========= */
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
  if (/^プラン|^pro|^残り|^のこり/i.test(t)) return 'plan';
  return 'chit_chat';
}

async function pickNonRepeat(u, list, tag) {
  const key = `nr:${u.id}:${tag}`;
  const last = await rget(key, null);
  const candidates = list.filter(x => x !== last);
  const chosen = pick(candidates.length ? candidates : list);
  await rset(key, chosen);
  return chosen;
}

/* ========= Text handler ========= */
async function routeText(u, raw) {
  const text = (raw || '').trim();

  if (isSpicy(text)) return safeRedirect(u);

  // 同意フロー
  if (!u.consent && /^同意$/i.test(text)) {
    u.consent = true; await saveUser(u);
    return [
      { type: 'text', text: (OWNER_USER_ID && u.id === OWNER_USER_ID) ? '同意ありがとう、しょうた☺️ もっと仲良くなろ。' : '同意ありがとう！もっと仲良くなれるね☺️' },
      { type: 'text', text: '好きな呼ばれ方ある？（例：しょーたん）' }
    ];
  }
  if (!u.consent && /^やめておく$/i.test(text)) {
    return [{ type: 'text', text: 'OK。また気が向いたら声かけてね🌸' }];
  }
  if (!u.consent) {
    if (shouldShowConsent(u, text)) {
      u.consentCardShown = true; u.consentShownAt = now(); await saveUser(u);
      return [consentFlex()];
    }
    if (isGreeting(text)) {
      return [
        { type:'text', text:'お話ししよ〜☺️' },
        { type:'text', text:'記憶してもOKなら「同意」って送ってね（いつでも削除できるよ）' }
      ];
    }
    return [{ type:'text', text:'よかったら「同意」と送ってね。いつでもやめられるから安心して🌸' }];
  }

  // 名前初回設定（オーナーはスキップ）
  if (!u.name && !(OWNER_USER_ID && u.id === OWNER_USER_ID) && text.length <= 16) {
    u.name = text; if (isShota(u.name)) u.loverMode = true; await saveUser(u);
    return [{ type:'text', text:`じゃあ ${u.name} って呼ぶね！` }];
  }

  // プラン表示ショートカット
  if (intent(text) === 'plan') {
    const pro = await isPro(u.id);
    const used = await getUsage(u.id);
    const rem = pro ? '∞' : Math.max(0, FREE_CAP - used);
    const badge = pro ? 'PRO ✓' : 'FREE';
    const buyUrl = `${APP_BASE_URL}/billing/checkout?userId=${u.id}`;
    return [
      { type:'text', text:`状態: ${badge}　今日の使用: ${used}/${pro ? '∞' : FREE_CAP}` },
      remainingBubble(pro ? 999 : (FREE_CAP - used), pro ? null : buyUrl)
    ];
  }

  // 各種ハンドラ
  const kind = intent(text);
  if (kind === 'self_reset') {
    await deleteUser(u.id);
    await resetUsage(u.id);
    return [{ type:'text', text:'会話の記憶を初期化したよ！また最初から仲良くしてね☺️' }];
  }
  if (kind === 'nickname') {
    const base = (callName(u) || 'きみ').replace(/さん|くん|ちゃん/g, '').slice(0,4) || 'きみ';
    const cands = isShota(u.name)
      ? ['しょーたん','しょたぴ','しょうちゃん']
      : [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`];
    const nick = await pickNonRepeat(u, cands, 'nick');
    u.nickname = nick; await saveUser(u);
    return [{ type:'text', text:`…${nick} が可愛いと思うな。どう？` }];
  }
  if (kind === 'gender') {
    if (/女性|女/.test(text)) u.gender = 'female';
    else if (/男性|男/.test(text)) u.gender = 'male';
    await saveUser(u);
    return [{ type:'text', text:'了解だよ〜📝 メモしておくね。' }];
  }
  if (kind === 'morning') {
    const a = await pickNonRepeat(u, SCRIPTS.morning, 'morning');
    return [{ type:'text', text: soften(a, u) }];
  }
  if (kind === 'night') {
    const a = await pickNonRepeat(u, SCRIPTS.night, 'night');
    return [{ type:'text', text: soften(a, u) }];
  }
  if (kind === 'comfort') {
    const msg = (u.gender === 'female')
      ? 'わかる…その気持ち。まずは私が味方だよ。いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';
    return [{ type:'text', text: msg }];
  }
  if (kind === 'sticker') {
    return [{ type:'sticker', packageId: '11537', stickerId: pick(['52002734','52002736','52002768']) }];
  }

  // ── ここから無料枠チェック ──
  const pro = await isPro(u.id);
  const used = await getUsage(u.id);
  const remain = pro ? Infinity : Math.max(0, FREE_CAP - used);

  if (!pro && remain <= 0) {
    const buyUrl = `${APP_BASE_URL}/billing/checkout?userId=${u.id}`;
    return [
      { type:'text', text:'今日はたくさんお話できて嬉しい…！無料の上限に達しちゃったみたい。' },
      remainingBubble(0, buyUrl),
      { type:'text', text:'「Proプラン」にするとこのまま無制限で話せるよ。必要になったらいつでもで大丈夫😊' }
    ];
  }

  // OpenAI 応答（429は数秒で諦め→fallback文）
  try {
    const reply = await chatLLM(u, text);
    await addUsage(u.id, 1);
    const badge = pro ? ' PRO✓' : ` Free残り:${pro ? '∞' : (remain-1)}`;
    const tail = u.loverMode && chance(0.4) ? ' となりで小声で話したい…💭' : '';
    return [{ type:'text', text: soften(`${reply}${tail}`, u), quickReply: quick(['プラン','おはよう','おやすみ']) },
            { type:'text', text:`（ステータス: ${badge}）` }];
  } catch (e) {
    console.error('openai error', e?.status || e?.response?.status || '-', e?.message || e);
    // 速やかにフォールバック
    const buyUrl = `${APP_BASE_URL}/billing/checkout?userId=${u.id}`;
    return [
      { type:'text', text:'ちょっと混み合ってるみたい…もう一度だけ送ってくれる？' },
      !pro ? { type:'text', text:'待つより早くお話を続けたい時は、Proにするとスムーズになるよ💡' } : null,
      !pro ? remainingBubble(Math.max(0, remain), buyUrl) : null
    ].filter(Boolean);
  }
}

/* ========= Images ========= */
function imageReplies(u) {
  const first = `わぁ、${callName(u)}の写真うれしい！`;
  return [
    { type: 'text', text: soften(first, u), quickReply: quick(['ごはん','風景','自撮り']) },
    { type: 'text', text: 'どれかな？まちがってても大丈夫だよ〜' }
  ];
}

/* ========= Express ========= */
const app = express();

app.get('/', (_, res) => res.status(200).send('china-bot FULL v2 / OK'));
app.get('/health', (_, res) => res.status(200).send('OK'));

// LINE webhook（ここでは body-parser を使わない）
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
        if (out?.length) await client.replyMessage(e.replyToken, out);
      } else if (e.message.type === 'image') {
        const out = imageReplies(u);
        await client.replyMessage(e.replyToken, out);
      } else {
        await client.replyMessage(e.replyToken, { type:'text', text:'送ってくれてありがとう！' });
      }

      u.turns = (u.turns || 0) + 1;
      u.lastSeenAt = now();
      await saveUser(u);
    } catch (err) {
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

// 以降のルートは JSON OK
app.use('/tasks', express.json());
app.use('/admin', express.json());
app.use('/billing', express.json());

/* ========= Broadcast ========= */
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
    const text = pick(pool);
    const msg = [{ type:'text', text }];
    await Promise.allSettled(idx.map(id => client.pushMessage(id, msg).catch(() => {})));
    res.json({ ok:true, type, sent: idx.length, sample: text });
  } catch (e) {
    console.error('broadcast error', e?.response?.data || e);
    res.status(500).json({ ok:false });
  }
});

/* ========= Admin Reset ========= */
app.post('/reset/me', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok:false, error:'userId required' });
  await deleteUser(userId); await resetUsage(userId);
  res.json({ ok:true });
});
app.post('/admin/reset', async (req, res) => {
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if (!ADMIN_TOKEN || key !== ADMIN_TOKEN) return res.status(403).json({ ok:false });
  const { userId } = req.body || {};
  if (userId) { await deleteUser(userId); await resetUsage(userId); return res.json({ ok:true, target:userId }); }
  const idx = await getIndex(); await Promise.allSettled(idx.map(id => deleteUser(id))); res.json({ ok:true, cleared: idx.length });
});

/* ========= Billing: Checkout（動的） =========
   POST /billing/checkout?userId=LINE_USER_ID
   - STRIPE_PRICE_ID があればサブスク、なければワンタイム
*/
app.post('/billing/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok:false, error:'stripe disabled' });
    const userId = (req.query.userId || req.body?.userId || '').toString();
    if (!userId) return res.status(400).json({ ok:false, error:'userId required' });

    const success_url = `${APP_BASE_URL}/billing/success?userId=${encodeURIComponent(userId)}`;
    const cancel_url = `${APP_BASE_URL}/billing/cancel?userId=${encodeURIComponent(userId)}`;

    const session = STRIPE_PRICE_ID
      ? await stripe.checkout.sessions.create({
          mode: 'subscription',
          success_url, cancel_url,
          metadata: { userId },
          line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }]
        })
      : await stripe.checkout.sessions.create({
          mode: 'payment',
          success_url, cancel_url,
          metadata: { userId },
          line_items: [{ price_data: {
              currency: 'jpy',
              product_data: { name: 'ちなちゃん Pro（ワンタイム・デモ）' },
              unit_amount: 50000 // 500円
            }, quantity: 1 }]
        });

    res.json({ ok:true, url: session.url });
  } catch (e) {
    console.error('stripe checkout error', e);
    res.status(500).json({ ok:false });
  }
});

app.get('/billing/success', async (req, res) => {
  res.status(200).send('購入手続きありがとうございます！LINEに戻って「プラン」と送ってみてね。');
});
app.get('/billing/cancel', async (req, res) => {
  res.status(200).send('キャンセルされました。また必要になったらいつでもどうぞ。');
});

/* ========= Stripe Webhook ========= */
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).end();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('stripe webhook verify error', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const userId = s.metadata?.userId;
        if (userId) {
          await setPro(userId, true, { customer: s.customer, subscription: s.subscription });
          await resetUsage(userId); // 購入直後は気持ちよく0に
          console.log('PRO enabled:', userId);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        // サブスク終了 → Pro解除
        // どのユーザーかは pro:meta:* のcustomerを逆引きする運用でもOK（簡易実装省略）
        console.log('subscription deleted (handle mapping as needed)');
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('stripe webhook handler error', e);
    res.status(500).end();
  }
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
