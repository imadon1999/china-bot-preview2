import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import NodeCache from 'node-cache';

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);
const state = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 120 });

const nowHour = () => new Date().getHours();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isShotaName = (name='') => /しょうた|ショウタ|shota|imadon/i.test(name);
const ownerId = process.env.OWNER_USER_ID;

async function ensureUser(ctx) {
  const id = ctx.source.userId;
  let u = state.get(`user:${id}`);
  if (!u) {
    let name = '';
    try {
      const prof = await client.getProfile(id);
      name = prof?.displayName || '';
    } catch (_) {}
    u = { id, name, gender: null, nickname: null, intimacy: 30, consent: false, loverMode: false };
    if ((name && isShotaName(name)) || (ownerId && id === ownerId)) u.loverMode = true;
    state.set(`user:${id}`, u);
  }
  return u;
}

const tone = {
  friendly: (t) => ` ${t}`,
  lover: (t) => ` ${t}💗`,
};

function consentMessage() {
  return {
    type: 'flex',
    altText: 'プライバシー同意のお願い',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold', size: 'md' },
          { type: 'text', text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'プライバシーポリシー', weight: 'bold' },
          { type: 'text', wrap: true, size: 'sm',
            text: '記憶は会話の向上のためだけに使い、第三者提供しません。いつでも削除OKです。' },
          { type: 'text', size: 'sm', color: '#888888', text: '全文はプロフィールのURLからご確認ください。' }
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

function suggestNick(u) {
  const name = u.name || 'きみ';
  const base = name.replace(/さん|くん|ちゃん/g,'').slice(0, 4);
  const candidates = [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`, `しょーたん`, `しょたぴ`];
  if (isShotaName(name)) return pick(['しょーたん', 'しょたぴ', 'しょうちゃん']);
  return pick(candidates);
}

async function routeText(u, text) {
  const t = text.trim();
  if (/^同意$/i.test(t)) {
    u.consent = true;
    state.set(`user:${u.id}`, u);
    return [
      { type: 'text', text: '同意ありがとう！これからもっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずはお名前（呼び方）教えて？\n例）しょうた など' }
    ];
  }
  if (/やめておく/i.test(t)) return [{ type: 'text', text: 'わかったよ。いつでも気が変わったら言ってね🌸' }];

  if (u.consent && !u.name && t.length <= 16) {
    u.name = t;
    if (isShotaName(t)) u.loverMode = true;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `じゃあ ${t} って呼ぶね！` }];
  }

  if (/あだ名つけて|ニックネーム/i.test(t)) {
    const nick = suggestNick(u);
    u.nickname = nick;
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `うーん…${nick} が可愛いと思うな、どう？` }];
  }

  if (/性別|男|女|女性|男性/.test(t) && u.consent) {
    if (/女性|女/i.test(t)) u.gender = 'female';
    else if (/男性|男/i.test(t)) u.gender = 'male';
    state.set(`user:${u.id}`, u);
    return [{ type: 'text', text: `了解だよ〜！メモしておくね📝` }];
  }

  if (/おはよ/.test(t)) {
    const msg = pick(['おはよう☀️今日もいちばん応援してる！', 'おはよ〜、まずは深呼吸しよ？すー…はー…🤍']);
    return [{ type: 'text', text: u.loverMode ? msg + ' ぎゅっ🫂' : msg }];
  }
  if (/おやすみ|寝る/.test(t)) {
    const msg = pick(['今日もがんばったね。ゆっくりおやすみ🌙', '明日もとなりで応援してるからね、ぐっすり…💤']);
    return [{ type: 'text', text: u.loverMode ? msg + ' 添い寝、ぎゅ〜🛏️' : msg }];
  }

  if (/寂しい|さびしい|つらい|しんど/i.test(t)) {
    const msg = u.gender === 'female'
      ? 'わかる…その気持ち。まずは私が味方だよ。よかったら、今いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: msg }];
  }

  if (/イマドン|白い朝|Day by day|Mountain|I don'?t remember/i.test(t)) {
    const msg = pick([
      '『白い朝、手のひらから』…まっすぐで、胸があったかくなる曲だったよ。',
      '“Day by day”染みた…小さな前進を抱きしめてくれる感じ🌿',
      '“Mountain”は景色が浮かぶんだよね。息を合わせて登っていこうって気持ちになる。'
    ]);
    return [{ type: 'text', text: msg }];
  }

  if (/スタンプ|stamp/i.test(t)) {
    return [{
      type: 'sticker',
      packageId: '11537',
      stickerId: pick(['52002735', '52002736', '52002768'])
    }];
  }

  const call = u.nickname || u.name || 'きみ';
  const base = nowHour() < 12 ? `おはよ、${call}。今日なにする？` : `ねぇ${call}、いま何してた？`;
  return [{ type: 'text', text: u.loverMode ? base + ' となりでぎゅ…🫂' : base }];
}

const app = express();
app.get('/health', (_, res) => res.status(200).send('OK'));

app.post('/webhook', lineMiddleware(config), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);

      if (e.message.type === 'text') {
        if (!u.consent) { await client.replyMessage(e.replyToken, consentMessage()); continue; }
        const replies = await routeText(u, e.message.text || '');
        if (replies?.length) await client.replyMessage(e.replyToken, replies);
        continue;
      }
      await client.replyMessage(e.replyToken, { type: 'text', text: u.loverMode ? '写真ありがと…大事に見るね📷💗' : '送ってくれてありがとう！' });
    } catch (err) { console.error('handle error', err?.response?.data || err); }
  }
});
app.get('/', (_, res) => res.send('Shiraishi China Preview Bot running. /health = OK'));
app.listen(process.env.PORT || 3000, () => console.log('Server started.'));
