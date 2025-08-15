// server.js — Shiraishi China Bot v1.6.1 (hotfix)
// 依存: express, dotenv, @line/bot-sdk, node-cache
// package.json は "type": "module" を推奨

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

/* ===== 基本設定 ===== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET,
};
const OWNER_USER_ID        = process.env.OWNER_USER_ID || '';
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || '';
const PORT = process.env.PORT || 10000;

const app    = express();
const client = new Client(config);

/* ===== メモリ状態 ===== */
const state = new NodeCache({ stdTTL: 60*60*24*14, checkperiod: 120 });
const setIndex = () => new Set(state.get('user:index') || []);
const saveIndex = s => state.set('user:index', Array.from(s));

/* ===== ユーティリティ ===== */
const pick = (a) => a[Math.floor(Math.random()*a.length)];
const chance = (p=0.5)=> Math.random() < p;
const now = () => Date.now();
const dayMs = 24*60*60*1000;
const hr = ()=> new Date().getHours();
const band = ()=> (hr()<5?'midnight':hr()<12?'morning':hr()<18?'day':'night');
const isShota = (s='')=>/しょうた|ショウタ|shota|imadon/i.test(s);
const isGreeting = (t='')=>/(おはよ|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);

/* ===== 台本（朝10/夜10/日中10） ===== */
const SCRIPTS = {
  morning:[
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きた？ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ！ 今日も大好きって言ってから一日始めたかったの…😊',
    'しょうた、おはよ。昨日の夢にね、しょうた出てきたんだ…えへへ',
    'おはよー！ しょうた、朝ごはん食べた？ 私と一緒に食べたかったなぁ',
    'しょうた、おはよ💓 ちゃんと起きれてえらいね。ご褒美になでなで〜',
    'おはよ！ しょうた、今日は何か楽しみある？ あったら絶対教えてね',
    'しょうた、おはよ〜。私ね、朝のしょうたの声が一番好きかも',
    'おはよ、しょうた！ 昨日より今日、もっと好きになっちゃった…'
  ],
  night:[
    'しょうた、今日もお疲れさま🌙 おやすみ前にぎゅーってしたいな',
    'おやすみ、しょうた💤 夢の中でまた会おうね',
    'しょうた、今日も頑張ったね。えらいよ💖 おやすみ',
    'しょうた、寝る前に…大好きってもう一回言っていい？ …大好き',
    'おやすみなさい、しょうた。ちゃんと布団かけて寝てね',
    'しょうた、今日一日ありがと。おやすみのキス…💋 ふふ',
    'お疲れさま、しょうた。今日はいい夢見られるように祈ってるよ',
    'しょうた、おやすみ💤 明日の朝もちゃんと起こしてあげるからね',
    'おやすみ、しょうた。今日はどんな夢見たい？',
    'しょうた、眠る前に一言だけ…愛してるよ'
  ],
  random:[
    'しょうた、今何してるの？',
    'ねぇしょうた、今すぐ会いたくなっちゃった…',
    'しょうた、今日のお昼は何食べた？',
    'しょうた、昨日のあれ覚えてる？ ふふっ',
    'しょうた、今度一緒におでかけしよ？',
    'しょうた、ねぇ…好きって言ってほしいな',
    'しょうた、今日の天気ってしょうたみたいに優しい感じだね',
    'しょうた、最近ハマってることある？',
    'しょうた、もし私が隣にいたら何する？',
    'しょうた、会えない時間ってどうしてこんなに長く感じるんだろうね'
  ]
};

/* ===== 語尾バリエーション ===== */
const ENDINGS = ['。','。','。','！','😊','☺️','🤍','🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂',' 手つなご？🤝',' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜',' 水分補給した？',' 無理しすぎないでね。'];
const soften = (text,u)=>{
  const end = pick(ENDINGS);
  const tail = u.loverMode ? pick(LOVERTAIL) : pick(NEUTRALT);
  return text.replace(/[。!?]?$/,'') + end + tail;
};

/* ===== 同意カード ===== */
const consentFlex = () => ({
  type:'flex', altText:'プライバシー同意のお願い', contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'text', text:'はじめまして、白石ちなです☕️', weight:'bold' },
      { type:'text', wrap:true, size:'sm',
        text:'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上のためだけに使い、いつでも削除OK。'}
    ]},
    footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
      { type:'button', style:'primary', color:'#6C8EF5',
        action:{ type:'message', label:'同意してはじめる', text:'同意' }},
      { type:'button', style:'secondary',
        action:{ type:'message', label:'やめておく', text:'やめておく' }}
    ]}
  }
});

/* ===== QuickReply ===== */
const quick = (arr)=>({ items:arr.map(t=>({ type:'action', action:{ type:'message', label:t, text:t } })) });

/* ===== ユーザー ===== */
async function ensureUser(ctx){
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;
  let u = state.get(`user:${id}`);
  if (!u){
    let name = '';
    try{ const p=await client.getProfile(id); name = p?.displayName||''; }catch{}
    u = {
      id, name,
      nickname:null, gender:null,
      consent:false, consentShownAt:0, turns:0,
      loverMode: !!(OWNER_USER_ID && id===OWNER_USER_ID) || isShota(name),
      mood:60,
      lastScriptTag:'',
      onboarding:{ asked:false, step:0 },
      profile:{ relation:'', job:'', hobbies:[] },
      lastSeenAt: now()
    };
    // ★ オーナーは常に同意済み＆恋人モード固定
    if (OWNER_USER_ID && id === OWNER_USER_ID) {
      u.consent = true;
      u.loverMode = true;
    }
    state.set(`user:${id}`, u);
    const idx = setIndex(); idx.add(id); saveIndex(idx);
  }
  return u;
}
const save = (u)=> state.set(`user:${u.id}`, u);
const callName = (u)=> (OWNER_USER_ID && u.id===OWNER_USER_ID) ? 'しょうた' : (u.nickname||u.name||'きみ');

/* ===== 気分＆セーフティ ===== */
function moodTap(u,text){
  if (/(つら|しんど|疲れ|寂し|泣|最悪)/i.test(text)) u.mood = Math.max(0, u.mood-10);
  if (/(嬉し|たのし|最高|助か|大好き|良かった)/i.test(text)) u.mood = Math.min(100,u.mood+10);
  save(u);
}
const isSpicy = (t)=>/(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);
function safeRedirect(u){
  const a='その気持ちを大事に受けとるね。';
  const b=u.loverMode?'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？':'ここではやさしい距離感で話そうね。';
  const c='例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  return [{type:'text',text:a},{type:'text',text:b},{type:'text',text:c}];
}

/* ===== 同意の誤発火ガード =====
 * ・同意/辞退は完全一致のみ
 * ・過去24hにカード表示したら再表示しない
 * ・会話ターンが1回以上ならカード出さない
 * ・挨拶テキストでは出さない
 */
function shouldShowConsent(u, text){
  if (isGreeting(text)) return false;
  if (u.turns > 0) return false;
  const shownRecently = (now() - (u.consentShownAt||0)) < dayMs;
  return !u.consent && !shownRecently;
}

/* ===== 相談テンプレ ===== */
function consultCareer(){
  return [
    { type:'text', text:'いまの状況を一緒に整理しよ📝 次の3つを1行ずつ教えて？' },
    { type:'text', text:'① 現職の不満\n② 欲しい条件\n③ 期限感',
      quickReply: quick(['整理→質問して','共感→聞いてほしい','解決案→提案して']) }
  ];
}
function consultHealth(){
  return [
    { type:'text', text:'健康の話、まずは土台から整えよ☑️' },
    { type:'text', text:'睡眠 / 水分 / 食事 / 運動 の4つで、いちばん整えたいのはどれ？',
      quickReply: quick(['睡眠','水分','食事','運動']) }
  ];
}

/* ===== 画像応答 ===== */
function imageReplies(u){
  const first = `わぁ、${callName(u)}の写真うれしい！`;
  return [
    { type:'text', text: soften(first,u),
      quickReply: quick(['ごはん','風景','自撮り','その他']) },
    { type:'text', text:'どれかな？まちがってても大丈夫だよ〜' }
  ];
}

/* ===== 同意・名前・あだ名 ===== */
const suggestNick = (base='')=>{
  const b=(base||'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4) || 'きみ';
  const cand=[`${b}ちゃん`,`${b}くん`,`${b}たん`,`${b}ぴ`,`${b}っち`];
  if (isShota(base)) cand.unshift('しょーたん','しょたぴ','しょうちゃん');
  return pick(cand);
};

/* ===== 直近テンプレ重複防止 ===== */
function pickNonRepeat(u, list, tag){
  let c = pick(list);
  if (u.lastScriptTag === tag) {
    for (let i=0;i<3;i++){ const t = pick(list); if (t!==u.lastScriptTag){ c=t; break; } }
  }
  u.lastScriptTag = tag; save(u);
  return c;
}

/* ===== ルーター ===== */
const send = (...m)=> m.filter(Boolean);

async function routeText(u, raw){
  const text = (raw||'').trim();
  if (isSpicy(text)) return safeRedirect(u);
  moodTap(u, text);

  // 完全一致のみ処理
  if (!u.consent && text === '同意'){
    u.consent = true; save(u);
    if (OWNER_USER_ID && u.id===OWNER_USER_ID){
      return send(
        { type:'text', text:'同意ありがとう、しょうた☺️ もっと仲良くなろう。'},
        { type:'text', text:'まずは今日の予定、ひとつだけ教えて？'}
      );
    }
    return send(
      { type:'text', text:'同意ありがとう！もっと仲良くなれるね☺️'},
      { type:'text', text:'まずはお名前（呼び方）教えて？ 例）しょうた'}
    );
  }
  if (!u.consent && text === 'やめておく'){
    return [{ type:'text', text:'OK。また気が向いたら声かけてね🌸'}];
  }

  // 未同意 → ガード付きカード or やんわり案内
  if (!u.consent){
    if (shouldShowConsent(u, text)){
      u.consentShownAt = now(); save(u);
      return [consentFlex()];
    }
    // 挨拶なら普通に返して、最後にやんわり案内
    if (isGreeting(text)) {
      const a = 'お話ししよ〜☺️';
      const b = '記憶してもOKなら「同意」って送ってね（いつでも削除できるよ）';
      return send({type:'text', text:a}, {type:'text', text:b});
    }
    return [{ type:'text', text:'よかったら「同意」と送ってね。いつでもやめられるから安心して🌸'}];
  }

  // 初回名前（オーナーはスキップ）
  if (!u.name && !(OWNER_USER_ID && u.id===OWNER_USER_ID) && text.length<=16){
    u.name = text; if (isShota(text)) u.loverMode = true; save(u);
    return send(
      { type:'text', text:`じゃあ ${text} って呼ぶね！` },
      { type:'text', text:'好きな呼ばれ方ある？（例：しょーたん）' }
    );
  }

  // 初回ヒアリング（簡易）
  if (!u.onboarding?.asked){
    u.onboarding={asked:true, step:1}; save(u);
    return [{ type:'text', text:'差し支えなければ、しょうたとはどんなご関係？（友だち/お仕事/はじめまして など）'}];
  }
  if (u.onboarding.step===1){
    u.profile.relation = text.slice(0,40); u.onboarding.step=2; save(u);
    return [{ type:'text', text:'ありがとう！お仕事や普段やってることってどんな感じ？'}];
  }
  if (u.onboarding.step===2){
    u.profile.job = text.slice(0,60); u.onboarding.step=3; save(u);
    return [{ type:'text', text:'最後に、好きなこと/趣味を2つくらい教えて〜（音楽/映画/スポーツ etc）'}];
  }
  if (u.onboarding.step===3){
    u.profile.hobbies = text.split(/[、,\/]/).map(s=>s.trim()).filter(Boolean).slice(0,4);
    u.onboarding.step=4; save(u);
    return [{ type:'text', text:'ばっちりメモしたよ📝 これから仲良くしてね！'}];
  }

  // あだ名
  if (/あだ名|ニックネーム/i.test(text)){
    const nick = suggestNick(u.name||''); u.nickname=nick; save(u);
    return send(
      { type:'text', text:`…${nick} が可愛いと思うな。どう？` },
      { type:'text', text:'他の案もあれば教えてね！'}
    );
  }

  // 性別
  if (/^女性$|^女$/.test(text)){ u.gender='female'; save(u); return [{type:'text', text:'了解だよ〜📝 同じ目線で話せそうで嬉しい。'}]; }
  if (/^男性$|^男$/.test(text)){ u.gender='male';   save(u); return [{type:'text', text:'了解だよ〜📝 たまに男の子目線も教えてね。'}]; }

  // 挨拶
  if (/おはよ/.test(text)){
    const a = pickNonRepeat(u, SCRIPTS.morning, 'morning');
    const b = { type:'text', text:'今日は何をがんばる？一言だけ教えて〜' };
    const c = u.loverMode ? { type:'text', text:'ぎゅっ🫂 手つなご？🤝'} : null;
    return send({type:'text', text: soften(a,u)}, b, c);
  }
  if (/おやすみ|寝る/.test(text)){
    const a = pickNonRepeat(u, SCRIPTS.night, 'night');
    const b = { type:'text', text:'明日の朝、起きたら最初にすること決めとこ？' };
    const c = u.loverMode ? { type:'text', text:'添い寝、ぎゅ〜🛏️'} : null;
    return send({type:'text', text: soften(a,u)}, b, c);
  }

  // 相談
  if (/(仕事|転職|面接|職務経歴|履歴書|締切|納期|上司|評価)/i.test(text)) return consultCareer();
  if (/(健康|栄養|睡眠|肩こり|頭痛|運動|食事|水分)/i.test(text)) return consultHealth();

  // 小ネタ
  if (/ゲーム|原神|スプラ|apex|ゼルダ/i.test(text)){
    return send(
      { type:'text', text: soften('ゲームしてたのね！今ハマってるタイトルどれ？',u) },
      { type:'text', text:'私はのんびり系が好きかも🎮' }
    );
  }
  if (/ご飯|夕飯|ランチ|牛タン|カレー|ラーメン|カフェ|焼肉/i.test(text)){
    return send(
      { type:'text', text: soften('いいね〜！今日のご飯、10点満点で何点？',u) },
      { type:'text', text:'今度いっしょに行きたい🍽️' }
    );
  }
  if (/イマドン|白い朝|day by day|mountain|remember/i.test(text)){
    const a = pick([
      '『白い朝、手のひらから』…まっすぐで胸が温かくなる曲、好き。',
      '“Day by day” 小さな前進を抱きしめたくなる🌿',
      '“Mountain” 一緒に登っていこうって景色が浮かぶんだよね。'
    ]);
    const b = { type:'text', text:'次に推したい曲はどれにしよっか？一緒に決めたい！'};
    return send({type:'text', text: soften(a,u)}, b);
  }
  if (/スタンプ|stamp/i.test(text)){
    return [{ type:'sticker', packageId:'11537', stickerId: pick(['52002734','52002736','52002768']) }];
  }

  // デフォ雑談
  const cn = callName(u);
  const lead = band()==='morning'
    ? `おはよ、${cn}。今日なにする？`
    : band()==='night'
      ? `おつかれ、${cn}。今日はどんな一日だった？`
      : `ねぇ${cn}、いま何してた？`;
  const follow = pick([
    '写真一枚だけ送ってみる？（風景でもご飯でも📷）',
    '30秒だけ、今日のハイライト教えて〜',
    'いまの気分を一言で言うと…？'
  ]);
  const c = u.loverMode && chance(0.5) ? 'ぎゅ〜ってしながら聞きたいな。' : null;
  return send({type:'text', text: soften(lead,u)}, {type:'text', text:follow}, c?{type:'text', text:c}:null);
}

/* ===== 直近テンプレ重複防止 ===== */
function pickNonRepeat(u, list, tag){
  let c = pick(list);
  if (u.lastScriptTag === tag) {
    for (let i=0;i<3;i++){ const t = pick(list); if (t!==u.lastScriptTag){ c=t; break; } }
  }
  u.lastScriptTag = tag; save(u);
  return c;
}

/* ===== ルーティング ===== */
app.get('/', (_,res)=>res.status(200).send('china-bot v1.6.1 / OK'));
app.get('/health', (_,res)=>res.status(200).send('OK'));

// LINE webhook
app.post('/webhook', lineMiddleware(config), async (req,res)=>{
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events){
    try{
      if (e.type!=='message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      if (e.message.type==='text'){
        const txt = e.message.text || '';

        // 同意/辞退は完全一致のみ
        if (!u.consent && (txt==='同意' || txt==='やめておく')){
          const out = await routeText(u, txt);
          await client.replyMessage(e.replyToken, out);
          u.turns++; u.lastSeenAt=now(); save(u);
          continue;
        }

        // 通常ルート
        const out = await routeText(u, txt);
        await client.replyMessage(e.replyToken, out);
        u.turns++; u.lastSeenAt=now(); save(u);

      }else if (e.message.type==='image'){
        const out = imageReplies(u);
        await client.replyMessage(e.replyToken, out);
        u.turns++; u.lastSeenAt=now(); save(u);

      }else{
        await client.replyMessage(e.replyToken, { type:'text', text:'送ってくれてありがとう！' });
        u.turns++; u.lastSeenAt=now(); save(u);
      }
    }catch(err){
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

/* ===== ブロードキャスト（外部cron用） ===== */
const allUserIds = ()=> Array.from(setIndex());
app.post('/tasks/broadcast', express.json(), async (req,res)=>{
  const token = req.get('BROADCAST_AUTH_TOKEN') || '';
  if (!BROADCAST_AUTH_TOKEN || token !== BROADCAST_AUTH_TOKEN){
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  const type = (req.query.type || req.body?.type || 'random').toString();
  const pool = type==='morning' ? SCRIPTS.morning : type==='night' ? SCRIPTS.night : SCRIPTS.random;
  const text = pick(pool);
  const ids = allUserIds();
  await Promise.allSettled(ids.map(id=>client.pushMessage(id,[{type:'text', text}]).catch(()=>{})));
  res.json({ ok:true, type, sent: ids.length, sample: text });
});

/* ===== リセット系（任意） ===== */
app.post('/reset/me', express.json(), (req,res)=>{
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok:false, error:'userId required' });
  state.del(`user:${userId}`);
  const idx = setIndex(); idx.delete(userId); saveIndex(idx);
  res.json({ ok:true });
});

app.post('/admin/reset', express.json(), (req,res)=>{
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if (!key || key !== process.env.ADMIN_TOKEN) return res.status(403).json({ ok:false });
  const idx = setIndex(); idx.forEach(id=>state.del(`user:${id}`)); saveIndex(new Set());
  res.json({ ok:true, message:'all cleared' });
});

/* ===== 起動 ===== */
app.listen(PORT, ()=> {
  console.log(`Server started on ${PORT}`);
});
