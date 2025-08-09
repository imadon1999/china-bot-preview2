
// server.js
import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

// ── Optional: OpenAI(ある場合のみ使用)
let openai = null;
if (process.env.OPENAI_API_KEY) {
  const { OpenAI } = await import('openai');
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/* ===== LINE SDK ===== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);

/* ===== State（簡易・揮発）===== */
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 14, checkperiod: 120 }); // 2週間
const ownerId = process.env.OWNER_USER_ID || null;

/* ===== Utils ===== */
const nowH = () => new Date().getHours();
const pick = a => a[Math.floor(Math.random()*a.length)];
const isShota = s => /しょうた|ショウタ|shota|imadon/i.test(s||'');
const userKeys = () => state.keys().filter(k=>k.startsWith('user:'));

/* ===== Persona/Knowledge ===== */
const SONGS = [
  { key:/白い朝|shiroi/i, comment:'『白い朝、手のひらから』はコーヒーの湯気みたいに優しい余韻が好き。' },
  { key:/day ?by ?day/i, comment:'“Day by day” は小さな一歩を祝ってくれる曲。今日の自分を好きになれるやつ🌿' },
  { key:/mountain/i, comment:'“Mountain” は景色が浮かぶ。息を合わせて登っていこうって気持ちになる。' },
  { key:/remember|I don'?t/i, comment:'“I don’t remember” の不完全さ、逆にリアルでグッときた…！' },
];

/* ===== User bootstrap ===== */
async function ensureUser(ctx){
  const id = ctx.source?.userId || ctx.userId;
  let u = state.get(`user:${id}`);
  if(!u){
    let name = '';
    try{ name = (await client.getProfile(id))?.displayName || '';}catch(_){}
    u = {
      id, name, gender:null, nickname:null,
      consent:false, loverMode:false, muted:false,
      // 自然会話用
      memory:{ likes:[], facts:[], mood:'neutral' },
      history:[]  // {role:'user'|'assistant', content:string}
    };
    if ((name && isShota(name)) || (ownerId && id===ownerId)) u.loverMode = true;
    state.set(`user:${id}`, u);
  }
  return u;
}

/* ===== 同意カード ===== */
function consentFlex(){
  return {
    type:'flex', altText:'プライバシー同意のお願い',
    contents:{
      type:'bubble',
      body:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'text', text:'はじめまして、白石ちなです☕️', weight:'bold' },
        { type:'text', wrap:true, text:'自然な会話のため、ニックネーム等を記憶しても良い？' },
        { type:'text', text:'プライバシー', weight:'bold' },
        { type:'text', size:'sm', color:'#888', wrap:true,
          text:'会話向上にのみ使用・第三者提供なし。いつでも削除OK（プロフィールURL参照）。' }
      ]},
      footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
        { type:'button', style:'primary', color:'#6C8EF5', action:{type:'message',label:'同意してはじめる', text:'同意'}},
        { type:'button', style:'secondary', action:{type:'message',label:'やめておく', text:'やめておく'}}
      ]}
    }
  };
}

/* ===== ニックネーム提案 ===== */
function suggestNick(u){
  const base = (u.name||'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4)||'きみ';
  if (isShota(u.name)) return pick(['しょーたん','しょたぴ','しょうちゃん']);
  return pick([`${base}ちゃん`,`${base}くん`,`${base}たん`,`${base}ぴ`,` ${base}っち`]);
}

/* ===== ルールベース応答（フォールバック）===== */
function ruleBased(u, t){
  // 基本挨拶
  if (/おはよ/.test(t)) return u.loverMode
    ? 'おはよう💗 まずは深呼吸して、ぎゅっ🫂'
    : 'おはよう！今日もゆるっといこう☀️';
  if (/おやすみ|寝る/.test(t)) return u.loverMode
    ? '今日もえらかったね。添い寝、ぎゅ〜🛏️'
    : '今日もお疲れさま。ゆっくり休んでね🌙';

  // 相談
  if (/寂しい|つらい|しんど|不安/i.test(t)){
    return (u.gender==='female')
      ? 'わかる…その気持ち。まずは私が味方。1行で「今いちばん辛いこと」だけ教えて？'
      : 'ここにいるよ。深呼吸→少しずつ話そ？私はずっと味方だよ☺️';
  }

  // イマドン
  for (const s of SONGS) if (s.key.test(t)) return s.comment;

  // スタンプ要求
  if (/スタンプ|stamp/i.test(t)) return { sticker:true };

  // デフォルト
  const call = u.nickname || u.name || 'きみ';
  return u.loverMode
    ? `ねぇ${call}、いま何してた？となりでぎゅ…🫂`
    : `ねぇ${call}、いま何してた？`;
}

/* ===== OpenAI 応答（ある場合のみ）===== */
async function llmReply(u, userText){
  if (!openai) return null;
  // 簡易履歴（直近8ターン）
  const hist = (u.history||[]).slice(-8).map(h=>({role:h.role, content:h.content}));
  const persona =
`あなたは「白石ちな」。20代前半、照れ屋で健気。丁寧だが距離は近い。
恋人モード(loverMode=${u.loverMode})のときはやさしく甘め。だが節度を保つ。
禁止: 露骨な性的表現・年齢不明の描写・攻撃的発言。
話題例: 日常、小さな励まし、音楽(イマドン)、健康・美容の軽い知識。
一人称は「わたし」。相手の呼び方は「${u.nickname||u.name||'きみ'}」。句読点はやわらかく。
50〜85文字程度、日本語。絵文字は0〜2個まで。`;

  const messages = [
    { role:'system', content: persona },
    ...hist,
    { role:'user', content: userText }
  ];

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.8,
    max_tokens: 140
  });
  return res.choices?.[0]?.message?.content?.trim() || null;
}

/* ===== 受信テキストのハンドラ ===== */
async function handleText(u, text){
  const t = text.trim();

  // 同意／やめておく
  if (/^同意$/i.test(t)){
    u.consent = true; state.set(`user:${u.id}`, u);
    return [
      { type:'text', text:'同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type:'text', text:'まずはお名前（呼び方）教えて？\n例）しょうた など' }
    ];
  }
  if (/やめておく/i.test(t)) return [{type:'text',text:'わかったよ。いつでも気が変わったら言ってね🌸'}];

  // 名前登録（最初の一回）
  if (u.consent && !u.name && t.length<=16){
    u.name = t;
    if (isShota(t)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{type:'text', text:`じゃあ ${t} って呼ぶね！`}];
  }

  // コマンド
  if (/^(通知オフ|ミュート)$/i.test(t)){ u.muted=true; state.set(`user:${u.id}`, u); return [{type:'text',text:'定時/ランダムを停止したよ🔕（「通知オン」で再開）'}]; }
  if (/^(通知オン|ミュート解除)$/i.test(t)){ u.muted=false; state.set(`user:${u.id}`, u); return [{type:'text',text:'再開したよ🔔 また時々声かけるね！'}]; }
  if (/^記憶消して|リセット$/i.test(t)){ u.history=[]; u.memory={likes:[],facts:[],mood:'neutral'}; state.set(`user:${u.id}`,u); return [{type:'text',text:'OK！一旦まっさらにしたよ🧽'}]; }
  if (/あだ名つけて|ニックネーム/i.test(t)){ const nick=suggestNick(u); u.nickname=nick; state.set(`user:${u.id}`,u); return [{type:'text',text:`…${nick} が可愛いと思うな、どう？`}]; }
  if (/女性|女|男性|男/.test(t) && /性別|わたし|俺|僕|私/.test(t)){ if(/女性|女/.test(t))u.gender='female'; else if(/男性|男/.test(t))u.gender='male'; state.set(`user:${u.id}`,u); return [{type:'text',text:'了解だよ〜！メモしておくね📝'}]; }

  // 作品認識（固定知識）
  for (const s of SONGS) if (s.key.test(t)) return [{type:'text', text:s.comment}];

  // OpenAI で自然応答（ある場合）
  let answer = null;
  try { answer = await llmReply(u, t); } catch(_){ /* fallback */ }

  // 返答テキスト or スタンプ
  const rb = ruleBased(u, t);
  if (rb && rb.sticker) {
    return [{ type:'sticker', packageId:'11537', stickerId: pick(['52002735','52002736','52002768']) }];
  }
  const textOut = answer || rb;
  // 履歴更新
  u.history.push({role:'user', content:t});
  u.history.push({role:'assistant', content: typeof textOut==='string'? textOut : '[sticker]' });
  u.history = u.history.slice(-12);
  state.set(`user:${u.id}`, u);

  return [{type:'text', text:textOut}];
}

/* ===== Express ===== */
const app = express();
app.get('/',(_,res)=>res.send('China bot running. /health = OK'));
app.get('/health',(_,res)=>res.status(200).send('OK'));

app.post('/webhook', lineMiddleware(config), async (req,res)=>{
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events){
    try{
      if (e.type!=='message') continue;
      const u = await ensureUser(e);

      if (e.message.type==='text'){
        const text = e.message.text || '';

        // 同意/やめておく を先に処理
        if (!u.consent && /^(同意|やめておく)$/i.test(text)){
          const replies = await handleText(u, text);
          if (replies?.length) await client.replyMessage(e.replyToken, replies);
          continue;
        }
        // 未同意 → 同意カード返す
        if (!u.consent){
          await client.replyMessage(e.replyToken, consentFlex());
          continue;
        }
        // 通常
        const replies = await handleText(u, text);
        if (replies?.length) await client.replyMessage(e.replyToken, replies);
        continue;
      }

      // 画像/スタンプ等
      const fallback = u.loverMode
        ? '写真ありがと…大事に見るね📷💗'
        : '送ってくれてありがとう！';
      await client.replyMessage(e.replyToken, { type:'text', text:fallback });

    }catch(err){
      console.error('handle error', err?.response?.data || err);
    }
  }
});

/* ===== Push（定時/ランダム/カメオ友人）===== */
async function safePush(u, msg, {quiet=true}={}){
  if (!u?.consent || u?.muted) return;
  const h = nowH();
  if (quiet && (h<7 || h>23)) return;
  await client.pushMessage(u.id, Array.isArray(msg)?msg:[msg]);
}

// 朝7:30
cron.schedule('30 7 * * *', async ()=>{
  for (const k of userKeys()){
    const u = state.get(k); if(!u) continue;
    const m = u.loverMode
      ? pick(['おはよ💗今日もがんばろうね。ぎゅっ🫂','おはよう☀️大好きだよ、先にコーヒーいれるね☕️'])
      : pick(['おはよう！深呼吸からスタートしよ〜☀️','おはよ！今日はどんな1日にする？']);
    await safePush(u,{type:'text',text:m},{quiet:false});
  }
},{timezone:'Asia/Tokyo'});

// 夜23:00
cron.schedule('0 23 * * *', async ()=>{
  for (const k of userKeys()){
    const u = state.get(k); if(!u) continue;
    const m = u.loverMode
      ? pick(['今日もお疲れさま💗 添い寝、ぎゅ〜🛏️','目閉じて…ほっぺぽん。おやすみ🌙'])
      : pick(['今日もおつかれ！いい夢見てね🌙','がんばった分だけ休もう、また明日！']);
    await safePush(u,{type:'text',text:m},{quiet:false});
  }
},{timezone:'Asia/Tokyo'});

// 日中のランダム（2時間毎トリガー・50%送信）
cron.schedule('0 */2 * * *', async ()=>{
  const h = nowH(); if (h<9 || h>21) return;
  for (const k of userKeys()){
    if (Math.random()>0.5) continue;
    const u = state.get(k); if(!u) continue;
    const arr = u.loverMode
      ? ['ねぇ…今なにしてる？💗','ふと思い出してメッセしちゃった🫂','お水のんだ？ちょっと休憩しよ？']
      : ['最近どう？','いま時間ある？ちょっと聞いてほしいことが…','今日は何食べよっか？'];
    await safePush(u,{type:'text',text:pick(arr)});
  }
},{timezone:'Asia/Tokyo'});

// 低頻度の友人カメオ（週3回・夕方17時/25%）
cron.schedule('0 17 * * 1,3,5', async ()=>{
  for (const k of userKeys()){
    if (Math.random()>0.25) continue;
    const u = state.get(k); if(!u) continue;
    const cameo = pick([
      '友だちの彩(あや)にカフェ誘われた〜。今度いっしょに行こ？',
      '高校の同級生ゆうたに街で会ってさ、ちょっと照れた…(なにもないよ笑)'
    ]);
    await safePush(u,{type:'text',text: came o});
  }
},{timezone:'Asia/Tokyo'});

/* ===== Start ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server started on ${PORT}`));
