// server.js  — ESM
import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

// ----- LINE config -----
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// ----- In-memory state (preview用) -----
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });
const ownerId = process.env.OWNER_USER_ID || ''; // しょうたさんのUserID(任意)
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || '';

// ----- helpers -----
const pick = a => a[Math.floor(Math.random() * a.length)];
const isShota = s => /しょうた|ショウタ|shota|imadon/i.test(s || '');
const nowHour = () => new Date().getHours();

async function ensureUser(userId) {
  let u = state.get(`user:${userId}`);
  if (!u) {
    let name = '';
    try {
      const p = await client.getProfile(userId);
      name = p?.displayName || '';
    } catch {}
    u = { id: userId, name, nickname: null, gender: null, consent: false, loverMode: false };
    if (isShota(name) || (ownerId && userId === ownerId)) u.loverMode = true;
    state.set(`user:${userId}`, u);
  }
  return u;
}

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
            text: 'もっと自然にお話するため、ニックネーム等を記憶して良いか教えてね。' },
          { type: 'text', text: 'プライバシーポリシー', weight: 'bold' },
          { type: 'text', size: 'xs', color: '#888',
            text: '記憶は会話向上のためだけに使用し、第三者提供しません。いつでも削除OK。' }
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

function suggestNick(name='きみ') {
  const base = name.replace(/さん|くん|ちゃん/g,'').slice(0,4) || 'きみ';
  if (isShota(name)) return pick(['しょーたん','しょたぴ','しょうちゃん']);
  return pick([`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`]);
}

async function routeText(u, t) {
  const text = (t || '').trim();

  // 同意フロー（最優先）
  if (!u.consent && /^同意$/i.test(text)) {
    u.consent = true; state.set(`user:${u.id}`, u);
    return [
      { type: 'text', text: '同意ありがとう！もっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずはお名前（呼び方）教えて？ 例）しょうた' }
    ];
  }
  if (!u.consent && /やめておく/i.test(text)) {
    return [{ type: 'text', text: 'OK。また気が向いたら声かけてね🌸' }];
  }
  if (!u.consent) return [consentFlex()];

  // 名前登録
  if (!u.name && text.length <= 16) {
    u.name = text;
    if (isShota(text)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${text} って呼ぶね！` }];
  }

  // あだ名
  if (/あだ名|ニックネーム/i.test(text)) {
    const nick = suggestNick(u.name || '');
    u.nickname = nick; state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `…${nick} が可愛いと思うな。どう？` }];
  }

  // 性別メモ（任意）
  if (/^女|女性$/.test(text)) { u.gender = 'female'; state.set(`user:${u.id}`, u); return [{ type: 'text', text:'了解だよ〜📝' }]; }
  if (/^男|男性$/.test(text)) { u.gender = 'male';   state.set(`user:${u.id}`, u); return [{ type: 'text', text:'了解だよ〜📝' }]; }

  // 定番挨拶
  if (/おはよ/.test(text)) {
    const msg = pick(['おはよう☀️今日もいちばん応援してる！','おはよ〜 深呼吸しよ…すー…はー…🤍']);
    return [{ type: 'text', text: u.loverMode ? msg + ' ぎゅっ🫂' : msg }];
  }
  if (/おやすみ|寝る/.test(text)) {
    const msg = pick(['今日もえらかったね。ゆっくりおやすみ🌙','となりで見守ってるよ。ぐっすり…💤']);
    return [{ type: 'text', text: u.loverMode ? msg + ' 添い寝、ぎゅ〜🛏️' : msg }];
  }

  // さびしい/つらい
  if (/寂しい|さびしい|つらい|しんど/i.test(text)) {
    const msg = u.gender === 'female'
      ? 'わかる…その気持ち。まず私が味方だよ。いちばん辛いポイント、ひとつだけ教えて？'
      : 'ここにいるよ。深呼吸して、少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: msg }];
  }

  // 楽曲トピック
  if (/イマドン|白い朝|Day by day|Mountain|remember/i.test(text)) {
    return [{ type: 'text', text: pick([
      '『白い朝、手のひらから』まっすぐで胸が温かくなる曲…好き。',
      '“Day by day” 小さな前進を抱きしめたくなる🌿',
      '“Mountain” 一緒に登っていこうって景色が浮かぶんだよね。'
    ]) }];
  }

  // スタンプ
  if (/スタンプ/i.test(text)) {
    return [{ type: 'sticker', packageId: '11537', stickerId: pick(['52002734','52002736','52002768']) }];
  }

  // 雑談デフォルト
  const call = u.nickname || u.name || 'きみ';
  const base = nowHour() < 12 ? `おはよ、${call}。今日なにする？` : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: u.loverMode ? base + ' となりでぎゅ…🫂' : base }];
}

// ----- Express app -----
// 重要：/webhook では JSON パーサ等を使わない！ lineMiddleware を先頭に。
const app = express();

// 動作確認用
app.get('/', (_, res) => res.status(200).send('OK /china-bot is running'));
app.get('/health', (_, res) => res.status(200).send('OK'));

// Webhook
app.post('/webhook', lineMiddleware(config), async (req, res) => {
  // すぐ200を返す（LINEの要件）
  res.status(200).end();

  const events = req.body?.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const userId = e.source?.userId;
      if (!userId) continue;
      const u = await ensureUser(userId);

      if (e.message.type === 'text') {
        const replies = await routeText(u, e.message.text || '');
        if (replies?.length) {
          // replyToken は 1回・1分以内のみ有効
          await client.replyMessage(e.replyToken, replies);
        }
      } else {
        await client.replyMessage(e.replyToken, {
          type: 'text',
          text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！'
        });
      }
    } catch (err) {
      // 失敗の詳細をログ（400の原因確認に有効）
      console.error('reply error:', err?.response?.status, err?.response?.data || err.message);
    }
  }
});

// ---- Broadcast (cron-jon から叩く) ----
app.post('/tasks/broadcast', (req, res) => {
  const token = req.headers['broadcast_auth_token'];
  if (!BROADCAST_AUTH_TOKEN || token !== BROADCAST_AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const type = (req.query.type || 'morning').toString();
  let text = 'やっほー👋';
  if (type === 'morning') text = pick(['おはよう☀️今日もとなりで応援してるよ！','おはよ〜 深呼吸からスタートしよ🤍']);
  if (type === 'goodnight') text = pick(['今日もえらかったね。ぬくぬく寝よ🌙','ぎゅっとしておやすみ…💤']);
  // ここは preview 用：broadcast で全員へ
  client.broadcast([{ type:'text', text }])
    .then(() => res.json({ ok:true }))
    .catch(err => {
      console.error('broadcast error', err?.response?.status, err?.response?.data || err.message);
      res.status(500).json({ ok:false });
    });
});

// ---- 起動 ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
  console.log('Your service is live 🎉');
});
