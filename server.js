// server.js — Shiraishi China Bot v1.8
// ---------------------------------------------------------------
// Requires: @line/bot-sdk, express, dotenv, @upstash/redis, node-cache, openai
// ENV:
//   CHANNEL_SECRET
//   CHANNEL_ACCESS_TOKEN
//   OPENAI_API_KEY
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   OWNER_USER_ID                 // 任意: あなたの LINE userId（強制同意 & 恋人モード）
//   BROADCAST_AUTH_TOKEN          // 任意: /tasks/broadcast 用
//   ADMIN_TOKEN                   // 任意: /admin/reset 用
//   OPENAI_MODEL                  // 任意: 例 "gpt-4o-mini"
//   PORT                          // 任意: 既定 10000

import 'dotenv/config';
import express from 'express';
import { Client, middleware as lineMiddleware } from '@line/bot-sdk';
import { Redis as UpstashRedis } from '@upstash/redis';
import NodeCache from 'node-cache';
import OpenAI from 'openai';

/* ========= ENV ========= */
const {
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  OWNER_USER_ID = '',
  BROADCAST_AUTH_TOKEN = '',
  ADMIN_TOKEN = '',
  OPENAI_MODEL = 'gpt-4o-mini',
  PORT = 10000
} = process.env;

/* ========= LINE CLIENT ========= */
const client = new Client({
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

/* ========= OpenAI ========= */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ========= Redis (Upstash) + メモリフォールバック ========= */
const mem = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 120 }); // 30日
const hasUpstash = !!UPSTASH_REDIS_REST_URL && !!UPSTASH_REDIS_REST_TOKEN;
const redis = hasUpstash
  ? new UpstashRedis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
  : null;
const STORAGE = redis ? 'upstash' : 'memory';
console.log(`[storage] mode=${STORAGE}`);

// 共通KV
const rget = async (key, def = null) => {
  try {
    if (redis) {
      const v = await redis.get(key); // 自動JSONデコード
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

// ブロードキャスト用インデックス
async function getIndex() { return (await rget('user:index', [])) || []; }
async function addIndex(id) {
  const idx = await getIndex();
  if (!idx.includes(id)) { idx.push(id); await rset('user:index', idx); }
}
async function delIndex(id) {
  const idx = await getIndex();
  await rset('user:index', idx.filter(x => x !== id));
}

// ユーザー状態（セッション）
const userKey = (id) => `user:${id}`;
async function loadUser(id) { return await rget(userKey(id), null); }
async function saveUser(u, ttlSec = 60 * 60 * 24 * 30) { await rset(userKey(u.id), u, ttlSec); }
async function deleteUser(id) { await rdel(userKey(id)); await delIndex(id); }

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

/* ========= 同意カード ========= */
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

/* ========= 直近重複回避 ========= */
async function pickNonRepeat(u, list, tag) {
  const key = `nr:${u.id}:${tag}`;
  const last = await rget(key, null);
  const candidates = list.filter(x => x !== last);
  const chosen = pick(candidates.length ? candidates : list);
  await rset(key, chosen);
  return chosen;
}

/* ========= ユーザー管理 ========= */
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
      hist: [],                                  // ChatGPT 用 直近の会話履歴
      onboarding: { asked: false, step: 0 },
      profile: { relation: '', job: '', hobbies: [] },
      lastSeenAt: now()
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

/* ========= ChatGPT 応答 ========= */
function personaSystem(u) {
  const cn = callName(u);
  const lover = u.loverMode ? '恋人モード（やさしく甘め、ちょっとだけスキンシップ表現OK）' :
                              'フレンドモード（丁寧すぎず、やさしく）';
  return [
    'あなたは「白石ちな」。一人称は「私」。日本語で温かく、短すぎない返事を作る。',
    `相手の呼称は「${cn}」。トーンは${lover}。敬語とタメ口を自然に混ぜてOK。`,
    '禁止: 露骨/成人向け表現、個人情報要求、差別、医療・法律の断定。',
    '返答は1〜3文。必要なら相手に1つだけ優しい質問を返す。',
    '絵文字は1〜2個まで。乱用しない。',
  ].join('\n');
}

function trimHist(hist = [], maxTurns = 12) {
  // hist: [{role:'user'|'assistant', content: '...'}]
  const copy = Array.isArray(hist) ? [...hist] : [];
  while (copy.length > maxTurns * 2) copy.shift();
  return copy;
}

async function aiReply(u, userText) {
  const messages = [
    { role: 'system', content: personaSystem(u) },
    ...(trimHist(u.hist).map(h => ({ role: h.role, content: h.content }))),
    { role: 'user', content: userText }
  ];
  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,        // 例: gpt-4o-mini
      messages,
      temperature: 0.9,
      max_tokens: 220
    });
    const out = resp?.choices?.[0]?.message?.content?.trim() || '';
    return out || 'うん、ちゃんと聞いてるよ。もう少し詳しく教えて？';
  } catch (e) {
    console.error('openai error', e?.response?.data || e?.message || e);
    return null; // 失敗時はテンプレにフォールバック
  }
}

/* ========= テキストルーティング ========= */
function intent(text) {
  const t = (text || '').trim();
  if (/^(同意|やめておく)$/i.test(t)) return 'consent';
  if (/^reset$/i.test(t)) return 'self_reset';
  if (/^id$/i.test(t)) return 'whoami';
  if (/^redis\s?test$/i.test(t)) return 'redis_test';
  if (/おはよ|おはよう/i.test(t)) return 'morning';
  if (/おやすみ|寝る|ねむ/i.test(t)) return 'night';
  if (/寂しい|さみしい|つらい|しんど|不安/i.test(t)) return 'comfort';
  if (/あだ名|ニックネーム|呼んで/i.test(t)) return 'nickname';
  if (/^女性$|^女$|^男性$|^男$|性別/i.test(t)) return 'gender';
  if (/イマドン|白い朝|day by day|mountain|remember/i.test(t)) return 'song';
  if (/スタンプ|stamp/i.test(t)) return 'sticker';
  return 'chit_chat';
}

async function routeText(u, raw) {
  const text = (raw || '').trim();

  if (isSpicy(text)) return safeRedirect(u);

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

  if (kind === 'self_reset') {
    await deleteUser(u.id);
    return [{ type: 'text', text: '会話の記憶を初期化したよ！また最初から仲良くしてね☺️' }];
  }
  if (kind === 'whoami') {
    return [{ type: 'text', text: `your id: ${u.id}` }];
  }
  if (kind === 'redis_test') {
    const key = `debug:${u.id}`;
    const payload = { ok: true, at: Date.now() };
    await rset(key, payload);
    const back = await rget(key, null);
    const where = redis ? 'Upstash' : 'Memory';
    return [{ type: 'text', text: `[${where}] rset/rget OK -> ${JSON.stringify(back)}` }];
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

  // —— ここから ChatGPT で自然会話 ——
  const ai = await aiReply(u, text);
  if (ai) {
    // 履歴更新
    u.hist = trimHist([...(u.hist || []), { role: 'user', content: text }, { role: 'assistant', content: ai }]);
    await saveUser(u);
    return [{ type: 'text', text: ai }];
  }

  // LLM障害時フォールバック（時間帯リード + 追い質問）
  const cn = callName(u);
  const lead = band() === 'morning'
    ? `おはよ、${cn}。今日なにする？`
    : band() === 'night'
      ? `おつかれ、${cn}。今日はどんな一日だった？`
      : `ねぇ${cn}、いま何してた？`;
  const follow = pick([
    '写真一枚だけ送ってみる？（風景でもご飯でも📷）',
    '30秒だけ、今日のハイライト教えて〜',
    'いまの気分を一言で言うと…？'
  ]);
  const c = u.loverMode && chance(0.5) ? 'ぎゅ〜ってしながら聞きたいな。' : null;

  return [
    { type: 'text', text: soften(lead, u) },
    { type: 'text', text: follow },
    c ? { type: 'text', text: c } : null
  ].filter(Boolean);
}

/* ========= EXPRESS ========= */
const app = express();

app.get('/', (_, res) => res.status(200).send('china-bot v1.8 / OK'));
app.get('/health', (_, res) => res.status(200).send('OK'));

// ★ webhook より前では express.json() を使わない（署名検証エラー対策）
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

      // 共通のターン更新
      u.turns = (u.turns || 0) + 1;
      u.lastSeenAt = now();
      await saveUser(u);
    } catch (err) {
      console.error('reply error', err?.response?.status || '-', err?.response?.data || err);
    }
  }
});

// webhook 以外は JSON OK
app.use('/tasks', express.json());
app.use('/admin', express.json());

/* ========= ブロードキャスト（cron-job用） =========
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

/* ========= リセット ========= */
// ユーザー自身の初期化（外部ツールや管理画面から呼ぶ）
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

/* ========= 起動 ========= */
app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
