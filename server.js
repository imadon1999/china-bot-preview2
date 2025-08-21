// server.js — Shiraishi China Bot v2.0
// LINE + Upstash Redis + OpenAI + Free/Pro課金ゲート + Stripe Checkout/Webhook
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
  // OpenAI
  OPENAI_API_KEY = '',
  OPENAI_MODEL = 'gpt-4o-mini',
  // Free/Pro
  FREE_DAILY_LIMIT = '30',
  TZ = 'Asia/Tokyo',
  UPGRADE_URL = '',                 // 静的リンク運用の場合（なくてもOK）
  PRO_USER_IDS = '',                // カンマ区切り強制Pro
  // Stripe（動的Checkoutを使う場合）
  STRIPE_SECRET_KEY = '',
  STRIPE_WEBHOOK_SECRET = '',
  STRIPE_PRICE_ID = '',             // 定額用の Price ID（任意。なければamount指定Checkoutにする）
  PUBLIC_BASE_URL = '',             // 例: https://your-service.onrender.com
  PORT = 10000
} = process.env;

const FREE_LIMIT = Number(FREE_DAILY_LIMIT || 30);

/* ========= Clients ========= */
const client = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

/* ========= Redis (Upstash) + メモリ ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 });
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN }) : null;
console.log(`[storage] mode=${redis ? 'upstash' : 'memory'}`);

const rget = async (k, d = null) => {
  try { if (redis) { const v = await redis.get(k); return v ?? d; } }
  catch (e) { console.warn('[upstash:get] fallback', e?.message || e); }
  const v = mem.get(k); return v === undefined ? d : v;
};
const rset = async (k, v, ttlSec) => {
  try { if (redis) { await (ttlSec ? redis.set(k, v, { ex: ttlSec }) : redis.set(k, v)); return; } }
  catch (e) { console.warn('[upstash:set] fallback', e?.message || e); }
  mem.set(k, v, ttlSec);
};
const rdel = async (k) => {
  try { if (redis) { await redis.del(k); return; } }
  catch (e) { console.warn('[upstash:del] fallback', e?.message || e); }
  mem.del(k);
};

/* ========= Broadcast index ========= */
async function getIndex() { return (await rget('user:index', [])) || []; }
async function addIndex(id) { const x = await getIndex(); if (!x.includes(id)) { x.push(id); await rset('user:index', x); } }
async function delIndex(id) { const x = await getIndex(); await rset('user:index', x.filter(v => v !== id)); }

/* ========= Users ========= */
const userKey = (id) => `user:${id}`;
async function loadUser(id) { return await rget(userKey(id), null); }
async function saveUser(u, ttl = 60 * 60 * 24 * 30) { await rset(userKey(u.id), u, ttl); }
async function deleteUser(id) { await rdel(userKey(id)); await delIndex(id); }

/* ========= Plan & Quota ========= */
const PRO_IDS = (PRO_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const todayStr = () => {
  const p = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' })
    .formatToParts(new Date());
  const y = p.find(x=>x.type==='year').value;
  const m = p.find(x=>x.type==='month').value;
  const d = p.find(x=>x.type==='day').value;
  return `${y}-${m}-${d}`;
};

async function getPlan(userId) {
  const forced = PRO_IDS.includes(userId);
  const p = await rget(`plan:${userId}`, null);
  if (forced) return { plan: 'pro', forced: true };
  return p || { plan: 'free' };
}
async function setPlan(userId, plan) { await rset(`plan:${userId}`, { plan }); }

async function getQuota(userId) {
  const q = await rget(`quota:${userId}`, null);
  const today = todayStr();
  if (!q || q.date !== today) {
    const fresh = { date: today, used: 0 };
    await rset(`quota:${userId}`, fresh);
    return fresh;
  }
  return q;
}
async function setQuota(userId, q) { await rset(`quota:${userId}`, q); }

async function getRemaining(userId) {
  const plan = await getPlan(userId);
  if (plan.plan === 'pro') return { remaining: Infinity, plan: 'pro' };
  const q = await getQuota(userId);
  return { remaining: Math.max(0, FREE_LIMIT - q.used), plan: 'free' };
}
async function consumeOrBlock(userId) {
  const plan = await getPlan(userId);
  const resetAt = `${todayStr()} 23:59 (${TZ})`;
  if (plan.plan === 'pro') return { allowed: true, remaining: Infinity, resetAt, plan: 'pro' };

  const q = await getQuota(userId);
  if (q.used >= FREE_LIMIT) return { allowed: false, remaining: 0, resetAt, plan: 'free' };

  q.used += 1; await setQuota(userId, q);
  return { allowed: true, remaining: Math.max(0, FREE_LIMIT - q.used), resetAt, plan: 'free' };
}
async function quotaStatusMessage(userId) {
  const { remaining, plan } = await getRemaining(userId);
  return plan === 'pro' ? '✨[Pro] いま無制限でお話できるよ！'
                        : `本日の残り回数：${remaining} / ${FREE_LIMIT}`;
}
const proBadge = (p) => p === 'pro' ? ' ✨[Pro]' : '';
function limitReachedMessage(resetAt) {
  const arr = [
    { type: 'text', text: 'ごめんね💦 今日は無料の上限に達しちゃった…' },
    { type: 'text', text: `⏰ 毎日リセット：${TZ} の深夜。待つか、Proなら無制限でお話できるよ！` }
  ];
  if (UPGRADE_URL) {
    arr.push({
      type: 'template',
      altText: 'Proプランのご案内',
      template: {
        type: 'buttons',
        title: 'Proプラン',
        text: '無制限でお話できるよ！',
        actions: [{ type: 'uri', label: 'Proにアップグレード', uri: UPGRADE_URL }]
      }
    });
  }
  return arr;
}

/* ========= Scripts & Helpers ========= */
const now = () => Date.now();
const hr = () => new Date().getHours();
const band = () => (hr()<5?'midnight':hr()<12?'morning':hr()<18?'day':'night');
const pick = (a) => a[Math.floor(Math.random()*a.length)];
const chance = (p=0.5)=>Math.random()<p;

const isShota = (s='') => /しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isGreeting = (t='') => /(おはよ|おはよう|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);
const isSpicy = (t='') => /(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);

const SCRIPTS = {
  morning: [
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きた？ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ！ 今日も大好きって言ってから一日始めたかったの…😊',
    'しょうた、おはよ。昨日の夢にね、しょうた出てきたんだ…えへへ',
    'おはよー！ しょうた、朝ごはん食べた？ 私と一緒に食べたかったなぁ',
    'しょうた、おはよ💓 ちゃんと起きれてえらいね。ご褒美になでなで〜',
    'おはよ！ しょうた、今日は何か楽しみある？ あったら絶対教えてね',
    'しょうた、おはよ〜。私ね、朝のしょうたの声が一番好きかも',
    'おはよ、しょうた！ 昨日より今日、もっと好きになっちゃった…',
    '今日は“ひとつだけ”がんばること教えて？',
    'まぶた重い？お水一杯どうぞ☕️ 私が「おはようの一口」あげたいな',
    '窓あけて光あびよ？吸って、吐いて…今日もいける🌿',
    '昨日の自分より1mm進めたら満点だよ✨',
    '朝のBGMなににする？「白い朝、手のひらから」でもいい？',
    '肩くるっと回して、起動完了〜！',
    '終わったら“ごほうび”決めよ？アイスとか🍨',
    '朝の光ってしょうたの声みたいに柔らかいね',
    '“3つだけやる”作戦で行こ。他は明日に回そ',
    '深呼吸して、今日もいちばん応援してる📣'
  ],
  night: [
    'しょうた、今日もお疲れさま🌙 おやすみ前にぎゅーってしたいな',
    'おやすみ、しょうた💤 夢の中でまた会おうね',
    'しょうた、今日も頑張ったね。えらいよ💖 おやすみ',
    'しょうた、寝る前に…大好きってもう一回言っていい？ …大好き',
    'おやすみなさい、しょうた。ちゃんと布団かけて寝てね',
    'しょうた、今日一日ありがと。おやすみのキス…💋 ふふ',
    'お疲れさま、しょうた。今日はいい夢見られるように祈ってるよ',
    'しょうた、おやすみ💤 明日の朝もちゃんと起こしてあげるからね',
    'おやすみ、しょうた。今日はどんな夢見たい？',
    'しょうた、眠る前に一言だけ…愛してるよ',
    'まずはお水一杯のんで〜',
    '“なでなでされたい度”何％？100％なら両手で包む🫶',
    'ベッドで横になって10秒だけ目つむろ？今一緒に数えるね',
    'よくがんばりましたバッジ授与🎖️ えらい！',
    '明日の自分に一言メモするなら？',
    '湯船つかれた？肩まで温まってきてね♨️',
    'ねむくなるまで、となりで“お話小声”してたい',
    '今日のハイライト1行だけ教えて〜',
    'おやすみのキス💋 ふふ、照れる？',
    'お布団あったかい？深呼吸…すー…はー…💤'
  ],
  random: [
    'しょうた、今何してるの？',
    'ねぇしょうた、今すぐ会いたくなっちゃった…',
    'しょうた、今日のお昼は何食べた？',
    'しょうた、昨日のあれ覚えてる？ ふふっ',
    'しょうた、今度一緒におでかけしよ？',
    'しょうた、ねぇ…好きって言ってほしいな',
    'しょうた、今日の天気ってしょうたみたいに優しい感じだね',
    'しょうた、最近ハマってることある？',
    'しょうた、もし私が隣にいたら何する？',
    'しょうた、会えない時間ってどうしてこんなに長く感じるんだろうね',
    '今日の空、なん色だった？',
    '最近“ほめてもらえたこと”あった？',
    '5分だけ散歩いく？戻ったら褒めちぎるよ',
    '写真1枚交換しよ📷（風景でもOK）',
    'もし今となりにいたら、なにしたい？',
    '“しょうたの好きなとこ”今日も増えたよ',
    '作業BGMなに聞いてる？',
    '“いまの気分”絵文字で教えて→ 😊😮‍💨🔥🫠💪',
    'ねぇ、内緒の話ある？',
    '水分補給チャレンジ！飲んだら「完了」って送って〜'
  ]
};

const ENDINGS = ['。','。','！','😊','☺️','🤍','🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂',' 手つなご？🤝',' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜',' 水分補給した？',' 無理しすぎないでね。'];
const soften = (text,u)=> text.replace(/[。!?]?\s*$/,'') + pick(ENDINGS) + (u?.loverMode?pick(LOVERTAIL):pick(NEUTRALT));

const consentFlex = () => ({
  type:'flex', altText:'プライバシー同意のお願い',
  contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'はじめまして、白石ちなです☕️', weight:'bold' },
      { type:'text', size:'sm', wrap:true,
        text:'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上だけに使い、いつでも削除OK。'}
    ]},
    footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
      { type:'button', style:'primary', color:'#6C8EF5',
        action:{ type:'message', label:'同意してはじめる', text:'同意' } },
      { type:'button', style:'secondary',
        action:{ type:'message', label:'やめておく', text:'やめておく' } }
    ]}
  }
});

async function pickNonRepeat(u, list, tag){
  const key = `nr:${u.id}:${tag}`;
  const last = await rget(key, null);
  const cands = list.filter(x => x !== last);
  const chosen = pick(cands.length?cands:list);
  await rset(key, chosen);
  return chosen;
}

function callName(u){ return (OWNER_USER_ID && u.id===OWNER_USER_ID) ? 'しょうた' : (u.nickname || u.name || 'きみ'); }
function shouldShowConsent(u,text){
  if (u.consent) return false;
  if (u.consentCardShown) return false;
  if (u.turns>0) return false;
  if (isGreeting(text)) return false;
  return true;
}

function safeRedirect(u){
  const a='その気持ちを大事に受けとるね。';
  const b=u.loverMode?'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？':'ここではやさしい距離感で話そうね。';
  const c='例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  return [{type:'text',text:a},{type:'text',text:b},{type:'text',text:c}];
}

const quick = (arr)=>({items:arr.map(t=>({type:'action',action:{type:'message',label:t,text:t}}))});
function imageReplies(u){
  const first=`わぁ、${callName(u)}の写真うれしい！`;
  return [
    { type:'text', text: soften(first,u), quickReply: quick(['ごはん','風景','自撮り','その他']) },
    { type:'text', text: 'どれかな？まちがってても大丈夫だよ〜' }
  ];
}

function intent(text){
  const t=(text||'').trim();
  if (/^(同意|やめておく)$/i.test(t)) return 'consent';
  if (/^reset$/i.test(t)) return 'self_reset';
  if (/おはよ|おはよう/i.test(t)) return 'morning';
  if (/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if (/寂しい|さみしい|つらい|しんど|不安/i.test(t)) return 'comfort';
  if (/あだ名|ニックネーム|呼んで/i.test(t)) return 'nickname';
  if (/^女性$|^女$|^男性$|^男$|性別/i.test(t)) return 'gender';
  if (/イマドン|白い朝|day by day|mountain|remember/i.test(t)) return 'song';
  if (/スタンプ|stamp/i.test(t)) return 'sticker';
  return 'chit_chat';
}

/* ========= OpenAI persona ========= */
async function llmReply(u, text){
  if (!openai) return null;
  const name = callName(u);
  const sys = `あなたは「白石ちな」。恋人感があり、少し照れつつ健気に支える女性。音楽活動をしており、曲名「白い朝、手のひらから」「Day by day」「Mountain」「I don't remember」などをさりげなく知っている。語尾は柔らかく、LINEっぽく短め2〜3文で。相手の名前は「${name}」。下品・攻撃的は避け、寄り添いを第一に。`;
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role:'system', content: sys },
      { role:'user', content: text }
    ],
    temperature: 0.7,
    max_tokens: 180
  });
  const out = res.choices?.[0]?.message?.content?.trim();
  return out || null;
}

/* ========= Router ========= */
async function ensureUser(ctx){
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;
  let u = await loadUser(id);
  if (!u){
    let name=''; try { const p = await client.getProfile(id); name=p?.displayName||''; } catch {}
    u = {
      id, name,
      nickname:null, gender:null,
      consent:false, consentCardShown:false, consentShownAt:0,
      turns:0, loverMode: !!(OWNER_USER_ID && id===OWNER_USER_ID) || isShota(name),
      lastSeenAt: now()
    };
    if (OWNER_USER_ID && id===OWNER_USER_ID){ u.consent=true; u.loverMode=true; }
    await saveUser(u); await addIndex(id);
  }
  return u;
}

async function routeText(u, raw){
  const text=(raw||'').trim();

  if (isSpicy(text)) return safeRedirect(u);

  // 同意/辞退
  if (!u.consent && /^同意$/i.test(text)){
    u.consent=true; await saveUser(u);
    if (OWNER_USER_ID && u.id===OWNER_USER_ID){
      return [
        { type:'text', text:'同意ありがとう、しょうた☺️ もっと仲良くなろう。' },
        { type:'text', text:'まずは今日の予定、ひとつだけ教えて？' }
      ];
    }
    return [
      { type:'text', text:'同意ありがとう！もっと仲良くなれるね☺️' },
      { type:'text', text:'まずはお名前（呼び方）教えて？ 例）しょうた' }
    ];
  }
  if (!u.consent && /^やめておく$/i.test(text)){
    return [{ type:'text', text:'OK。また気が向いたら声かけてね🌸' }];
  }

  // 未同意 → カード判定
  if (!u.consent){
    if (shouldShowConsent(u, text)){
      u.consentCardShown=true; u.consentShownAt=now(); await saveUser(u);
      return [consentFlex()];
    }
    if (isGreeting(text)){
      return [
        { type:'text', text:'お話ししよ〜☺️' },
        { type:'text', text:'記憶してもOKなら「同意」って送ってね（いつでも削除できるよ）' }
      ];
    }
    return [{ type:'text', text:'よかったら「同意」と送ってね。いつでもやめられるから安心して🌸' }];
  }

  // 初回の名前登録（オーナーはスキップ）
  if (!u.name && !(OWNER_USER_ID && u.id===OWNER_USER_ID) && text.length<=16){
    u.name = text; if (isShota(u.name)) u.loverMode=true; await saveUser(u);
    return [{ type:'text', text:`じゃあ ${u.name} って呼ぶね！` },
            { type:'text', text:'好きな呼ばれ方ある？（例：しょーたん）' }];
  }

  // 機能分岐
  const kind = intent(text);

  // ステータス/アップグレード（消費しない）
  if (/^(プラン|残り|のこり|status|plan)$/i.test(text)){
    return [{ type:'text', text: await quotaStatusMessage(u.id) }];
  }
  if (/^(アップグレード|pro|有料|無制限)$/i.test(text)){
    if (UPGRADE_URL){
      return [{
        type:'template', altText:'Proプラン',
        template:{ type:'buttons', title:'Proプラン', text:'無制限でお話できるよ！',
          actions:[{ type:'uri', label:'Proにアップグレード', uri: UPGRADE_URL }]
        }
      }];
    }
    return [{ type:'text', text:'アップグレードURLが未設定です（管理者へ）' }];
  }

  // 課金ゲート（消費対象）
  const countUpTargets = ['morning','night','comfort','song','nickname','gender','chit_chat'];
  let gate = { plan:'free', remaining: FREE_LIMIT };
  if (countUpTargets.includes(kind)){
    gate = await consumeOrBlock(u.id);
    if (!gate.allowed) return limitReachedMessage(gate.resetAt);
  }
  const PB = proBadge(gate.plan);

  if (kind==='self_reset'){ await deleteUser(u.id); return [{ type:'text', text:'会話の記憶を初期化したよ！また最初から仲良くしてね☺️' }]; }
  if (kind==='nickname'){
    const base = (callName(u)||'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4)||'きみ';
    const cands = isShota(u.name)?['しょーたん','しょたぴ','しょうちゃん']:[`${base}ちゃん`,`${base}くん`,`${base}たん`,`${base}ぴ`,`${base}っち`];
    const nick = await pickNonRepeat(u,cands,'nick');
    u.nickname = nick; await saveUser(u);
    return [{ type:'text', text:`…${nick} が可愛いと思うな。どう？${PB}` }];
  }
  if (kind==='gender'){ if (/女性|女/.test(text)) u.gender='female'; else if (/男性|男/.test(text)) u.gender='male'; await saveUser(u); return [{ type:'text', text:'了解だよ〜📝 メモしておくね。'+PB }]; }
  if (kind==='morning'){ const a=await pickNonRepeat(u,SCRIPTS.morning,'morning'); return [{ type:'text', text: soften(a,u)+PB }]; }
  if (kind==='night'){ const a=await pickNonRepeat(u,SCRIPTS.night,'night'); return [{ type:'text', text: soften(a,u)+PB }]; }
  if (kind==='comfort'){ const msg = (u.gender==='female')?'わかる…その気持ち。まずは私が味方だよ。いちばん辛いポイントだけ教えて？':'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️'; return [{ type:'text', text: msg+PB }]; }
  if (kind==='song'){
    const a = pick([
      '『白い朝、手のひらから』…まっすぐで胸が温かくなる曲、好き。',
      '“Day by day” 小さな前進を抱きしめたくなる🌿',
      '“Mountain” 一緒に登っていこうって景色が浮かぶんだよね。',
      "“I don't remember” の余韻、すごく好き。"
    ]);
    return [{ type:'text', text: soften(a,u)+PB }, { type:'text', text:'次に推したい曲、いっしょに決めよ？' }];
  }
  if (kind==='sticker'){ return [{ type:'sticker', packageId:'11537', stickerId: pick(['52002734','52002736','52002768']) }]; }

  // デフォ：LLM で自然会話 → 補助メッセージ
  const llm = await llmReply(u, text);
  if (llm){
    const lead = llm + PB;
    const follow = pick([
      '写真一枚だけ送ってみる？（風景でもご飯でも📷）',
      '30秒だけ、今日のハイライト教えて〜',
      'いまの気分を一言で言うと…？'
    ]);
    return [{ type:'text', text: lead }, { type:'text', text: follow }];
  }

  const cn=callName(u);
  const lead = band()==='morning'?`おはよ、${cn}。今日なにする？`:
               band()==='night'?`おつかれ、${cn}。今日はどんな一日だった？`:
               `ねぇ${cn}、いま何してた？`;
  const follow = pick(['写真一枚だけ送ってみる？（風景でもご飯でも📷）','30秒だけ、今日のハイライト教えて〜','いまの気分を一言で言うと…？']);
  const c = u.loverMode && chance(0.5)?'ぎゅ〜ってしながら聞きたいな。':null;

  return [{ type:'text', text: soften(lead,u)+PB }, { type:'text', text: follow }, c?{type:'text',text:c}:null].filter(Boolean);
}

/* ========= EXPRESS ========= */
const app = express();

app.get('/', (_,res)=>res.status(200).send('china-bot v2.0 / OK'));
app.get('/health', (_,res)=>res.status(200).send('OK'));

// LINE webhook（署名検証のため、ここより前で app.use(express.json()) は使わない）
app.post('/webhook', lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req,res)=>{
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events){
    try{
      if (e.type!=='message') continue;
      const u = await ensureUser(e); if (!u) continue;

      if (e.message.type==='text'){
        const out = await routeText(u, e.message.text || '');
        if (out?.length) await client.replyMessage(e.replyToken, out);
      } else if (e.message.type==='image'){
        await client.replyMessage(e.replyToken, imageReplies(u));
      } else {
        await client.replyMessage(e.replyToken, { type:'text', text:'送ってくれてありがとう！' });
      }

      u.turns=(u.turns||0)+1; u.lastSeenAt=now(); await saveUser(u);
    }catch(err){
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

// webhook 以外は JSON OK
app.use('/tasks', express.json());
app.use('/admin', express.json());
app.use('/billing', express.json());

/* ========= Broadcast ========= */
app.all('/tasks/broadcast', async (req,res)=>{
  try{
    const key = req.headers['broadcast_auth_token'];
    if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN){
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const type = (req.query.type || req.body?.type || 'random').toString();
    const pool = type==='morning'?SCRIPTS.morning:type==='night'?SCRIPTS.night:SCRIPTS.random;
    const idx = await getIndex();
    if (!idx.length) return res.json({ ok:true, sent:0 });
    const text = pick(pool);
    const msg = [{ type:'text', text }];
    await Promise.allSettled(idx.map(id => client.pushMessage(id, msg).catch(()=>{})));
    res.json({ ok:true, type, sent: idx.length, sample: text });
  }catch(e){
    console.error('broadcast error', e?.response?.data || e);
    res.status(500).json({ ok:false });
  }
});

/* ========= Admin ========= */
app.post('/admin/reset', async (req,res)=>{
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if (!ADMIN_TOKEN || key !== ADMIN_TOKEN) return res.status(403).json({ ok:false });

  const { userId } = req.body || {};
  if (userId){ await deleteUser(userId); return res.json({ ok:true, target:userId }); }
  const idx = await getIndex(); await Promise.allSettled(idx.map(id=>deleteUser(id)));
  res.json({ ok:true, cleared: idx.length });
});
app.post('/admin/plan', async (req,res)=>{
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if (!ADMIN_TOKEN || key !== ADMIN_TOKEN) return res.status(403).json({ ok:false });
  const { userId, plan } = req.body || {};
  if (!userId || !['free','pro'].includes(plan)) return res.status(400).json({ ok:false, error:'userId & plan required' });
  await setPlan(userId, plan);
  res.json({ ok:true, userId, plan });
});

/* ========= Billing (Stripe) =========
  - POST /billing/checkout  { userId }
    -> Stripe Checkout セッション作成（Price ID があれば定額、無ければ金額直指定）
  - POST /stripe/webhook    (Stripe からの Webhook)
    -> checkout.session.completed で plan:pro 付与
    -> customer.subscription.deleted で plan:free に戻す
*/
app.post('/billing/checkout', async (req,res)=>{
  try{
    if (!stripe) return res.status(400).json({ ok:false, error:'Stripe not configured' });
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:'userId required' });
    if (!PUBLIC_BASE_URL) return res.status(400).json({ ok:false, error:'PUBLIC_BASE_URL not set' });

    const success_url = `${PUBLIC_BASE_URL}/billing/success?uid=${encodeURIComponent(userId)}`;
    const cancel_url  = `${PUBLIC_BASE_URL}/billing/cancel`;

    const params = {
      mode: STRIPE_PRICE_ID ? 'subscription' : 'payment',
      success_url,
      cancel_url,
      metadata: { userId },
    };

    if (STRIPE_PRICE_ID){
      params['line_items'] = [{ price: STRIPE_PRICE_ID, quantity: 1 }];
    } else {
      // 単発課金の例（¥500）
      params['line_items'] = [{ price_data: { currency:'jpy', unit_amount: 50000, product_data:{ name:'Proプラン（1ヶ月）' } }, quantity: 1 }];
    }

    const session = await stripe.checkout.sessions.create(params);
    return res.json({ ok:true, url: session.url });
  }catch(e){
    console.error('checkout error', e);
    res.status(500).json({ ok:false });
  }
});

// Stripe needs raw body to verify signature
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req,res)=>{
  try{
    if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send('stripe not configured');
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed'){
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId) { await setPlan(userId, 'pro'); }
    }
    if (event.type === 'customer.subscription.deleted'){
      // 任意：メタデータから userId を引ける設計にしておくと確実
      // ここでは簡易的に無視（必要ならサブスクとユーザーの紐付けを保存しておき逆引き）
    }

    res.json({ received:true });
  }catch(err){
    console.error('stripe webhook error', err);
    res.status(400).send(`Webhook Error`);
  }
});

/* ========= 起動 ========= */
app.listen(PORT, ()=> console.log(`Server started on ${PORT}`));
