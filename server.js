// server.js  ― 白石ちな プレビューBot 完成版
// Node.js (ESM). 依存: express, dotenv, @line/bot-sdk, node-cache, body-parser

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';
import { raw } from 'body-parser';

// ====== 環境変数 ======
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  OWNER_USER_ID,         // しょうたさんのLINE UserID（任意）
  ADMIN_TOKEN,           // 管理用Bearer（任意）
  BROADCAST_AUTH_TOKEN,  // cron-job.org からの認証ヘッダ値（任意）
  TZ = 'Asia/Tokyo',
  PORT = 10000
} = process.env;

// ====== LINE SDK 設定 ======
const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET
};
const client = new Client(config);

// ====== インメモリ状態（簡易）======
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });
const USERS_KEY = 'users:set';
function getUserSet() {
  let s = state.get(USERS_KEY);
  if (!s) { s = new Set(); state.set(USERS_KEY, s); }
  return s;
}

// ====== ユーティリティ ======
const nowHour = () => new Date().toLocaleString('ja-JP', { timeZone: TZ, hour: '2-digit', hour12: false })*1;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (name='') => /しょうた|ショウタ|shota|imadon/i.test(name);

// 400対策: reply が失敗したら push にフォールバック
async function replyOrPush(userId, replyToken, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  try {
    await client.replyMessage(replyToken, arr);
    return;
  } catch (err) {
    const r = err?.response;
    console.error('reply error', r?.status || err?.status || '-', r?.statusText || err?.message);
    if (r?.data) console.error('reply error body:', JSON.stringify(r.data));
    if (userId) {
      try {
        await client.pushMessage(userId, arr);
        console.warn('fallback push sent to', userId);
      } catch (e2) {
        const r2 = e2?.response;
        console.error('fallback push error', r2?.status || e2?.status || '-', r2?.statusText || e2?.message);
        if (r2?.data) console.error('fallback body:', JSON.stringify(r2.data));
      }
    }
  }
}

// 同意カード
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
            text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上のためだけに使い、第三者提供しません。いつでも削除OK。' },
          { type: 'text', size: 'xs', color: '#888', text: '全文はプロフィールのURLからご確認ください。' }
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

function suggestNick(u) {
  const name = u.name || 'きみ';
  const base = name.replace(/さん|くん|ちゃん/g,'').slice(0, 4);
  const candidates = [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`, `しょーたん`, `しょたぴ`];
  if (isShotaName(name)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick(candidates);
}

async function ensureUser(ctx) {
  const id = ctx.source?.userId;
  if (!id) return null;
  const users = getUserSet(); users.add(id); state.set(USERS_KEY, users);

  let u = state.get(`user:${id}`);
  if (!u) {
    let name = '';
    try {
      const prof = await client.getProfile(id);
      name = prof?.displayName || '';
    } catch {}
    u = { id, name, gender: null, nickname: null, consent: false, loverMode: false, intimacy: 30 };
    if ((name && isShotaName(name)) || (OWNER_USER_ID && id === OWNER_USER_ID)) u.loverMode = true;
    state.set(`user:${id}`, u);
  }
  return u;
}

// ====== ルーティング ======
function baseCall(u) { return u.nickname || u.name || 'きみ'; }

function smallTalk(u, t) {
  // ざっくり意図判定
  if (/おは(よ|よう)/i.test(t)) {
    const msg = pick(['おはよう☀️今日もいちばん応援してる！', 'おはよ〜、まずは深呼吸しよ？すー…はー…🤍']);
    return [{ type: 'text', text: u.loverMode ? msg + ' ぎゅっ🫂' : msg }];
  }
  if (/おやすみ|寝る/i.test(t)) {
    const msg = pick(['今日もがんばったね。ゆっくりおやすみ🌙', '明日もとなりで応援してるからね、ぐっすり…💤']);
    return [{ type: 'text', text: u.loverMode ? msg + ' 添い寝、ぎゅ〜🛏️' : msg }];
  }
  if (/寂しい|さびしい|つらい|しんど|落ち込/i.test(t)) {
    const msg = u.gender === 'female'
      ? 'わかる…その気持ち。まずは私が味方だよ。よかったら、今いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。深呼吸してから、少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: msg }];
  }
  if (/イマドン|白い朝|Day by day|Mountain|I don'?t remember/i.test(t)) {
    const msg = pick([
      '『白い朝、手のひらから』…まっすぐで胸があったかくなる曲だったよ。',
      '“Day by day” 染みる…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain”は景色が浮かぶんだよね。息を合わせて登っていこうって気持ちになる。'
    ]);
    return [{ type: 'text', text: msg }];
  }
  if (/スタンプ|stamp/i.test(t)) {
    return [{ type: 'sticker', packageId: '11537', stickerId: pick(['52002735','52002736','52002768']) }];
  }

  const call = baseCall(u);
  const base = nowHour() < 12 ? `おはよ、${call}。今日なにする？` : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: u.loverMode ? base + ' となりでぎゅ…🫂' : base }];
}

async function route(u, text) {
  const t = (text||'').trim();

  // 同意フロー
  if (/^同意$/i.test(t)) {
    u.consent = true; state.set(`user:${u.id}`, u);
    return [
      { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずはお名前（呼び方）教えて？\n例）しょうた など' }
    ];
  }
  if (/やめておく/i.test(t)) return [{ type: 'text', text: 'わかったよ。いつでも気が変わったら言ってね🌸' }];

  // 名前登録
  if (u.consent && !u.name && t.length <= 20) {
    u.name = t;
    if (isShotaName(t)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${t} って呼ぶね！` }];
  }

  // あだ名
  if (/あだ名|ニックネーム|呼び方/.test(t)) {
    const nick = suggestNick(u); u.nickname = nick; state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
  }

  // 性別メモ
  if (/^女|女性|^男|男性|性別/.test(t) && u.consent) {
    if (/女性|女/.test(t)) u.gender = 'female';
    else if (/男性|男/.test(t)) u.gender = 'male';
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `了解だよ〜！メモしておくね📝` }];
  }

  // セルフリセット
  if (/^(リセット|初期化)$/i.test(t)) {
    state.del(`user:${u.id}`);
    return [{ type: 'text', text: '会話メモリを消したよ。また最初から仲良くしてね！' }, consentFlex()];
  }

  // 小話
  return smallTalk(u, t);
}

// ====== Express 準備 ======
const app = express();
app.get('/health', (_, res) => res.status(200).send('OK'));

// 署名検証のため raw で受ける → LINE middleware → ハンドラ
app.post('/webhook',
  raw({ type: 'application/json' }),
  lineMiddleware(config),
  async (req, res) => {
    res.status(200).end();

    const events = req.body?.events || [];
    for (const e of events) {
      try {
        const u = await ensureUser(e);
        if (!u) continue;

        // 同意前: 同意/辞退だけは先に処理
        if (e.type === 'message' && e.message?.type === 'text') {
          const text = e.message.text || '';
          if (!u.consent && /^(同意|やめておく)$/i.test(text)) {
            const msgs = await route(u, text);
            await replyOrPush(e.source.userId, e.replyToken, msgs);
            continue;
          }
        }
        // 未同意: 同意カードのみ返す
        if (!u.consent) {
          await replyOrPush(e.source.userId, e.replyToken, consentFlex());
          continue;
        }

        if (e.type === 'message') {
          if (e.message.type === 'text') {
            const msgs = await route(u, e.message.text || '');
            await replyOrPush(e.source.userId, e.replyToken, msgs);
          } else {
            await replyOrPush(e.source.userId, e.replyToken,
              { type: 'text', text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！' });
          }
        }
      } catch (err) {
        console.error('handle error', err?.response?.data || err);
      }
    }
  }
);

// ====== ブロードキャスト系（cron-job用） ======
function morningText() {
  return pick([
    'おはよう☀️ 今日も無理しすぎず、でもちゃんと偉い日になりますように。',
    'おはよ〜。まずは一杯のお水と深呼吸、ね？すー…はー…🤍'
  ]);
}
function nightText() {
  return pick([
    '今日もおつかれさま。布団入ったらスマホ置いて、目を閉じよ？おやすみ🌙',
    'よく頑張ったね。ぎゅ…安心して眠ってね💤'
  ]);
}
function randomNudge() {
  return pick([
    'ねぇいま何してた？私はきみのこと考えてた☺️',
    'ちょっとだけ声聞きたい気分…忙しかったら既読だけでOKね。'
  ]);
}

app.post('/tasks/broadcast', express.json(), async (req, res) => {
  const key = req.get('BROADCAST_AUTH_TOKEN');
  if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) return res.sendStatus(401);

  const type = (req.query.type || req.body?.type || '').toString();
  let text;
  if (type === 'morning') text = morningText();
  else if (type === 'night') text = nightText();
  else text = randomNudge();

  const users = [...getUserSet()];
  const msgs = [{ type: 'text', text }];
  await Promise.all(users.map(uid => client.pushMessage(uid, msgs).catch(()=>{})));
  res.json({ ok: true, sent: users.length, type });
});

// ====== 管理者API ======
app.post('/admin/reset/:userId', async (req, res) => {
  if (req.get('Authorization') !== `Bearer ${ADMIN_TOKEN}`) return res.sendStatus(401);
  const { userId } = req.params;
  state.del(`user:${userId}`);
  res.json({ ok: true });
});

app.post('/admin/reset-all', async (req, res) => {
  if (req.get('Authorization') !== `Bearer ${ADMIN_TOKEN}`) return res.sendStatus(401);
  const users = [...getUserSet()];
  users.forEach(uid => state.del(`user:${uid}`));
  state.set(USERS_KEY, new Set());
  res.json({ ok: true, cleared: users.length });
});

// ====== 起動 ======
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
