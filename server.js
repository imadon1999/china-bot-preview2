// server.js  ── LINE Bot「白石ちな」最新版（自然会話・同意フロー・定時配信・ログ強化）

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

// ---------- 基本設定 ----------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);

// メモリ状態（簡易キャッシュ：7日保持）
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });

// 環境変数（あれば使う）
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';             // 管理者（プレビュー送信用）
const BROADCAST_AUTH_TOKEN = process.env.BROADCAST_AUTH_TOKEN || '';// 定時配信の簡易認証
const PORT = process.env.PORT || 10000;

// ---------- ヘルパ ----------
const nowHour = () => new Date().getHours();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (name = '') => /しょうた|ショウタ|shota|imadon/i.test(name);

// ユーザー状態の確保
async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId; // イベント or 手動pushで使えるように
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
      intimacy: 30,
      loverMode: false
    };
    if ((name && isShotaName(name)) || (OWNER_USER_ID && id === OWNER_USER_ID)) {
      u.loverMode = true;
    }
    state.set(`user:${id}`, u);
  }
  return u;
}

// ---------- 同意カード ----------
function consentFlex() {
  return {
    type: 'flex',
    altText: 'プライバシー同意のお願い',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold', size: 'md' },
          { type: 'text', text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。', wrap: true, size: 'sm' }
        ],
        spacing: 'sm'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'プライバシーポリシー', weight: 'bold' },
          { type: 'text', wrap: true, size: 'sm',
            text: '記憶は会話の向上のためだけに使い、第三者提供しません。いつでも削除OKです。' },
          { type: 'text', size: 'sm', color: '#888', text: '全文はプロフィールのURLからご確認ください。', wrap: true }
        ],
        spacing: 'md'
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

// ニックネーム提案
function suggestNick(u) {
  const name = u.name || 'きみ';
  const base = name.replace(/さん|くん|ちゃん/g, '').slice(0, 4) || 'きみ';
  const candidates = [
    `${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`,
    `しょーたん`, `しょたぴ`
  ];
  if (isShotaName(name)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick(candidates);
}

// ---------- 会話ルーター（同意済み以降の通常テキスト） ----------
async function routeText(u, textRaw) {
  const t = (textRaw || '').trim();

  // あだ名
  if (/あだ名|ニックネーム/i.test(t)) {
    const nick = suggestNick(u);
    u.nickname = nick;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
  }

  // 性別ヒント
  if (/性別|男|女|女性|男性/.test(t)) {
    if (/女性|女/i.test(t)) u.gender = 'female';
    else if (/男性|男/i.test(t)) u.gender = 'male';
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `了解だよ〜！メモしておくね📝` }];
  }

  // あいさつ
  if (/おは(よ|よう)/i.test(t)) {
    const msg = pick(['おはよう☀️今日もいちばん応援してる！', 'おはよ〜、まずは深呼吸しよ？すー…はー…🤍']);
    return [{ type: 'text', text: u.loverMode ? msg + ' ぎゅっ🫂' : msg }];
  }
  if (/おやすみ|寝る/i.test(t)) {
    const msg = pick(['今日もがんばったね。ゆっくりおやすみ🌙', '明日もとなりで応援してるからね、ぐっすり…💤']);
    return [{ type: 'text', text: u.loverMode ? msg + ' 添い寝、ぎゅ〜🛏️' : msg }];
  }

  // 悩み系
  if (/寂しい|さびしい|辛い|つらい|しんど|落ち込/i.test(t)) {
    const msg = u.gender === 'female'
      ? 'わかる…その気持ち。まずは私が味方だよ。よかったら、今いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。深呼吸して、少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: msg }];
  }

  // 作品認識（イマドン）
  if (/イマドン|白い朝|Day by day|Mountain|I don'?t remember/i.test(t)) {
    const msg = pick([
      '『白い朝、手のひらから』…まっすぐで、胸があったかくなる曲だったよ。',
      '“Day by day”染みた…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain”は景色が浮かぶんだよね。息を合わせて登っていこうって気持ちになる。'
    ]);
    return [{ type: 'text', text: msg }];
  }

  // スタンプおねだり
  if (/スタンプ|stamp/i.test(t)) {
    return [{
      type: 'sticker',
      packageId: '11537',
      stickerId: pick(['52002735', '52002736', '52002768'])
    }];
  }

  // デフォルト返答（温度感）
  const call = u.nickname || u.name || 'きみ';
  const base = nowHour() < 12 ? `おはよ、${call}。今日なにする？` : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: u.loverMode ? base + ' となりでぎゅ…🫂' : base }];
}

// ---------- Express ----------
const app = express();
app.use(express.json());

// 健康チェック
app.get('/health', (_, res) => res.status(200).send('OK'));

// セルフリセット（ユーザーが「リセット」等送った時のための説明表示）
app.get('/', (_, res) => res.send('Shiraishi China Bot is running.'));

// 管理者：ユーザー状態を消す（GET /admin/reset?userId=xxx&token=...）
app.get('/admin/reset', async (req, res) => {
  const { userId, token } = req.query;
  if (!token || token !== (process.env.ADMIN_RESET_TOKEN || '')) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!userId) return res.status(400).json({ ok: false, error: 'missing userId' });
  state.del(`user:${userId}`);
  return res.json({ ok: true });
});

// 定時配信用（cron-job.org などから叩く）
// 例: POST /tasks/broadcast?type=morning  ヘッダ: BROADCAST_AUTH_TOKEN: <env>
app.all('/tasks/broadcast', async (req, res) => {
  try {
    const key = req.headers['broadcast_auth_token'] || req.headers['BROADCAST_AUTH_TOKEN'];
    if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, error: 'bad token' });
    }
    const type = (req.query.type || req.body?.type || '').toString();

    // 送る文面
    let messageText = 'やっほー☺️';
    if (type === 'morning') {
      messageText = pick([
        'おはよう☀️ 今日はどんな1日にする？私はまずコーヒー淹れて深呼吸〜☕️',
        'おはよ〜！無理しすぎないで、マイペースにね。いってらっしゃい🕊'
      ]);
    } else if (type === 'night') {
      messageText = pick([
        '今日もおつかれさま🌙 目閉じて、肩の力ぬこう。おやすみ…😴',
        'がんばったね。水飲んで、ぬくぬく布団へ〜。おやすみ🛏'
      ]);
    } else if (type === 'random') {
      messageText = pick([
        'ねぇ、いま何してた？ふと思い出してメッセしちゃった☺️',
        '最近ハマりごとある？私は音楽探ししてた🎧'
      ]);
    }

    // プレビューのみ管理者に送る場合は ?preview=1 を付与
    if (req.query.preview === '1' && OWNER_USER_ID) {
      await client.pushMessage(OWNER_USER_ID, { type: 'text', text: messageText });
      return res.json({ ok: true, preview: true });
    }

    // 全体配信
    await client.broadcast({ type: 'text', text: messageText });
    return res.json({ ok: true });
  } catch (err) {
    console.error('broadcast error:', JSON.stringify(err?.response?.data || err, null, 2));
    return res.status(500).json({ ok: false });
  }
});

// ---------- Webhook ----------
app.post('/webhook', lineMiddleware(config), async (req, res) => {
  res.status(200).end();

  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;

      const u = await ensureUser(e);

      // テキスト以外（画像/スタンプ等）
      if (e.message.type !== 'text') {
        try {
          await client.replyMessage(e.replyToken, {
            type: 'text',
            text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！'
          });
        } catch (err2) {
          console.error('LINE non-text reply error:',
            JSON.stringify(err2?.response?.data || err2, null, 2));
        }
        continue;
      }

      const text = e.message.text || '';

      // ★ 同意フローは先に処理（カードのループ回避）
      if (!u.consent && /^(同意|やめておく)$/i.test(text)) {
        if (/^同意$/i.test(text)) {
          u.consent = true;
          state.set(`user:${u.id}`, u);
          const first = [
            { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
            { type: 'text', text: 'まずはお名前（呼び方）教えて？\n例）しょうた など' }
          ];
          await client.replyMessage(e.replyToken, first);
        } else {
          await client.replyMessage(e.replyToken, [{ type: 'text', text: 'わかったよ。いつでも気が変わったら言ってね🌸' }]);
        }
        continue;
      }

      // ★ 未同意はカードを一度だけ返す
      if (!u.consent) {
        try {
          await client.replyMessage(e.replyToken, consentFlex());
        } catch (errCard) {
          console.error('consent card error:',
            JSON.stringify(errCard?.response?.data || errCard, null, 2));
          // もしFlexがエラーならテキストで案内
          try {
            await client.replyMessage(e.replyToken, {
              type: 'text',
              text: 'はじめまして、白石ちなです☕️ 記憶の同意をもらえると自然にお話できるよ。「同意」と送ってね。'
            });
          } catch (_) {}
        }
        continue;
      }

      // 名前未設定なら短い文字列を名前として受け付け
      if (!u.name && text.length <= 16 && !/同意|やめておく/.test(text)) {
        u.name = text;
        if (isShotaName(text)) u.loverMode = true;
        state.set(`user:${u.id}`, u);
        await client.replyMessage(e.replyToken, [{ type: 'text', text: `じゃあ ${text} って呼ぶね！` }]);
        continue;
      }

      // 通常ルーティング
      const replies = await routeText(u, text);

      // 返信を正規化（必ず配列＆有効オブジェクト）
      const norm = (Array.isArray(replies) ? replies : [replies])
        .filter(Boolean)
        .map(m => (m.type ? m : { type: 'text', text: String(m) }))
        .map(m => {
          if (m.type === 'text' && m.text && m.text.length > 1900) {
            m.text = m.text.slice(0, 1900) + '…';
          }
          return m;
        });

      try {
        await client.replyMessage(e.replyToken, norm.length ? norm : [{ type: 'text', text: '（…考え中）' }]);
      } catch (errReply) {
        console.error('LINE reply error:',
          JSON.stringify(errReply?.response?.data || errReply, null, 2));
        // フォールバック（返信トークン消費のため）
        try {
          await client.replyMessage(e.replyToken, {
            type: 'sticker',
            packageId: '11537',
            stickerId: '52002736'
          });
        } catch (_) {}
      }
    } catch (err) {
      console.error('handle error:', JSON.stringify(err?.response?.data || err, null, 2));
    }
  }
});

// ---------- 起動 ----------
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
  console.log('Your service is live  🚀');
});
