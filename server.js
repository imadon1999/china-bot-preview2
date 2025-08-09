Server.is かんせーばん！

// server.js — Shiraishi China LINE Bot (natural chat + scheduler + admin reset)
// Node v18+ / ESM

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

/* ========= 基本設定 ========= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);

/* ========= 簡易ストア（メモリ） ========= */
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 }); // 30日
const KNOWN_KEY = 'knownUserIds';
if (!state.get(KNOWN_KEY)) state.set(KNOWN_KEY, new Set());

/* ========= 環境変数 ========= */
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';           // しょうた専用
const TZ = process.env.TZ || 'Asia/Tokyo';
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || ''; // /tasks/broadcast 保護
const ADMIN_RESET_TOKEN = process.env.ADMIN_RESET_TOKEN || '';       // /admin/reset 保護

/* ========= 小ユーティリティ ========= */
const now = () => new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
const hour = () => now().getHours();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const isShotaName = (s='') => /しょうた|ショウタ|shota|imadon/i.test(s);

function getKnownSet() {
  const s = state.get(KNOWN_KEY);
  return s instanceof Set ? s : new Set();
}
function saveKnownSet(s) { state.set(KNOWN_KEY, s); }

function speak(u, text) {
  return u?.loverMode ? `${text} ぎゅっ🫂` : `${text}☺️`;
}

/* ========= ユーザー初期化 ========= */
async function ensureUser(e) {
  const id = e?.source?.userId;
  if (!id) return null;

  // 既知ユーザー補記
  const set = getKnownSet(); set.add(id); saveKnownSet(set);

  let u = state.get(`user:${id}`);
  if (u) return u;

  let displayName = '';
  try { displayName = (await client.getProfile(id))?.displayName || ''; } catch {}

  u = {
    id, displayName,
    name: '',           // 呼び方
    nickname: null,
    gender: null,       // 'male'|'female'|null
    consent: false,
    loverMode: (displayName && isShotaName(displayName)) || (OWNER_USER_ID && id === OWNER_USER_ID),
    intimacy: 35,
    lastSeen: Date.now()
  };
  state.set(`user:${id}`, u);
  return u;
}

/* ========= 同意カード ========= */
function consentFlex() {
  return {
    type: 'flex',
    altText: 'プライバシー同意のお願い',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold', size: 'md' },
          { type: 'text', wrap: true, size: 'sm', text: '自然な会話のため、ニックネーム等を記憶しても良い？' },
          { type: 'text', size: 'xs', color: '#888', wrap: true,
            text: '会話向上のみに使用・第三者提供なし。いつでも削除OK（プロフィールURL参照）。' }
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', color: '#6C8EF5',
            action: { type: 'message', label: '同意してはじめる', text: '同意' } },
          { type: 'button', style: 'secondary',
            action: { type: 'message', label: 'やめておく', text: 'やめておく' } }
        ]
      }
    }
  };
}

/* ========= ニックネーム提案 ========= */
function suggestNick(u) {
  const base = (u.name || u.displayName || 'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4) || 'きみ';
  if (isShotaName(base)) return pick(['しょーたん','しょたぴ','しょうちゃん']);
  return pick([`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}っち`, `${base}ぴ`]);
}

/* ========= 簡易意図判定 ========= */
function detectIntent(text) {
  const t = text.toLowerCase();
  if (/^(同意|やめておく)$/.test(text)) return 'consent';
  if (/あだ名|ニックネーム/.test(t)) return 'nickname';
  if (/(女性|女)\b/.test(t)) return 'gender_female';
  if (/(男性|男)\b/.test(t)) return 'gender_male';
  if (/おはよ|ohayo|morning/.test(t)) return 'greet_morning';
  if (/おやすみ|寝る|good ?night/.test(t)) return 'greet_night';
  if (/寂しい|さびしい|つらい|しんど|疲れた/.test(t)) return 'comfort';
  if (/スタンプ|stamp/.test(t)) return 'sticker';
  if (/イマドン|白い朝|day by day|mountain|i don'?t remember/i.test(t)) return 'music';
  if (/ありがとう|感謝/.test(t)) return 'thanks';
  if (/すき|好き|love/.test(t)) return 'love';
  if (/なにしてた|何してた|今何|いま何/.test(t)) return 'smalltalk';
  if (/^(初期化|リセット|はじめから)$/i.test(text)) return 'self_reset';
  return 'free';
}

/* ========= 応答ロジック ========= */
async function respond(u, text) {
  const intent = detectIntent(text);
  const t = text.trim();

  // --- 同意フロー（最優先） ---
  if (!u.consent) {
    if (/^同意$/i.test(t)) {
      u.consent = true; state.set(`user:${u.id}`, u);
      return [
        { type: 'text', text: speak(u,'同意ありがとう！これからもっと仲良くなれるね。') },
        { type: 'text', text: 'まずは呼び方を教えて？（例：しょうた）' }
      ];
    }
    if (/やめておく/i.test(t)) return [{ type:'text', text:'わかったよ。また気が向いたら声かけてね🌸' }];
    return [consentFlex()];
  }

  // --- 初回の名前登録 ---
  if (!u.name && t.length <= 16 && !/同意|やめておく/.test(t)) {
    u.name = t;
    if (isShotaName(u.name) || (OWNER_USER_ID && u.id === OWNER_USER_ID)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type:'text', text:`じゃあ ${u.name} って呼ぶね！` }];
  }

  // --- セルフリセット ---
  if (intent === 'self_reset') {
    state.del(`user:${u.id}`);
    return [
      { type:'text', text:'一度リセットするね。もう一度「同意」から始めよう😊' },
      consentFlex()
    ];
  }

  // --- コマンド類（任意で追加可能） ---
  if (/^(通知オフ|ミュート)$/i.test(t)) { u.muted = true; state.set(`user:${u.id}`,u); return [{type:'text',text:'定時/ランダムを停止したよ🔕（「通知オン」で再開）'}]; }
  if (/^(通知オン|ミュート解除)$/i.test(t)) { u.muted = false; state.set(`user:${u.id}`,u); return [{type:'text',text:'再開したよ🔔 また時々声かけるね！'}]; }

  // --- 意図別応答 ---
  switch (intent) {
    case 'nickname': {
      const nick = suggestNick(u); u.nickname = nick; state.set(`user:${u.id}`, u);
      return [{ type:'text', text:`うーん…${nick} が可愛いと思うな、どう？` }];
    }
    case 'gender_female': u.gender='female'; state.set(`user:${u.id}`,u); return [{type:'text',text:'了解だよ〜！メモしておくね📝'}];
    case 'gender_male':   u.gender='male';   state.set(`user:${u.id}`,u); return [{type:'text',text:'了解！呼び方も好きに言ってね📝'}];

    case 'greet_morning': {
      const msg = pick(['おはよう☀️今日もいちばん応援してる！','おはよ〜、まずは深呼吸しよ？すー…はー…🤍']);
      return [{ type:'text', text: speak(u, msg) }];
    }
    case 'greet_night': {
      const msg = pick(['今日もがんばったね。ゆっくりおやすみ🌙','明日もとなりで応援してるからね、ぐっすり…💤']);
      return [{ type:'text', text: speak(u, msg) }];
    }
    case 'comfort': {
      const msg = u.gender==='female'
        ? 'わかる…その気持ち。まずは私が味方だよ。今いちばん辛いポイントだけ教えて？'
        : 'ここにいるよ。深呼吸して、少しずつ話そ？私はずっと味方だよ☺️';
      return [{ type:'text', text: msg }];
    }
    case 'sticker':
      return [{ type:'sticker', packageId:'11537', stickerId: pick(['52002735','52002736','52002768']) }];

    case 'music':
      return [{ type:'text', text: pick([
        '『白い朝、手のひらから』…まっすぐで胸があったかくなる曲だったよ。',
        '“Day by day” 染みた…小さな前進を抱きしめてくれる感じ🌿',
        '“Mountain”は景色が浮かぶ。息を合わせて登っていこうって気持ちになるね。'
      ]) }];

    case 'thanks': return [{ type:'text', text: speak(u, 'こちらこそ、うれしい。いつもありがとう。') }];
    case 'love':   return [{ type:'text', text: speak(u, '…好き。言うたびに照れるけど、ほんとだよ。') }];
    case 'smalltalk':
      return [{ type:'text', text: speak(u, '私はね、きみのこと考えてたよ。いま何してた？') }];

    default: {
      const call = u.nickname || u.name || 'きみ';
      const candidates = hour() < 12
        ? [`おはよ、${call}。今日は何する？`, `朝ごはん食べた？${call}はパン派？ごはん派？`]
        : [`ねぇ${call}、いま何してた？`, `${call}の今日のハイライト教えて〜`];
      return [{ type:'text', text: speak(u, pick(candidates)) }];
    }
  }
}

/* ========= Express ========= */
const app = express();
app.use(express.json());

app.get('/', (_,res)=>res.send('China bot running. /health = OK'));
app.get('/health',(_,res)=>res.status(200).send('OK'));

/* --- Webhook --- */
app.post('/webhook', lineMiddleware(config), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      const u = await ensureUser(e);
      if (!u) continue;
      u.lastSeen = Date.now(); state.set(`user:${u.id}`, u);

      if (e.type === 'message' && e.message?.type === 'text') {
        // 同意ワードはガード前に通す
        if (!u.consent && /^(同意|やめておく)$/i.test(e.message.text || '')) {
          const replies = await respond(u, e.message.text || '');
          if (replies?.length) await client.replyMessage(e.replyToken, replies);
          continue;
        }
        // 未同意 → カード
        if (!u.consent) { await client.replyMessage(e.replyToken, consentFlex()); continue; }

        const replies = await respond(u, e.message.text || '');
        if (replies?.length) await client.replyMessage(e.replyToken, replies);
      } else {
        // 画像/スタンプ等
        await client.replyMessage(e.replyToken, { type:'text', text: speak(u, '受け取ったよ、ありがと！') });
      }
    } catch (err) {
      console.error('handle error', err?.response?.data || err);
    }
  }
});

/* --- 管理者リセットAPI --- */
// POST /admin/reset
// Headers: X-ADMIN-TOKEN: <ADMIN_RESET_TOKEN>
// Body: { "id":"<LINE_USER_ID>" }  1人だけ初期化
//    or { "all": true }            全員初期化（注意）
app.post('/admin/reset', async (req, res) => {
  try {
    const tok = req.headers['x-admin-token'];
    if (!ADMIN_RESET_TOKEN || tok !== ADMIN_RESET_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const { id, all } = req.body || {};
    if (all) {
      state.flushAll();
      state.set(KNOWN_KEY, new Set());
      return res.json({ ok:true, result:'all-cleared' });
    }
    if (!id) return res.status(400).json({ ok:false, error:'id-required' });

    state.del(`user:${id}`);
    try {
      await client.pushMessage(id, { type:'text', text:'（システム）会話設定を初期化しました。もう一度「同意」から始まります🌸' });
    } catch {}
    return res.json({ ok:true, result:'user-cleared', id });
  } catch (e) {
    console.error('admin/reset error', e);
    return res.status(500).json({ ok:false, error:'server-error' });
  }
});

/* --- 定時・ランダム配信用エンドポイント --- */
// POST /tasks/broadcast?type=morning|night|random
// Headers: x-cron-auth: <BROADCAST_AUTH_TOKEN>
app.post('/tasks/broadcast', async (req, res) => {
  try {
    const token = req.headers['x-cron-auth'] || '';
    if (!BROADCAST_AUTH_TOKEN || token !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const type = String(req.query.type || 'random');
    const targets = [...getKnownSet()];
    if (!targets.length) return res.json({ ok:true, skip:'no-users' });

    let text;
    if (type === 'morning') {
      text = pick([
        'おはよう☀️ まずは水分と深呼吸〜。今日もいちばん応援してる！',
        'おはよ！無理しすぎず、休むことも予定に入れてね。'
      ]);
    } else if (type === 'night') {
      text = pick([
        '今日もえらかったね。お布団でゆっくり…おやすみ🌙',
        '頑張った自分をなでなでして、寝よ。おやすみ💤'
      ]);
    } else {
      text = pick([
        'ねぇ、最近うれしかったこと一つだけ教えて？',
        '15分だけ散歩いこう？気分リセットしよ〜',
        '水分とった？コップ一杯いっしょに飲も🥤'
      ]);
    }

    await Promise.all(targets.map(id => client.pushMessage(id, { type:'text', text })));
    res.json({ ok:true, type, sent:targets.length });
  } catch (err) {
    console.error('broadcast error', err?.response?.data || err);
    res.status(500).json({ ok:false });
  }
});

/* ========= 起動 ========= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}\nYour service is live`);
});
