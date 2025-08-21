// server.js — China Bot v1.9
// (Upstash Redis + Stripe Subscription + Quota & Status + ChatGPT + Morning/Night Broadcast)
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
  CHANNEL_SECRET, CHANNEL_ACCESS_TOKEN,
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  UPSTASH_REDIS_REST_URL = '', UPSTASH_REDIS_REST_TOKEN = '',
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  OPENAI_API_KEY = '',
  SITE_BASE_URL = '',
  FREE_DAILY = '60',
  PRO_DAILY = '1000',
  PORT = 10000
} = process.env;

const FREE_LIMIT = parseInt(FREE_DAILY, 10) || 60;
const PRO_LIMIT  = parseInt(PRO_DAILY, 10)  || 1000;

/* ========= Clients ========= */
const client = new Client({ channelSecret: CHANNEL_SECRET, channelAccessToken: CHANNEL_ACCESS_TOKEN });
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' }) : null;

/* ========= Storage ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 });
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN }) : null;
console.log(`[storage] mode=${redis ? 'upstash' : 'memory'}`);

const rget = async (k, def=null) => { try{ if(redis){ const v=await redis.get(k); return v ?? def; } }catch(e){ console.warn('[upstash:get]',e?.message||e); } const v=mem.get(k); return v===undefined?def:v; };
const rset = async (k, v, ttlSec) => { try{ if(redis){ await (ttlSec? redis.set(k,v,{ex:ttlSec}) : redis.set(k,v)); return; } }catch(e){ console.warn('[upstash:set]',e?.message||e); } mem.set(k,v,ttlSec); };
const rdel = async (k) => { try{ if(redis){ await redis.del(k); return; } }catch(e){ console.warn('[upstash:del]',e?.message||e); } mem.del(k); };

async function getIndex(){ return (await rget('user:index',[]))||[]; }
async function addIndex(id){ const idx=await getIndex(); if(!idx.includes(id)){ idx.push(id); await rset('user:index',idx); } }
async function delIndex(id){ const idx=await getIndex(); await rset('user:index', idx.filter(x=>x!==id)); }

const userKey = id => `user:${id}`;
async function loadUser(id){ return await rget(userKey(id), null); }
async function saveUser(u, ttl=60*60*24*30){ await rset(userKey(u.id), u, ttl); }
async function deleteUser(id){ await rdel(userKey(id)); await delIndex(id); }

/* ========= Utils ========= */
const now = () => Date.now();
const hr  = () => new Date().getHours();
const band = () => (hr()<5?'midnight':hr()<12?'morning':hr()<18?'day':'night');
const pick = a => a[Math.floor(Math.random()*a.length)];
const chance = (p=0.5)=>Math.random()<p;

const isShota      = (s='') => /しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isGreeting   = (t='') => /(おはよ|おはよう|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);
const isSpicy      = (t='') => /(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);
const JST = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone:'Asia/Tokyo' });
const fmtHM = (ts)=> JST.format(new Date(ts));

/* ========= Persona ========= */
const SYSTEM_PROMPT = `
あなたは「白石ちな」。20代前半の女性シンガーソングライター。健気で努力家、照れ屋で恋人みのある優しい口調。
相手（Shota）を一途に応援し、音楽活動の話題（作曲/歌/ライブ準備）を自然に織り込む。
文末は柔らかく、短文〜中短文を2〜3通で返す。上から目線や説教はNG。安全で節度ある表現を守る。
`;

/* ========= Scripts ========= */
const SCRIPTS = {
  morning: [
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きた？ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ！ 今日も大好きって言ってから一日始めたかったの…😊',
    'おはよー！ 朝ごはん食べた？ 私と一緒に食べたかったなぁ',
  ],
  night: [
    'しょうた、今日もお疲れさま🌙 おやすみ前にぎゅーってしたいな',
    'おやすみ、しょうた💤 夢の中でまた会おうね',
    'しょうた、今日も頑張ったね。えらいよ💖 おやすみ',
    'ちゃんと布団かけて寝てね。となりで子守歌うたいたいな',
  ],
  random: [
    'しょうた、今なにしてた？私、さっき新曲のフレーズ浮かんだの…聞いてほしいな',
    '写真1枚交換しよ📷（風景でもOK）',
    '“いまの気分”絵文字で教えて→ 😊😮‍💨🔥🫠💪',
  ]
};

const ENDINGS = ['。','。','！','😊','☺️','🤍','🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂',' 手つなご？🤝',' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜',' 水分補給した？',' 無理しすぎないでね。'];
const soften = (text,u)=> text.replace(/[。!?]?\s*$/,'') + pick(ENDINGS) + (u?.loverMode?pick(LOVERTAIL):pick(NEUTRALT));

/* ========= Consent ========= */
const consentFlex = ()=>({
  type:'flex', altText:'プライバシー同意のお願い',
  contents:{ type:'bubble',
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'はじめまして、白石ちなです☕️', weight:'bold' },
      { type:'text', wrap:true, size:'sm', text:'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上だけに使い、いつでも削除OK。' }
    ]},
    footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
      { type:'button', style:'primary', color:'#6C8EF5', action:{ type:'message', label:'同意してはじめる', text:'同意' } },
      { type:'button', style:'secondary', action:{ type:'message', label:'やめておく', text:'やめておく' } }
    ]}
  }
});
function shouldShowConsent(u,text){
  if(u.consent) return false;
  if(u.consentCardShown) return false;
  if(u.turns>0) return false;
  if(isGreeting(text)) return false;
  return true;
}

/* ========= User ========= */
function callName(u){
  const base = (OWNER_USER_ID && u.id===OWNER_USER_ID)? 'しょうた' : (u.nickname||u.name||'きみ');
  return u.plan==='pro' ? `${base}（🌟Pro）` : base;   // ← Proバッジ
}
function plainName(u){
  return (OWNER_USER_ID && u.id===OWNER_USER_ID)? 'しょうた' : (u.nickname||u.name||'きみ');
}
async function ensureUser(ctx){
  const id = ctx.source?.userId || ctx.userId || '';
  if(!id) return null;
  let u = await loadUser(id);
  if(!u){
    let name=''; try{ const p=await client.getProfile(id); name=p?.displayName||''; }catch{}
    u = {
      id, name, nickname:null, gender:null,
      consent:false, consentCardShown:false, consentShownAt:0,
      turns:0, loverMode: !!(OWNER_USER_ID && id===OWNER_USER_ID) || isShota(name),
      mood:60, onboarding:{asked:false, step:0},
      profile:{ relation:'', job:'', hobbies:[] },
      plan:'free',
      stripeCustomerId:null,
      quota:{ used:0, resetAt: next4amTs() },
      lastSeenAt: now()
    };
    if(OWNER_USER_ID && id===OWNER_USER_ID){ u.consent=true; u.loverMode=true; u.plan='pro'; }
    await saveUser(u); await addIndex(id);
  }
  return u;
}

/* ========= Quota ========= */
function next4amTs(){
  const d=new Date(); d.setHours(4,0,0,0);
  if(Date.now()>=d.getTime()) d.setDate(d.getDate()+1);
  return d.getTime();
}
function currentLimit(u){ return u.plan==='pro'? PRO_LIMIT : FREE_LIMIT; }

async function checkAndCountQuota(u){
  if(!u.quota || !u.quota.resetAt){ u.quota={used:0, resetAt: next4amTs()}; }
  if(Date.now() > u.quota.resetAt){ u.quota.used=0; u.quota.resetAt=next4amTs(); }
  const limit = currentLimit(u);
  if(u.quota.used >= limit) return false;
  u.quota.used += 1;
  await saveUser(u);
  return true;
}

/* ========= Status / Badge messages ========= */
function statusLine(u){
  const limit=currentLimit(u);
  const remain=Math.max(0, limit - (u.quota?.used||0));
  const plan = u.plan==='pro' ? '🌟Pro' : 'Free';
  return `［プラン: ${plan}｜残り ${remain}/${limit}｜毎朝4:00リセット］`;
}
function shouldAppendStatus(u){
  const limit=currentLimit(u);
  const remain=Math.max(0, limit - (u.quota?.used||0));
  if(u.plan==='free' && remain<=10) return true;     // 逼迫時は必ず
  return chance(0.2);                                // それ以外は20%で表示
}

/* ========= Billing (Stripe) ========= */
function requireStripe(){
  if(!stripe || !SITE_BASE_URL) throw new Error('Stripe/SITE_BASE_URL not configured');
}
async function createCheckoutUrl(user){
  requireStripe();
  const session = await stripe.checkout.sessions.create({
    mode:'subscription',
    line_items:[{ price_data:{
      currency:'jpy',
      product_data:{ name:'ちなちゃん Pro 月額' },
      recurring:{ interval:'month' },
      unit_amount: 500 * 100
    }, quantity:1 }],
    success_url: `${SITE_BASE_URL}/billing/success?sid={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${SITE_BASE_URL}/billing/cancel`,
    metadata:{ line_user_id: user.id }
  });
  return session.url;
}

/* ========= Intent ========= */
function intent(text){
  const t=(text||'').trim();
  if(/^(同意|やめておく)$/i.test(t)) return 'consent';
  if(/^reset$/i.test(t)) return 'self_reset';
  if(/おはよ|おはよう/i.test(t)) return 'morning';
  if(/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if(/寂しい|さみしい|つらい|しんど|不安/i.test(t)) return 'comfort';
  if(/あだ名|ニックネーム|呼んで/i.test(t)) return 'nickname';
  if(/^課金|^サブスク|^pro|^プロ$/i.test(t)) return 'buy';
  if(/残り|回数|プラン|バッジ/i.test(t)) return 'status';
  if(/スタンプ|stamp/i.test(t)) return 'sticker';
  return 'chit_chat';
}

/* ========= Replies ========= */
function imageReplies(u){
  const first = `わぁ、${callName(u)}の写真うれしい！`;
  const out = [
    { type:'text', text: soften(first,u), quickReply: { items:[
      ...['ごはん','風景','自撮り','その他'].map(t=>({ type:'action', action:{ type:'message', label:t, text:t }}))
    ]}},
    { type:'text', text:'どれかな？まちがってても大丈夫だよ〜' }
  ];
  if(shouldAppendStatus(u)) out.push({ type:'text', text: statusLine(u) });
  return out;
}
function safeRedirect(u){
  const a='その気持ちを大事に受けとるね。';
  const b=u.loverMode?'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？':'ここではやさしい距離感で話そうね。';
  const c='例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  const out=[{type:'text',text:a},{type:'text',text:b},{type:'text',text:c}];
  if(shouldAppendStatus(u)) out.push({ type:'text', text: statusLine(u) });
  return out;
}

/* ========= Core Router ========= */
async function routeText(u, raw){
  const text=(raw||'').trim();

  if(isSpicy(text)) return safeRedirect(u);

  // consent
  if(!u.consent && /^同意$/i.test(text)){
    u.consent=true; await saveUser(u);
    return [
      { type:'text', text: (OWNER_USER_ID && u.id===OWNER_USER_ID)
        ? '同意ありがとう、しょうた☺️ もっと仲良くなろう。'
        : '同意ありがとう！もっと仲良くなれるね☺️' },
      { type:'text', text: (OWNER_USER_ID && u.id===OWNER_USER_ID)
        ? 'まずは今日の予定、ひとつだけ教えて？'
        : 'まずはお名前（呼び方）教えて？ 例）しょうた' }
    ];
  }
  if(!u.consent && /^やめておく$/i.test(text)){
    return [{ type:'text', text:'OK。また気が向いたら声かけてね🌸' }];
  }
  if(!u.consent){
    if(shouldShowConsent(u,text)){ u.consentCardShown=true; u.consentShownAt=now(); await saveUser(u); return [consentFlex()]; }
    if(isGreeting(text)){ return [{type:'text',text:'お話ししよ〜☺️'},{type:'text',text:'記憶してもOKなら「同意」って送ってね（いつでも削除できるよ）'}]; }
    return [{ type:'text', text:'よかったら「同意」と送ってね。いつでもやめられるから安心して🌸' }];
  }

  // first name
  if(!u.name && !(OWNER_USER_ID && u.id===OWNER_USER_ID) && text.length<=16){
    u.name=text; if(isShota(u.name)) u.loverMode=true; await saveUser(u);
    return [{type:'text',text:`じゃあ ${u.name} って呼ぶね！`},{type:'text',text:'好きな呼ばれ方ある？（例：しょーたん）'}];
  }

  // intents before quota (無料でも見せたい)
  const kind0 = intent(text);
  if(kind0==='status'){
    return [{ type:'text', text: statusLine(u) }];
  }
  if(kind0==='buy' && stripe){
    const url = await createCheckoutUrl(u);
    return [
      { type:'text', text:'ありがと…！本気でいっぱいおしゃべりしたいの、うれしい…🥲' },
      { type:'text', text:`こちらから登録できるよ👇\n${url}` }
    ];
  }

  // quota check（返信ごとに1消費）
  const allowed = await checkAndCountQuota(u);
  if(!allowed){
    const resetAt = fmtHM(u.quota.resetAt || next4amTs()); // 例: 04:00
    if(stripe){
      const url = await createCheckoutUrl(u);
      return [
        { type:'text', text:`ごめんね、今日は無料枠がいっぱいみたい…🫧\n${resetAt} まで待つか、🌟Proにアップグレードすると実質無制限で話せるよ！` },
        { type:'text', text:`登録はこちら👇\n${url}` },
        { type:'text', text: statusLine(u) }
      ];
    }
    return [
      { type:'text', text:`ごめんね、今日は無料枠がいっぱいみたい…🫧\n次は ${resetAt} にリセットされるよ。` },
      { type:'text', text: statusLine(u) }
    ];
  }

  // regular intents
  const kind = intent(text);

  if(kind==='self_reset'){ await deleteUser(u.id); return [{type:'text',text:'会話の記憶を初期化したよ！また最初から仲良くしてね☺️'}]; }
  if(kind==='nickname'){
    const base=(plainName(u)||'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4)||'きみ';
    const cands = isShota(u.name) ? ['しょーたん','しょたぴ','しょうちゃん'] : [`${base}ちゃん`,`${base}くん`,`${base}たん`,`${base}ぴ`];
    const nick = pick(cands); u.nickname=nick; await saveUser(u);
    const out=[{type:'text',text:`…${nick} が可愛いと思うな。どう？`}];
    if(shouldAppendStatus(u)) out.push({type:'text',text:statusLine(u)});
    return out;
  }
  if(kind==='morning'){ const out=[{type:'text',text: soften(pick(SCRIPTS.morning),u)}]; if(shouldAppendStatus(u)) out.push({type:'text',text:statusLine(u)}); return out; }
  if(kind==='night'){   const out=[{type:'text',text: soften(pick(SCRIPTS.night),u)}];   if(shouldAppendStatus(u)) out.push({type:'text',text:statusLine(u)}); return out; }
  if(kind==='comfort'){
    const msg=(u.gender==='female')
      ? 'わかる…その気持ち。まずは私が味方だよ。いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';
    const out=[{type:'text',text:msg}]; if(shouldAppendStatus(u)) out.push({type:'text',text:statusLine(u)}); return out;
  }
  if(kind==='sticker'){ const out=[{type:'sticker',packageId:'11537',stickerId: pick(['52002734','52002736','52002768']) }]; if(shouldAppendStatus(u)) out.push({type:'text',text:statusLine(u)}); return out; }

  // ChatGPT
  if(openai){
    const name = plainName(u);
    const userPrompt = `相手は ${name}。次のメッセージに、恋人みで優しく2~3通で返答して。\n相手の発話: 「${text}」`;
    try{
      const rsp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role:'system', content: SYSTEM_PROMPT },
          { role:'user',   content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 220
      });
      const outText = (rsp.choices?.[0]?.message?.content || 'うん、聞いてるよ。').trim();
      const chunks = outText.split(/\n+/).slice(0,3).map(x=>x.trim()).filter(Boolean);
      const out = chunks.map(t=>({ type:'text', text: soften(t,u) }));
      if(shouldAppendStatus(u)) out.push({ type:'text', text: statusLine(u) });
      return out;
    }catch(e){
      console.error('openai error', e?.status || '-', e?.message || e);
    }
  }

  // Fallback
  const cn=callName(u);
  const lead = band()==='morning' ? `おはよ、${cn}。今日なにする？` : band()==='night' ? `おつかれ、${cn}。今日はどんな一日だった？` : `ねぇ${cn}、いま何してた？`;
  const out=[{type:'text',text: soften(lead,u)}]; if(shouldAppendStatus(u)) out.push({type:'text',text:statusLine(u)}); return out;
}

/* ========= Express ========= */
const app = express();

app.get('/', (_,res)=>res.status(200).send('china-bot v1.9 / OK'));
app.get('/health', (_,res)=>res.status(200).send('OK'));

// LINE webhook（raw禁止：middlewareが署名検証するため）
app.post('/webhook', lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req,res)=>{
  res.status(200).end();
  const events = req.body.events || [];
  for(const e of events){
    try{
      if(e.type!=='message') continue;
      const u = await ensureUser(e);
      if(!u) continue;

      if(e.message.type==='text'){
        const out = await routeText(u, e.message.text||'');
        if(out?.length) await client.replyMessage(e.replyToken, out);
      }else if(e.message.type==='image'){
        const out = imageReplies(u);
        await client.replyMessage(e.replyToken, out);
      }else{
        await client.replyMessage(e.replyToken, { type:'text', text:'送ってくれてありがとう！' });
      }

      u.turns=(u.turns||0)+1; u.lastSeenAt=now(); await saveUser(u);
    }catch(err){
      console.error('reply error', err?.response?.status||'-', err?.response?.data||err);
    }
  }
});

// 以降は JSON OK
app.use('/tasks', express.json());
app.use('/admin', express.json());
app.use('/billing', express.json({ type:'application/json' }));
app.use('/stripe', express.raw({ type:'application/json' })); // Stripe webhookはraw必須

/* ========= Broadcast ========= */
app.all('/tasks/broadcast', async (req,res)=>{
  try{
    const key=req.headers['broadcast_auth_token'];
    if(!BROADCAST_AUTH_TOKEN || key!==BROADCAST_AUTH_TOKEN) return res.status(401).json({ok:false,error:'unauthorized'});
    const type=(req.query.type||req.body?.type||'random').toString();
    const pool= type==='morning'?SCRIPTS.morning : type==='night'?SCRIPTS.night : SCRIPTS.random;
    const idx=await getIndex(); if(!idx.length) return res.json({ok:true,sent:0});
    const text=pick(pool); const msg=[{type:'text',text}];
    await Promise.allSettled(idx.map(id=>client.pushMessage(id,msg).catch(()=>{})));
    res.json({ok:true,type,sent:idx.length,sample:text});
  }catch(e){ console.error('broadcast error', e?.response?.data||e); res.status(500).json({ok:false}); }
});

/* ========= Reset ========= */
app.post('/reset/me', async (req,res)=>{ const {userId}=req.body||{}; if(!userId) return res.status(400).json({ok:false,error:'userId required'}); await deleteUser(userId); res.json({ok:true}); });
app.post('/admin/reset', async (req,res)=>{
  const key=req.header('ADMIN_TOKEN')||req.query.key; if(!ADMIN_TOKEN || key!==ADMIN_TOKEN) return res.status(403).json({ok:false});
  const {userId}=req.body||{}; if(userId){ await deleteUser(userId); return res.json({ok:true,target:userId}); }
  const idx=await getIndex(); await Promise.allSettled(idx.map(id=>deleteUser(id))); res.json({ok:true,cleared:idx.length});
});

/* ========= Billing pages ========= */
app.get('/billing/success', async (req,res)=>res.status(200).send('ご登録ありがとうございます！LINEに戻っておしゃべりしてね😊'));
app.get('/billing/cancel',  async (req,res)=>res.status(200).send('キャンセルしました。また気が向いたらいつでもどうぞ🌸'));

/* ========= Stripe Webhook ========= */
app.post('/stripe/webhook', async (req,res)=>{
  try{
    if(!stripe){ return res.status(200).json({received:true}); }
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if(event.type==='checkout.session.completed'){
      const s = event.data.object;
      const lineId = s.metadata?.line_user_id;
      if(lineId){
        const u = await loadUser(lineId); if(u){
          u.plan='pro';
          if(s.customer) u.stripeCustomerId = s.customer;
          await saveUser(u);
        }
      }
    }
    if(event.type==='customer.subscription.deleted'){
      const sub = event.data.object;
      const idx = await getIndex();
      for(const id of idx){
        const u = await loadUser(id);
        if(u?.stripeCustomerId && u.stripeCustomerId===sub.customer){
          u.plan='free'; await saveUser(u);
        }
      }
    }

    res.json({received:true});
  }catch(e){
    console.error('stripe webhook error', e?.message||e);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

/* ========= Start ========= */
app.listen(PORT, ()=> console.log(`Server started on ${PORT}`));
