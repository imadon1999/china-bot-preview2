
// server.js — Shiraishi China (preview, full)
// Node >= 18 (ESM)

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

/* =======================
 * Config / Globals
 * ======================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const OWNER_USER_ID        = process.env.OWNER_USER_ID || '';           // あなたのLINE User ID（恋人モード既定ON）
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || '';     // cron/外部からの定時叩き用
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || '';              // 管理者API用

const app = express();
const client = new Client(config);

// 会話状態（1週間保持）
const store = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });

// 既知ユーザー一覧（ブロードキャスト用）
function getUserSet() {
  return new Set(store.get('users') || []);
}
function addUserId(uid) {
  const s = getUserSet();
  if (!s.has(uid)) {
    s.add(uid);
    store.set('users', Array.from(s));
  }
}

// 便利関数群
const nowHour = () => new Date().getHours();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShota = (t='') => /しょうた|ショウタ|shota|imadon/i.test(t);

async function ensureUser(source) {
  const id = source.userId || source?.sender?.id; // safety
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
      nickname: null,
      gender: null,         // 'male' | 'female' | null
      consent: false,       // プライバシー同意
      loverMode: false,     // 恋人トーン
      intimacy: 30          // 0-100（簡易）
    };
    if ((name && isShota(name)) || (OWNER_USER_ID && id === OWNER_USER_ID)) {
      u.loverMode = true;
    }
    store.set(`user:${id}`, u);
  }
  addUserId(u.id);
  return u;
}

// 返信ラッパ（詳細ログ）
async function safeReply(replyToken, messages) {
  try {
    await client.replyMessage(replyToken, messages);
  } catch (err) {
    const r = err?.response;
    console.error('reply error', r?.status || err?.status || '-', r?.statusText || err?.message);
    if (r?.data) console.error('reply error body:', JSON.stringify(r.data));
  }
}
async function safePush(userId, messages) {
  try {
    await client.pushMessage(userId, messages);
  } catch (err) {
    const r = err?.response;
    console.error('push error', r?.status || err?.status || '-', r?.statusText || err?.message);
    if (r?.data) console.error('push error body:', JSON.stringify(r.data));
  }
}

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
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold', size: 'md' },
          { type: 'text', wrap: true, size: 'sm',
            text: 'もっと自然にお話するため、呼び方などを記憶しても良いか教えてね。' },
          { type: 'text', text: 'プライバシーポリシー', weight: 'bold' },
          { type: 'text', wrap: true, size: 'sm',
            text: '記憶は会話の向上のためだけに使い、第三者提供しません。いつでも削除OKです。' },
          { type: 'text', size: 'xs', color: '#888',
            text: '全文はプロフィールのURLからご確認ください。' }
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

/* =======================
 * ヒアリング＆自然会話
 * ======================= */
function suggestNick(u) {
  const base = (u.name || 'きみ').replace(/さん|くん|ちゃん/g,'').slice(0,4) || 'きみ';
  if (isShota(u.name)) return pick(['しょーたん','しょたぴ','しょうちゃん']);
  return pick([`${base}ちゃん`, `${base}くん`, `${base}っち`, `${base}ぴ`]);
}

function detectIntent(text) {
  const t = text.toLowerCase();
  if (/^同意$/.test(text)) return 'consent_yes';
  if (/やめておく/.test(text)) return 'consent_no';
  if (/おはよ|おはよう/.test(t)) return 'morning';
  if (/おやす|寝る/.test(t)) return 'goodnight';
  if (/寂しい|さびしい|つらい|しんど|落ち込/.test(t)) return 'comfort';
  if (/スタンプ|stamp/.test(t)) return 'sticker';
  if (/あだ名|ニックネーム/.test(t)) return 'nickname';
  if (/男|女|男性|女性/.test(t)) return 'gender';
  if (/イマドン|白い朝|day by day|mountain|i don'?t remember/.test(t)) return 'music';
  return 'free';
}

function loverize(msg, on, suffix='') {
  return on ? `${msg}${suffix || ' ぎゅっ🫂'}` : msg;
}

async function route(u, text) {
  const intent = detectIntent(text);

  // 同意フロー
  if (intent === 'consent_yes') {
    u.consent = true;
    store.set(`user:${u.id}`, u);
    return [
      { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずは呼び方教えて？\n例）しょうた など' }
    ];
  }
  if (intent === 'consent_no') {
    return [{ type: 'text', text: 'わかったよ。気が変わったらいつでも言ってね🌸' }];
  }

  // 未同意 → カードでガード
  if (!u.consent) {
    return consentFlex();
  }

  // 名前初回入力（16文字以内くらいを名前とみなす）
  if (!u.name && text.length <= 16) {
    u.name = text.trim();
    if (isShota(u.name)) u.loverMode = true;
    store.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${u.name} って呼ぶね！` }];
  }

  // ニックネーム提案
  if (intent === 'nickname') {
    const nick = suggestNick(u);
    u.nickname = nick; store.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
  }

  // 性別メモ
  if (intent === 'gender') {
    if (/女性|女/.test(text)) u.gender = 'female';
    else if (/男性|男/.test(text)) u.gender = 'male';
    store.set(`user:${u.id}`, u);
    return [{ type: 'text', text: '了解だよ〜！メモしておくね📝' }];
  }

  if (intent === 'morning') {
    const m = pick(['おはよう☀️今日もいちばん応援してる！', 'おはよ〜、まずは深呼吸しよ？すー…はー…🤍']);
    return [{ type: 'text', text: loverize(m, u.loverMode) }];
  }
  if (intent === 'goodnight') {
    const m = pick(['今日もがんばったね。ゆっくりおやすみ🌙', '明日もとなりで応援してるからね、ぐっすり…💤']);
    return [{ type: 'text', text: loverize(m, u.loverMode, ' 添い寝、ぎゅ〜🛏️') }];
  }
  if (intent === 'comfort') {
    const m = (u.gender === 'female')
      ? 'わかる…その気持ち。まずは私が味方だよ。今いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: m }];
  }
  if (intent === 'music') {
    const m = pick([
      '『白い朝、手のひらから』…まっすぐで胸があったかくなる曲だったよ。',
      '“Day by day” 染みた…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain”は景色が浮かぶんだよね。一緒に登っていこうって気持ちになる。'
    ]);
    return [{ type: 'text', text: m }];
  }
  if (intent === 'sticker') {
    return [{
      type: 'sticker',
      packageId: '11537',
      stickerId: pick(['52002735','52002736','52002768'])
    }];
  }

  // 自然会話（軽いテンプレ）
  const call = u.nickname || u.name || 'きみ';
  const base = nowHour() < 12
    ? `おはよ、${call}。今日は何する予定？`
    : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: loverize(base, u.loverMode) }];
}

/* =======================
 * ルーティング
 * ======================= */

// /health
app.get('/health', (_, res) => res.status(200).send('OK'));

// ----- LINE webhook -----
// 署名検証のため raw body を渡す（ERR_INVALID_ARG_TYPE対策）
app.post(
  '/webhook',
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; }   // lineMiddleware が参照
  }),
  lineMiddleware(config),
  async (req, res) => {
    res.status(200).end();

    const events = req.body?.events || [];
    for (const e of events) {
      try {
        // 既知ユーザー管理
        if (e?.source?.userId) addUserId(e.source.userId);
        const u = await ensureUser(e.source);

        // セルフリセット（ユーザー側）
        if (e.type === 'message' && e.message?.type === 'text' &&
            /^(reset|リセット)$/i.test(e.message.text || '')) {
          store.del(`user:${u.id}`);
          await safeReply(e.replyToken, [{ type: 'text', text: '会話メモをリセットしたよ。はじめましてから、よろしくね！' }]);
          continue;
        }

        // テキスト
        if (e.type === 'message' && e.message?.type === 'text') {
          const text = e.message.text || '';

          // 未同意：同意/やめておくだけは先に処理
          if (!u.consent && /^(同意|やめておく)$/i.test(text)) {
            const msgs = await route(u, text);
            await safeReply(e.replyToken, msgs);
            continue;
          }
          // 未同意：カードを返す
          if (!u.consent) {
            await safeReply(e.replyToken, consentFlex());
            continue;
          }

          const msgs = await route(u, text);
          await safeReply(e.replyToken, msgs);
          continue;
        }

        // 画像/その他
        await safeReply(e.replyToken, [{
          type: 'text',
          text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！'
        }]);
      } catch (err) {
        const r = err?.response;
        console.error('handle error', r?.status || err?.status || '-', r?.statusText || err?.message);
        if (r?.data) console.error('handle error body:', JSON.stringify(r.data));
      }
    }
  }
);

/* =======================
 * 定時メッセ & ランダム呼びかけ
 *   例）/tasks/broadcast?type=morning
 *   Header: BROADCAST_AUTH_TOKEN: <token>
 * ======================= */
app.post('/tasks/broadcast', express.json(), async (req, res) => {
  try {
    const token = req.get('BROADCAST_AUTH_TOKEN') || '';
    if (!BROADCAST_AUTH_TOKEN || token !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const type = (req.query.type || 'random').toString();
    const users = Array.from(getUserSet());
    if (users.length === 0) return res.json({ ok: true, sent: 0 });

    let template;
    if (type === 'morning') {
      template = () => pick([
        'おはよう☀️ 今日も小さくても前に進もうね！',
        '朝の深呼吸、すー…はー…🤍 いってらっしゃい！'
      ]);
    } else if (type === 'night') {
      template = () => pick([
        '今日もえらかったね。おやすみ🌙 また明日いちばんに応援させてね。',
        '湯船つかった？あったかくして寝よ〜💤'
      ]);
    } else {
      template = () => pick([
        'ねぇ、いま何してた？',
        '水分とった？一緒に一杯のもう🥤',
        'そういえば最近のマイブーム教えて〜！'
      ]);
    }

    let sent = 0;
    for (const uid of users) {
      await safePush(uid, [{ type: 'text', text: template() }]);
      sent++;
    }
    res.json({ ok: true, type, sent });
  } catch (err) {
    const r = err?.response;
    console.error('broadcast error', r?.status || err?.status || '-', r?.statusText || err?.message);
    if (r?.data) console.error('broadcast body:', JSON.stringify(r.data));
    res.status(500).json({ ok: false });
  }
});

/* =======================
 * 管理API：全ユーザー/個別リセット
 * ======================= */
// 全体リセット
app.post('/admin/reset-all', express.json(), (req, res) => {
  const token = req.get('ADMIN_TOKEN') || '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });

  const keys = store.keys();
  for (const k of keys) store.del(k);
  res.json({ ok:true, cleared: keys.length });
});

// 個別リセット ?userId=xxx
app.post('/admin/reset-user', express.json(), (req, res) => {
  const token = req.get('ADMIN_TOKEN') || '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });

  const id = (req.query.userId || '').toString();
  if (!id) return res.status(400).json({ ok:false, error:'userId required' });

  store.del(`user:${id}`);
  res.json({ ok:true, userId:id });
});

/* =======================
 * Server boot
 * ======================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
