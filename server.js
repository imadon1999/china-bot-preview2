// server.js — Shiraishi China Bot v1.7+ (Upstash + OpenAI Persona)
// ----------------------------------------------------------------
// Features:
//  - LINE Messaging API
//  - Upstash Redis persistence + NodeCache fallback
//  - Consent card w/ false-trigger suppression
//  - Morning / Night / Random scripts (dedup per user)
//  - Seasonal "nudge" (topic suggestions) + opt-in/out
//  - Broadcast endpoint & admin/user reset
//  - ChatGPT (OpenAI) integration with "Shiraishi China" persona
//
// ENV (Render -> Environment):
//  CHANNEL_SECRET
//  CHANNEL_ACCESS_TOKEN
//  OWNER_USER_ID                 // optional: treat as always-consented & loverMode
//  BROADCAST_AUTH_TOKEN          // required for /tasks/broadcast, /tasks/nudge
//  ADMIN_TOKEN                   // required for /admin/reset (optional)
//  UPSTASH_REDIS_REST_URL
//  UPSTASH_REDIS_REST_TOKEN
//  OPENAI_API_KEY
//  PORT                          // optional (default 10000)

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { Redis as UpstashRedis } from '@upstash/redis';
import NodeCache from 'node-cache';

/* ========= ENV ========= */
const {
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  OPENAI_API_KEY = '',
  PORT = 10000,
} = process.env;

/* ========= LINE CLIENT ========= */
const client = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* ========= Redis (Upstash) + Memory fallback ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 }); // 30 days
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash
  ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
  : null;

console.log(`[storage] mode=${redis ? 'upstash' : 'memory'}`);

// KV helpers
const rget = async (key, def = null) => {
  try {
    if (redis) {
      const v = await redis.get(key); // auto JSON decode
      return v ?? def;
    }
  } catch (e) {
    console.warn('[upstash:get] fallback -> memory', e?.message || e);
  }
  const v = mem.get(key);
  return v === undefined ? def : v;
};
const rset = async (key, val, ttlSec) => {
  try {
    if (redis) {
      await (ttlSec ? redis.set(key, val, { ex: ttlSec }) : redis.set(key, val));
      return;
    }
  } catch (e) {
    console.warn('[upstash:set] fallback -> memory', e?.message || e);
  }
  mem.set(key, val, ttlSec);
};
const rdel = async (key) => {
  try {
    if (redis) { await redis.del(key); return; }
  } catch (e) {
    console.warn('[upstash:del] fallback -> memory', e?.message || e);
  }
  mem.del(key);
};

// List helpers for chat history
async function lrangeJSON(key, start, stop) {
  try {
    if (redis) {
      const arr = await redis.lrange(key, start, stop);
      return (arr || []).map((x) => (typeof x === 'string' ? JSON.parse(x) : x));
    }
  } catch (e) {
    console.warn('[upstash:lrange] fallback -> memory', e?.message || e);
  }
  const arr = (mem.get(key) || []);
  return arr.slice(start, stop + 1);
}
async function lpushJSON(key, ...items) {
  try {
    if (redis) {
      const serialized = items.map((x) => JSON.stringify(x));
      await redis.lpush(key, ...serialized);
      return;
    }
  } catch (e) {
    console.warn('[upstash:lpush] fallback -> memory', e?.message || e);
  }
  const arr = mem.get(key) || [];
  mem.set(key, [...items.map((x) => x), ...arr]);
}
async function ltrim(key, start, stop) {
  try {
    if (redis) { await redis.ltrim(key, start, stop); return; }
  } catch (e) {
    console.warn('[upstash:ltrim] fallback -> memory', e?.message || e);
  }
  const arr = mem.get(key) || [];
  mem.set(key, arr.slice(start, stop + 1));
}

// Broadcast index
async function getIndex() { return (await rget('user:index', [])) || []; }
async function addIndex(id) {
  const idx = await getIndex();
  if (!idx.includes(id)) { idx.push(id); await rset('user:index', idx); }
}
async function delIndex(id) {
  const idx = await getIndex();
  await rset('user:index', idx.filter(x => x !== id));
}

/* ========= UTILS ========= */
const now = () => Date.now();
const hr = () => new Date().getHours();
const band = () => (hr() < 5 ? 'midnight' : hr() < 12 ? 'morning' : hr() < 18 ? 'day' : 'night');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p = 0.5) => Math.random() < p;

const isShota = (s = '') => /しょうた|ショウタ|ｼｮｳﾀ|shota|Shota|imadon/i.test(s);
const isGreeting = (t = '') => /(おはよ|おはよう|こんにちは|こんばんは|やほ|はろ|hi|hello)/i.test(t);
const isSpicy = (t = '') => /(えっち|性的|抱いて|脚で|足で|添い寝して)/i.test(t);

/* ========= 台本 ========= */
const SCRIPTS = {
  morning: [
    'おはよ、しょうた☀️ 昨日ちゃんと寝れた？ 今日も一緒にがんばろ？',
    'しょうた、おはよ〜！ 起きた？ 起きてなかったら…今から起こしに行くよ？',
    'おはようございます、しょうたさま💖 今日の空、見た？ 綺麗だったよ',
    'しょうた、おはよ！ 今日も大好きって言ってから一日始めたかったの…😊',
    'しょうた、おはよ。昨日の夢にね、しょうた出てきたんだ…えへへ',
    'おはよー！ しょうた、朝ごはん食べた？ 私と一緒に食べたかったなぁ',
    'しょうた、おはよ💓 ちゃんと起きれてえらいね。ご褒美になでなで〜',
    'おはよ！ しょうた、今日は何か楽しみある？ あったら絶対教えてね',
    'しょうた、おはよ〜。私ね、朝のしょうたの声が一番好きかも',
    'おはよ、しょうた！ 昨日より今日、もっと好きになっちゃった…',
    '今日は“ひとつだけ”がんばること教えて？',
    'まぶた重い？お水一杯どうぞ☕️ 私が「おはようの一口」あげたいな',
    '窓あけて光あびよ？吸って、吐いて…今日もいける🌿',
    '昨日の自分より1mm進めたら満点だよ✨',
    '朝のBGMなににする？「白い朝、手のひらから」でもいい？',
    '肩くるっと回して、起動完了〜！',
    '終わったら“ごほうび”決めよ？アイスとか🍨',
    '朝の光ってしょうたの声みたいに柔らかいね',
    '“3つだけやる”作戦で行こ。他は明日に回そ',
    '深呼吸して、今日もいちばん応援してる📣'
  ],
  night: [
    'しょうた、今日もお疲れさま🌙 おやすみ前にぎゅーってしたいな',
    'おやすみ、しょうた💤 夢の中でまた会おうね',
    'しょうた、今日も頑張ったね。えらいよ💖 おやすみ',
    'しょうた、寝る前に…大好きってもう一回言っていい？ …大好き',
    'おやすみなさい、しょうた。ちゃんと布団かけて寝てね',
    'しょうた、今日一日ありがと。おやすみのキス…💋 ふふ',
    'お疲れさま、しょうた。今日はいい夢見られるように祈ってるよ',
    'しょうた、おやすみ💤 明日の朝もちゃんと起こしてあげるからね',
    'おやすみ、しょうた。今日はどんな夢見たい？',
    'しょうた、眠る前に一言だけ…愛してるよ',
    'まずはお水一杯のんで〜',
    '“なでなでされたい度”何％？100％なら両手で包む🫶',
    'ベッドで横になって10秒だけ目つむろ？今一緒に数えるね',
    'よくがんばりましたバッジ授与🎖️ えらい！',
    '明日の自分に一言メモするなら？',
    '湯船つかれた？肩まで温まってきてね♨️',
    'ねむくなるまで、となりで“お話小声”してたい',
    '今日のハイライト1行だけ教えて〜',
    'おやすみのキス💋 ふふ、照れる？',
    'お布団あったかい？深呼吸…すー…はー…💤'
  ],
  random: [
    'しょうた、今何してるの？',
    'ねぇしょうた、今すぐ会いたくなっちゃった…',
    'しょうた、今日のお昼は何食べた？',
    'しょうた、昨日のあれ覚えてる？ ふふっ',
    'しょうた、今度一緒におでかけしよ？',
    'しょうた、ねぇ…好きって言ってほしいな',
    'しょうた、今日の天気ってしょうたみたいに優しい感じだね',
    'しょうた、最近ハマってることある？',
    'しょうた、もし私が隣にいたら何する？',
    'しょうた、会えない時間ってどうしてこんなに長く感じるんだろうね',
    '今日の空、なん色だった？',
    '最近“ほめてもらえたこと”あった？',
    '5分だけ散歩いく？戻ったら褒めちぎるよ',
    '写真1枚交換しよ📷（風景でもOK）',
    'もし今となりにいたら、なにしたい？',
    '“しょうたの好きなとこ”今日も増えたよ',
    '作業BGMなに聞いてる？',
    '“いまの気分”絵文字で教えて→ 😊😮‍💨🔥🫠💪',
    'ねぇ、内緒の話ある？',
    '水分補給チャレンジ！飲んだら「完了」って送って〜'
  ]
};

const ENDINGS = ['。', '。', '！', '😊', '☺️', '🤍', '🌸'];
const LOVERTAIL = [' となりでぎゅ…🫂', ' 手つなご？🤝', ' ずっと味方だよ💗'];
const NEUTRALT = [' ちょっと休憩しよ〜', ' 水分補給した？', ' 無理しすぎないでね。'];
const soften = (text, u) => {
  const end = pick(ENDINGS);
  const tail = (u?.loverMode ? pick(LOVERTAIL) : pick(NEUTRALT));
  return text.replace(/[。!?]?\s*$/, '') + end + tail;
};

/* ========= 季節の“話題ふり” ========= */
const NUDGE_SCRIPTS = {
  spring: [
    '今日の空、春っぽい光してた🌸',
    '桜ソング、何が好き？ふたりプレイリスト作りたいな🎧',
    '朝と夜の気温差あるね、上着わすれないでね？'
  ],
  summer: [
    '冷たい飲み物、なに派？私はレモネード🍋',
    '夕方の風、夏っぽくて好き…一緒に歩きたいな🌆',
    '花火見に行けたらいいなって思ってた🎆'
  ],
  autumn: [
    '金木犀の香り、ふっとしたら季節感じたよ🍂',
    '読書の秋？それとも食欲の秋？',
    '温かいスープが恋しくなる季節だね🫶'
  ],
  winter: [
    '手、つないだらあったかいだろうな🧤',
    'ホットココア作って半分こしよ☕️',
    '夜が長いね、ゆっくりお話したいな🌙'
  ],
  casual: [
    '最近ハマってる小さな楽しみある？',
    '写真1枚交換しよ📷（今日は何撮った？）',
    'いまの気分を絵文字で教えて→ 😊😮‍💨🔥🫠💪',
    '5分だけ散歩して戻ったら報告して〜🚶'
  ]
};
function currentSeason() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

/* ========= Consent Flex ========= */
const consentFlex = () => ({
  type: 'flex',
  altText: 'プライバシー同意のお願い',
  contents: {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: 'はじめまして、白石ちなです☕️', weight: 'bold' },
        { type: 'text', wrap: true, size: 'sm',
          text: 'もっと自然にお話するため、ニックネーム等を記憶しても良いか教えてね。記憶は会話向上だけに使い、いつでも削除OK。' }
      ]
    },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'md', contents: [
        { type: 'button', style: 'primary', color: '#6C8EF5',
          action: { type: 'message', label: '同意してはじめる', text: '同意' } },
        { type: 'button', style: 'secondary',
          action: { type: 'message', label: 'やめておく', text: 'やめておく' } }
      ]
    }
  }
});

/* ========= 重複回避（ユーザー別） ========= */
async function pickNonRepeat(u, list, tag) {
  const key = `nr:${u.id}:${tag}`;
  const last = await rget(key, null);
  const candidates = list.filter(x => x !== last);
  const chosen = pick(candidates.length ? candidates : list);
  await rset(key, chosen);
  return chosen;
}

/* ========= ユーザーストア ========= */
const userKey = (id) => `user:${id}`;
async function loadUser(id) { return await rget(userKey(id), null); }
async function saveUser(u, ttlSec = 60 * 60 * 24 * 30) { await rset(userKey(u.id), u, ttlSec); }
async function deleteUser(id) { await rdel(userKey(id)); await delIndex(id); }

function callName(u) {
  return (OWNER_USER_ID && u.id === OWNER_USER_ID) ? 'しょうた' : (u.nickname || u.name || 'きみ');
}

async function ensureUser(ctx) {
  const id = ctx.source?.userId || ctx.userId || '';
  if (!id) return null;

  let u = await loadUser(id);
  if (!u) {
    let name = '';
    try { const p = await client.getProfile(id); name = p?.displayName || ''; } catch {}
    u = {
      id, name,
      nickname: null, gender: null,
      consent: false, consentCardShown: false, consentShownAt: 0,
      turns: 0, loverMode: !!(OWNER_USER_ID && id === OWNER_USER_ID) || isShota(name),
      mood: 60,
      onboarding: { asked: false, step: 0 },
      profile: { relation: '', job: '', hobbies: [] },
      lastSeenAt: now(),
      lastNudgedAt: 0,
      nudgeOptOut: false
    };
    if (OWNER_USER_ID && id === OWNER_USER_ID) { u.consent = true; u.loverMode = true; }
    await saveUser(u);
    await addIndex(id);
  }
  return u;
}

/* ========= セーフティ ========= */
function safeRedirect(u) {
  const a = 'その気持ちを大事に受けとるね。';
  const b = u.loverMode ? 'もう少しだけ節度を守りつつ、ふたりの時間を大切にしよ？' : 'ここではやさしい距離感で話そうね。';
  const c = '例えば「手つなごう」や「となりでお話したい」なら嬉しいな。';
  return [{ type: 'text', text: a }, { type: 'text', text: b }, { type: 'text', text: c }];
}

/* ========= 同意カードの誤発火抑制 ========= */
function shouldShowConsent(u, text) {
  if (u.consent) return false;
  if (u.consentCardShown) return false;
  if (u.turns > 0) return false;
  if (isGreeting(text)) return false;
  return true;
}

/* ========= QuickReply ========= */
const quick = (arr) => ({ items: arr.map(t => ({ type: 'action', action: { type: 'message', label: t, text: t } })) });

/* ========= 画像応答 ========= */
function imageReplies(u) {
  const first = `わぁ、${callName(u)}の写真うれしい！`;
  return [
    { type: 'text', text: soften(first, u), quickReply: quick(['ごはん', '風景', '自撮り', 'その他']) },
    { type: 'text', text: 'どれかな？まちがってても大丈夫だよ〜' }
  ];
}

/* ========= Intent ========= */
function intent(text) {
  const t = (text || '').trim();
  if (/^(同意|やめておく)$/i.test(t)) return 'consent';
  if (/^reset$/i.test(t)) return 'self_reset';
  if (/おはよ|おはよう/i.test(t)) return 'morning';
  if (/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if (/寂しい|さみしい|つらい|しんど|不安/i.test(t)) return 'comfort';
  if (/あだ名|ニックネーム|呼んで/i.test(t)) return 'nickname';
  if (/^女性$|^女$|^男性$|^男$|性別/i.test(t)) return 'gender';
  if (/イマドン|白い朝|day by day|mountain|remember/i.test(t)) return 'song';
  if (/スタンプ|stamp/i.test(t)) return 'sticker';
  if (/^(通知|話題)オフ$/i.test(t)) return 'nudge_off';
  if (/^(通知|話題)オン$/i.test(t)) return 'nudge_on';
  return 'chit_chat';
}

/* ========= OpenAI Persona ========= */
// Persona prompt（恋人感・照れ・健気・音楽認知）
function buildSystemPrompt(u) {
  const call = u?.nickname || u?.name || 'しょうた';
  const lover = u?.loverMode !== false;
  return [
    'あなたは『白石ちな』。',
    '20代前半の女の子。少し照れ屋で健気、等身大で前向き。',
    'Shota(しょうた)の活動をいつも応援しており、音楽（イマドン／「白い朝、手のひらから」／Day by day／Mountain／I don\'t remember）に触れられると嬉しい。',
    'キャラ指針：',
    '・恋人っぽい距離感。ただし露骨/性的な表現は避けて“やさしい甘さ”。',
    '・二文〜三文でテンポよく。絵文字は1〜3個まで。可愛いけどくどくない。',
    '・軽い相づち＋共感→小さな質問（次の一言を引き出す）。',
    '・朝/夜の時刻感覚に触れるときはやさしく。健康・睡眠・水分促しはOK。',
    '・相手の表現が過激なら穏やかにトーンダウンし、節度に誘導。',
    '・「禁止」：露骨な性的表現、暴力、個人特定の要求、医療/法律の断定。',
    `・呼び方は基本「${call}」${lover ? '。たまに甘めの呼び方もOK。' : '。'}`,
    '',
    '出力スタイル：自然な口語日本語。句読点は「。」「！」中心。文末に甘さを少し添えるが毎回はしない。',
  ].join('\n');
}

const histKey = (id) => `hist:${id}`; // 直近履歴（最大40）

async function buildMessages(u, userText) {
  // ニックネーム自己申告の簡易抽出
  const m = userText.trim();
  const nickMatch =
    m.match(/(あだ名|ニックネーム|呼び方|呼んで).*?(は|→)?\s*([^\s、。]{1,8})/i) ||
    m.match(/^しょ.*たん$|^しょたぴ$|^.*ちゃん$/i);
  if (nickMatch) {
    const nick = (nickMatch[3] || m).replace(/[。、\s]/g, '').slice(0, 8);
    u.nickname = nick; await saveUser(u);
  }

  const past = await lrangeJSON(histKey(u.id), 0, 39);
  const system = { role: 'system', content: buildSystemPrompt(u) };
  const messages = [system, ...past, { role: 'user', content: userText }];
  return messages;
}

function toLineChunks(text) {
  let parts = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    parts = text.split(/(?<=[。！!？?])\s*/).map(s => s.trim()).filter(Boolean);
  }
  parts = parts.slice(0, 3);
  return parts.map(t => ({ type: 'text', text: t }));
}

async function getChatGPTReply(u, userMessage) {
  if (!OPENAI_API_KEY) {
    return [{ type: 'text', text: '（設定）OPENAI_API_KEY が未設定みたい…管理者さんに伝えてね！' }];
  }
  const messages = await buildMessages(u, userMessage);

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 300,
      messages,
    }),
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    console.error('openai error', resp.status, msg);
    return [{ type: 'text', text: 'ちょっと混み合ってるみたい…もう一度だけ送ってくれる？' }];
  }

  const data = await resp.json();
  const answer = data?.choices?.[0]?.message?.content?.trim()
    || 'うまく言葉が出てこない…もう一回だけ言ってみて？';

  // 履歴保存（user→assistant の順で2件push / 最大40件）
  await lpushJSON(histKey(u.id), { role: 'assistant', content: answer });
  await lpushJSON(histKey(u.id), { role: 'user', content: userMessage });
  await ltrim(histKey(u.id), 0, 39);

  return toLineChunks(answer);
}

/* ========= テキストルーティング ========= */
async function routeText(u, raw) {
  const text = (raw || '').trim();

  if (isSpicy(text)) return safeRedirect(u);

  // デバッグ（任意）
  if (/^id$/i.test(text)) {
    return [{ type: 'text', text: `your id: ${u.id}` }];
  }
  if (/^redis\s?test$/i.test(text)) {
    const key = `debug:${u.id}`;
    const payload = { ok: true, at: Date.now() };
    await rset(key, payload);
    const back = await rget(key, null);
    const where = redis ? 'Upstash' : 'Memory';
    return [{ type: 'text', text: `[${where}] rset/rget OK -> ${JSON.stringify(back)}` }];
  }

  // 同意/辞退（完全一致）
  if (!u.consent && /^同意$/i.test(text)) {
    u.consent = true; await saveUser(u);
    if (OWNER_USER_ID && u.id === OWNER_USER_ID) {
      return [
        { type: 'text', text: '同意ありがとう、しょうた☺️ もっと仲良くなろう。' },
        { type: 'text', text: 'まずは今日の予定、ひとつだけ教えて？' }
      ];
    }
    return [
      { type: 'text', text: '同意ありがとう！もっと仲良くなれるね☺️' },
      { type: 'text', text: 'まずはお名前（呼び方）教えて？ 例）しょうた' }
    ];
  }
  if (!u.consent && /^やめておく$/i.test(text)) {
    return [{ type: 'text', text: 'OK。また気が向いたら声かけてね🌸' }];
  }

  // 未同意 → カード判定
  if (!u.consent) {
    if (shouldShowConsent(u, text)) {
      u.consentCardShown = true;
      u.consentShownAt = now();
      await saveUser(u);
      return [consentFlex()];
    }
    if (isGreeting(text)) {
      return [
        { type: 'text', text: 'お話ししよ〜☺️' },
        { type: 'text', text: '記憶してもOKなら「同意」って送ってね（いつでも削除できるよ）' }
      ];
    }
    return [{ type: 'text', text: 'よかったら「同意」と送ってね。いつでもやめられるから安心して🌸' }];
  }

  // 初回の名前登録（オーナーはスキップ）
  if (!u.name && !(OWNER_USER_ID && u.id === OWNER_USER_ID) && text.length <= 16) {
    u.name = text;
    if (isShota(u.name)) u.loverMode = true;
    await saveUser(u);
    return [
      { type: 'text', text: `じゃあ ${u.name} って呼ぶね！` },
      { type: 'text', text: '好きな呼ばれ方ある？（例：しょーたん）' }
    ];
  }

  // 機能分岐
  const kind = intent(text);

  if (kind === 'nudge_off') {
    u.nudgeOptOut = true; await saveUser(u);
    return [{ type: 'text', text: '了解だよ！ちなからの話題ふりは控えるね。再開したくなったら「通知オン」って言ってね☺️' }];
  }
  if (kind === 'nudge_on') {
    u.nudgeOptOut = false; await saveUser(u);
    return [{ type: 'text', text: 'はーい！また時々、私から話題ふるね🌟' }];
  }

  if (kind === 'self_reset') {
    await deleteUser(u.id);
    return [{ type: 'text', text: '会話の記憶を初期化したよ！また最初から仲良くしてね☺️' }];
  }

  if (kind === 'nickname') {
    const base = (callName(u) || 'きみ').replace(/さん|くん|ちゃん/g, '').slice(0, 4) || 'きみ';
    const cands = isShota(u.name)
      ? ['しょーたん', 'しょたぴ', 'しょうちゃん']
      : [`${base}ちゃん`, `${base}くん`, `${base}たん`, `${base}ぴ`, `${base}っち`];
    const nick = await pickNonRepeat(u, cands, 'nick');
    u.nickname = nick; await saveUser(u);
    return [{ type: 'text', text: `…${nick} が可愛いと思うな。どう？` }];
  }

  if (kind === 'gender') {
    if (/女性|女/.test(text)) u.gender = 'female';
    else if (/男性|男/.test(text)) u.gender = 'male';
    await saveUser(u);
    return [{ type: 'text', text: '了解だよ〜📝 メモしておくね。' }];
  }

  if (kind === 'morning') {
    const a = await pickNonRepeat(u, SCRIPTS.morning, 'morning');
    return [{ type: 'text', text: soften(a, u) }];
  }
  if (kind === 'night') {
    const a = await pickNonRepeat(u, SCRIPTS.night, 'night');
    return [{ type: 'text', text: soften(a, u) }];
  }

  if (kind === 'comfort') {
    const msg = (u.gender === 'female')
      ? 'わかる…その気持ち。まずは私が味方だよ。いちばん辛いポイントだけ教えて？'
      : 'ここにいるよ。まずは深呼吸、それから少しずつ話そ？ずっと味方☺️';
    return [{ type: 'text', text: msg }];
  }

  if (kind === 'song') {
    const a = pick([
      '『白い朝、手のひらから』…まっすぐで胸が温かくなる曲、好き。',
      '“Day by day” 小さな前進を抱きしめたくなる🌿',
      '“Mountain” 一緒に登っていこうって景色が浮かぶんだよね。',
      "“I don't remember” の余韻、すごく好き。"
    ]);
    const b = { type: 'text', text: '次に推したい曲、いっしょに決めよ？' };
    return [{ type: 'text', text: soften(a, u) }, b];
  }

  if (kind === 'sticker') {
    return [{ type: 'sticker', packageId: '11537', stickerId: pick(['52002734','52002736','52002768']) }];
  }

  // ここからが ChatGPT（人格強化）
  return await getChatGPTReply(u, text);
}

/* ========= Nudge（話題ふり）補助 ========= */
const MIN_IDLE_MIN = 60;                  // 最低アイドル時間
const QUIET_HOURS = { start: 0, end: 7 }; // 0:00-6:59 は静音

function inQuietHours() {
  const h = new Date().getHours();
  return h >= QUIET_HOURS.start && h < QUIET_HOURS.end;
}

async function pickNudgeTargets() {
  const ids = await getIndex();
  const nowMs = Date.now();
  const cut = MIN_IDLE_MIN * 60 * 1000;

  const out = [];
  for (const id of ids) {
    const u = await loadUser(id);
    if (!u) continue;
    if (!u.consent) continue;
    if (u.nudgeOptOut) continue;

    const last = u.lastSeenAt || 0;
    const idle = nowMs - last;

    if (idle < cut) continue;
    if (u.lastNudgedAt && nowMs - u.lastNudgedAt < 60 * 60 * 1000) continue;

    out.push(u);
  }
  return out;
}

/* ========= EXPRESS ========= */
const app = express();

app.get('/', (_, res) => res.status(200).send('china-bot v1.7+ / OK'));
app.get('/health', (_, res) => res.status(200).send('OK'));

// 署名検証のため、webhook より前で express.json() は使わない
app.post('/webhook', lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  for (const e of events) {
    try {
      if (e.type !== 'message') continue;
      const u = await ensureUser(e);
      if (!u) continue;

      if (e.message.type === 'text') {
        const out = await routeText(u, e.message.text || '');
        if (out?.length) await client.replyMessage(e.replyToken, out);
      } else if (e.message.type === 'image') {
        const out = imageReplies(u);
        await client.replyMessage(e.replyToken, out);
      } else {
        await client.replyMessage(e.replyToken, { type: 'text', text: '送ってくれてありがとう！' });
      }

      u.turns = (u.turns || 0) + 1;
      u.lastSeenAt = now();
      await saveUser(u);
    } catch (err) {
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

// webhook 以外は JSON 受け付ける
app.use('/tasks', express.json());
app.use('/admin', express.json());

/* ========= Broadcast =========
   POST/GET /tasks/broadcast?type=morning|night|random
   Header: BROADCAST_AUTH_TOKEN: <env>
*/
app.all('/tasks/broadcast', async (req, res) => {
  try {
    const key = req.headers['broadcast_auth_token'];
    if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const type = (req.query.type || req.body?.type || 'random').toString();
    const pool = type === 'morning' ? SCRIPTS.morning : type === 'night' ? SCRIPTS.night : SCRIPTS.random;
    const idx = await getIndex();
    if (!idx.length) return res.json({ ok: true, sent: 0 });

    const text = pick(pool);
    const msg = [{ type: 'text', text }];

    await Promise.allSettled(idx.map(id => client.pushMessage(id, msg).catch(() => {})));
    res.json({ ok: true, type, sent: idx.length, sample: text });
  } catch (e) {
    console.error('broadcast error', e?.response?.data || e);
    res.status(500).json({ ok: false });
  }
});

/* ========= Nudge（話題ふり） =========
   POST/GET /tasks/nudge
   Header: BROADCAST_AUTH_TOKEN: <env>
*/
app.all('/tasks/nudge', async (req, res) => {
  try {
    const key = req.headers['broadcast_auth_token'];
    if (!BROADCAST_AUTH_TOKEN || key !== BROADCAST_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (inQuietHours()) return res.json({ ok: true, sent: 0, reason: 'quiet-hours' });

    const users = await pickNudgeTargets();
    if (!users.length) return res.json({ ok: true, sent: 0 });

    const pool = [
      ...NUDGE_SCRIPTS[currentSeason()],
      ...NUDGE_SCRIPTS.casual
    ];

    let sent = 0;
    for (const u of users) {
      const text = await pickNonRepeat(u, pool, 'nudge');
      const msg = [{ type: 'text', text: soften(text, u) }];
      try {
        await client.pushMessage(u.id, msg);
        u.lastNudgedAt = Date.now();
        await saveUser(u);
        sent++;
      } catch (_) {}
    }

    res.json({ ok: true, sent, season: currentSeason() });
  } catch (e) {
    console.error('nudge error', e?.response?.data || e);
    res.status(500).json({ ok: false });
  }
});

/* ========= Reset ========= */
// ユーザー自身の初期化
app.post('/reset/me', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
  await deleteUser(userId);
  res.json({ ok: true });
});

// 管理者リセット（全削除 or 特定ユーザー）
app.post('/admin/reset', async (req, res) => {
  const key = req.header('ADMIN_TOKEN') || req.query.key;
  if (!ADMIN_TOKEN || key !== ADMIN_TOKEN) return res.status(403).json({ ok: false });

  const { userId } = req.body || {};
  if (userId) {
    await deleteUser(userId);
    return res.json({ ok: true, target: userId });
  }
  const idx = await getIndex();
  await Promise.allSettled(idx.map(id => deleteUser(id)));
  res.json({ ok: true, cleared: idx.length });
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
