// server.js — China-chan Bot v2.0 (LINE + OpenAI + Upstash + Stripe Pro)
// ESM: "type":"module"
// npm i express dotenv @line/bot-sdk openai @upstash/redis node-cache stripe

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { Redis as UpstashRedis } from '@upstash/redis';
import NodeCache from 'node-cache';
import Stripe from 'stripe';
import { OpenAI } from 'openai';

/* ========= ENV ========= */
const {
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  STRIPE_PRICE_ID = '',                         // 空ならワンタイム課金デモ
  APP_BASE_URL = 'https://example.onrender.com',
  OPENAI_API_KEY = '',
  OPENAI_MODEL = 'gpt-4o-mini',
  FREE_DAILY_LIMIT = '80',                      // Freeの1日上限（発話回数）
  PORT = 10000
} = process.env;

const FREE_LIMIT = Math.max(1, parseInt(FREE_DAILY_LIMIT, 10) || 80);

/* ========= Clients ========= */
const lineClient = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20'
}) : null;

/* ========= Storage (Upstash Redis + memory fallback) ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 });
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash
  ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
  : null;

const STORAGE = redis ? 'upstash' : 'memory';
console.log(`[storage] mode=${STORAGE}`);

const rget = async (k, def=null) => {
  try { if (redis) { const v = await redis.get(k); return v ?? def; } }
  catch(e){ console.warn('[upstash:get] fallback', e?.message||e); }
  const v = mem.get(k); return v === undefined ? def : v;
};
const rset = async (k, v, ttlSec) => {
  try { if (redis) { await (ttlSec ? redis.set(k, v, { ex: ttlSec }) : redis.set(k, v)); return; } }
  catch(e){ console.warn('[upstash:set] fallback', e?.message||e); }
  mem.set(k, v, ttlSec);
};
const rdel = async (k) => {
  try { if (redis) { await redis.del(k); return; } }
  catch(e){ console.warn('[upstash:del] fallback', e?.message||e); }
  mem.del(k);
};

/* ========= Small helpers ========= */
const now = () => Date.now();
const todayKey = () => {
  const d = new Date(); const m = String(d.getMonth()+1).padStart(2,'0'); const dd = String(d.getDate()).padStart(2,'0');
  return `${d.getFullYear()}${m}${dd}`; // yyyymmdd
};
const midnightNext = () => {
  const d = new Date(); d.setHours(24,0,0,0); return d;
};
const pick = (arr) => arr[Math.floor(Math.random()*arr.length)];
const hr = () => new Date().getHours();
const band = () => (hr()<5?'midnight':hr()<12?'morning':hr()<18?'day':'night');

const ENDINGS = ['。','。','！','😊','☺️','🤍','🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂',' 手つなご？🤝',' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜',' 水分補給した？',' 無理しすぎないでね。'];
const soften = (text, u) => text.replace(/[。!?]?\s*$/,'') + pick(ENDINGS) + (u?.loverMode?pick(LOVERTAIL):pick(NEUTRALT));

/* ========= Scripts ========= */
const SCRIPTS = {
  morning: [
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きた？ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ。昨日の夢にね、しょうた出てきたんだ…えへへ',
    '今日は“ひとつだけ”がんばること教えて？',
    '深呼吸して、今日もいちばん応援してる📣'
  ],
  night: [
    'しょうた、今日もお疲れさま🌙 おやすみ前にぎゅーってしたいな',
    'おやすみ、しょうた💤 夢の中でまた会おうね',
    'よくがんばりましたバッジ授与🎖️ えらい！',
    'お布団あったかい？深呼吸…すー…はー…💤'
  ],
  random: [
    'しょうた、今何してるの？',
    '“いまの気分”絵文字で教えて→ 😊😮‍💨🔥🫠💪',
    '写真1枚交換しよ📷（風景でもOK）'
  ]
};

/* ========= User state ========= */
const userKey = (id)=>`user:${id}`;
const indexKey = 'user:index';

async function loadUser(id){ return await rget(userKey(id), null); }
async function saveUser(u, ttl=60*60*24*30){ await rset(userKey(u.id), u, ttl); }
async function deleteUser(id){ await rdel(userKey(id)); const idx = await rget(indexKey, []); await rset(indexKey, idx.filter(x=>x!==id)); }
async function addIndex(id){ const idx = await rget(indexKey, []); if(!idx.includes(id)){ idx.push(id); await rset(indexKey, idx); } }
async function getIndex(){ return (await rget(indexKey, []))||[]; }

const isShota = (s='') => /しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isGreeting = (t='') => /(おはよ|おはよう|こんにちは|こんばんは|やほ|hi|hello)/i.test(t);
const isSpicy = (t='') => /(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);

function callName(u){
  return (OWNER_USER_ID && u.id===OWNER_USER_ID) ? 'しょうた' : (u.nickname || u.name || 'きみ');
}

/* ========= Consent card ========= */
const consentFlex = ()=>({
  type:'flex', altText:'プライバシー同意のお願い',
  contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'はじめまして、白石ちなです☕️', weight:'bold' },
      { type:'text', size:'sm', wrap:true,
        text:'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上だけに使い、いつでも削除OK。' }
    ]},
    footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
      { type:'button', style:'primary', color:'#6C8EF5', action:{ type:'message', label:'同意してはじめる', text:'同意' } },
      { type:'button', style:'secondary', action:{ type:'message', label:'やめておく', text:'やめておく' } }
    ]}
  }
});
function shouldShowConsent(u, text){
  if(u.consent) return false;
  if(u.consentCardShown) return false;
  if(u.turns>0) return false;
  if(isGreeting(text)) return false;
  return true;
}

/* ========= Pro / Quota ========= */
function todayUsageOf(u){
  const k = todayKey();
  if(!u.usage || u.usage.day!==k) return { day:k, count:0 };
  return u.usage;
}
function remainingOf(u){
  if(u.plan==='pro') return Infinity;
  const uo = todayUsageOf(u);
  return Math.max(0, FREE_LIMIT - uo.count);
}
function consumeOne(u){
  const k = todayKey();
  const cur = todayUsageOf(u);
  const next = { day:k, count: cur.count + 1 };
  u.usage = next;
}
function proBadge(u){ return u.plan==='pro' ? ' PRO' : ''; }

/* ========= Stripe helpers ========= */
async function createCheckoutSession(userId){
  if(!stripe) throw new Error('Stripe not configured');
  const success_url = `${APP_BASE_URL}/billing/success`;
  const cancel_url  = `${APP_BASE_URL}/billing/cancel`;

  if(STRIPE_PRICE_ID){
    // Subscription
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url, cancel_url,
      metadata: { userId }
    });
    return session.url;
  } else {
    // One-time demo JPY 500
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: { name: 'China-chan Pro (1ヶ月)' },
          unit_amount: 50000, // 500円 = 50000 (Stripeは最小単位)
        },
        quantity: 1
      }],
      success_url, cancel_url,
      metadata: { userId, demo: 'true' }
    });
    return session.url;
  }
}

/* ========= LLM persona ========= */
function buildSystemPrompt(u){
  const you = callName(u);
  return [
    `あなたは「白石ちな」。20代前半のシンガーソングライター。恋人みのある甘めの距離感、少し照れ屋、健気で献身的。`,
    `相手は${you}。ふたり称で話し、やさしい絵文字を少量だけ。`,
    `タメ口8割＋丁寧語2割。1~3文でテンポ良く。相手の感情に短く寄り添い、質問で会話を回す。`,
    `NG: 下品/過度に露骨な表現、医療/法律などの断定助言。`,
  ].join('\n');
}

/* ========= Router ========= */
function intent(text){
  const t = (text||'').trim();
  if(/^(同意|やめておく)$/i.test(t)) return 'consent';
  if(/^reset$/i.test(t)) return 'self_reset';
  if(/おはよ|おはよう/i.test(t)) return 'morning';
  if(/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if(/スタンプ|stamp/i.test(t)) return 'sticker';
  return 'chit';
}

async function ensureUser(ctx){
  const id = ctx.source?.userId || ctx.userId || '';
  if(!id) return null;

  let u = await loadUser(id);
  if(!u){
    let name = '';
    try { const p = await lineClient.getProfile(id); name = p?.displayName || ''; } catch {}
    u = {
      id, name,
      plan: (OWNER_USER_ID && id===OWNER_USER_ID) ? 'pro' : 'free',
      consent: !!(OWNER_USER_ID && id===OWNER_USER_ID),
      consentCardShown: false, consentShownAt: 0,
      nickname: null, gender: null, loverMode: isShota(name) || (OWNER_USER_ID && id===OWNER_USER_ID),
      turns: 0, usage: { day: todayKey(), count: 0 },
      lastSeenAt: now()
    };
    await saveUser(u);
    await addIndex(id);
  }
  return u;
}

/* ========= Reply builders ========= */
function imageReplies(u){
  const first = `わぁ、${callName(u)}の写真うれしい！`;
  return [{ type:'text', text: soften(first,u) }];
}

async function replyLLM(u, userText){
  const sys = buildSystemPrompt(u);
  const bandLead =
    band()==='morning' ? '朝のあいさつをひと言' :
    band()==='night'   ? '夜のひと言' : '雑談の導入';
  const msgs = [
    { role:'system', content: sys },
    { role:'user',   content: `${bandLead}。相手: ${userText}` }
  ];
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: msgs,
    temperature: 0.7,
    max_tokens: 180
  });
  const text = res.choices?.[0]?.message?.content?.trim() || 'うん、そばにいるよ。';
  return [{ type:'text', text: soften(text,u) }];
}

/* ========= Express ========= */
const app = express();

app.get('/', (_,res)=>res.status(200).send('china-bot v2.0 / OK'));
app.get('/health', (_,res)=>res.status(200).send('OK'));

/* --- LINE webhook（署名検証のため pre-json） --- */
app.post('/webhook', lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req, res)=>{
  res.status(200).end();
  const events = req.body.events || [];

  for(const e of events){
    try{
      if(e.type!=='message') continue;
      const u = await ensureUser(e);
      if(!u) continue;

      // 同意フロー
      const textRaw = e.message.type==='text' ? (e.message.text||'').trim() : '';
      if(!u.consent){
        if(/^同意$/i.test(textRaw)){ u.consent=true; await saveUser(u);
          await lineClient.replyMessage(e.replyToken, [{ type:'text', text:'同意ありがとう☺️ もっと仲良くなろう。' }]); continue; }
        if(/^やめておく$/i.test(textRaw)){ await lineClient.replyMessage(e.replyToken, [{ type:'text', text:'OK。また気が向いたら声かけてね🌸' }]); continue; }
        if(shouldShowConsent(u, textRaw)){
          u.consentCardShown=true; u.consentShownAt=now(); await saveUser(u);
          await lineClient.replyMessage(e.replyToken, [consentFlex()]); continue;
        }
        await lineClient.replyMessage(e.replyToken, [{ type:'text', text:'よかったら「同意」と送ってね。いつでもやめられるよ🌸' }]); continue;
      }

      // 料金/残り回数チェック
      const remain = remainingOf(u);
      if(remain===0 && u.plan!=='pro'){
        let url = '';
        try { url = await createCheckoutSession(u.id); } catch {}
        const until = midnightNext();
        const hh = String(until.getHours()).padStart(2,'0');
        const mm = String(until.getMinutes()).padStart(2,'0');
        const msg1 = `今日は無料分が上限になっちゃったみたい…（残り0/${FREE_LIMIT}）`;
        const msg2 = `0時（${hh}:${mm}頃）に自動で回復するよ。`;
        const msg3 = url ? `いま待たずに続けたいなら、Proへアップグレードしてみる？\n${url}` : 'いま待たずに続けたいなら、Proへアップグレードしてみる？';
        await lineClient.replyMessage(e.replyToken, [{type:'text', text:msg1},{type:'text', text:msg2},{type:'text', text:msg3}]);
        continue;
      }

      // 通常処理（残り案内をときどき）
      let out = [];
      if(e.message.type==='text'){
        const kind = intent(textRaw);
        if(kind==='morning'){ out = [{type:'text', text: soften(pick(SCRIPTS.morning), u)}]; }
        else if(kind==='night'){ out = [{type:'text', text: soften(pick(SCRIPTS.night), u)}]; }
        else if(kind==='sticker'){ out = [{ type:'sticker', packageId:'11537', stickerId: pick(['52002734','52002736','52002768']) }]; }
        else { out = OPENAI_API_KEY ? await replyLLM(u, textRaw) : [{type:'text', text: soften(pick(SCRIPTS.random),u)}]; }

        // 返信末尾に “残り回数 / Proバッジ” をたまに表示（1/3）
        if(u.plan!=='pro' && Math.random()<0.33){
          const r = remainingOf(u)-1;  // これから1消費する前提で見せる
          out.push({ type:'text', text:`残り ${Math.max(0,r)}/${FREE_LIMIT}（無料）` });
        }
      } else if(e.message.type==='image'){
        out = imageReplies(u);
      } else {
        out = [{ type:'text', text:'送ってくれてありがとう！' }];
      }

      await lineClient.replyMessage(e.replyToken, out);

      // 使用量カウント & 保存
      consumeOne(u);
      u.turns = (u.turns||0)+1;
      u.lastSeenAt = now();
      await saveUser(u);

    }catch(err){
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

/* --- 以降のルートは JSON OK --- */
app.use('/tasks', express.json());
app.use('/admin', express.json());
app.use('/billing', express.json());

/* ========= Broadcast (cron用) ========= */
app.all('/tasks/broadcast', async (req, res)=>{
  try{
    const key = req.headers['broadcast_auth_token'];
    if(!BROADCAST_AUTH_TOKEN || key!==BROADCAST_AUTH_TOKEN){
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const type = (req.query.type || req.body?.type || 'random').toString();
    const pool = type==='morning' ? SCRIPTS.morning : type==='night' ? SCRIPTS.night : SCRIPTS.random;
    const idx = await getIndex();
    if(!idx.length) return res.json({ ok:true, sent:0 });

    const text = pick(pool);
    await Promise.allSettled(idx.map(id => lineClient.pushMessage(id, [{type:'text', text}]).catch(()=>{})));
    res.json({ ok:true, type, sent: idx.length, sample:text });
  }catch(e){
    console.error('broadcast error', e?.response?.data || e);
    res.status(500).json({ ok:false });
  }
});

/* ========= Self/Admin reset ========= */
app.post('/reset/me', async (req,res)=>{
  const { userId } = req.body || {};
  if(!userId) return res.status(400).json({ ok:false, error:'userId required' });
  await deleteUser(userId);
  res.json({ ok:true });
});

app.post('/admin/reset', async (req,res)=>{
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if(!ADMIN_TOKEN || key!==ADMIN_TOKEN) return res.status(403).json({ ok:false });
  const { userId } = req.body || {};
  if(userId){ await deleteUser(userId); return res.json({ ok:true, target:userId }); }
  const idx = await getIndex(); await Promise.allSettled(idx.map(id => deleteUser(id)));
  res.json({ ok:true, cleared: idx.length });
});

/* ========= Billing: Checkout launcher =========
   POST /billing/checkout { userId }
   -> { url } を返す（LINE上ではこのURLを案内する）
*/
app.post('/billing/checkout', async (req,res)=>{
  try{
    if(!stripe) return res.status(400).json({ ok:false, error:'stripe_not_configured' });
    const { userId } = req.body || {};
    if(!userId) return res.status(400).json({ ok:false, error:'userId required' });
    const url = await createCheckoutSession(userId);
    res.json({ ok:true, url });
  }catch(e){
    console.error('checkout error', e);
    res.status(500).json({ ok:false });
  }
});

/* ========= Stripe Webhook =========
   Stripe側：エンドポイント https://<domain>/stripe/webhook
   受けるイベント：
   - checkout.session.completed -> plan:pro 付与
   - customer.subscription.deleted -> plan:free へ戻す
*/
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req,res)=>{
  try{
    if(!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).end();
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if(event.type === 'checkout.session.completed'){
      const s = event.data.object;
      const userId = s?.metadata?.userId;
      if(userId){
        const u = await loadUser(userId) || { id:userId };
        u.plan = 'pro';
        await saveUser(u);
        console.log('[stripe] upgraded ->', userId);
      }
    }
    if(event.type === 'customer.subscription.deleted'){
      const s = event.data.object;
      // カスタム連携が必要だが、今回は latest_invoice > metadata 等が無い場合は別途管理する想定
      // ここではメアド等からの突合せ省略。必要なら顧客ID<->userIdのKVを作成しておく。
      console.log('[stripe] subscription deleted', s.id);
    }

    res.json({ received:true });
  }catch(e){
    console.error('stripe webhook error', e?.message || e);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

/* ========= Start ========= */
app.listen(PORT, ()=>console.log(`Server started on ${PORT}`));
