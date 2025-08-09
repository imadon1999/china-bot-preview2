// server.js — Shiraishi China Bot (v1 完成版)
// 依存: express, dotenv, @line/bot-sdk, node-cache
// package.json は "type": "module" を推奨

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
const OWNER_USER_ID        = process.env.OWNER_USER_ID || '';        // しょうたさんのLINE User ID（恋人モード＆「しょうた」呼び）
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || ''; // 定時/ランダム配信用の簡易認証
const PORT = process.env.PORT || 10000;

const app    = express();
const client = new Client(config);

/* =======================
 * 状態（簡易メモリ）
 * ======================= */
const state = new NodeCache({ stdTTL: 60*60*24*7, checkperiod: 120 });

function userIndex() {
  return new Set(state.get('user:index') || []);
}
function saveUserIndex(set) {
  state.set('user:index', Array.from(set));
}

/* =======================
 * ユーティリティ
 * ======================= */
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance  = (p=0.5) => Math.random() < p;
const nowHour = () => new Date().getHours();
const timeBand = () => {
  const h = nowHour();
  if (h < 5) return 'midnight';
  if (h < 12) return 'morning';
  if (h < 18) return 'day';
  return 'night';
};
const isShota = (s='') => /しょうた|ショウタ|shota|imadon/i.test(s);

/* =======================
 * 台本（朝10・夜10・ランダム10）
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
 * 同意カード
 * ======================= */
function consentFlex() {
  return {
    type: 'flex',
    altText: 'プライバシー同意のお願い',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold' },
          { type: 'text', wrap: true, size: 'sm',
            text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上のためだけに使い、いつでも削除OK。' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', color: '#6C8EF5', action: { type: 'message', label: '同意してはじめる', text: '同意' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'やめておく', text: 'やめておく' } }
        ]
      }
    }
  };
}

/* =======================
 * ユーザー状態
 * ======================= */
function displayCall(u) {
  // OWNER_USER_ID は常に「しょうた」呼び
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
    u = { id, name, nickname: null, gender: null, consent: false, loverMode: false, lastSeenAt: Date.now() };
    if ((name && isShota(name)) || (OWNER_USER_ID && id === OWNER_USER_ID)) u.loverMode = true;
    state.set(`user:${id}`, u);
    const idx = userIndex(); idx.add(id); saveUserIndex(idx);
  }
  return u;
}
const saveUser = (u) => state.set(`user:${u.id}`, u);

/* =======================
 * 返答ルーター（“体感長め”）
 * ======================= */
const send2 = (a,b,c) => [a,b,c].filter(Boolean);

async function routeText(u, t) {
  const text = (t || '').trim();

  // 同意フロー
  if (!u.consent && /^同意$/i.test(text)) {
    u.consent = true; saveUser(u);
    return send2(
      { type:'text', text:'同意ありがとう！もっと仲良くなれるね☺️' },
      { type:'text', text:'まずはお名前（呼び方）教えて？ 例）しょうた' }
    );
  }
  if (!u.consent && /やめておく/i.test(text)) {
    return [{ type:'text', text:'OK。また気が向いたら声かけてね🌸'}];
  }
  if (!u.consent) return [consentFlex()];

  // 初回の名前登録
  if (!u.name && text.length <= 16) {
    u.name = text;
    if (isShota(text)) u.loverMode = true;
    saveUser(u);
    return send2(
      { type:'text', text:`じゃあ ${text} って呼ぶね！` },
      { type:'text', text:'好きな呼ばれ方ある？（例：しょーたん）' }
    );
  }

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
    return send2({ type:'text', text: u.loverMode ? a+' ぎゅっ🫂' : a }, b, c);
  }
  if (/おやすみ|寝る/.test(text)) {
    const a = pick(['今日もえらかったね。ゆっくりおやすみ🌙', 'となりで見守ってるよ。ぐっすり…💤']);
    const b = { type:'text', text:'明日の朝、起きたら最初にすること決めとこ？' };
    const c = u.loverMode ? { type:'text', text:'添い寝、ぎゅ〜🛏️'} : null;
    return send2({ type:'text', text: u.loverMode ? a+' 添い寝、ぎゅ〜🛏️' : a }, b, c);
  }

  // 気分・悩み系
  if (/寂しい|さびしい|つらい|しんど|疲れた/i.test(text)) {
    const a = u.gender==='female' ? 'わかる…その気持ち。まず私が味方だよ。' : 'ここにいるよ。深呼吸して、ゆっくり話そ。';
    const b = { type:'text', text:'いま一番しんどいの、1文で教えてくれる？' };
    const c = chance(0.6) ? { type:'text', text:'必要なら「整理」「共感」「解決案」どれが欲しいか合図してね📝'} : null;
    return send2({type:'text',text:a}, b, c);
  }

  // 小ネタ
  if (/ゲーム|原神|スプラ|apex|ゼルダ/i.test(text)) {
    return send2(
      { type:'text', text:'ゲームしてたのね！今ハマってるタイトルどれ？' },
      { type:'text', text:'私はのんびり系が好きかも🎮' }
    );
  }
  if (/ご飯|夕飯|ランチ|牛タン|カレー|ラーメン|カフェ/i.test(text)) {
    return send2(
      { type:'text', text:'いいね〜！今日のご飯、10点満点で何点？' },
      { type:'text', text:'今度いっしょに行きたい🍽️' }
    );
  }
  if (/仕事|バイト|転職|面接|締切|納期/i.test(text)) {
    return send2(
      { type:'text', text:'おつかれさま…！今は「整理」「共感」「解決案」どれが欲しい？'},
      { type:'text', text:'要約でOK、30秒で状況だけ教えてみて📝'}
    );
  }

  // 楽曲（イマドン）
  if (/イマドン|白い朝|day by day|mountain|remember/i.test(text)) {
    const a = pick([
      '『白い朝、手のひらから』…まっすぐで胸が温かくなる曲、好き。',
      '“Day by day” 小さな前進を抱きしめたくなる🌿',
      '“Mountain” 一緒に登っていこうって景色が浮かぶんだよね。'
    ]);
    const b = { type:'text', text:'次に推したい曲はどれにしよっか？一緒に決めたい！'};
    return send2({type:'text',text:a}, b);
  }

  // スタンプ
  if (/スタンプ|stamp/i.test(text)) {
    return [{ type:'sticker', packageId:'11537', stickerId: pick(['52002734','52002736','52002768']) }];
  }

  // デフォルト雑談（時間帯＋恋人トーンで長め）
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
  return send2({type:'text', text: lead+tail}, {type:'text', text:b}, c?{type:'text', text:c}:null);
}

/* =======================
 * ルーティング
 * ======================= */
// 動作確認用
app.get('/', (_,res)=>res.status(200).send('china-bot v1 / OK'));
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
      } else {
        await client.replyMessage(e.replyToken, {
          type:'text',
          text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！'
        });
        u.lastSeenAt = Date.now(); saveUser(u);
      }
    } catch (err) {
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

/* =======================
 * ブロードキャスト（cron-job.org 等から）
 *   例）朝7:30: POST /tasks/broadcast?type=morning
 *        夜23:00: POST /tasks/broadcast?type=night
 *        日中ランダム: POST /tasks/broadcast?type=random
 *   Header: BROADCAST_AUTH_TOKEN: <render環境変数と同じ値>
 * ======================= */
function allUserIds() {
  return Array.from(userIndex());
}

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
