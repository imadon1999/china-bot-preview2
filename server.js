// server.js — Shiraishi China Bot (v1.5 完成版)
// 依存: express, dotenv, @line/bot-sdk, node-cache
// package.json は "type":"module" を推奨

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

/* =======================
 * 基本設定
 * ======================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET,
};
const OWNER_USER_ID        = process.env.OWNER_USER_ID || '';        // しょうたさんのLINE User ID
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || '';
const PORT = process.env.PORT || 10000;

const app    = express();
const client = new Client(config);

/* =======================
 * 状態（簡易メモリ）
 * ======================= */
const state = new NodeCache({ stdTTL: 60*60*24*7, checkperiod: 120 });

function userIndex() { return new Set(state.get('user:index') || []); }
function saveUserIndex(set) { state.set('user:index', Array.from(set)); }

/* =======================
 * ユーティリティ
 * ======================= */
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance  = (p=0.5) => Math.random() < p;
const nowHour = () => new Date().getHours();
const timeBand = () => (nowHour()<5?'midnight':nowHour()<12?'morning':nowHour()<18?'day':'night');
const isShota = (s='') => /しょうた|ショウタ|shota|imadon/i.test(s);

/* =======================
 * 台本（朝10・夜10・ランダム10） v1から継承
 * ======================= */
const SCRIPTS = {
  morning: [
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きた？ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ！ 今日も大好きって言ってから一日始めたかったの…😊',
    'しょうた、おはよ。昨日の夢にね、しょうた出てきたんだ…えへへ',
    'おはよー！ しょうた、朝ごはん食べた？ 私と一緒に食べたかったなぁ',
    'しょうた、おはよ💓 ちゃんと起きれてえらいね。ご褒美になでなでしてあげる〜',
    'おはよ！ しょうた、今日は何か楽しみある？ あったら絶対教えてね',
    'しょうた、おはよ〜。私ね、朝のしょうたの声が一番好きかも',
    'おはよ、しょうた！ 昨日より今日、もっと好きになっちゃった…'
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
    'しょうた、眠る前に一言だけ…愛してるよ'
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
    'しょうた、会えない時間ってどうしてこんなに長く感じるんだろうね'
  ]
};

/* =======================
 * 同意カード & QuickReply
 * ======================= */
function consentFlex() {
  return {
    type: 'flex',
    altText: 'プライバシー同意のお願い',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold' },
          { type: 'text', wrap: true, size: 'sm',
            text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上のためだけに使い、いつでも削除OK。' }
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'md',
        contents: [
          { type:'button', style:'primary', color:'#6C8EF5', action:{ type:'message', label:'同意してはじめる', text:'同意' } },
          { type:'button', style:'secondary', action:{ type:'message', label:'やめておく', text:'やめておく' } }
        ]
      }
    }
  };
}

function quick(items) {
  return {
    items: items.map(text => ({
      type: 'action',
      action: { type: 'message', label: text, text }
    }))
  };
}

/* =======================
 * ユーザー状態
 * ======================= */
function displayCall(u) {
  if (OWNER_USER_ID && u.id === OWNER_USER_ID) return 'しょうた';
  return u.nickname || u.name || 'きみ';
}
function suggestNick(baseName='') {
  const base = (baseName || 'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4) || 'きみ';
  const cands = [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`];
  if (isShota(baseName)) cands.unshift('しょーたん', 'しょたぴ', 'しょうちゃん');
  return pick(cands);
}

async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;
  let u = state.get(`user:${id}`);
  if (!u) {
    let name = '';
    try { const p = await client.getProfile(id); name = p?.displayName || ''; } catch {}
    u = {
      id, name,
      nickname: null,
      gender: null,
      consent: false,
      loverMode: !!(OWNER_USER_ID && id === OWNER_USER_ID) || isShota(name),
      mood: 60,                         // 0-100（簡易感情）
      onboarding: { asked: false, step: 0 }, // 友だち初回ヒアリング
      profile: { relation:'', job:'', hobbies:[] },
      lastSeenAt: Date.now()
    };
    state.set(`user:${id}`, u);
    const idx = userIndex(); idx.add(id); saveUserIndex(idx);
  }
  return u;
}
const saveUser = (u) => state.set(`user:${u.id}`, u);

/* =======================
 * ミニ感情モデル（語句で mood を上下）
 * ======================= */
function applyMood(u, text) {
  const down = /(つら|しんど|疲れ|寂し|ムリ|最悪|泣)/i.test(text);
  const up   = /(嬉し|たのし|最高|助か|よかった|大好き)/i.test(text);
  if (down) u.mood = Math.max(0, u.mood - 10);
  if (up)   u.mood = Math.min(100, u.mood + 10);
  saveUser(u);
}

function soften(text, u) {
  // mood が低いほど絵文字増やさず優しめ、loverMode で追いメッセ
  const tail = u.loverMode
    ? (u.mood<40 ? ' となりにいるよ…🫂' : ' ぎゅ…🫂')
    : (u.mood<40 ? ' まずは深呼吸しよ。' : '');
  return text + tail;
}

/* =======================
 * セーフティ（ソフトに受け止め→節度ある誘導）
 * ======================= */
function isSpicy(t) {
  return /(えっち|エッチ|性的|キスして|抱いて|添い寝して|脚で|フェチ|足で)/i.test(t);
}
function safeRedirect(u) {
  const a = 'その気持ちを大事に受けとるね。';
  const b = u.loverMode
    ? 'もうちょっとだけ節度を守りつつ、ふたりの時間を大事にしよ？'
    : 'ここではやさしい距離感でお話ししようね。';
  const c = '例えば「手つなごう」とか「となりでお話したい」なら嬉しいな。';
  return [{ type:'text', text: `${a} ${b}` }, { type:'text', text: c }];
}

/* =======================
 * 相談テンプレ（仕事/転職/健康）
 * ======================= */
function consultCareer() {
  return [
    { type:'text', text:'いまの状況を一緒に整理しよ📝 次の3つを1行ずつ教えてみて？' },
    { type:'text', text:'① 現職の不満（例：残業多い）\n② ほしい条件（例：週3リモート）\n③ 期限感（例：3ヶ月以内）',
      quickReply: quick(['整理→質問して','共感→聞いてほしい','解決案→提案して']) }
  ];
}
function consultHealth() {
  return [
    { type:'text', text:'健康の話、いいね。まずは生活の土台をチェックしよ☑️' },
    { type:'text', text:'睡眠 / 水分 / 食事 / 運動 の4つで、いちばん整えたいのはどれ？',
      quickReply: quick(['睡眠','水分','食事','運動']) }
  ];
}

/* =======================
 * 友だち初回ヒアリング（任意）
 * ======================= */
function onboardingStep(u, text) {
  // 同意後、最初の数往復だけ軽く質問して記憶
  const st = u.onboarding || { asked:false, step:0 };
  if (!st.asked) {
    st.asked = true; st.step = 1; u.onboarding = st; saveUser(u);
    return [{ type:'text', text:'差し支えなければ、しょうたとはどんなご関係？（友だち/お仕事/はじめまして etc）' }];
  }
  if (st.step === 1) {
    u.profile.relation = (text||'').slice(0,40);
    st.step = 2; u.onboarding = st; saveUser(u);
    return [{ type:'text', text:'ありがとう！お仕事や普段やってることってどんな感じ？' }];
  }
  if (st.step === 2) {
    u.profile.job = (text||'').slice(0,60);
    st.step = 3; u.onboarding = st; saveUser(u);
    return [{ type:'text', text:'最後に、好きなこと/趣味を2つくらい教えて〜（音楽/映画/スポーツ etc）' }];
  }
  if (st.step === 3) {
    const hs = (text||'').split(/[、,\/]/).map(s=>s.trim()).filter(Boolean).slice(0,4);
    u.profile.hobbies = hs; st.step = 4; u.onboarding = st; saveUser(u);
    return [{ type:'text', text:'ばっちりメモしたよ📝 これから仲良くしてね！' }];
  }
  return null;
}

/* =======================
 * 返答ルーター（体感長め＋意図判定＋相談強化）
 * ======================= */
const send2 = (...m) => m.filter(Boolean);

async function routeText(u, t) {
  const text = (t || '').trim();
  applyMood(u, text);
  if (isSpicy(text)) return safeRedirect(u);

  // 同意フロー
  if (!u.consent && /^同意$/i.test(text)) {
    u.consent = true; saveUser(u);
    // オーナーは呼び方スキップ
    if (OWNER_USER_ID && u.id === OWNER_USER_ID) {
      return send2(
        { type:'text', text:'同意ありがとう、しょうた☺️ もっと仲良くなろうね。' },
        { type:'text', text:'まずは今日の予定、ひとつだけ教えて？' }
      );
    }
    return send2(
      { type:'text', text:'同意ありがとう！もっと仲良くなれるね☺️' },
      { type:'text', text:'まずはお名前（呼び方）教えて？ 例）しょうた' }
    );
  }
  if (!u.consent && /やめておく/i.test(text)) {
    return [{ type:'text', text:'OK。また気が向いたら声かけてね🌸'}];
  }
  if (!u.consent) return [consentFlex()];

  // 初回の名前登録（オーナーは固定）
  if (!u.name && !(OWNER_USER_ID && u.id === OWNER_USER_ID) && text.length <= 16) {
    u.name = text;
    if (isShota(text)) u.loverMode = true;
    saveUser(u);
    return send2(
      { type:'text', text:`じゃあ ${text} って呼ぶね！` },
      { type:'text', text:'好きな呼ばれ方ある？（例：しょーたん）' }
    );
  }

  // 友だち初回ヒアリング（同意後〜数ターン）
  const ob = onboardingStep(u, text);
  if (ob) return ob;

  // あだ名
  if (/あだ名|ニックネーム/i.test(text)) {
    const nick = suggestNick(u.name || '');
    u.nickname = nick; saveUser(u);
    return send2(
      { type:'text', text:`…${nick} が可愛いと思うな。どう？` },
      { type:'text', text:'他の案もあれば教えてね！' }
    );
  }

  // 性別メモ（任意）
  if (/^女$|^女性$/.test(text)) { u.gender='female'; saveUser(u); return [{ type:'text', text:'了解だよ〜📝 同じ目線でお話しできそうで嬉しい。'}]; }
  if (/^男$|^男性$/.test(text)) { u.gender='male';   saveUser(u); return [{ type:'text', text:'了解だよ〜📝 たまに男の子目線も教えてね。'}]; }

  // 挨拶
  if (/おはよ/.test(text)) {
    const a = pick(['おはよう☀️今日もいちばん応援してる！', 'おはよ〜 深呼吸…すー…はー…🤍']);
    const b = { type:'text', text:'今日は何をがんばる？一言だけ教えて〜' };
    const c = u.loverMode ? { type:'text', text:'ぎゅっ🫂 手つなご？🤝'} : null;
    return send2({ type:'text', text: soften(u.loverMode ? a+' ぎゅっ🫂' : a, u) }, b, c);
  }
  if (/おやすみ|寝る/.test(text)) {
    const a = pick(['今日もえらかったね。ゆっくりおやすみ🌙', 'となりで見守ってるよ。ぐっすり…💤']);
    const b = { type:'text', text:'明日の朝、起きたら最初にすること決めとこ？' };
    const c = u.loverMode ? { type:'text', text:'添い寝、ぎゅ〜🛏️'} : null;
    return send2({ type:'text', text: soften(u.loverMode ? a+' 添い寝、ぎゅ〜🛏️' : a, u) }, b, c);
  }

  // 相談：仕事/転職/面接/締切
  if (/(仕事|転職|面接|職務経歴|履歴書|締切|納期|上司|評価)/i.test(text)) {
    return consultCareer();
  }
  // 相談：健康/栄養/睡眠/肩こり/運動
  if (/(健康|栄養|睡眠|肩こり|頭痛|運動|食事|水分)/i.test(text)) {
    return consultHealth();
  }

  // 小ネタ
  if (/ゲーム|原神|スプラ|apex|ゼルダ/i.test(text)) {
    return send2(
      { type:'text', text: soften('ゲームしてたのね！今ハマってるタイトルどれ？', u) },
      { type:'text', text:'私はのんびり系が好きかも🎮' }
    );
  }
  if (/ご飯|夕飯|ランチ|牛タン|カレー|ラーメン|カフェ|焼肉/i.test(text)) {
    return send2(
      { type:'text', text: soften('いいね〜！今日のご飯、10点満点で何点？', u) },
      { type:'text', text:'今度いっしょに行きたい🍽️' }
    );
  }
  if (/イマドン|白い朝|day by day|mountain|remember/i.test(text)) {
    const a = pick([
      '『白い朝、手のひらから』…まっすぐで胸が温かくなる曲、好き。',
      '“Day by day” 小さな前進を抱きしめたくなる🌿',
      '“Mountain” 一緒に登っていこうって景色が浮かぶんだよね。'
    ]);
    const b = { type:'text', text:'次に推したい曲はどれにしよっか？一緒に決めたい！'};
    return send2({type:'text', text: soften(a, u)}, b);
  }
  if (/スタンプ|stamp/i.test(text)) {
    return [{ type:'sticker', packageId:'11537', stickerId: pick(['52002734','52002736','52002768']) }];
  }

  // デフォルト雑談
  const call = displayCall(u);
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
  return send2({type:'text', text: soften(lead+tail, u)}, {type:'text', text:b}, c?{type:'text', text:c}:null);
}

/* =======================
 * 画像メッセージの分岐（推測＆質問で自然化）
 * ======================= */
function imageReplies(u) {
  const call = displayCall(u);
  const opts = ['ごはん？','風景？','自撮り？','その他'];
  const first = soften(`わぁ、${call}の写真うれしい！`, u);
  const follow = 'どれかな？まちがってても大丈夫だよ〜';
  return [{
    type:'text',
    text:first,
    quickReply: quick(opts)
  },{
    type:'text',
    text:follow
  }];
}

/* =======================
 * ルーティング
 * ======================= */
app.get('/', (_,res)=>res.status(200).send('china-bot v1.5 / OK'));
app.get('/health', (_,res)=>res.status(200).send('OK'));

// LINE webhook（他の body-parser は噛ませない）
app.post('/webhook', lineMiddleware(config), async (req, res) => {
  res.status(200).end();

  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      if (e.message.type === 'text') {
        const txt = e.message.text || '';

        // 未同意：同意/辞退は先に処理
        if (!u.consent && /^(同意|やめておく)$/i.test(txt)) {
          const msgs = await routeText(u, txt);
          await client.replyMessage(e.replyToken, msgs);
          continue;
        }
        // 未同意：カード返し
        if (!u.consent) {
          await client.replyMessage(e.replyToken, consentFlex());
          continue;
        }

        const msgs = await routeText(u, txt);
        await client.replyMessage(e.replyToken, msgs);
        u.lastSeenAt = Date.now(); saveUser(u);
      } else if (e.message.type === 'image') {
        const msgs = imageReplies(u);
        await client.replyMessage(e.replyToken, msgs);
        u.lastSeenAt = Date.now(); saveUser(u);
      } else {
        await client.replyMessage(e.replyToken, {
          type:'text',
          text: soften('送ってくれてありがとう！', u)
        });
        u.lastSeenAt = Date.now(); saveUser(u);
      }
    } catch (err) {
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

/* =======================
 * ブロードキャスト（cron）
 * ======================= */
function allUserIds() { return Array.from(userIndex()); }

app.post('/tasks/broadcast', express.json(), async (req, res) => {
  const token = req.get('BROADCAST_AUTH_TOKEN') || '';
  if (!BROADCAST_AUTH_TOKEN || token !== BROADCAST_AUTH_TOKEN) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  const type = (req.query.type || req.body?.type || 'random').toString();
  const pool = type === 'morning' ? SCRIPTS.morning
             : type === 'night'   ? SCRIPTS.night
             : SCRIPTS.random;
  const text = pick(pool);

  const ids = allUserIds();
  const tasks = ids.map(id => client.pushMessage(id, [{ type:'text', text }]).catch(()=>{}));
  await Promise.allSettled(tasks);
  res.json({ ok:true, type, sent: ids.length, sample: text });
});

/* =======================
 * 起動
 * ======================= */
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
