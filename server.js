
// server.js
import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

// =========================
// 基本設定（環境変数）
// =========================
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';        // オーナー(しょうた)のLINE userId
const ADMIN_KEY      = process.env.ADMIN_KEY || '';            // 管理APIトークン
const BROADCAST_AUTH = process.env.BROADCAST_AUTH_TOKEN || ''; // cron-job からの認証用
const TZ             = process.env.TZ || 'Asia/Tokyo';

// =========================
// 状態ストア（メモリ）
// =========================
const client = new Client(config);
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 }); // 7日保持

// =========================
// 小ユーティリティ
// =========================
const now = () => new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
const hour = () => now().getHours();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (name = '') => /しょうた|ショウタ|shota|imadon/i.test(name);

// 全友だち一覧をキャッシュ（簡易）※本番はDB推奨
const getAllUserIds = () => {
  const keys = state.keys().filter(k => k.startsWith('user:'));
  return keys.map(k => state.get(k)?.id).filter(Boolean);
};

// =========================
// ユーザー確保／初期化
// =========================
async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId || ctx.id;
  let u = state.get(`user:${id}`);
  if (!u) {
    let displayName = '';
    try {
      const prof = await client.getProfile(id);
      displayName = prof?.displayName || '';
    } catch (_) {}
    u = {
      id,
      name: displayName || '',
      nickname: null,
      gender: null,
      consent: false,
      loverMode: false,     // 恋人距離感（オーナー or 名前が“しょうた”系ならON）
      intimacy: 35,         // 親密度の雰囲気スコア
      lastRandomAt: 0
    };
    if ((displayName && isShotaName(displayName)) || (OWNER_USER_ID && id === OWNER_USER_ID)) {
      u.loverMode = true;
    }
    state.set(`user:${id}`, u);
  }
  return u;
}

// =========================
/* テンプレ群 */
// =========================
const tone = {
  friendly: (t) => `${t}`,
  lover:    (t) => `${t}💗`,
};

const greetMorning = [
  'おはよう☀️ 今日もいちばん応援してる！',
  'おはよ〜、まずは深呼吸しよ？ すー…はー…🤍',
  '起きれたのえらい！水分とっていこ〜🥤'
];
const greetNight = [
  '今日もがんばったね。ゆっくりおやすみ🌙',
  '明日もとなりで応援してるからね、ぐっすり…💤',
  'スマホは置いて、目を閉じよ？ぎゅ〜🛏️'
];

const smallTalk = [
  'ねぇ、いま何してた？',
  '最近ハマってる曲ある？私は“白い朝、手のひらから”が頭から離れないの。',
  '水分ちゃんととってる？',
  '今日はどんな一日だった？一言で表すなら？',
];

const comfortFemale = 'わかる…その感じ。まずは私が味方だよ。いちばん辛かったポイントだけ教えて？';
const comfortNeutral = 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';

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
          { type: 'text', wrap: true, size: 'sm', text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。' },
          { type: 'text', text: 'プライバシーポリシー', weight: 'bold' },
          { type: 'text', wrap: true, size: 'sm', text: '記憶は会話の向上のためだけに使い、第三者提供しません。いつでも削除OKです。' },
          { type: 'text', size: 'sm', color: '#888', text: '全文はプロフィールのURLからご確認ください。' }
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

function suggestNick(u) {
  const base = (u.name || 'きみ').replace(/さん|くん|ちゃん/g, '').slice(0, 4);
  const candidates = [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`, `しょーたん`, `しょたぴ`];
  if (isShotaName(u.name)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick(candidates);
}

// =========================
// 軽い意図判定 → 返信生成
// =========================
async function routeText(u, text) {
  const t = (text || '').trim();

  // --- 同意フロー優先 ---
  if (/^同意$/i.test(t)) {
    u.consent = true;
    state.set(`user:${u.id}`, u);
    return [
      { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずはお名前（呼び方）教えて？\n例）しょうた など' }
    ];
  }
  if (/やめておく/i.test(t)) {
    return [{ type: 'text', text: 'わかったよ。いつでも気が変わったら言ってね🌸' }];
  }
  if (t === 'リセット') {
    state.del(`user:${u.id}`);
    return [{ type: 'text', text: 'あなたの記憶を一旦クリアしたよ。最初からやり直そ〜🧹' }];
  }

  // --- ヒアリング ---
  if (u.consent && !u.name && t.length <= 16) {
    u.name = t;
    if (isShotaName(t) || u.id === OWNER_USER_ID) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${t} って呼ぶね！` }];
  }
  if (/あだ名|ニックネーム/i.test(t)) {
    const nick = suggestNick(u);
    u.nickname = nick;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `うーん… ${nick} が可愛いと思うな、どう？` }];
  }
  if (/女性|女/.test(t) && u.consent) {
    u.gender = 'female'; state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: '了解だよ〜！メモしておくね📝' }];
  }
  if (/男性|男/.test(t) && u.consent) {
    u.gender = 'male'; state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: '了解だよ〜！メモしておくね📝' }];
  }

  // --- 生活挨拶 ---
  if (/おはよ|おはよう/i.test(t)) {
    const msg = pick(greetMorning);
    return [{ type: 'text', text: u.loverMode ? tone.lover(msg + ' ぎゅっ🫂') : tone.friendly(msg) }];
  }
  if (/おやすみ|寝る/i.test(t)) {
    const msg = pick(greetNight);
    return [{ type: 'text', text: u.loverMode ? tone.lover(msg + ' 添い寝…🛏️') : tone.friendly(msg) }];
  }

  // --- ケア・相談 ---
  if (/寂しい|さびしい|つらい|しんど|不安|落ち込/i.test(t)) {
    const msg = u.gender === 'female' ? comfortFemale : comfortNeutral;
    return [{ type: 'text', text: msg }];
  }

  // --- 作品（イマドン）に触れる ---
  if (/イマドン|今どん|白い朝|Day by day|Mountain|I don'?t remember/i.test(t)) {
    const msg = pick([
      '『白い朝、手のひらから』…まっすぐで、胸があったかくなる曲だったよ。',
      '“Day by day” 染みた…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain”は景色が浮かぶ。息を合わせて登っていこうって気持ちになる！'
    ]);
    return [{ type: 'text', text: msg }];
  }

  // --- スタンプ ---
  if (/スタンプ|stamp/i.test(t)) {
    return [{
      type: 'sticker',
      packageId: '11537',
      stickerId: pick(['52002735', '52002736', '52002768'])
    }];
  }

  // --- ランダム小話（会話の起点） ---
  if (/話題|ひま|暇|なに話す|何話す/i.test(t)) {
    const q = pick(smallTalk);
    return [{ type: 'text', text: u.loverMode ? tone.lover(q) : tone.friendly(q) }];
  }

  // --- 通常ラリー ---
  const call = u.nickname || u.name || 'きみ';
  const base = hour() < 12 ? `おはよ、${call}。今日なにする？` : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: u.loverMode ? tone.lover(base + ' となりでぎゅ…🫂') : tone.friendly(base) }];
}

// =========================
// Express 構築
// =========================
const app = express();

// ヘルスチェック（Render用）
app.get('/health', (_, res) => res.status(200).send('OK'));

// 署名検証が必要な /webhook は raw body を保つため、グローバルで express.json() は使わない！
app.post('/webhook', lineMiddleware(config), async (req, res) => {
  res.status(200).end();
  const events = req.body?.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);

      // 同意カード先出し
      if (!u.consent && e.message?.type === 'text') {
        if (!/^(同意|やめておく)$/i.test(e.message.text || '')) {
          await client.replyMessage(e.replyToken, consentFlex());
          continue;
        }
      }
      if (e.message.type === 'text') {
        const replies = await routeText(u, e.message.text);
        if (replies?.length) await client.replyMessage(e.replyToken, replies);
      } else {
        await client.replyMessage(e.replyToken, { type: 'text', text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！' });
      }
    } catch (err) {
      console.error('handle error', err?.response?.data || err);
    }
  }
});

// =========================
// 管理API（個別に JSON を付ける）
// =========================
app.use('/tasks', express.json());
app.use('/admin', express.json());

// 1) 管理者リセット
app.post('/admin/reset', async (req, res) => {
  if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const { type = 'all', userId } = req.body || {};
  if (type === 'all') {
    getAllUserIds().forEach(id => state.del(`user:${id}`));
    return res.json({ ok: true, cleared: 'all' });
  }
  if (type === 'user' && userId) {
    state.del(`user:${userId}`);
    return res.json({ ok: true, cleared: userId });
  }
  return res.status(400).json({ ok: false, error: 'bad_request' });
});

// 2) ブロードキャスト（cron-job 用）
app.post('/tasks/broadcast', async (req, res) => {
  if ((req.headers['broadcast_auth_token'] || '') !== BROADCAST_AUTH)
    return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { type = 'random' } = req.query;
  let text;
  if (type === 'morning') text = pick(greetMorning);
  else if (type === 'night') text = pick(greetNight);
  else text = pick(smallTalk);

  const ids = getAllUserIds();
  await Promise.all(ids.map(async (id) => {
    const u = state.get(`user:${id}`) || { loverMode: false };
    try {
      await client.pushMessage(id, { type: 'text', text: u.loverMode ? tone.lover(text) : tone.friendly(text) });
    } catch (e) {
      console.error('push error', id, e?.response?.data || e);
    }
  }));
  res.json({ ok: true, sent: ids.length, type });
});

// =========================
// サーバ起動
// =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
