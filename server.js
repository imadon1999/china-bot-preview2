// server.js  — ESM版（package.jsonの "type":"module" を忘れずに）
import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

// ========= 基本設定 =========
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET
};
const app    = express();
const client = new Client(config);

// LINE署名エラー対策：@line/bot-sdk の middleware だけを使う（他の bodyParser を噛ませない）
app.get('/', (_,res)=>res.status(200).send('china-bot-preview2 / OK'));
app.get('/health', (_,res)=>res.status(200).send('OK'));

const state = new NodeCache({ stdTTL: 60*60*24*7, checkperiod: 120 });
// 永続DBがないので、ユーザーIDはメモリ保持（Render再起動で消えます）
function getUserIndex(){
  const ids = state.get('user:index') || [];
  return new Set(ids);
}
function saveUserIndex(set){
  state.set('user:index', Array.from(set));
}

// ========= ユーティリティ =========
const nowHour = () => new Date().getHours();
const pick    = (arr)=>arr[Math.floor(Math.random()*arr.length)];
const chance  = (p=0.5)=>Math.random()<p;
const timeBand = ()=>{
  const h = nowHour();
  if (h < 5)  return 'midnight';
  if (h < 12) return 'morning';
  if (h < 18) return 'day';
  return 'night';
};
const isShota = (name='') => /しょうた|ショウタ|shota|imadon/i.test(name);

// 1reply=最大5メッセージまで
const reply = (token, messages=[])=>{
  const arr = Array.isArray(messages) ? messages : [messages];
  return client.replyMessage(token, arr.slice(0,5));
};
const send2 = (a,b,c)=>[a,b,c].filter(Boolean);

// ========= ユーザー管理 =========
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';
async function ensureUser(ctx){
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;
  let u = state.get(`user:${id}`);
  if (!u){
    let name = '';
    try { const p = await client.getProfile(id); name = p?.displayName || ''; } catch {}
    u = {
      id, name,
      gender: null,
      nickname: null,
      consent: false,
      intimacy: 30,
      loverMode: false,
      lastSeenAt: Date.now()
    };
    if ((name && isShota(name)) || (OWNER_USER_ID && id===OWNER_USER_ID)) u.loverMode = true;
    state.set(`user:${id}`, u);
    const idx = getUserIndex(); idx.add(id); saveUserIndex(idx);
  }
  return u;
}
function saveUser(u){ if (u?.id) state.set(`user:${u.id}`, u); }

// ========= 同意カード =========
function consentFlex(){
  return {
    type: 'flex',
    altText: 'プライバシー同意のお願い',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight:'bold' },
          { type: 'text', wrap:true, size:'sm',
            text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。' },
          { type: 'text', text:'プライバシーポリシー', weight:'bold' },
          { type: 'text', wrap:true, size:'sm',
            text:'記憶は会話向上のためだけに使い、第三者提供しません。いつでも削除OK。全文はプロフィールURLへ。' }
        ]
      },
      footer:{
        type:'box', layout:'horizontal', spacing:'md',
        contents:[
          { type:'button', style:'primary', color:'#6C8EF5',
            action:{ type:'message', label:'同意してはじめる', text:'同意' } },
          { type:'button', style:'secondary',
            action:{ type:'message', label:'やめておく', text:'やめておく' } }
        ]
      }
    }
  };
}

// ========= ニックネーム提案 =========
function suggestNick(baseName=''){
  const base = (baseName || 'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4) || 'きみ';
  const cands = [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`];
  if (isShota(baseName)) cands.unshift('しょーたん','しょたぴ','しょうちゃん');
  return pick(cands);
}

// ========= 主要ルーター（複数バブル＋フォロー質問で“体感長め”） =========
async function routeText(u, t){
  const text = (t||'').trim();

  // --- 同意フロー ---
  if (!u.consent && /^同意$/i.test(text)){
    u.consent = true; saveUser(u);
    return send2(
      { type:'text', text:'同意ありがとう！もっと仲良くなれるね☺️' },
      { type:'text', text:'まずはお名前（呼び方）教えて？ 例）しょうた' }
    );
  }
  if (!u.consent && /やめておく/i.test(text)){
    return [{ type:'text', text:'OK。また気が向いたら声かけてね🌸'}];
  }
  if (!u.consent) return [consentFlex()];

  // --- 初回の名前登録 ---
  if (!u.name && text.length <= 16){
    u.name = text;
    if (isShota(text)) u.loverMode = true;
    saveUser(u);
    const follow = chance(0.8)
      ? { type:'text', text:'好きな呼ばれ方ある？（例：しょーたん）' }
      : null;
    return send2(
      { type:'text', text:`じゃあ ${text} って呼ぶね！` },
      follow
    );
  }

  // --- あだ名 ---
  if (/あだ名|ニックネーム/i.test(text)){
    const nick = suggestNick(u.name || '');
    u.nickname = nick; saveUser(u);
    return send2(
      { type:'text', text:`…${nick} が可愛いと思うな。どう？` },
      { type:'text', text:'他の案もあれば教えてね！'}
    );
  }

  // --- 性別メモ（任意） ---
  if (/^女$|^女性$/.test(text)){ u.gender='female'; saveUser(u);
    return [{ type:'text', text:'了解だよ〜📝 同じ目線でお話しできそうで嬉しい。'}]; }
  if (/^男$|^男性$/.test(text)){ u.gender='male';   saveUser(u);
    return [{ type:'text', text:'了解だよ〜📝 たまに男の子目線も教えてね。'}]; }

  // --- 時間帯挨拶 ---
  if (/おはよ/.test(text)){
    const a = pick(['おはよう☀️今日もいちばん応援してる！','おはよ〜 深呼吸…すー…はー…🤍']);
    const b = { type:'text', text: '今日は何をがんばる？一言だけ教えて〜' };
    const c = u.loverMode ? { type:'text', text:'ぎゅっ🫂 手つなご？🤝'} : null;
    return send2({ type:'text', text: u.loverMode ? a+' ぎゅっ🫂' : a }, b, c);
  }
  if (/おやすみ|寝る/.test(text)){
    const a = pick(['今日もえらかったね。ゆっくりおやすみ🌙','となりで見守ってるよ。ぐっすり…💤']);
    const b = { type:'text', text:'明日の朝、起きたら最初にすること決めとこ？'};
    const c = u.loverMode ? { type:'text', text:'添い寝、ぎゅ〜🛏️'} : null;
    return send2({ type:'text', text: u.loverMode ? a+' 添い寝、ぎゅ〜🛏️' : a }, b, c);
  }

  // --- 気分・悩み系 ---
  if (/寂しい|さびしい|つらい|しんど|疲れた/i.test(text)){
    const a = u.gender==='female'
      ? 'わかる…その気持ち。まず私が味方だよ。'
      : 'ここにいるよ。深呼吸して、ゆっくり話そ。';
    const b = { type:'text', text:'いま一番しんどいの、1文で教えてくれる？' };
    const c = chance(0.6)?{ type:'text', text:'必要なら「整理」「共感」「解決案」どれが欲しいか合図してね📝'}:null;
    return send2({type:'text',text:a}, b, c);
  }

  // --- ドメイン小トピック ---
  if (/ゲーム|原神|スプラ|APEX|ゼルダ/i.test(text)){
    return send2(
      { type:'text', text:'ゲームしてたのね！今ハマってるタイトルどれ？' },
      { type:'text', text:'私はのんびり系が好きかも🎮'}
    );
  }
  if (/ご飯|夕飯|ランチ|牛タン|カレー|ラーメン|カフェ/i.test(text)){
    return send2(
      { type:'text', text:'いいね〜！今日のご飯、10点満点で何点？' },
      { type:'text', text:'今度いっしょに行きたい🍽️'}
    );
  }
  if (/仕事|バイト|転職|面接|締切|納期/i.test(text)){
    return send2(
      { type:'text', text:'おつかれさま…！今は「整理」「共感」「解決案」どれが欲しい？'},
      { type:'text', text:'要約でOK、30秒で状況だけ教えてみて📝'}
    );
  }

  // --- 楽曲（イマドン） ---
  if (/イマドン|白い朝|Day by day|Mountain|remember/i.test(text)){
    const a = pick([
      '『白い朝、手のひらから』…まっすぐで胸が温かくなる曲、好き。',
      '“Day by day” 小さな前進を抱きしめたくなる🌿',
      '“Mountain” 一緒に登っていこうって景色が浮かぶんだよね。'
    ]);
    const b = { type:'text', text:'次に推したい曲はどれにしよっか？一緒に決めたい！'};
    return send2({type:'text',text:a}, b);
  }

  // --- スタンプ要請 ---
  if (/スタンプ|stamp/i.test(text)){
    return [{ type:'sticker', packageId:'11537', stickerId: pick(['52002734','52002736','52002768']) }];
  }

  // --- デフォルト雑談（長め） ---
  const call = u.nickname || u.name || 'きみ';
  const band = timeBand();
  const lead = band==='morning'
    ? `おはよ、${call}。今日なにする？`
    : band==='night'
      ? `おつかれ、${call}。今日はどんな一日だった？`
      : `ねぇ${call}、いま何してた？`;
  const tail = u.loverMode
    ? pick([' となりでぎゅ…🫂',' ずっと味方だよ💗',' 手つなご？🤝'])
    : pick([' ちょっと休憩しよ〜',' 水分補給した？',' 無理しすぎないでね。']);
  const b = pick([
    '写真一枚だけ送ってみる？（風景でもご飯でも📷）',
    '30秒だけ、今日のハイライト教えて〜',
    'いまの気分を一言で言うと…？'
  ]);
  const c = u.loverMode && chance(0.5) ? 'ぎゅ〜ってしながら聞きたいな。' : null;
  return send2({type:'text', text: lead+tail}, {type:'text', text:b}, c?{type:'text', text:c}:null);
}

// ========= Webhook =========
app.post('/webhook', lineMiddleware(config), async (req, res)=>{
  res.status(200).end(); // LINEには即200
  const events = req.body.events || [];
  for (const e of events){
    try{
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      // 同意フロー最優先（短文トリガー）
      if (e.message.type === 'text'){
        const txt = e.message.text || '';
        if (!u.consent && /^(同意|やめておく)$/i.test(txt)){
          return await reply(e.replyToken, await routeText(u, txt));
        }
        if (!u.consent){
          return await reply(e.replyToken, consentFlex());
        }
        const messages = await routeText(u, txt);
        await reply(e.replyToken, messages);
        u.lastSeenAt = Date.now(); saveUser(u);
        continue;
      }

      // 画像/スタンプなど
      await reply(e.replyToken, { type:'text', text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！' });
      u.lastSeenAt = Date.now(); saveUser(u);
    }catch(err){
      console.error('handle error', err?.response?.data || err);
    }
  }
});

// ========= セルフリセット（ユーザーから送る用） =========
app.post('/reset/me', express.json(), async (req, res)=>{
  try{
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:'userId required' });
    state.del(`user:${userId}`);
    const idx = getUserIndex(); idx.delete(userId); saveUserIndex(idx);
    return res.json({ ok:true });
  }catch(e){ return res.status(500).json({ ok:false }); }
});

// ========= 管理者用リセット =========
app.post('/admin/reset', express.json(), (req,res)=>{
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if (!key || key !== process.env.ADMIN_TOKEN) return res.status(403).json({ ok:false });
  const idx = getUserIndex(); idx.forEach(id=>state.del(`user:${id}`)); saveUserIndex(new Set());
  return res.json({ ok:true, message:'all cleared' });
});

// ========= ブロードキャスト（cron-job.orgから叩く） =========
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || '';
function authBroadcast(req){
  const v = req.header('BROADCAST_AUTH_TOKEN') || req.query.key;
  return v && v === BROADCAST_AUTH_TOKEN;
}
const morningTemplates = [
  'おはよう☀️ まずは深呼吸…すー…はー…🤍 今日やること、ひとつだけ決めよ！',
  'おはよ〜！コーヒー淹れた？私はとなりで応援してるよ📣'
];
const nightTemplates = [
  '今日もえらかったね。お風呂→保湿→ストレッチで、ととのえてから寝よ🌙',
  '電源OFFの時間だよ〜。おやすみのぎゅっ🫂'
];
const randomNudges = [
  '水分補給した？コップ一杯だけでもごくごく〜🚰',
  '進捗1個だけ教えて？小さくても十分えらい！',
  '最近撮ったお気に入り写真、1枚ちょうだい📷'
];

app.post('/tasks/broadcast', express.json(), async (req,res)=>{
  if (!authBroadcast(req)) return res.status(403).json({ ok:false });
  const type = (req.query.type || req.body?.type || 'random').toString();

  const ids = Array.from(getUserIndex());
  const text =
    type==='morning' ? pick(morningTemplates) :
    type==='night'   ? pick(nightTemplates)   :
    pick(randomNudges);

  // まとめてpush（失敗は握りつぶして継続）
  await Promise.all(ids.map(id=>{
    return client.pushMessage(id, [{ type:'text', text }]).catch(()=>{});
  }));
  res.json({ ok:true, sent: ids.length, type, preview: text });
});

// ========= サーバ起動 =========
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> {
  console.log(`Server started on ${PORT}`);
  console.log('Your service is live 🚀');
});
