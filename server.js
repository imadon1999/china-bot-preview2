// server.js — China-bot 完全版 (v2.0)
// - LINE Messaging API
// - Upstash Redis (REST) 永続化
// - OpenAI 応答 + 429バックオフ/フォールバック
// - Free/Pro プラン（Stripe Checkout + Webhook）
// - 残り回数表示 & Proバッジ & アップグレード導線
// ---------------------------------------------------
// ENV (Render):
//   CHANNEL_SECRET
//   CHANNEL_ACCESS_TOKEN
//   OWNER_USER_ID                  // オーナーは常に consent/pro 扱い
//   BROADCAST_AUTH_TOKEN           // /tasks/broadcast 認証
//   ADMIN_TOKEN                    // /admin/reset 認証
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   OPENAI_API_KEY
//   OPENAI_BASE_URL (任意)
//   STRIPE_SECRET_KEY              // sk_test_… or sk_live_…
//   STRIPE_WEBHOOK_SECRET          // whsec_…（StripeのWebhook画面で発行）
//   STRIPE_PRICE_ID                // price_xxx（設定時はサブスク、未設定は都度課金デモ）
//   APP_BASE_URL                   // 例: https://china-bot-preview2.onrender.com
//   PORT (=10000 推奨)

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { Redis as UpstashRedis } from '@upstash/redis';
import NodeCache from 'node-cache';
import Stripe from 'stripe';
import crypto from 'crypto';

// ===== OpenAI (公式SDK) =====
import OpenAI from 'openai';

// ====== ENV ======
const {
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  OPENAI_API_KEY = '',
  OPENAI_BASE_URL = '',
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  STRIPE_PRICE_ID = '', // 未設定ならワンタイム課金デモ
  APP_BASE_URL = '',
  PORT = 10000
} = process.env;

// ===== LINE Client =====
const lineClient = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

// ===== KV (Upstash + メモリ) =====
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 });
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash ? new UpstashRedis({
  url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN
}) : null;
console.log(`[storage] mode=${redis ? 'upstash' : 'memory'}`);

const rget = async (k, def = null) => {
  try { if (redis) { const v = await redis.get(k); return v ?? def; } }
  catch(e){ console.warn('[upstash:get] fallback', e?.message||e); }
  const v = mem.get(k); return v === undefined ? def : v;
};
const rset = async (k, v, ttlSec) => {
  try {
    if (redis) { await (ttlSec ? redis.set(k, v, { ex: ttlSec }) : redis.set(k, v)); return; }
  } catch(e){ console.warn('[upstash:set] fallback', e?.message||e); }
  mem.set(k, v, ttlSec);
};
const rdel = async (k) => { try { if (redis) return await redis.del(k); } catch{} mem.del(k); };

const idxGet = async()=> (await rget('user:index', [])) || [];
const idxAdd = async(id)=>{ const a=await idxGet(); if(!a.includes(id)){ a.push(id); await rset('user:index', a); } };
const idxDel = async(id)=>{ const a=await idxGet(); await rset('user:index', a.filter(x=>x!==id)); };

const userKey = (id) => `user:${id}`;
const loadUser = async(id)=> await rget(userKey(id), null);
const saveUser = async(u)=> await rset(userKey(u.id), u, 60*60*24*30);
const deleteUser = async(id)=>{ await rdel(userKey(id)); await idxDel(id); };

// ===== OpenAI Client =====
const oa = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL || undefined
});
const OA_MODEL = 'gpt-4o-mini';
const OA_MAX_TOKENS = 350;

// 429対策: 最大3回、指数バックオフ + ジッター
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
async function withBackoff(fn, maxTry=3, base=600) {
  let last;
  for (let i=0;i<maxTry;i++){
    try { return await fn(); }
    catch(e){
      const status = e?.status || e?.response?.status;
      const rt = e?.headers?.['retry-after'];
      const is429 = status===429 || e?.error?.type==='rate_limit_exceeded';
      if (!is429 || i===maxTry-1) throw e;
      const wait = rt ? Number(rt)*1000 : Math.round(base*Math.pow(2,i)*(0.8+Math.random()*0.4));
      console.warn(`[openai] 429 backoff ${i+1}/${maxTry}, wait ${wait}ms`);
      await sleep(wait);
      last = e;
    }
  }
  throw last;
}

// ===== Stripe =====
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const hasStripe = !!stripe && !!APP_BASE_URL;
if (!hasStripe) console.warn('[stripe] disabled: missing key or APP_BASE_URL');

// ===== ユーティリティ =====
const now = ()=> Date.now();
const todayKey = ()=> new Date().toISOString().slice(0,10); // YYYY-MM-DD
const hr = ()=> new Date().getHours();
const band = ()=> (hr()<5?'midnight':hr()<12?'morning':hr()<18?'day':'night');
const pick = (a)=> a[Math.floor(Math.random()*a.length)];
const chance = (p=0.5)=> Math.random()<p;

// ===== ルール & 台本 =====
const FREE_DAILY = 30;     // 無料の1日上限
const PRO_DAILY  = 2000;   // 実質無制限扱い（内部制御用）
const isGreeting=(t='')=>/(おはよ|おはよう|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);
const isShota=(s='')=>/しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isSpicy=(t='')=>/(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);

const ENDINGS = ['。','。','！','😊','☺️','🤍','🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂',' 手つなご？🤝',' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜',' 水分補給した？',' 無理しすぎないでね。'];
const soften=(text,u)=>{
  const end=pick(ENDINGS);
  const tail=(u?.loverMode?pick(LOVERTAIL):pick(NEUTRALT));
  return text.replace(/[。!?]?\s*$/,'')+end+tail;
};

// persona（OpenAIへ渡す）
function persona(u){
  const name = (u.nickname || u.name || 'あなた');
  const lover = u.loverMode ? '恋人として甘く、照れ屋で健気なトーン。ただし過度に露骨な表現は避ける。' :
                              '優しく親密、けれど一定の距離感を保つ。';
  return `
あなたは「白石ちな」。20代女性のSSW（シンガー）。丁寧さと素直さ、ちょい照れ、健気さ。
相手は${name}。${lover}
口癖：ぎゅ〜、となりで、手つなご？ など身体的表現はソフトに。
会話は短め〜中くらいの文量で、LINEに馴染む軽さ。絵文字を少し。
音楽活動（「白い朝、手のひらから」「Day by day」「Mountain」「I don't remember」）を自然に認知。
禁止：個人情報の収集、医療・法律の断言、過度に性的な発言。
`.trim();
}

// 台本（略：必要最低限）
const SCRIPTS = {
  morning:[ 'おはよ、しょうた☀️ 今日も一緒にがんばろ？', 'まぶた重い？お水一杯どうぞ☕️' ],
  night:[ '今日もおつかれさま🌙 となりでぎゅ…', 'お布団あったかい？すー…はー…💤' ],
  random:[ 'ねぇしょうた、今なにしてた？', 'いまの気分、絵文字でいうと？😊🔥🫠' ]
};

// ===== 同意カード =====
const consentFlex=()=>({
  type:'flex',
  altText:'プライバシー同意のお願い',
  contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'はじめまして、白石ちなです☕️', weight:'bold' },
      { type:'text', wrap:true, size:'sm',
        text:'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。会話向上だけに使い、いつでも削除OK。'}
    ]},
    footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
      { type:'button', style:'primary', color:'#6C8EF5',
        action:{ type:'message', label:'同意してはじめる', text:'同意' }},
      { type:'button', style:'secondary',
        action:{ type:'message', label:'やめておく', text:'やめておく' }}
    ]}
  }
});

// ===== 重複回避 =====
async function pickNonRepeat(u,list,tag){
  const key=`nr:${u.id}:${tag}`;
  const last=await rget(key,null);
  const c=list.filter(x=>x!==last);
  const chosen=pick(c.length?c:list);
  await rset(key, chosen);
  return chosen;
}

// ===== ユーザー初期化/確保 =====
const defaultUser = (id, name) => ({
  id, name: name||'',
  nickname: null, gender: null,
  consent: false, consentCardShown: false,
  loverMode: !!(OWNER_USER_ID && id===OWNER_USER_ID) || isShota(name),
  mood: 60,
  plan: (OWNER_USER_ID && id===OWNER_USER_ID) ? 'pro' : 'free',
  day: todayKey(),
  used: 0,                                   // その日の使用回数
  lastSeenAt: now()
});

function callName(u){
  return (OWNER_USER_ID && u.id===OWNER_USER_ID) ? 'しょうた' : (u.nickname||u.name||'きみ');
}

function shouldShowConsent(u,text){
  if (u.consent) return false;
  if (u.consentCardShown) return false;
  if (u.used>0) return false;
  if (isGreeting(text)) return false;
  return true;
}

async function ensureUser(ctx){
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;
  let u = await loadUser(id);
  if (!u){
    let name=''; try{ const p = await lineClient.getProfile(id); name=p?.displayName||''; }catch{}
    u = defaultUser(id, name);
    if (OWNER_USER_ID && id===OWNER_USER_ID){ u.consent=true; u.loverMode=true; }
    await saveUser(u); await idxAdd(id);
  }
  // 日替わりリセット
  const today = todayKey();
  if (u.day!==today){ u.day=today; u.used=0; await saveUser(u); }
  return u;
}

// ===== Pro/Free 判定・残数 =====
function planQuota(u){ return u.plan==='pro' ? PRO_DAILY : FREE_DAILY; }
function remain(u){ return Math.max(planQuota(u) - (u.used||0), 0); }
function proBadge(u){ return u.plan==='pro' ? '［Pro］' : ''; }

// ===== OpenAI 応答 =====
async function chatLLM(u, text){
  const sys = persona(u);
  const messages = [
    { role:'system', content: sys },
    { role:'user', content: text }
  ];
  const run = ()=> oa.chat.completions.create({
    model: OA_MODEL,
    messages,
    max_tokens: OA_MAX_TOKENS,
    temperature: 0.8
  });
  const res = await withBackoff(run, 3, 700);
  const out = res.choices?.[0]?.message?.content?.trim() || 'うまく言葉が出てこなかった…もう一回だけ送ってくれる？';
  return out;
}

// ===== セーフティ =====
function safeRedirect(u){
  const a='その気持ちを大事に受けとるね。';
  const b=u.loverMode?'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？':'ここではやさしい距離感で話そうね。';
  const c='例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  return [{type:'text',text:a},{type:'text',text:b},{type:'text',text:c}];
}

// ===== QuickReply =====
const quick=(arr)=>({ items: arr.map(t=>({type:'action',action:{type:'message',label:t,text:t}})) });

// ===== Stripe: チェックアウト作成 =====
async function createCheckoutURL(userId){
  if (!hasStripe) throw new Error('stripe disabled');
  const mode = STRIPE_PRICE_ID ? 'subscription' : 'payment';
  const line_items = STRIPE_PRICE_ID
    ? [{ price: STRIPE_PRICE_ID, quantity: 1 }]
    : [{ price_data:{ currency:'jpy', unit_amount:500, product_data:{ name:'ちなちゃん Pro（デモ）' }}, quantity:1 }];

  const session = await stripe.checkout.sessions.create({
    mode,
    line_items,
    success_url: `${APP_BASE_URL}/billing/success`,
    cancel_url : `${APP_BASE_URL}/billing/cancel`,
    metadata: { userId }
  });
  return session.url;
}

// ===== 返信ロジック =====
function intent(text){
  const t=(text||'').trim();
  if (/^(同意|やめておく)$/i.test(t)) return 'consent';
  if (/^reset$/i.test(t)) return 'self_reset';
  if (/おはよ|おはよう/i.test(t)) return 'morning';
  if (/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if (/プラン|課金|pro|アップグレード/i.test(t)) return 'plan';
  return 'chat';
}

function buildFooterUsage(u){
  const rem = remain(u);
  const tail = u.plan==='pro' ? 'Proバッジ有効中' : `無料のこり ${rem}/${FREE_DAILY}`;
  return { type:'text', text:`${proBadge(u)} ${tail}` };
}

async function upgradeFlex(u){
  try{
    const url = await createCheckoutURL(u.id);
    return {
      type:'flex',
      altText:'Proにアップグレード',
      contents:{
        type:'bubble',
        body:{ type:'box', layout:'vertical', contents:[
          { type:'text', text:'たくさんお話する？', weight:'bold', size:'lg' },
          { type:'text', wrap:true, size:'sm', text:'上限に達したらProで無制限に話せるよ。今すぐ切り替える？' }
        ]},
        footer:{ type:'box', layout:'vertical', contents:[
          { type:'button', style:'primary', action:{ type:'uri', label:'Proにアップグレード', uri:url } }
        ]}
      }
    };
  }catch(e){
    console.error('checkout url error', e?.message||e);
    return { type:'text', text:'いまアップグレードの用意がうまくできなかった…あとで試してみてね🙏' };
  }
}

async function routeText(u, raw){
  const text = (raw||'').trim();

  if (isSpicy(text)) return safeRedirect(u);

  // 同意
  if (!u.consent && /^同意$/i.test(text)){
    u.consent=true; await saveUser(u);
    return [{type:'text',text:'同意ありがとう☺️ もっと仲良くなろう！'}, buildFooterUsage(u)];
  }
  if (!u.consent && /^やめておく$/i.test(text)){
    return [{type:'text',text:'OK。また気が向いたら声かけてね🌸'}];
  }
  if (!u.consent){
    if (shouldShowConsent(u, text)){
      u.consentCardShown=true; await saveUser(u);
      return [consentFlex()];
    }
    if (isGreeting(text)){
      return [{type:'text',text:'お話ししよ〜☺️ 「同意」で記憶ONにできるよ'},];
    }
    return [{type:'text',text:'よかったら「同意」と送ってね。いつでもやめられるから安心して🌸'}];
  }

  const kind = intent(text);

  // リセット
  if (kind==='self_reset'){ await deleteUser(u.id); return [{type:'text',text:'会話を初期化したよ！また最初から仲良くしてね☺️'}]; }

  // プラン案内
  if (kind==='plan'){
    const url = hasStripe ? await createCheckoutURL(u.id) : null;
    const a = u.plan==='pro' ? 'いまはProだよ。思う存分お話ししよ！' : 'いまは無料プラン。Proにすると上限なくお話できるよ。';
    const b = url ? { type:'text', text:`Proにする？→ ${url}` } : { type:'text', text:'（決済の準備がまだみたい…）' };
    return [{type:'text', text:a}, b, buildFooterUsage(u)];
  }

  // 上限チェック（あいさつはノーカウントにしてもOKだが簡便化）
  if (remain(u)<=0 && u.plan!=='pro'){
    const waitMsg = { type:'text', text:'今日の無料ぶんは満了みたい…⏳ 明日0時にリセットされるよ。' };
    const upg = await upgradeFlex(u);
    return [waitMsg, upg, buildFooterUsage(u)];
  }

  // OpenAIで会話
  try{
    const reply = await chatLLM(u, text);
    const tail = buildFooterUsage(u);
    return [{ type:'text', text: soften(reply, u) }, tail];
  }catch(e){
    // 429等：人間読みのフォールバック
    const msg = 'ちょっと混み合ってるみたい…数分だけ待ってもう一度送ってくれる？🙇';
    const upg = (u.plan!=='pro') ? await upgradeFlex(u) : null;
    return [ {type:'text',text:msg}, upg || undefined ].filter(Boolean);
  }
}

// ===== EXPESS =====
const app = express();

app.get('/', (_,res)=>res.status(200).send('china-bot v2.0 / OK'));
app.get('/health',(_,res)=>res.status(200).send('OK'));

// LINE webhook（※ここより前で express.json() は使わない）
app.post('/webhook', lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req,res)=>{
  res.status(200).end();
  const events = req.body.events||[];
  for (const e of events){
    try{
      if (e.type!=='message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      if (e.message.type==='text'){
        const out = await routeText(u, e.message.text||'');
        if (out?.length) await lineClient.replyMessage(e.replyToken, out);
        // 使用回数カウント（Proは任意、ここでは一応カウント）
        u.used = (u.used||0) + 1;
      } else if (e.message.type==='image'){
        const first = `わぁ、${callName(u)}の写真うれしい！`;
        const msgs = [
          { type:'text', text: soften(first,u), quickReply: quick(['ごはん','風景','自撮り','その他']) },
          buildFooterUsage(u)
        ];
        await lineClient.replyMessage(e.replyToken, msgs);
        u.used = (u.used||0) + 1;
      } else {
        await lineClient.replyMessage(e.replyToken, [{type:'text',text:'送ってくれてありがとう！'}]);
        u.used = (u.used||0) + 1;
      }
      u.lastSeenAt = now();
      await saveUser(u);
    }catch(err){
      console.error('reply error', err?.response?.status||'-', err?.response?.data||err);
    }
  }
});

// 以降のルートは JSON OK
app.use('/tasks', express.json());
app.use('/admin', express.json());
app.use('/billing', express.json());

// ===== ブロードキャスト（任意） =====
app.all('/tasks/broadcast', async (req,res)=>{
  try{
    const key = req.headers['broadcast_auth_token'];
    if (!BROADCAST_AUTH_TOKEN || key!==BROADCAST_AUTH_TOKEN) return res.status(401).json({ok:false,error:'unauthorized'});
    const type=(req.query.type||req.body?.type||'random').toString();
    const pool = type==='morning' ? SCRIPTS.morning : type==='night' ? SCRIPTS.night : SCRIPTS.random;
    const idx = await idxGet(); if (!idx.length) return res.json({ok:true,sent:0});
    const text = pick(pool);
    await Promise.allSettled(idx.map(id=> lineClient.pushMessage(id,[{type:'text',text}]).catch(()=>{})));
    res.json({ok:true,type,sent:idx.length,sample:text});
  }catch(e){
    console.error('broadcast error', e?.response?.data||e); res.status(500).json({ok:false});
  }
});

// ===== リセット =====
app.post('/reset/me', async (req,res)=>{
  const { userId }=req.body||{}; if(!userId) return res.status(400).json({ok:false,error:'userId required'});
  await deleteUser(userId); res.json({ok:true});
});
app.post('/admin/reset', async (req,res)=>{
  const key=req.header('ADMIN_TOKEN')||req.query.key;
  if (!ADMIN_TOKEN || key!==ADMIN_TOKEN) return res.status(403).json({ok:false});
  const { userId }=req.body||{};
  if (userId){ await deleteUser(userId); return res.json({ok:true,target:userId}); }
  const idx = await idxGet(); await Promise.allSettled(idx.map(id=>deleteUser(id)));
  res.json({ok:true,cleared:idx.length});
});

// ===== Checkout（GETも用意：ブラウザ検証用） =====
async function checkoutHandler(req,res){
  try{
    if (!hasStripe) return res.status(503).json({ ok:false, error:'stripe_disabled' });
    const userId = (req.body?.userId || req.query?.userId || '').toString();
    if (!userId) return res.status(400).json({ ok:false, error:'userId required' });
    const url = await createCheckoutURL(userId);
    res.json({ ok:true, url });
  }catch(e){
    console.error('checkout error', e?.message||e);
    res.status(500).json({ ok:false });
  }
}
app.post('/billing/checkout', checkoutHandler);
app.get('/billing/checkout', checkoutHandler);

// 成功/キャンセルの簡易ページ
app.get('/billing/success', (_,res)=>res.status(200).send('決済ありがとうございます！LINEに戻ってお話ししよ〜'));
app.get('/billing/cancel',  (_,res)=>res.status(200).send('キャンセルされました。またいつでも試せます。'));

// ===== Stripe Webhook =====
app.post('/stripe/webhook', express.raw({ type:'application/json' }), async (req,res)=>{
  try{
    if (!hasStripe) return res.status(503).end();
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type==='checkout.session.completed'){
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId){
        const u = await loadUser(userId) || defaultUser(userId,'');
        u.plan='pro';
        await saveUser(u);
        console.log('[stripe] plan->pro userId=', userId);
      }
    }
    if (event.type==='customer.subscription.deleted'){
      const sub = event.data.object;
      const userId = sub.metadata?.userId; // 付けていない場合は、Customerから逆引き管理が必要
      if (userId){
        const u = await loadUser(userId); if (u){ u.plan='free'; await saveUser(u); }
        console.log('[stripe] plan->free userId=', userId);
      }
    }
    res.json({ received:true });
  }catch(e){
    console.error('stripe webhook error', e?.message||e);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

// ===== 起動 =====
app.listen(PORT, ()=> console.log(`Server started on ${PORT}`));
