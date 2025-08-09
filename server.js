// server.js
import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

// ====== LINE & runtime config ======
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const PORT = process.env.PORT || 10000;
const OWNER_USER_ID = process.env.OWNER_USER_ID || ''; // しょうた用
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || ''; // 定時配信用ヘッダ
const ADMIN_AUTH_TOKEN = process.env.ADMIN_AUTH_TOKEN || ''; // 管理API用ヘッダ

const client = new Client(config);
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });

// ====== small helpers ======
const HOUR = () => new Date().getHours();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (name = '') => /しょうた|ｼｮｳﾀ|ショウタ|shota|imadon/i.test(name);

async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId;
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
      gender: null,
      nickname: null,
      consent: false,
      loverMode: false,
      intimacy: 30,
    };
    if ((name && isShotaName(name)) || (OWNER_USER_ID && id === OWNER_USER_ID)) {
      u.loverMode = true;
    }
    state.set(`user:${id}`, u);
  }
  return u;
}

function consentCard() {
  return {
    type: 'flex',
    altText: 'はじめまして！記憶の同意のお願い',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold' },
          { type: 'text', wrap: true, size: 'sm', text: 'ニックネームや会話を少し覚えて、もっと自然にお話してもいい？' },
          { type: 'text', wrap: true, size: 'xs', color: '#888',
            text: '記憶は会話向上のためだけ。第三者提供なし／いつでも削除OK。詳しくはプロフィールURLへ。' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        contents: [
          { type: 'button', style: 'primary', color: '#6C8EF5', action: { type: 'message', label: '同意', text: '同意' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: 'やめておく', text: 'やめておく' } },
        ],
      },
    },
  };
}

function suggestNick(u) {
  const name = u.name || 'きみ';
  const base = name.replace(/さん|くん|ちゃん/g, '').slice(0, 4) || 'きみ';
  const cands = [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`, `しょーたん`, `しょたぴ`];
  if (isShotaName(name)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick(cands);
}

function greetingByTime(u) {
  const call = u.nickname || u.name || 'きみ';
  const h = HOUR();
  if (h < 12) return `おはよう、${call}☀️ 今日もいちばん応援してる！`;
  if (h < 18) return `やっほ〜${call}、ちょっとひと休みしよ☕️`;
  return `今日もえらかったね、${call}。ゆっくりおやすみ🌙`;
}

// ====== 意図ざっくり判定 → テンプレ応答 ======
async function routeText(u, text) {
  const t = (text || '').trim();

  // 1) 同意フロー先に処理
  if (/^同意$/i.test(t)) {
    u.consent = true;
    state.set(`user:${u.id}`, u);
    return [
      { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずはお名前（呼び方）教えて？\n例）しょうた など' },
    ];
  }
  if (/やめておく/.test(t)) {
    return [{ type: 'text', text: 'わかったよ。気が変わったらいつでも言ってね🌸' }];
  }

  // 2) セルフリセット
  if (/^(リセット|初期化)$/i.test(t)) {
    const old = state.get(`user:${u.id}`);
    state.set(`user:${u.id}`, { id: u.id, name: '', gender: null, nickname: null, consent: false, loverMode: old?.loverMode || false, intimacy: 30 });
    return [{ type: 'text', text: '会話の記憶を初期化したよ。はじめましてからやり直そ！' }, consentCard()];
  }

  // 3) 名前・性別・あだ名
  if (u.consent && !u.name && t.length <= 16) {
    u.name = t;
    if (isShotaName(t)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${t} って呼ぶね！` }];
  }
  if (/あだ名|ニックネーム/.test(t)) {
    const nick = suggestNick(u);
    u.nickname = nick;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
  }
  if (/(男|女|男性|女性)/.test(t) && u.consent) {
    if (/女性|女/.test(t)) u.gender = 'female';
    else if (/男性|男/.test(t)) u.gender = 'male';
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: '了解だよ〜！メモしておくね📝' }];
  }

  // 4) 定番あいさつ
  if (/おはよ|おはよう/.test(t)) {
    const msg = pick(['おはよう☀️深呼吸して良い一日にしよ〜', 'おはよ〜！まずお水のんだ？💧']);
    return [{ type: 'text', text: u.loverMode ? msg + ' ぎゅっ🫂' : msg }];
  }
  if (/おやすみ|寝る/.test(t)) {
    const msg = pick(['今日もがんばったね。ゆっくりおやすみ🌙', 'となりで応援してるからね、ぐっすり…💤']);
    return [{ type: 'text', text: u.loverMode ? msg + ' 添い寝、ぎゅ〜🛏️' : msg }];
  }

  // 5) 励まし
  if (/寂しい|さびしい|つらい|しんど|不安/.test(t)) {
    const msg = u.gender === 'female'
      ? 'わかる…その気持ち。まずは私が味方だよ。今いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。深呼吸して、少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: msg }];
  }

  // 6) イマドン（音楽）関連
  if (/イマドン|白い朝|Day by day|Mountain|I don'?t remember/i.test(t)) {
    const msg = pick([
      '『白い朝、手のひらから』…まっすぐで胸があったかくなる曲だったよ。',
      '“Day by day” 染みた…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain”は景色が浮かぶ。隣で一緒に登っていこうって思えるね。',
    ]);
    return [{ type: 'text', text: msg }];
  }

  // 7) スタンプ
  if (/スタンプ|stamp/i.test(t)) {
    return [{ type: 'sticker', packageId: '11537', stickerId: pick(['52002735', '52002736', '52002768']) }];
  }

  // 8) デフォルト雑談
  const call = u.nickname || u.name || 'きみ';
  const base = HOUR() < 12 ? `おはよ、${call}。今日なにする？` : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: u.loverMode ? base + ' となりでぎゅ…🫂' : base }];
}

// ====== App init ======
const app = express();

// ヘルスチェック
app.get('/health', (_, res) => res.status(200).send('OK'));

// JSONが必要なルートだけ個別にON
app.use('/tasks', express.json());
app.use('/admin', express.json());

// ====== LINE Webhook（順番が超重要！） ======
app.post(
  '/webhook',
  // 1) raw で受ける（先に置く）
  express.raw({ type: '*/*' }),
  // 2) 署名検証
  lineMiddleware(config),
  // 3) handler
  async (req, res) => {
    res.status(200).end();

    const events = (req.body && req.body.events) || [];
    for (const e of events) {
      try {
        if (e.type !== 'message') continue;
        const u = await ensureUser(e);

        // 同意フローだけは未同意でも通す
        if (e.message?.type === 'text') {
          const text = e.message.text || '';

          if (!u.consent && /^(同意|やめておく)$/i.test(text)) {
            const replies = await routeText(u, text);
            if (replies?.length) await client.replyMessage(e.replyToken, replies);
            continue;
          }

          // 未同意 → カードを返す
          if (!u.consent) {
            await client.replyMessage(e.replyToken, consentCard());
            continue;
          }

          // 通常応答
          const replies = await routeText(u, text);
          if (replies?.length) await client.replyMessage(e.replyToken, replies);
          continue;
        }

        // 画像/スタンプ等
        await client.replyMessage(
          e.replyToken,
          { type: 'text', text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！' }
        );
      } catch (err) {
        console.error('handle error', err?.response?.data || err);
      }
    }
  }
);

// ====== 定時配信/ランダム投げかけ（外部cronから叩く） ======
app.post('/tasks/broadcast', async (req, res) => {
  if ((req.headers['broadcast_auth_token'] || '') !== BROADCAST_AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const type = (req.query.type || 'random').toString();

  // 簡易メッセ雛形
  const messages = {
    morning: [
      'おはよう☀️ 水分とって、背伸びしていこ〜',
      'おはよ〜！今日もいちばん応援してるね🤍',
    ],
    night: [
      '今日もえらかったね。深呼吸して、ゆっくりおやすみ🌙',
      '布団トン…おやすみの魔法かけとくね💤',
    ],
    random: [
      'ねぇ、いま何してた？ちょっとだけ私に分けて〜☺️',
      '肩の力、すこーし抜こ！好きな飲み物は？',
    ],
  };

  // cache から全ユーザーID収集
  const keys = state.keys().filter(k => k.startsWith('user:'));
  const userIds = keys.map(k => state.get(k)?.id).filter(Boolean);

  const text = pick(messages[type] || messages.random);
  // マルチキャスト
  try {
    if (userIds.length) await client.multicast(userIds, [{ type: 'text', text }]);
    return res.json({ ok: true, sent: userIds.length, type, text });
  } catch (e) {
    console.error('broadcast error', e?.response?.data || e);
    return res.status(500).json({ ok: false });
  }
});

// ====== 管理API：リセット ======
app.post('/admin/reset', async (req, res) => {
  if ((req.headers['admin_auth_token'] || '') !== ADMIN_AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { userId, all } = req.body || {};
  if (all) {
    state.flushAll();
    return res.json({ ok: true, cleared: 'all' });
  }
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
  state.del(`user:${userId}`);
  return res.json({ ok: true, cleared: userId });
});

// ====== start ======
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
