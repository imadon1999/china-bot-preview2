
// server.js — Shiraishi China (preview) all-in-one
// =================================================
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser'; // CommonJSモジュール → default import
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';
import crypto from 'crypto';

// ===== 基本設定 =====
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';                 // あなたのLINE UID（任意）
const ADMIN_TOKEN    = process.env.ADMIN_TOKEN || 'admin';              // 管理APIトークン
const BROADCAST_AUTH = process.env.BROADCAST_AUTH_TOKEN || '';          // cron用ヘッダ値
const TZ = process.env.TZ || 'Asia/Tokyo';

const app = express();
const client = new Client(config);

// 7日TTLのメモリDB
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });

// ===== ユーティリティ =====
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const now = () => new Date();
const hour = () =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now());
const isShotaName = (s = '') => /しょうた|ショウタ|shota|imadon/i.test(s);

// LINE署名の明示検証（トラブル時の保険）
function verifyLineSignature(req) {
  const signature = req.get('x-line-signature');
  if (!signature) return false;
  const h = crypto.createHmac('sha256', config.channelSecret);
  h.update(req.body); // Buffer (raw)
  return signature === h.digest('base64');
}

// webhook だけ raw で受ける（他はJSON）
const webhookRaw = bodyParser.raw({ type: 'application/json' });
app.use('/health', bodyParser.json());
app.use('/tasks', bodyParser.json());
app.use('/admin', bodyParser.json());

// ===== ユーザー状態 =====
async function ensureUser(e) {
  const id = e?.source?.userId;
  if (!id) return null;
  let u = state.get(`user:${id}`);
  if (!u) {
    let name = '';
    try {
      const prof = await client.getProfile(id);
      name = prof?.displayName || '';
    } catch (_) {}
    u = {
      id,
      name,
      nickname: null,
      gender: null,
      consent: false,
      loverMode: false,
      mood: 50, // 0-100
    };
    if ((name && isShotaName(name)) || (OWNER_USER_ID && id === OWNER_USER_ID)) {
      u.loverMode = true;
    }
    state.set(`user:${id}`, u);
  }
  return u;
}
const saveUser = (u) => state.set(`user:${u.id}`, u);

// ===== メッセージ定義 =====
const consentFlex = () => ({
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
        { type: 'text', wrap: true, size: 'sm', text: '自然にお話するため、ニックネーム等を記憶してもいいか教えてね。' },
        { type: 'text', size: 'sm', color: '#888', text: '※記憶は会話の向上のためだけに使用・いつでも削除OK' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      contents: [
        { type: 'button', style: 'primary', color: '#6C8EF5', action: { type: 'message', label: '同意してはじめる', text: '同意' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: 'やめておく', text: 'やめておく' } },
      ],
    },
  },
});

const morningTemps = [
  'おはよう☀️ まずは深呼吸、すー…はー…🤍',
  'おはよ！今日の目標ひとつだけ教えて？',
  'おはよ〜！コーヒー淹れてくるね☕️',
];
const nightTemps = [
  '今日もえらかった…ゆっくりおやすみ🌙',
  'ぎゅ〜して寝よ…🛏️💤',
  '目を閉じて、良かったことを1つ思い出そ。おやすみ😴',
];
const randomPokes = [
  'ねぇ、今なにしてた？',
  '水分とった？🍵',
  'ちょっとだけ声聞きたくなった…☺️',
];

// ===== 意図判定（ライト） =====
function detectIntent(t) {
  const s = t.toLowerCase();
  if (/(はよ|おはよ|ohayo)/.test(s)) return 'morning';
  if (/(おやす|寝る|おねむ|oyasumi)/.test(s)) return 'night';
  if (/(つら|しんど|さみしい|辛|泣|さびし)/.test(s)) return 'comfort';
  if (/(審査|仕事|転職|面接|履歴書|職務経歴)/.test(s)) return 'career';
  if (/(健康|睡眠|肩こり|頭痛|栄養|食事|水分)/.test(s)) return 'health';
  if (/(イマドン|白い朝|day by day|mountain|donburi)/i.test(s)) return 'music';
  if (/(スタンプ|すたんぷ)/.test(s)) return 'stamp';
  if (/(あだ名|ニックネーム)/.test(s)) return 'nick';
  if (/^reset$/i.test(s)) return 'self-reset';
  return 'chit';
}

// ===== 口調生成 =====
function speak(u, text) {
  if (u.loverMode) return `${text} ぎゅ…🫂`;
  return text;
}

// ===== ルーティング =====
function suggestNick(u) {
  const base = (u.name || 'きみ').replace(/さん|くん|ちゃん/g, '').slice(0, 4);
  if (isShotaName(u.name)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick([`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`]);
}

async function routeText(u, text) {
  const intent = detectIntent(text);

  // 自己リセット
  if (intent === 'self-reset') {
    state.del(`user:${u.id}`);
    return [{ type: 'text', text: 'OK！いったん記憶をクリアして最初からやり直そっ🧹' }];
  }

  if (/^同意$/i.test(text)) {
    u.consent = true;
    saveUser(u);
    return [
      { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずは呼び方を教えて？ 例）しょうた など' },
    ];
  }
  if (/やめておく/.test(text)) {
    return [{ type: 'text', text: 'わかったよ。いつでも気が変わったら言ってね🌸' }];
  }

  // 同意後の初回ヒアリング（名前）
  if (u.consent && !u.name && text.length <= 16) {
    u.name = text.trim();
    if (isShotaName(u.name)) u.loverMode = true;
    saveUser(u);
    return [{ type: 'text', text: `じゃあ ${u.name} って呼ぶね！` }];
  }

  switch (intent) {
    case 'morning':
      return [{ type: 'text', text: speak(u, pick(morningTemps)) }];
    case 'night':
      return [{ type: 'text', text: speak(u, pick(nightTemps)) }];
    case 'comfort':
      return [{
        type: 'text',
        text: u.gender === 'female'
          ? 'わかる…その気持ち。今日は私が味方だよ。今いちばん辛いポイントだけ教えて？'
          : 'ここにいるよ。深呼吸して、少しずつ話そ？大丈夫、味方だよ☺️',
      }];
    case 'career':
      return [{
        type: 'text',
        text: '転職/仕事の悩みなら一緒に整理しよ！①現職の不満 ②希望条件 ③期限感 の3つを教えてみて✨',
      }];
    case 'health':
      return [{
        type: 'text',
        text: 'ヘルスケアチェック☑️ 睡眠/水分/食事/運動のどれを整えたい？まずは一歩だけ決めてみよ！',
      }];
    case 'music':
      return [{
        type: 'text',
        text: 'イマドンの曲、染みるよね…『白い朝、手のひらから』は朝の白光みたいに優しい☕️',
      }];
    case 'stamp':
      return [{
        type: 'sticker',
        packageId: '11537',
        stickerId: pick(['52002735', '52002736', '52002768']),
      }];
    case 'nick': {
      const nick = suggestNick(u);
      u.nickname = nick; saveUser(u);
      return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
    }
    default: {
      const call = u.nickname || u.name || 'きみ';
      const opener = Number(hour()) < 12
        ? `おはよ、${call}。いま何してた？`
        : `ねぇ${call}、いま何してたの？`;
      return [{ type: 'text', text: speak(u, opener) }];
    }
  }
}

// ====== Webhook ======
// 署名検証を**明示**、かつ lineMiddleware も利用
app.post('/webhook', webhookRaw, (req, res, next) => {
  if (!verifyLineSignature(req)) {
    console.error('invalid signature');
    return res.status(401).end();
  }
  // lineMiddleware は生の Buffer を期待するので raw を一旦保存し bodyに再セット
  const rawBody = req.body;
  try {
    req.body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    req.body = {};
  }
  next();
}, lineMiddleware(config), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      if (e.message.type === 'text') {
        const text = e.message.text || '';

        // 同意フロー先行
        if (!u.consent && /^(同意|やめておく)$/i.test(text)) {
          const msgs = await routeText(u, text);
          if (msgs?.length) await client.replyMessage(e.replyToken, msgs);
          continue;
        }
        // 未同意 → 同意カードを返す
        if (!u.consent) {
          await client.replyMessage(e.replyToken, consentFlex());
          continue;
        }
        // 既同意 → 通常処理
        const msgs = await routeText(u, text);
        if (msgs?.length) await client.replyMessage(e.replyToken, msgs);
      } else {
        // 画像やスタンプ
        await client.replyMessage(e.replyToken, {
          type: 'text',
          text: speak(u, '送ってくれてありがと！あとでゆっくり見るね📷'),
        });
      }
    } catch (err) {
      console.error('reply error -', err?.response?.status || '', err?.response?.data || err);
    }
  }
});

// ====== Health ======
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ====== ブロードキャスト（朝/夜/ランダム） ======
function allUserIds() {
  return state.keys()
    .filter((k) => k.startsWith('user:'))
    .map((k) => k.replace('user:', ''));
}
async function broadcast(textGen) {
  const ids = allUserIds();
  if (!ids.length) return { sent: 0 };
  const chunks = [];
  for (const id of ids) {
    const u = state.get(`user:${id}`) || { id, loverMode: false, name: '' };
    const call = u.nickname || u.name || 'きみ';
    const text = textGen(u, call);
    chunks.push(client.pushMessage(id, [{ type: 'text', text }]));
  }
  await Promise.allSettled(chunks);
  return { sent: ids.length };
}

app.post('/tasks/broadcast', async (req, res) => {
  if (req.get('BROADCAST_AUTH_TOKEN') !== BROADCAST_AUTH) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const type = (req.query.type || 'random').toString();

  let result = { sent: 0 };
  if (type === 'morning') {
    result = await broadcast((u) => speak(u, pick(morningTemps)));
  } else if (type === 'night') {
    result = await broadcast((u) => speak(u, pick(nightTemps)));
  } else {
    result = await broadcast((u, call) => speak(u, pick([
      `ねぇ${call}、今日こころ晴れてる？`,
      `${call}、水分とった？🍵`,
      `なんかね、会いたくなっただけ☺️`,
    ])));
  }
  res.json({ ok: true, type, ...result });
});

// ====== 管理API（全消去/個別消去） ======
app.post('/admin/reset', (req, res) => {
  if ((req.query.token || '') !== ADMIN_TOKEN) return res.status(401).json({ ok: false });
  const which = (req.query.which || 'all').toString();
  if (which === 'all') {
    state.flushAll();
    return res.json({ ok: true, cleared: 'all' });
  }
  const key = `user:${which}`;
  state.del(key);
  return res.json({ ok: true, cleared: which });
});

// ====== 起動 ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
  console.log('Your service is live 🎉');
});
