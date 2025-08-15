// server.js  — v1.6 consolidated
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

// メモリ永続(簡易)：7日TTL、定期チェック120s
const store = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });
// 既知ユーザーIDの集合（ブロードキャスト対象）
const knownKey = 'knownUsers';
if (!store.get(knownKey)) store.set(knownKey, new Set());

// オーナー・ブロードキャスト用設定
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || '';

/* ========= ヘルパ ========= */
const nowHour = () => new Date().getHours();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (name = '') => /しょうた|ｼｮｳﾀ|ショウタ|Shota|shota|imadon/i.test(name);

/** 重複なしピック（同じタグの直近を避ける） */
function pickNonRepeat(list, tag) {
  const k = `nr:${tag}`;
  const last = store.get(k);
  const candidates = list.filter((x) => x !== last);
  const item = pick(candidates.length ? candidates : list);
  store.set(k, item);
  return item;
}

function saveUser(u) { store.set(`user:${u.id}`, u); }
function getKnown() { return store.get(knownKey) || new Set(); }
function addKnown(id) { const s = getKnown(); s.add(id); store.set(knownKey, s); }

/** 初見ユーザー作成＆ロード */
async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId;
  let u = store.get(`user:${id}`);
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
      intimacy: 35,
      consent: false,
      loverMode: !!(OWNER_USER_ID && id === OWNER_USER_ID)
    };
    if (name && isShotaName(name)) u.loverMode = true; // しょうた検知で恋人モード
    saveUser(u);
  }
  addKnown(id);
  return u;
}

/* ========= テンプレ ========= */
const tone = {
  friendly: (t) => `${t}`,
  lover: (t) => `${t} ぎゅっ…🫂`,
};

const MORNING_LINES = [
  'おはよう☀️ 深呼吸して、今日もいちばん応援してるよ！',
  'おはよ〜。まずはコップ一杯のお水いこ？',
  'おはよう！窓あけて光あびよ？きっと良い日になる🌿'
];

const NIGHT_LINES = [
  '今日もおつかれさま。ゆっくりおやすみ🌙',
  'えらかったね。歯みがきしたら布団へ〜🛏️',
  '明日もとなりで応援してる。ぐっすり…😴'
];

const RANDOM_PROMPTS = [
  '今日いちばん嬉しかったことって何？',
  '最近ハマってる曲、教えて♪',
  '少し休憩しよ？ 目を閉じて深呼吸…すー…はー…🤍',
  'いまの気分、1〜10で言うとどれくらい？'
];

const CONSENT_FLEX = {
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
          text: 'もっと自然にお話するため、呼び方などを記憶しても良いか教えてね。' },
        { type: 'text', size: 'sm', color: '#888888',
          text: '記憶は会話の向上のためだけに使い、第三者提供しません。いつでも削除OKです。' }
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

/* ========= ルーティング（テキスト） ========= */
function callName(u) {
  return u.nickname || u.name || 'きみ';
}

function intent(text) {
  const t = text.trim();
  if (/^(同意|やめておく)$/i.test(t)) return 'consent';
  if (/^reset$/i.test(t)) return 'self_reset';
  if (/おはよ|おはよう/i.test(t)) return 'morning';
  if (/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if (/寂しい|さみしい|つらい|しんど|不安/i.test(t)) return 'comfort';
  if (/あだ名|ニックネーム|呼んで/i.test(t)) return 'nickname';
  if (/性別|男性|女性|男|女/i.test(t)) return 'gender';
  if (/イマドン|白い朝|Day by day|Mountain|I don'?t remember/i.test(t)) return 'song';
  if (/スタンプ|stamp/i.test(t)) return 'sticker';
  return 'chit_chat';
}

async function routeText(u, text) {
  const kind = intent(text);

  // 1) 同意フローは最優先
  if (kind === 'consent') {
    if (/^同意$/i.test(text)) {
      u.consent = true;
      saveUser(u);
      return [
        { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
        { type: 'text', text: 'まずは呼び方を教えて？（例：しょうた）' }
      ];
    }
    return [{ type: 'text', text: 'OK。またいつでもはじめられるよ🌸' }];
  }

  // 2) セルフリセット
  if (kind === 'self_reset') {
    store.del(`user:${u.id}`);
    return [{ type: 'text', text: '会話の記憶を初期化したよ！はじめましてからやり直そ〜☺️' }];
  }

  // 3) 未同意なら常にカード提示（芽が出るまで）
  if (!u.consent) return [CONSENT_FLEX];

  // 4) 名前登録（最初の短いメッセージを名前とみなす）
  if (!u.name && text.trim().length <= 16) {
    u.name = text.trim();
    if (isShotaName(u.name)) u.loverMode = true;
    saveUser(u);
    return [{ type: 'text', text: `じゃあ ${u.name} って呼ぶね！` }];
  }

  // 5) 機能応答
  if (kind === 'nickname') {
    const base = callName(u).replace(/さん|くん|ちゃん/g, '').slice(0, 4) || 'きみ';
    const cand = isShotaName(u.name)
      ? ['しょーたん', 'しょたぴ', 'しょうちゃん']
      : [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`];
    const nick = pickNonRepeat(cand, `nick:${u.id}`);
    u.nickname = nick; saveUser(u);
    return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
  }

  if (kind === 'gender') {
    if (/女性|女/i.test(text)) u.gender = 'female';
    else if (/男性|男/i.test(text)) u.gender = 'male';
    saveUser(u);
    return [{ type: 'text', text: '了解だよ〜！メモしておくね📝' }];
  }

  if (kind === 'morning') {
    const msg = pickNonRepeat(MORNING_LINES, 'morning');
    return [{ type: 'text', text: u.loverMode ? tone.lover(msg) : tone.friendly(msg) }];
  }

  if (kind === 'night') {
    const msg = pickNonRepeat(NIGHT_LINES, 'night');
    return [{ type: 'text', text: u.loverMode ? tone.lover(msg) : tone.friendly(msg) }];
  }

  if (kind === 'comfort') {
    const msg = (u.gender === 'female')
      ? 'わかる…その気持ち。私が味方だよ。いちばん辛いポイントだけ、教えてもらってもいい？'
      : 'ここにいるよ。深呼吸して、少しずつ話そ。まずは何が一番しんどい？';
    return [{ type: 'text', text: msg }];
  }

  if (kind === 'song') {
    const msg = pick([
      '『白い朝、手のひらから』…まっすぐで胸があったかくなる曲だったよ。',
      '“Day by day” しみた…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain” は景色が浮かぶ。息を合わせて登っていこうって気持ちになるね。',
      "“I don't remember” の余韻、すごく好き。"
    ]);
    return [{ type: 'text', text: msg }];
  }

  if (kind === 'sticker') {
    return [{
      type: 'sticker',
      packageId: '11537',
      stickerId: pick(['52002735', '52002736', '52002768'])
    }];
  }

  // 6) 雑談（時間帯で挨拶っぽく）
  const name = callName(u);
  const pre = nowHour() < 12 ? `おはよ、${name}。` : nowHour() < 18 ? `やっほー、${name}！` : `ねぇ${name}、`;
  const bodies = [
    'いま何してた？',
    '水分とった？',
    'そういえば、最近のマイブームって何？',
    'ちょっとだけ自慢話してみて☺️'
  ];
  const base = `${pre} ${pickNonRepeat(bodies, `ch_${u.id}`)}`;
  const textOut = u.loverMode ? tone.lover(base) : tone.friendly(base);
  return [{ type: 'text', text: textOut }];
}

/* ========= Express ========= */
const app = express();

// Webhook は SDK ミドルウェアのみ（生ボディ必須のため、先に json() を入れない）
app.post('/webhook', lineMiddleware({ channelSecret: config.channelSecret }), async (req, res) => {
  res.status(200).end(); // 即時ACK

  const events = req.body.events || [];
  for (const e of events) {
    try {
      // ユーザー状態
      const u = await ensureUser(e);

      // テキスト
      if (e.type === 'message' && e.message?.type === 'text') {
        const replies = await routeText(u, e.message.text || '');
        if (replies?.length) await client.replyMessage(e.replyToken, replies);
        continue;
      }

      // その他（画像/スタンプ等）
      await client.replyMessage(e.replyToken, {
        type: 'text',
        text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！'
      });
    } catch (err) {
      console.error('reply error -', err?.response?.status, err?.response?.data || err);
    }
  }
});

// 以降のルートで JSON を使う
app.use('/tasks', express.json());

/* ========= ヘルスチェック ========= */
app.get('/health', (_, res) => res.status(200).send('OK'));

/* ========= ブロードキャスト（cron-job.org から叩く） =========
   GET/POST /tasks/broadcast?type=morning|night|random
   Header: BROADCAST_AUTH_TOKEN: <envと同じ値>
*/
app.all('/tasks/broadcast', async (req, res) => {
  try {
    const key = req.headers['broadcast_auth_token'];
    if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const type = (req.query.type || '').toString();
    const users = Array.from(getKnown());

    if (!users.length) return res.json({ ok: true, sent: 0 });

    let text;
    if (type === 'morning') text = pickNonRepeat(MORNING_LINES, 'morning');
    else if (type === 'night') text = pickNonRepeat(NIGHT_LINES, 'night');
    else text = pickNonRepeat(RANDOM_PROMPTS, 'random');

    const messages = [{ type: 'text', text }];
    await Promise.allSettled(users.map(id => client.pushMessage(id, messages)));

    res.json({ ok: true, type, sent: users.length });
  } catch (e) {
    console.error('broadcast error', e?.response?.data || e);
    res.status(500).json({ ok: false });
  }
});

/* ========= 管理者リセット =========
   POST /admin/reset  { userId?: string }
   Header: BROADCAST_AUTH_TOKEN: <env>
*/
app.post('/admin/reset', (req, res) => {
  const key = req.headers['broadcast_auth_token'];
  if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { userId } = req.body || {};
  if (userId) {
    store.del(`user:${userId}`);
    return res.json({ ok: true, target: userId });
  }
  // 全員（危険）：knownUsers だけ削除
  const users = Array.from(getKnown());
  users.forEach(id => store.del(`user:${id}`));
  store.set(knownKey, new Set());
  return res.json({ ok: true, cleared: users.length });
});

/* ========= 起動 ========= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
  console.log('Your service is live 🎉');
});
