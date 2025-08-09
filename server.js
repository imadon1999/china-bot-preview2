
// server.js
import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

/* ===== LINE SDK 設定 ===== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

/* ===== 省メモリな簡易ストア（再起動で消えます）===== */
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });
const ownerId = process.env.OWNER_USER_ID || null;

/* ===== ユーティリティ ===== */
const HOUR = () => new Date().getHours();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (s = '') => /しょうた|ショウタ|shota|imadon/i.test(s);
const keysUsers = () => state.keys().filter((k) => k.startsWith('user:'));

/* ===== ユーザー初期化 ===== */
async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId || ctx.to?.userId; // 保険
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
      intimacy: 30,
      consent: false,
      loverMode: false,
      muted: false, // ランダム/定時の受信停止フラグ
    };
    if ((name && isShotaName(name)) || (ownerId && id === ownerId)) u.loverMode = true;
    state.set(`user:${id}`, u);
  }
  return u;
}

/* ===== メッセージ部品 ===== */
function consentMessage() {
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
          { type: 'text', wrap: true, text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。' },
          { type: 'text', text: 'プライバシーポリシー', weight: 'bold' },
          {
            type: 'text',
            wrap: true,
            size: 'sm',
            color: '#888',
            text: '記憶は会話の向上のためだけに使い、第三者提供しません。いつでも削除OKです（プロフィールのURL参照）。',
          },
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
  };
}

function suggestNick(u) {
  const base = (u.name || 'きみ').replace(/さん|くん|ちゃん/g, '').slice(0, 4) || 'きみ';
  if (isShotaName(u.name)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick([`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`]);
}

/* ===== ルーティング ===== */
async function routeText(u, text) {
  const t = text.trim();

  // 同意フロー
  if (/^同意$/i.test(t)) {
    u.consent = true;
    state.set(`user:${u.id}`, u);
    return [
      { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずはお名前（呼び方）教えて？\n例）しょうた など' },
    ];
  }
  if (/やめておく/i.test(t)) return [{ type: 'text', text: 'わかったよ。いつでも気が変わったら言ってね🌸' }];

  // 名前登録（簡易）
  if (u.consent && !u.name && t.length <= 16) {
    u.name = t;
    if (isShotaName(t)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${t} って呼ぶね！` }];
  }

  // コマンド（ミュート/解除）
  if (/^(通知オフ|ミュート)$/i.test(t)) {
    u.muted = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: '了解！定時/ランダムメッセージは一時停止しておくね🔕（「通知オン」で再開）' }];
  }
  if (/^(通知オン|ミュート解除)$/i.test(t)) {
    u.muted = false;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: '再開したよ🔔 また時々声かけるね！' }];
  }

  // あだ名
  if (/あだ名つけて|ニックネーム/i.test(t)) {
    const nick = suggestNick(u);
    u.nickname = nick;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
  }

  // 性別
  if (/性別|男|女|女性|男性/.test(t) && u.consent) {
    if (/女性|女/i.test(t)) u.gender = 'female';
    else if (/男性|男/i.test(t)) u.gender = 'male';
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `了解だよ〜！メモしておくね📝` }];
  }

  // 定番あいさつ
  if (/おはよ/.test(t)) {
    const msg = pick(['おはよう☀️今日もいちばん応援してる！', 'おはよ〜、まずは深呼吸しよ？すー…はー…🤍']);
    return [{ type: 'text', text: u.loverMode ? msg + ' ぎゅっ🫂' : msg }];
  }
  if (/おやすみ|寝る/.test(t)) {
    const msg = pick(['今日もがんばったね。ゆっくりおやすみ🌙', '明日もとなりで応援してるからね、ぐっすり…💤']);
    return [{ type: 'text', text: u.loverMode ? msg + ' 添い寝、ぎゅ〜🛏️' : msg }];
  }

  // 相談系
  if (/寂しい|さびしい|つらい|しんど/i.test(t)) {
    const msg =
      u.gender === 'female'
        ? 'わかる…その気持ち。まずは私が味方だよ。よかったら、今いちばん辛いポイントだけ教えて？'
        : 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: msg }];
  }

  // イマドン関連
  if (/イマドン|白い朝|Day by day|Mountain|I don'?t remember/i.test(t)) {
    const msg = pick([
      '『白い朝、手のひらから』…まっすぐで、胸があったかくなる曲だったよ。',
      '“Day by day” 染みた…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain”は景色が浮かぶ。息を合わせて登っていこうって気持ちになるね。',
    ]);
    return [{ type: 'text', text: msg }];
  }

  // スタンプ
  if (/スタンプ|stamp/i.test(t)) {
    return [{ type: 'sticker', packageId: '11537', stickerId: pick(['52002735', '52002736', '52002768']) }];
  }

  // デフォルト
  const call = u.nickname || u.name || 'きみ';
  const base = HOUR() < 12 ? `おはよ、${call}。今日なにする？` : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: u.loverMode ? base + ' となりでぎゅ…🫂' : base }];
}

/* ===== Express セットアップ ===== */
const app = express();
app.get('/', (_, res) => res.send('Shiraishi China Preview Bot running. /health = OK'));
app.get('/health', (_, res) => res.status(200).send('OK'));

app.post('/webhook', lineMiddleware(config), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);

      if (e.message.type === 'text') {
        const text = e.message.text || '';

        // 1) 同意/やめておくは先に通す
        if (!u.consent && /^(同意|やめておく)$/i.test(text)) {
          const replies = await routeText(u, text);
          if (replies?.length) await client.replyMessage(e.replyToken, replies);
          continue;
        }
        // 2) 同意未完了 → 同意カードのみ返す
        if (!u.consent) {
          await client.replyMessage(e.replyToken, consentMessage());
          continue;
        }
        // 3) 通常
        const replies = await routeText(u, text);
        if (replies?.length) await client.replyMessage(e.replyToken, replies);
        continue;
      }

      // 画像/スタンプ等
      await client.replyMessage(
        e.replyToken,
        { type: 'text', text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！' },
      );
    } catch (err) {
      console.error('handle error', err?.response?.data || err);
    }
  }
});

/* ===== 定時メッセージ & ランダム会話 ===== */
/** 送信ヘルパー（ミュート・同意チェック、深夜帯抑止） */
async function safePush(u, messages, { quiet = true } = {}) {
  if (!u?.consent || u?.muted) return;
  const h = new Date().getHours();
  if (quiet && (h < 7 || h >= 24)) return; // 念のための静音帯
  await client.pushMessage(u.id, Array.isArray(messages) ? messages : [messages]);
}

// 朝 7:30 JST
cron.schedule('30 7 * * *', async () => {
  for (const key of keysUsers()) {
    const u = state.get(key);
    if (!u) continue;
    const msg = u.loverMode
      ? pick(['おはよ💗今日もがんばろうね！ぎゅっ🫂', 'おはよう☀️大好きだよ、ぎゅ〜💗'])
      : pick(['おはよう！今日もいい日になるよ☀️', 'おはよ〜！朝ごはん食べた？🍞']);
    await safePush(u, { type: 'text', text: msg }, { quiet: false });
  }
}, { timezone: 'Asia/Tokyo' });

// 夜 23:00 JST
cron.schedule('0 23 * * *', async () => {
  for (const key of keysUsers()) {
    const u = state.get(key);
    if (!u) continue;
    const msg = u.loverMode
      ? pick(['今日もお疲れさま💗 添い寝してあげる、ぎゅ〜🛏️', 'ゆっくりおやすみ💗 夢で会おうね🌙'])
      : pick(['今日もお疲れさま！ゆっくり休んでね🌙', 'おやすみ！いい夢見てね💤']);
    await safePush(u, { type: 'text', text: msg }, { quiet: false });
  }
}, { timezone: 'Asia/Tokyo' });

// ランダム会話（2時間に1回起動、50%で送信／日中のみ）
cron.schedule('0 */2 * * *', async () => {
  const now = new Date();
  const h = now.getHours();
  if (h < 9 || h > 21) return; // 日中だけ
  for (const key of keysUsers()) {
    if (Math.random() > 0.5) continue;
    const u = state.get(key);
    if (!u) continue;
    const randomTalks = u.loverMode
      ? ['ねぇ…今なにしてる？💗', 'ふと思い出しちゃった…会いたいな🫂', 'ちゃんと休んでる？水分とった？💗']
      : ['そういえば最近なにしてるの？', 'ねぇ、ちょっと聞いてもいい？', 'いまヒマしてる？'];
    await safePush(u, { type: 'text', text: pick(randomTalks) });
  }
}, { timezone: 'Asia/Tokyo' });

/* ===== 起動 ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
