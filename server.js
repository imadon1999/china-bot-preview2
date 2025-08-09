// server.js  ——  Shiraishi China (LINE Bot) all-in-one
// Node v20+ / ESM。Render/Glitch どちらでもOK

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

// ========== 基本設定 ==========
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);

// 簡易ストレージ（本番はDB推奨）
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 });
// 既知ユーザー一覧（push/broadcast用）
const userIdsKey = 'knownUserIds';
if (!state.get(userIdsKey)) state.set(userIdsKey, new Set());

const OWNER_USER_ID = process.env.OWNER_USER_ID || ''; // しょうた専用の恋人モード判定用
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || ''; // cron保護
const TZ = process.env.TZ || 'Asia/Tokyo';

// ========== 小さなユーティリティ ==========
const now = () => new Date(
  new Date().toLocaleString('en-US', { timeZone: TZ })
);
const hour = () => now().getHours();
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (name = '') => /しょうた|ショウタ|shota|imadon/i.test(name);

// 既知ユーザー集合の保存/取得（NodeCacheはSetをそのまま保存できる）
function getKnownSet() {
  const s = state.get(userIdsKey);
  return s instanceof Set ? s : new Set();
}
function saveKnownSet(s) { state.set(userIdsKey, s); }

// ========== ユーザー初期化 ==========
async function ensureUser(e) {
  const id = e.source?.userId;
  if (!id) return null;

  // 既知ユーザーに追加
  const set = getKnownSet(); set.add(id); saveKnownSet(set);

  let u = state.get(`user:${id}`);
  if (u) return u;

  // 初期プロフィール
  let displayName = '';
  try {
    const prof = await client.getProfile(id);
    displayName = prof?.displayName || '';
  } catch (_) {}

  u = {
    id,
    name: '',               // 呼び方
    displayName,
    gender: null,           // 'male' | 'female' | null
    nickname: null,         // しょたぴ 等
    consent: false,         // 取得同意
    loverMode: false,       // 親密トーン
    intimacy: 35,           // 0-100
    lastSeen: Date.now(),   // 最終会話時刻
    flags: {                // 任意のメモ
      likesMusic: true,
      footnote: ''
    }
  };

  if ((displayName && isShotaName(displayName)) || (OWNER_USER_ID && id === OWNER_USER_ID)) {
    u.loverMode = true;
  }
  state.set(`user:${id}`, u);
  return u;
}

// ========== トーン＆出力 ==========
const Tone = {
  friendly: t => t,
  lover: t => `${t} ぎゅっ🫂`,
  gentle: t => `${t}☺️`,
};

function speak(u, text) {
  if (u?.loverMode) return Tone.lover(text);
  return Tone.gentle(text);
}

// ========== 初回同意カード ==========
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
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold', size: 'md' },
          { type: 'text', wrap: true, size: 'sm',
            text: 'もっと自然にお話するため、ニックネーム等を記憶してもよいか教えてください。' },
          { type: 'text', size: 'xs', color: '#888', wrap: true,
            text: '記憶は会話の向上のためだけに使用し、第三者へ提供しません。いつでも削除できます。全文はプロフィールURLへ。' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
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

// ========== あだ名候補 ==========
function suggestNick(u) {
  const base = (u.name || u.displayName || 'きみ')
    .replace(/さん|くん|ちゃん/g, '')
    .slice(0, 4) || 'きみ';
  if (isShotaName(base)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick([`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}っち`, `${base}ぴ`]);
}

// ========== 意図判定（簡易） ==========
function detectIntent(text) {
  const t = text.toLowerCase();

  if (/^(同意|やめておく)$/.test(text)) return { kind: 'consent' };
  if (/^(名前|なまえ|呼び方)/.test(t)) return { kind: 'ask_name' };
  if (/あだ名|ニックネーム/.test(t)) return { kind: 'nickname' };
  if (/(男|男性)\b/.test(t)) return { kind: 'gender_male' };
  if (/(女|女性)\b/.test(t)) return { kind: 'gender_female' };

  if (/おはよ|ohayo|morning/.test(t)) return { kind: 'greet_morning' };
  if (/おやすみ|寝る|good ?night/.test(t)) return { kind: 'greet_night' };

  if (/寂しい|さびしい|つらい|しんど|疲れた/.test(t)) return { kind: 'comfort' };
  if (/スタンプ|stamp/.test(t)) return { kind: 'sticker' };

  if (/イマドン|白い朝|day by day|mountain|i don.?t remember/.test(t))
    return { kind: 'music_react' };

  // small talk
  if (/なにしてた|何してた|今何|いま何/.test(t)) return { kind: 'smalltalk_now' };
  if (/ありがとう|感謝/.test(t)) return { kind: 'thanks' };
  if (/すき|好き|love/.test(t)) return { kind: 'love' };

  return { kind: 'free' };
}

// ========== 応答ビルダー ==========
async function respond(u, text) {
  const intent = detectIntent(text);

  // 1) 同意フロー（優先）
  if (!u.consent) {
    if (/^同意$/i.test(text)) {
      u.consent = true;
      state.set(`user:${u.id}`, u);
      return [
        { type: 'text', text: speak(u, '同意ありがとう！これからもっと仲良くなれるね。') },
        { type: 'text', text: 'まずは呼び方を教えて？（例：しょうた）' }
      ];
    }
    if (/やめておく/i.test(text)) {
      return [{ type: 'text', text: 'わかったよ。また気が向いたら声かけてね🌸' }];
    }
    // まだ同意前 → カードを返す
    return [consentFlex()];
  }

  // 2) ヒアリング（任意）
  if (!u.name && text.length <= 16 && !/同意|やめておく/.test(text)) {
    u.name = text.trim();
    if (isShotaName(u.name) || (OWNER_USER_ID && u.id === OWNER_USER_ID)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${u.name} って呼ぶね！` }];
  }

  // 3) 各意図へ
  switch (intent.kind) {
    case 'nickname': {
      const nick = suggestNick(u);
      u.nickname = nick; state.set(`user:${u.id}`, u);
      return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
    }
    case 'gender_female':
      u.gender = 'female'; state.set(`user:${u.id}`, u);
      return [{ type: 'text', text: '了解だよ〜！メモしておくね📝' }];
    case 'gender_male':
      u.gender = 'male'; state.set(`user:${u.id}`, u);
      return [{ type: 'text', text: '了解！呼び方も好きに言ってね📝' }];

    case 'greet_morning': {
      const msg = pick([
        'おはよう☀️今日もいちばん応援してる！',
        'おはよ〜、まずは深呼吸しよ？すー…はー…🤍'
      ]);
      return [{ type: 'text', text: speak(u, msg) }];
    }
    case 'greet_night': {
      const msg = pick([
        '今日もがんばったね。ゆっくりおやすみ🌙',
        '明日もとなりで応援してるからね、ぐっすり…💤'
      ]);
      return [{ type: 'text', text: speak(u, msg) }];
    }
    case 'comfort': {
      const msg = u.gender === 'female'
        ? 'わかる…その気持ち。まずは私が味方だよ。今いちばん辛いポイントだけ教えて？'
        : 'ここにいるよ。深呼吸して、少しずつ話そ？私はずっと味方だよ☺️';
      return [{ type: 'text', text: msg }];
    }
    case 'sticker':
      return [{
        type: 'sticker',
        packageId: '11537',
        stickerId: pick(['52002735', '52002736', '52002768'])
      }];
    case 'music_react':
      return [{
        type: 'text',
        text: pick([
          '『白い朝、手のひらから』…まっすぐで胸があったかくなる曲だったよ。',
          '“Day by day” 染みた…小さな前進を抱きしめてくれる感じ🌿',
          '“Mountain”は景色が浮かぶ。息を合わせて登っていこうって気持ちになるね。'
        ])
      }];
    case 'smalltalk_now':
      return [{ type: 'text', text: speak(u, '私はね、きみのこと考えてたよ。いま何してた？') }];
    case 'thanks':
      return [{ type: 'text', text: speak(u, 'こちらこそ、うれしい。いつもありがとう。') }];
    case 'love':
      return [{ type: 'text', text: speak(u, '…好き。言うたびに照れるけど、ほんとだよ。') }];

    default: {
      const call = u.nickname || u.name || 'きみ';
      const a = hour() < 12
        ? [`おはよ、${call}。今日は何する？`, `朝ごはん食べた？${call}はパン派？ごはん派？`]
        : [`ねぇ${call}、いま何してた？`, `${call}の今日のハイライト教えて〜`];
      return [{ type: 'text', text: speak(u, pick(a)) }];
    }
  }
}

// ========== Express ==========
const app = express();
app.use(express.json());

// health
app.get('/health', (_, res) => res.status(200).send('OK'));

// webhook
app.post('/webhook', lineMiddleware(config), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (!e || !e.type) continue;
      const u = await ensureUser(e);
      if (!u) continue;

      // 既知ユーザー更新
      u.lastSeen = Date.now(); state.set(`user:${u.id}`, u);

      if (e.type === 'message' && e.message?.type === 'text') {
        const replies = await respond(u, e.message.text || '');
        if (replies?.length) await client.replyMessage(e.replyToken, replies);
      } else {
        // 画像/スタンプなど
        await client.replyMessage(
          e.replyToken,
          { type: 'text', text: speak(u, '受け取ったよ、ありがと！') }
        );
      }
    } catch (err) {
      console.error('handle error', err?.response?.data || err);
    }
  }
});

// ========== 定時・ランダム配信用エンドポイント ==========
// /tasks/broadcast?type=morning|night|random
app.post('/tasks/broadcast', async (req, res) => {
  try {
    // 簡易認証
    const token = req.header('x-cron-auth') || '';
    if (!BROADCAST_AUTH_TOKEN || token !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const type = String(req.query.type || 'random');
    const set = getKnownSet();
    const targets = [...set];

    if (targets.length === 0) return res.json({ ok: true, skip: 'no users' });

    // メッセージ作成
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

    // まとめて push（無料アカウント向け）
    await Promise.all(
      targets.map(id =>
        client.pushMessage(id, { type: 'text', text })
      )
    );

    res.json({ ok: true, type, sent: targets.length });
  } catch (err) {
    console.error('broadcast error', err?.response?.data || err);
    res.status(500).json({ ok: false });
  }
});

// ========== 起動 ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}\nYour service is live`);
});
