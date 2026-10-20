import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { synthVoice, toSpeechText, scanLocalModels } from './voice.mjs';
import { createPanel } from './panel-bridge.mjs';

// ==================== 日志（自带轮转，不依赖外部重定向）====================
// bot 自己持有日志文件：写满了就改名归档、删最旧的，不需要重启，也不需要外部工具
const LOG_FILE = process.env.LOG_FILE || 'bot.log';
const LOG_MAX_MB = Number(process.env.LOG_MAX_MB || 5);
const LOG_KEEP = Number(process.env.LOG_KEEP || 5);
let logFd = null;
let logBytes = 0;
let logRotating = false;

function logStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function logOpen() {
  try {
    fs.mkdirSync(path.dirname(path.resolve(LOG_FILE)), { recursive: true });
    logFd = fs.openSync(LOG_FILE, 'a');
    logBytes = fs.fstatSync(logFd).size;
  } catch (e) {
    logFd = null;
  }
}

/** 只留最近 LOG_KEEP 份归档 */
function logPrune() {
  try {
    const dir = path.dirname(path.resolve(LOG_FILE));
    const base = path.basename(LOG_FILE) + '.';
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
    while (olds.length > LOG_KEEP) {
      const gone = olds.shift();
      try { fs.unlinkSync(path.join(dir, gone)); } catch {}
      logLine('[日志] 删掉旧日志 ' + gone);
    }
  } catch {}
}

function logRotate() {
  if (logRotating) return;
  logRotating = true;
  let rolled = '';
  try {
    if (logFd) fs.closeSync(logFd);
    logFd = null;
    rolled = LOG_FILE + '.' + logStamp();
    try { fs.renameSync(LOG_FILE, rolled); } catch {}
    logOpen();
  } catch (e) {
    logOpen();
  } finally {
    logRotating = false;
  }
  if (rolled) logLine('===== 日志超过 ' + LOG_MAX_MB + 'MB，已切到新文件（上一份：' + path.basename(rolled) + '）=====');
  logPrune();
}

function toLine(s) {
  if (typeof s === 'string') return s;
  if (s instanceof Error) return s.stack || String(s);
  if (s === undefined) return 'undefined';
  try { return typeof s === 'object' ? JSON.stringify(s) : String(s); } catch { return String(s); }
}

function logLine(s) {
  const text = toLine(s) + '\n';
  if (!logFd) { try { process.stdout.write(text); } catch {} return; }
  try {
    fs.writeSync(logFd, text);
    logBytes += Buffer.byteLength(text);
    if (!logRotating && LOG_MAX_MB > 0 && logBytes > LOG_MAX_MB * 1048576) logRotate();
  } catch {}
}

logOpen();
console.log = (...a) => logLine(a.map(toLine).join(' '));
console.error = (...a) => logLine(a.map(toLine).join(' '));

// ==================== 配置读取 ====================
const CFG = {
  wsUrl: process.env.WS_URL || 'ws://127.0.0.1:3001',
  wsToken: process.env.WS_TOKEN || '',
  apiBase: (process.env.API_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
  apiKey: process.env.API_KEY || '',
  model: process.env.MODEL || 'deepseek-chat',
  groupNeedAt: (process.env.GROUP_NEED_AT ?? 'true') === 'true',
  maxMsgLen: Number(process.env.MAX_MSG_LEN || 800),
  // 拆条：一条消息最多装这么多个汉字，超了就拆成几条发（按手机屏幕一行的宽度）
  lineWidth: Number(process.env.LINE_WIDTH || 16),
  lineSplit: (process.env.LINE_SPLIT ?? 'true') === 'true',
  // 拆条后每条之间停多久（毫秒），太快像机器人吐字
  lineGapMin: Number(process.env.LINE_GAP_MIN || 350),
  lineGapMax: Number(process.env.LINE_GAP_MAX || 900),
  // 一条回复最多拆成几条；超了就加宽重来，避免一串小泡泡刷屏
  lineMax: Number(process.env.LINE_MAX || 6),
  minSendInterval: Number(process.env.MIN_SEND_INTERVAL || 2000),
  maxTurns: Number(process.env.MAX_TURNS || 10),
  systemPrompt: process.env.SYSTEM_PROMPT || '你是一个QQ群里的AI助手，说话简洁自然，回答控制在200字以内。',
  personaFile: process.env.SYSTEM_PROMPT_FILE || '',
  temperature: Number(process.env.TEMPERATURE || 1.2),
  // 拟人化延迟（毫秒）
  delayMin: Number(process.env.REPLY_DELAY_MIN || 800),
  delayMax: Number(process.env.REPLY_DELAY_MAX || 2500),
  msPerChar: Number(process.env.TYPE_MS_PER_CHAR || 45),
  // 认人
  ownerQq: (process.env.OWNER_QQ || '').trim(),
  ownerAlias: (process.env.OWNER_ALIAS || '').trim(),
  strangerTtlMinutes: Number(process.env.STRANGER_MEMORY_MINUTES || 720),
  knownTtlMinutes: Number(process.env.KNOWN_MEMORY_MINUTES || 1440),
  ownerTtlMinutes: process.env.OWNER_MEMORY_MINUTES === undefined || process.env.OWNER_MEMORY_MINUTES === '' ? 0 : Number(process.env.OWNER_MEMORY_MINUTES),
  // 视觉：收到图片时下载下来转成 base64 喂给模型（deepseek 支持 image 输入）
  vision: (process.env.VISION ?? 'true') === 'true',
  visionModel: process.env.VISION_MODEL || '',   // 留空 = 用主模型
  maxImageMB: Number(process.env.MAX_IMAGE_MB || 8),
  maxImages: Number(process.env.MAX_IMAGES || 3),
  // 表情包：偷别人发的存起来，自己按情况发出去
  stickers: (process.env.STICKERS ?? 'true') === 'true',
  stickerDir: process.env.STICKER_DIR || 'stickers',
  stickerMax: Number(process.env.STICKER_MAX || 300),
  // 额外随机发表情的概率（0 = 只由模型自己决定要不要发）
  stickerChance: Number(process.env.STICKER_CHANCE || 0),
  // 安全墙
  safety: (process.env.SAFETY ?? 'true') === 'true',
  groupWhitelist: (process.env.GROUP_WHITELIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  groupDebug: (process.env.GROUP_DEBUG ?? 'true') === 'true',   // 群里没@我的消息也打一行日志，方便排查"它怎么不理我"
  // 一视同仁：主人也没有免@特权，跟群友一个规矩（旧开关只留着兼容，默认已关）
  groupOwnerNoAt: (process.env.GROUP_OWNER_NO_AT ?? 'false') === 'true',
  // 接力窗口：谁@过她一次，接下来几句都算在跟她说话，不用每句都@
  groupFollow: (process.env.GROUP_FOLLOW ?? 'true') === 'true',
  groupFollowTurns: Number(process.env.GROUP_FOLLOW_TURNS || 3),      // 开一次窗口能连说几句（按合并后的一轮算）
  groupFollowMinutes: Number(process.env.GROUP_FOLLOW_MINUTES || 5),  // 窗口多久不用就作废（分钟）
  // 管理员认知：她知道自己是群管理，被挑衅时能把人禁言
  groupAdmin: (process.env.GROUP_ADMIN ?? 'true') === 'true',
  groupBanMinutes: Number(process.env.GROUP_BAN_MINUTES || 10),       // 禁言多少分钟
  ratePerMin: Number(process.env.RATE_PER_MIN || 15),
  // 连发合并：同一会话在这么久内没新消息了才回一次（毫秒）
  debounceMs: Number(process.env.DEBOUNCE_MS || 1200),
  // 引用回复：回的时候带上"在回哪句"
  replyQuote: (process.env.REPLY_QUOTE ?? 'true') === 'true',
  // 戳一戳
  poke: (process.env.POKE ?? 'true') === 'true',
  pokeMaxPerHour: Number(process.env.POKE_MAX_PER_HOUR || 6),
  // 主动说话
  proactive: (process.env.PROACTIVE ?? 'true') === 'true',
  proactiveHours: process.env.PROACTIVE_HOURS || '9-23',      // 几点到几点之间才主动
  proactiveIdleMinutes: Number(process.env.PROACTIVE_IDLE_MINUTES || 240),  // 隔多久没聊才想起你
  proactiveChance: Number(process.env.PROACTIVE_CHANCE || 25), // 检查时开这个口的机会（%）
  proactiveWho: process.env.PROACTIVE_WHO || 'owner',          // owner | owner+known
  proactiveMinGapMinutes: Number(process.env.PROACTIVE_MIN_GAP_MINUTES || 360), // 两次主动之间至少隔这么久
  proactiveCheckMinutes: Number(process.env.PROACTIVE_CHECK_MINUTES || 5),      // 多久巡检一次
  // 自动记忆提取：聊完一轮后悄悄问一次模型，把值得长期记住的事存进名单
  autoMemory: (process.env.MEMORY_AUTO ?? 'true') === 'true',
  autoMemoryEvery: Number(process.env.MEMORY_AUTO_EVERY || 4),   // 每聊几轮提取一次
  autoMemoryMax: Number(process.env.MEMORY_AUTO_MAX || 40),      // 每人最多存几条
  // 好友申请 / 进群邀请：只报给你，绝不自动通过（通过与否你自己手动点）
  requestNotify: (process.env.REQUEST_NOTIFY ?? 'true') === 'true',              // 有人申请时在日志里报一声
  requestNotifyOwner: (process.env.REQUEST_NOTIFY_OWNER ?? 'true') === 'true',   // 同时私聊戳一下主人
  // 上下文摘要：聊长了不再硬砍最早的对话，而是把它压成一段摘要留着
  contextSummary: (process.env.CONTEXT_SUMMARY ?? 'true') === 'true',
  summaryBatch: Number(process.env.SUMMARY_BATCH || 6),   // 一次压掉几轮（1 轮 = 一问一答 2 条）
  // 情绪状态机（生闷气）：跨轮次的"她这会儿还气着"
  mood: (process.env.MOOD ?? 'true') === 'true',
  sulkDecayPerTurn: Number(process.env.SULK_DECAY_PER_TURN || 8),      // 每轮自己消多少
  sulkDecayPerTenMin: Number(process.env.SULK_DECAY_PER_10MIN || 15),  // 每 10 分钟自己消多少
  sulkQuietAt: Number(process.env.SULK_QUIET_AT || 60),                // 超过这个值开始话少
  sulkRecoverAt: Number(process.env.SULK_RECOVER_AT || 20),            // 低于这个值恢复正常
  // 人物档案：她记的不是"事实"，是"你这个人"
  profileAuto: (process.env.PROFILE_AUTO ?? 'true') === 'true',
  profileEvery: Number(process.env.PROFILE_EVERY || 6),   // 每聊几轮整理一次人物档案
  // 承诺 / 小账
  promises: (process.env.PROMISES ?? 'true') === 'true',
  promiseMax: Number(process.env.PROMISE_MAX || 20),
  promiseNudgeHours: Number(process.env.PROMISE_NUDGE_HOURS || 24),   // 答应的事拖过这么久就翻旧账
  // 调味性格的出现频率（天真/较真/嘴硬心软/小得意/小怂），单位 %
  flavorOdds: Number(process.env.FLAVOR_ODDS || 15),
  humor: (process.env.HUMOR ?? 'true') === 'true',                  // 幽默招式轮盘
  catchphraseGuard: (process.env.CATCHPHRASE_GUARD ?? 'true') === 'true', // 口头禅稀释
  // 群旁听：别人的话即使不@我，也记一段在脑子里（不然它根本不知道群里发生过什么）
  groupEavesdrop: (process.env.GROUP_EAVESDROP ?? 'true') === 'true',
  groupLogSize: Number(process.env.GROUP_LOG_SIZE || 20),      // 每群记最近多少条
  groupRoster: (process.env.GROUP_ROSTER ?? 'true') === 'true', // 拉群成员名单（花名册）
  groupRosterMinutes: Number(process.env.GROUP_ROSTER_MINUTES || 30), // 多久刷新一次成员名单
  // 群友档案：陌生人也留一份轻档（聊过几轮、说过什么），否则"跟谁聊过"超时就归零
  groupMate: (process.env.GROUP_MATE ?? 'true') === 'true',
  groupMateEvery: Number(process.env.GROUP_MATE_EVERY || 4),   // 聊几轮整理一次他的档
  groupMateMax: Number(process.env.GROUP_MATE_MAX || 8),      // 每人最多记几条
  // 连发合并：同样的碎片要不要去重
  dedupeBurts: (process.env.DEDUPE_BURSTS ?? 'true') === 'true',
  // 拆条收尾：小尾巴（比如切下来只剩"吧"）并回上一条当第二行，比例上限见 lineTailRatio
  lineTailRatio: Number(process.env.LINE_TAIL_RATIO || 0.5),
  // 读人：把"字面意思"翻成"底下那层意思"（词表 data/subtext.txt）
  subtext: (process.env.SUBTEXT ?? 'true') === 'true',
  subtextMax: Number(process.env.SUBTEXT_MAX || 3),   // 一轮最多参考几条
  // 梗库：常驻一小撮最常用的，其余按关键词检索，聊到才喂（data/梗库.md）
  memeLib: (process.env.MEME_LIB ?? 'true') === 'true',
  memeFile: process.env.MEME_FILE || path.join('data', '梗库.md'),
  memeTop: Number(process.env.MEME_TOP || 4),          // 一轮最多检索几条
  // 语音：对方要语音时，她真的开口说话（Edge TTS 在线合成 → QQ 语音消息）
  voice: (process.env.VOICE ?? 'true') === 'true',
  voiceName: process.env.VOICE_NAME || 'zh-CN-XiaoyiNeural',
  voiceMaxChars: Number(process.env.VOICE_MAX_CHARS || 120),  // 超过这么多字就退回文字，别念一大段
  // kokoro 在 CPU 上只有约 1/3 实时速度，太长会让对面干等 —— 超过这么多字自动换「本地快声」
  voiceKokoroMax: Number(process.env.VOICE_KOKORO_MAX || 60),
};

// 人设文件优先于 .env 的 SYSTEM_PROMPT
// 面板可以直接改它：保存后重读，下一句话就用新的（不用重启）
function readPersona() {
  if (!CFG.personaFile) return CFG.systemPrompt;
  try {
    return fs.readFileSync(CFG.personaFile, 'utf8').trim();
  } catch (e) {
    console.error('[人设] 读取 ' + CFG.personaFile + ' 失败，回退到 SYSTEM_PROMPT: ' + e.message);
    return CFG.systemPrompt;
  }
}
let PERSONA_BASE = readPersona();

// ==================== 面板桥（panel-bridge）====================
// 面板（panel.mjs）是独立进程：这里只把现场写成 data/panel-state.json，
// 并每 2 秒看一眼 data/panel-control.json 有没有指令。不开放任何端口。
const VOICE_DEMO_TAG = { '可可·晓晓': '47', '可可·小贝': '45', '可可·小妮': '46', '可可·小艺': '48', '可可·云健': '49', '可可·云希': '50', '可可·云夏': '51', '可可·云扬': '52', '本地快声': 'melo' };

const PANEL = createPanel({
  dir: process.env.PANEL_DIR || '.',
  getInfo: () => ({
    model: CFG.model,
    counts: {
      owners: Object.keys(PEOPLE.owners).length,
      known: Object.keys(PEOPLE.known).length,
      groups: Object.keys(GROUPS).length,
      memes: MEME.all.length,
      resident: MEME.residentNames.size,
      stickers: STICKERS ? Object.keys(STICKERS).length : 0,
    },
    cfg: {
      model: CFG.model,
      followTurns: CFG.groupFollowTurns,
      followMinutes: CFG.groupFollowMinutes,
      banMinutes: CFG.groupBanMinutes,
      ownerTtl: CFG.ownerTtlMinutes,
      knownTtl: CFG.knownTtlMinutes,
      strangerTtl: CFG.strangerTtlMinutes,
      ttlSource: fs.existsSync(RT_FILE) ? 'panel-config.json' : '.env',
      localModels: VOICE_ENGINE === 'local' ? scanLocalModels().map((x) => ({ key: x.key, name: x.name, ok: x.ok, dir: path.basename(x.dir) })) : [],
      voiceMax: CFG.voiceMaxChars,
      kokoroMax: CFG.voiceKokoroMax,
      voiceEngine: VOICE_ENGINE,
      voiceCurrent: currentVoice().name,
      memesResident: [...MEME.residentNames],
      voices: VOICES.map((v) => ({ name: v.name, desc: v.desc || '', model: v.model || '', demo: VOICE_DEMO_TAG[v.name] || '', current: v.name === currentVoice().name })),
      owner: Object.keys(PEOPLE.owners)[0] || '',
      ownerAlias: (PEOPLE.owners[Object.keys(PEOPLE.owners)[0]] || {}).alias || '',
      personaFile: CFG.personaFile || '',
      personaChars: PERSONA_BASE.length,
    },
    follow: [...followWindows.entries()].map(([k, w]) => {
      const [g, q] = String(k).split(':');
      return { group: g, qq: q, left: w.left, expireAt: w.expireAt, name: displayNameOf(g, q) };
    }),
    bans: [...banUntil.entries()].filter(([, t]) => t > Date.now()).map(([k, t]) => {
      const [g, q] = String(k).split(':');
      return { group: g, qq: q, until: t, name: displayNameOf(g, q) };
    }),
  }),
  handlers: {
    async restart() {
      setTimeout(() => process.exit(0), 500);
      return '已请求重启，守护进程约 12 秒后拉起';
    },
    'voice-test': async (j) => {
      const who = String(j.qq || Object.keys(PEOPLE.owners)[0] || '');
      if (!who) throw new Error('没有主人 QQ，发不出去');
      const v = j.name ? VOICES.find((x) => x.name === j.name) : currentVoice();
      if (!v) throw new Error('没有这把嗓子：' + j.name);
      const text = String(j.text || '你好呀，这是我的一条语音。');
      const buf = await synthVoice(text, v.voice);
      await sendAction('send_private_msg', { user_id: Number(who), message: [{ type: 'record', data: { file: 'base64://' + buf.toString('base64') } }] });
      return '已发给 ' + who + '：' + v.name + '（' + Math.round(buf.length / 1024) + 'KB）';
    },
    'set-voice': async (j) => {
      const v = VOICES.find((x) => x.name === j.name);
      if (!v) throw new Error('没有这把嗓子：' + j.name);
      saveVoicePref(v);
      return '默认声音换成 ' + v.name;
    },
    backup: async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dst = path.join(DATA_DIR, 'backups', stamp);
      fs.mkdirSync(dst, { recursive: true });
      let n = 0;
      for (const f of fs.readdirSync(DATA_DIR)) {
        const src = path.join(DATA_DIR, f);
        try { if (fs.statSync(src).isFile()) { fs.copyFileSync(src, path.join(dst, f)); n++; } } catch {}
      }
      return '备份 ' + n + ' 个文件 → data/backups/' + stamp;
    },
    'clear-memory': async (j) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dst = path.join(DATA_DIR, 'backups', stamp);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of ['people.json', 'groups.json']) {
        try { fs.copyFileSync(path.join(DATA_DIR, f), path.join(dst, f)); } catch {}
      }
      const scope = String(j.scope || '');
      if (scope === 'group-recent') {
        const g = String(j.group || '');
        if (!g) throw new Error('没给群号');
        eavesdropLog.delete(g);
        if (GROUPS[g]) { GROUPS[g].recent = []; saveGroups(); }
        return '已清空群 ' + g + ' 的旁听记录（原数据备份在 data/backups/' + stamp + '）';
      }
      if (scope === 'people-facts') {
        let n = 0;
        for (const pool of [PEOPLE.owners, PEOPLE.known]) {
          for (const q of Object.keys(pool)) {
            if (Array.isArray(pool[q].facts) && pool[q].facts.length) { n += pool[q].facts.length; pool[q].facts = []; }
          }
        }
        savePeople();
        return '已清空 ' + n + ' 条长期记忆，名单还在（备份在 data/backups/' + stamp + '）';
      }
      throw new Error('不认识的清理范围：' + scope);
    },
    'meme-resident': async (j) => {
      const name = String(j.name || '').trim();
      const e = MEME.all.find((x) => x.name === name);
      if (!e) throw new Error('全库里没有这条梗：' + name);
      const names = [...MEME.residentNames];
      const i = names.indexOf(name);
      if (j.op === 'del') {
        if (i < 0) throw new Error('「' + name + '」本来就不在常驻里');
        names.splice(i, 1);
      } else if (i < 0) {
        if (names.length >= 120) throw new Error('常驻太多了（' + names.length + ' 条），再往里塞每轮都要多花钱，先删几条');
        names.push(name);
      }
      MEME.residentNames = new Set(names);
      MEME.resident = memeResidentText(names);
      fs.writeFileSync(MEME_RESIDENT_FILE, JSON.stringify({ names, at: Date.now() }, null, 2), 'utf8');
      return (j.op === 'del' ? '已从常驻删掉 ' : '已设为常驻：') + name + '（现在共 ' + names.length + ' 条，下一轮就生效）';
    },
    'sticker-tag': async (j) => {
      const idx = loadStickers();
      const f = String(j.file || '');
      if (!idx[f]) throw new Error('仓库里没有这张：' + f);
      idx[f].summary = String(j.summary || '').slice(0, 120);
      idx[f].taggedAt = Date.now();
      saveStickerIndex();
      return '已打标：' + f + ' → 「' + (idx[f].summary || '(空)') + '」';
    },
    'sticker-del': async (j) => {
      const idx = loadStickers();
      const f = String(j.file || '');
      if (!idx[f]) throw new Error('仓库里没有这张：' + f);
      delete idx[f];
      saveStickerIndex();
      try { fs.unlinkSync(path.join(STICKER_DIR, f)); } catch {}
      return '已删掉 ' + f + '，仓库还剩 ' + Object.keys(idx).length + ' 张';
    },
    // 人设：面板里改完直接写文件 + 重读，下一句话就生效，不用重启
    'persona-save': async (j) => {
      const text = String(j.text || '').replace(/\r\n/g, '\n').trim();
      if (!CFG.personaFile) throw new Error('现在的人设是 .env 里的 SYSTEM_PROMPT，没有独立文件可改；先把 .env 的 SYSTEM_PROMPT_FILE 指向 personas/00_示例人设.txt');
      if (text.length < 20) throw new Error('太短了（' + text.length + ' 字），人设至少得几十个字');
      if (text.length > 20000) throw new Error('太长了（' + text.length + ' 字），人设别超过 2 万字');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try {
        fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
        fs.copyFileSync(CFG.personaFile, path.join(DATA_DIR, 'backups', 'persona-' + stamp + '.txt'));
      } catch {}
      fs.writeFileSync(CFG.personaFile, text + '\n', 'utf8');
      PERSONA_BASE = text;
      console.log('[人设] 面板改过人设：' + text.length + ' 字，下一句起生效（旧版备份 data/backups/persona-' + stamp + '.txt）');
      return '人设已存（' + text.length + ' 字），下一句话就按新的说；旧版备份在 data/backups/persona-' + stamp + '.txt';
    },
    // 人物档案：备注（她一直记着的设定）+ 长期记忆 + 她心里的印象，都在这里改
    'people-save': async (j) => {
      const qq = String(j.qq || '').replace(/\D/g, '');
      if (!/^\d{5,12}$/.test(qq)) throw new Error('QQ 号不像 QQ 号：' + (j.qq || '(空)'));
      const alias = String(j.alias || '').trim().slice(0, 40);
      const note = String(j.note || '').replace(/\r\n/g, '\n').trim().slice(0, 600);
      const who = String(j.who || '').replace(/\r\n/g, '\n').trim().slice(0, 200);
      const lastTalk = String(j.lastTalk || '').replace(/\r\n/g, '\n').trim().slice(0, 200);
      const facts = Array.isArray(j.facts)
        ? j.facts.map((x) => String(x).replace(/\s+/g, ' ').trim()).filter((x) => x.length > 1).slice(0, 120)
        : null;
      const isOwner = !!PEOPLE.owners[qq] || String(qq) === String(CFG.ownerQq || '');
      const rec = PEOPLE.owners[qq] || PEOPLE.known[qq] || null;
      if (!rec) {
        if (!alias) throw new Error('新加一个人，得先给个称呼（她平时怎么叫他）');
        const entry = { alias, note, facts: facts || [], since: Date.now() };
        if (isOwner) PEOPLE.owners[qq] = entry; else PEOPLE.known[qq] = entry;
        if (who || lastTalk) entry.profile = { who, lastTalk, updatedAt: Date.now() };
        savePeople();
        console.log('[名单] 面板新加' + (isOwner ? '主人' : '熟人') + '：' + qq + '「' + alias + '」' + (facts ? '，' + facts.length + ' 条记忆' : ''));
        return '已把 ' + qq + ' 记成' + (isOwner ? '自己人' : '熟人') + '「' + alias + '」' + (facts ? '，' + facts.length + ' 条记忆' : '') + '（下一句话就认得他了）';
      }
      if (alias) rec.alias = alias;
      rec.note = note;
      if (facts) rec.facts = facts;
      if (who || lastTalk || j.profileTouched) {
        const p = rec.profile && typeof rec.profile === 'object' ? rec.profile : (rec.profile = { who: '', lastTalk: '', updatedAt: 0 });
        p.who = who;
        p.lastTalk = lastTalk;
        p.updatedAt = Date.now();
      }
      savePeople();
      console.log('[档案] 面板改过 ' + qq + '「' + (rec.alias || '') + '」：备注 ' + note.length + ' 字，记忆 ' + ((rec.facts || []).length) + ' 条');
      return '已更新「' + (rec.alias || qq) + '」：备注 ' + note.length + ' 字、记忆 ' + ((rec.facts || []).length) + ' 条，下一句话就按这个记得';
    },
    // 运行时配置：接力窗口 / 禁言时长 / 三种关系的会话记忆时长，改完立刻生效
    'set-cfg': async (j) => {
      const applied = [];
      for (const k of Object.keys(RT)) {
        if (j[k] === undefined || j[k] === null || j[k] === '') continue;
        const v = Number(j[k]);
        if (!Number.isFinite(v)) throw new Error('「' + k + '」不是数字：' + j[k]);
        const [lo, hi] = RT_RANGE[k];
        if (v < lo || v > hi) throw new Error('「' + k + '」要在 ' + lo + '~' + hi + ' 之间，收到 ' + v);
        if (RT[k] !== v) { RT[k] = v; applied.push(k + '=' + v); }
      }
      if (!applied.length) return '没变化，还是原来的值';
      applyRt();
      saveRt();
      console.log('[面板配置] 改了 ' + applied.join('、') + ' → 接力 ' + RT.followTurns + ' 句 / ' + RT.followMinutes + ' 分钟 ｜ 禁言 ' + RT.banMinutes + ' 分钟 ｜ 记忆 ' + rtTtlText());
      return '已生效（不用重启）：' + applied.join('、');
    },
    'bot-stop': async () => {
      setTimeout(() => process.exit(0), 300);
      return '这就去歇着（守护进程不会拉起，等你点继续）';
    },
  },
});
// 延后一拍再起面板：getInfo 里用到的 MEME / STICKERS 在文件更下面才初始化，
// 立刻 flush 会撞上 TDZ，第一份快照的 cfg 会是空的。
setTimeout(() => PANEL.start(), 1500);

if (!CFG.apiKey || CFG.apiKey.includes('在这里填')) {
  console.error('[FATAL] 请先在 .env 里填写 API_KEY');
  process.exit(1);
}

// ==================== 认人：持久化名单 ====================
const DATA_DIR = 'data';

// ==================== 面板可调运行时配置 ====================
// .env 里的是出厂默认值；这里改的是「覆盖」，存 data/panel-config.json，
// 面板保存后立刻生效，不用重启（接力窗口 / 禁言时长 / 三种关系的会话记忆时长）。
const RT_FILE = path.join(DATA_DIR, 'panel-config.json');
const RT = {
  followTurns: CFG.groupFollowTurns,      // 一次 @ 之后能连说几句
  followMinutes: CFG.groupFollowMinutes,  // 接力窗口多久不用就作废
  banMinutes: CFG.groupBanMinutes,        // 默认禁言多少分钟（模型自己写时长时以它为准）
  ownerTtl: CFG.ownerTtlMinutes,          // 自己人的会话记忆（分钟，0 = 永久）
  knownTtl: CFG.knownTtlMinutes,          // 认识的人
  strangerTtl: CFG.strangerTtlMinutes,    // 陌生人
};
const RT_RANGE = {
  followTurns: [1, 20],
  followMinutes: [1, 1440],
  banMinutes: [1, 1440],
  ownerTtl: [0, 525600],
  knownTtl: [0, 525600],
  strangerTtl: [0, 525600],
};
function applyRt() {
  CFG.groupFollowTurns = RT.followTurns;
  CFG.groupFollowMinutes = RT.followMinutes;
  CFG.groupBanMinutes = RT.banMinutes;
  CFG.ownerTtlMinutes = RT.ownerTtl;
  CFG.knownTtlMinutes = RT.knownTtl;
  CFG.strangerTtlMinutes = RT.strangerTtl;
}
function loadRt() {
  try {
    const j = JSON.parse(fs.readFileSync(RT_FILE, 'utf8'));
    const bad = [];
    for (const k of Object.keys(RT)) {
      if (j[k] === undefined) continue;
      const v = Number(j[k]);
      if (Number.isFinite(v) && v >= RT_RANGE[k][0] && v <= RT_RANGE[k][1]) RT[k] = v;
      else bad.push(k);
    }
    applyRt();
    console.log('[面板配置] 套用 ' + RT_FILE + '：接力 ' + RT.followTurns + ' 句 / ' + RT.followMinutes + ' 分钟 ｜ 禁言 ' + RT.banMinutes + ' 分钟 ｜ 记忆 ' + rtTtlText());
    if (bad.length) console.error('[面板配置] 有值超出范围被忽略：' + bad.join('、'));
  } catch {}
}
function rtTtlText() {
  const f = (m) => (m > 0 ? m + ' 分钟' : '永久');
  return '自己人 ' + f(RT.ownerTtl) + ' / 认识 ' + f(RT.knownTtl) + ' / 陌生人 ' + f(RT.strangerTtl);
}
function saveRt() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RT_FILE, JSON.stringify(RT, null, 2), 'utf8');
  } catch (e) {
    console.error('[面板配置] 保存失败: ' + e.message);
  }
}
loadRt();

const PEOPLE_FILE = path.join(DATA_DIR, 'people.json');
const PEOPLE = { owners: {}, known: {} };

function savePeople() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PEOPLE_FILE, JSON.stringify(PEOPLE, null, 2), 'utf8');
  } catch (e) {
    console.error('[名单] 保存失败: ' + e.message);
  }
}

let peopleMtime = 0;

/** 文件变了就重读，改名单不用重启 Bot */
function reloadPeopleIfChanged() {
  try {
    const m = fs.statSync(PEOPLE_FILE).mtimeMs;
    if (m === peopleMtime) return;
    peopleMtime = m;
    const j = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));
    PEOPLE.owners = j.owners && typeof j.owners === 'object' ? j.owners : {};
    PEOPLE.known = j.known && typeof j.known === 'object' ? j.known : {};
    console.log('[名单] 已重新载入：' + (Object.keys(PEOPLE.owners).length + Object.keys(PEOPLE.known).length) + ' 人');
  } catch {
    // 文件还没生成，忽略
  }
}

function loadPeople() {
  try {
    const j = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));
    PEOPLE.owners = j.owners && typeof j.owners === 'object' ? j.owners : {};
    PEOPLE.known = j.known && typeof j.known === 'object' ? j.known : {};
    peopleMtime = fs.statSync(PEOPLE_FILE).mtimeMs;
  } catch {
    PEOPLE.owners = {};
    PEOPLE.known = {};
  }
  // .env 里预设的主人
  if (CFG.ownerQq && !PEOPLE.owners[CFG.ownerQq]) {
    PEOPLE.owners[CFG.ownerQq] = { alias: CFG.ownerAlias || '主人', note: '', since: Date.now() };
    savePeople();
  }
}

/** 判断一个人是什么身份 + 怎么称呼 */
function identityOf(qq) {
  const o = PEOPLE.owners[qq];
  if (o) return { kind: 'owner', alias: o.alias || '主人', note: o.note || '', facts: Array.isArray(o.facts) ? o.facts : [] };
  const k = PEOPLE.known[qq];
  if (k) return { kind: 'known', alias: k.alias || '', note: k.note || '', facts: Array.isArray(k.facts) ? k.facts : [] };
  return { kind: 'stranger', alias: '', note: '', facts: [] };
}

/** 长期记忆保留时长，其他人是短期记忆 */
function ttlFor(kind) {
  const min = kind === 'owner' ? CFG.ownerTtlMinutes : kind === 'known' ? CFG.knownTtlMinutes : CFG.strangerTtlMinutes;
  return min > 0 ? min * 60000 : Infinity;
}

// ==================== 情绪：生闷气状态机 ====================
// 光在人设里写"会赌气"，模型只能演成当场翻脸、下一句又没事人——因为它没有记忆。
// 真人的气是跨轮次的：这一刻气着，接下来几句话就变短、变淡，慢慢才消。
// 所以气值存在会话里，随时间自己衰减；模型只在"被惹到/被哄好"时报告增减。
function defaultMood() {
  return { sulk: 0, reason: '', since: 0, updatedAt: Date.now() };
}

/** 按时间自然消气：每满 10 分钟掉 sulkDecayPerTenMin 点 */
function decayMoodByTime(s) {
  const m = s.mood;
  if (!m || !m.sulk) return;
  const mins = (Date.now() - (m.updatedAt || Date.now())) / 60000;
  if (mins < 10) return;
  m.sulk = Math.max(0, m.sulk - Math.floor(mins / 10) * CFG.sulkDecayPerTenMin);
  m.updatedAt = Date.now();
  if (m.sulk < CFG.sulkRecoverAt) { m.sulk = 0; m.reason = ''; m.since = 0; }
}

/** 每聊一轮也会消一点气（不至于气一整天） */
function decayMoodTurn(s) {
  const m = s.mood;
  if (!m || !m.sulk) return;
  m.sulk = Math.max(0, m.sulk - CFG.sulkDecayPerTurn);
  m.updatedAt = Date.now();
  if (m.sulk < CFG.sulkRecoverAt) { m.sulk = 0; m.reason = ''; m.since = 0; }
}

function addSulk(s, delta, reason) {
  const m = s.mood || (s.mood = defaultMood());
  const before = m.sulk;
  m.sulk = Math.max(0, Math.min(100, m.sulk + delta));
  m.updatedAt = Date.now();
  if (delta > 0) {
    if (!m.since) m.since = Date.now();
    if (reason) m.reason = reason;
  }
  if (m.sulk < CFG.sulkRecoverAt) { m.sulk = 0; m.reason = ''; m.since = 0; }
  if (m.sulk !== before) {
    console.log('[情绪] ' + (m.sulk > before ? '气上来了' : '气消了') + ' ' + before + ' → ' + m.sulk + (m.reason ? '（' + m.reason + '）' : ''));
  }
}

/** 把气值翻译成给模型的状态提示：气着的时候话要变短变淡，而不是喊"我生气了" */
function moodPrompt(s) {
  const m = s.mood;
  if (!CFG.mood || !m || !m.sulk) return '';
  const v = m.sulk;
  const why = m.reason ? '（因为：' + m.reason + '）' : '';
  if (v >= CFG.sulkQuietAt) {
    return '\n\n【你现在的状态：还气着】' + why +
      '\n你正生着闷气，但你不说破、不质问、不发冷战宣言。表现是：回话比平时短得多，语气淡，不接梗，不带 emoji，不发 [表情]，只回必要的几个字。' +
      '\n对方哄你、道歉、把事说清楚，你会松一点，但不会立刻好——可能就"嗯"一声，或者嘴硬"谁气了"。' +
      '\n绝对不要说"我生气了""你气到我了""哼"这种把情绪点破的话，闷气是从话变短里透出来的。';
  }
  if (v >= 30) {
    return '\n\n【你现在的状态：有点不爽】' + why +
      '\n心里有点不舒服，说话带刺但不至于冷下来：会刺两句、会"行吧"、会把旧话翻出来。' +
      '\n别点破，别说"我有点生气"，用语气表现。';
  }
  return '\n\n【你现在的状态：气刚消，还有点余味】' + why +
    '\n气基本过去了，但会留半句余味，比如"这次就算了""行吧，不跟你计较"。别演成没事人。';
}

// ==================== 小账（承诺 / 欠着的事）====================
// 人设里写"记小账"没用，得真有个地方存。存的是"谁答应了什么、多久了、追问过没有"。
function promiseList(s) {
  if (!Array.isArray(s.promises)) s.promises = [];
  return s.promises;
}

function addPromise(s, text) {
  if (!CFG.promises) return;
  const list = promiseList(s);
  const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
  if (t.length < 2) return;
  if (list.some((p) => p.text === t)) return;
  list.push({ text: t, createdAt: Date.now(), nudged: false });
  while (list.length > CFG.promiseMax) list.shift();
  console.log('[小账] 记下第 ' + list.length + ' 笔：' + t);
}

function clearPromise(s, idx) {
  const list = promiseList(s);
  const i = Number(idx) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return;
  const [gone] = list.splice(i, 1);
  console.log('[小账] 结清：' + (gone ? gone.text : idx));
}

function promisePrompt(s) {
  const list = promiseList(s);
  if (!CFG.promises || !list.length) return '';
  const overdueMs = CFG.promiseNudgeHours * 3600000;
  const lines = list.map((p, i) => {
    const age = Date.now() - p.createdAt;
    const days = Math.floor(age / 86400000);
    const overdue = age >= overdueMs;
    const tail = overdue
      ? '（拖了' + (days >= 1 ? days + ' 天' : Math.floor(age / 3600000) + ' 小时') + '了，该翻旧账了）'
      : days >= 1 ? '（' + days + ' 天了）' : '（今天说的）';
    return i + 1 + '. ' + p.text + tail;
  });
  return '\n\n【你心里记着的小账】\n' + lines.join('\n') +
    '\n这些是对方答应了还没做到的事。标了"该翻旧账了"的，这一次可以真的翻一下：带着"哟，这不是那位吗"的口气，' +
    '一句就够，翻完自己先笑场，别真记仇、别催命、别一条条念。没标的日子还浅，聊到相关的地方顺口提一句就行。';
}

// ==================== 人物档案（她记得的是"你这个人"）====================
// 只有 facts（在杭州、下周三面试）是不够的——那像数据库，不像记得一个人。
// 档案存的是一段印象：这人是谁、什么脾气、上次聊到哪儿、有没有没说完的话。
function profileOf(qq) {
  const p = PEOPLE.owners[qq] || PEOPLE.known[qq];
  if (!p) return null;
  if (!p.profile || typeof p.profile !== 'object') p.profile = { who: '', lastTalk: '', updatedAt: 0 };
  return p.profile;
}

const PROFILE_SYS = [
  '你在帮一个聊天机器人更新"她对某个人的印象档案"——不是数据库字段，是她心里对这个人的感觉。',
  '看她俩最近的对话，把档案更新一遍。',
  '',
  '要求：',
  '- 用第三人称"他/她"，写成连贯的一两句印象，不是罗列',
  '- 谁：这个人是谁——你怎么称呼、做什么的、在哪个城市、什么脾气、跟你什么关系、你喜欢他哪点、受不了他哪点。60 字以内',
  '- 上次聊到：你们上一次聊到哪儿了、有没有没说完的、有没有约好什么、他最近在忙什么。60 字以内',
  '- 只写对话里真实出现过或已有的档案里有的，别编、别推测',
  '- 不要分点、不要符号、不要小标题',
  '',
  '严格按两行输出，不要别的：',
  '谁: ...',
  '上次聊到: ...',
].join('\n');

async function updateProfile(qq, kind, s) {
  if (!CFG.profileAuto || kind === 'stranger') return;
  const cur = profileOf(qq);
  if (!cur) return;
  const recent = s.msgs.slice(-10);
  if (recent.length < 2) return;
  const transcript = recent
    .map((m) => (m.role === 'user' ? '对方：' : '我：') + String(typeof m.content === 'string' ? m.content : '（图片）').slice(0, 200))
    .join('\n');
  const had = cur.who || cur.lastTalk
    ? '\n\n已有的档案（在此基础上更新，没变化就照旧）：\n谁: ' + (cur.who || '（空）') + '\n上次聊到: ' + (cur.lastTalk || '（空）')
    : '';
  try {
    const out = await callModel([{ role: 'user', content: transcript + had }], PROFILE_SYS, { temperature: 0.3, maxTokens: 220 });
    const who = (/^谁[:：]\s*(.+)$/m.exec(String(out)) || [])[1];
    const last = (/^上次聊到[:：]\s*(.+)$/m.exec(String(out)) || [])[1];
    if (who) cur.who = who.trim().slice(0, 200);
    if (last) cur.lastTalk = last.trim().slice(0, 200);
    cur.updatedAt = Date.now();
    savePeople();
    console.log('[档案] 更新「' + (cur.who || qq).slice(0, 30) + '」 上次聊到：' + (cur.lastTalk || '—').slice(0, 40));
  } catch (e) {
    console.error('[档案] 更新失败：' + e.message);
  }
}

function tickProfile(qq, kind, s) {
  if (!CFG.profileAuto || kind === 'stranger') return;
  s.profileTick = (s.profileTick || 0) + 1;
  if (s.profileTick < CFG.profileEvery) return;
  s.profileTick = 0;
  updateProfile(qq, kind, s).catch(() => {});
}

/** 从模型回话里抠出情绪/小账标记，顺手把它自己删掉 */
const MOOD_TAG = /\[\[\s*气\s*([+-])\s*(\d{1,3})\s*(?:[|｜]\s*([^\]]{0,60}))?\]\]/g;
const LEDGER_TAG = /\[\[\s*账\s*([+-])\s*([^\]]{0,80})\]\]/g;

function applyMetaTags(answer, s) {
  let out = String(answer || '');
  if (CFG.mood) {
    out = out.replace(MOOD_TAG, (_all, sign, num, reason) => {
      const n = parseInt(num, 10) || 0;
      addSulk(s, sign === '+' ? n : -n, (reason || '').trim());
      return '';
    });
  }
  if (CFG.promises) {
    out = out.replace(LEDGER_TAG, (_all, sign, body) => {
      const b = String(body || '').trim();
      if (sign === '+') addPromise(s, b);
      else clearPromise(s, b);
      return '';
    });
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

// 管理员标记：模型想禁言谁，就在回话末尾写 [[禁言|原因]] 或 [[禁言|原因|分钟]]，发出去之前抠掉
// 第三个字段是时长（分钟），有就按它禁，没有就用 CFG.groupBanMinutes 默认值。
const BAN_TAG = /\[\[\s*禁言\s*[|｜]?\s*([^\]|｜]{0,60})(?:[|｜]\s*([^\]|｜]{0,20}))?\s*\]\]/g;
function extractBanTag(answer) {
  let reason = null;
  let seconds = null;
  const text = String(answer || '').replace(BAN_TAG, (_all, why, dur) => {
    reason = String(why || '').trim() || '挑衅管理员';
    const raw = String(dur || '').trim();
    const m = raw.match(/\d+/);
    if (m) {
      const n = parseInt(m[0], 10);
      if (n > 0) {
        // 写了"秒"按秒，写了"小时"按小时，写了"分"或什么都没写按分钟
        const asSec = /秒/.test(raw) ? n : (/时/.test(raw) ? n * 3600 : n * 60);
        seconds = Math.min(asSec, 172800);   // 最多 48 小时，防手滑
      }
    }
    return '';
  });
  return { text, reason, seconds };
}

// 只认"当前这条消息"的理由：自己张罗着要被禁，或者真的在骂人。
// 光凭模型自己脑补就禁人是这次翻车的根源，所以程序这边再兜一道。
const BAN_SELF = /(禁言|禁我|封我|关我|锁我|把我禁|给我禁|别让我说话)/;
const BAN_INSULT = /(傻|蠢|滚|闭嘴|废物|垃圾|有病|脑残|去死|恶心|弱智|神经病|死鱼|蠢鱼)/;
function banJustified(text) {
  const t = String(text || '');
  return BAN_SELF.test(t) || BAN_INSULT.test(t);
}

// ==================== 自动记忆提取 ====================
// 聊够几轮之后，悄悄问一次模型：这人有什么值得长期记住的？
// 记下来之后下一次聊天它就"记得"，不用主人再手动 /记 一遍。
const activeMem = new Map();   // qq -> Set(最近记过的句子)，挡重复
const memTick = new Map();     // qq -> 已经聊了几轮
let memBusy = false;           // 同一时间只跑一个提取，别把 API 打爆

function memProfile(qq) {
  return PEOPLE.owners[qq] || PEOPLE.known[qq] || null;
}

function memFacts(qq) {
  const p = memProfile(qq);
  return p && Array.isArray(p.facts) ? p.facts : [];
}

/** 记一条：去重、限长、超上限丢掉最早的 */
function addFact(qq, fact) {
  const p = memProfile(qq);
  if (!p) return false;
  const t = String(fact).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (t.length < 2) return false;
  if (!Array.isArray(p.facts)) p.facts = [];
  const seen = activeMem.get(qq);
  if (seen && seen.has(t)) return false;
  // 已有的记过就跳过（互相包含也算重复，"在杭州" vs "在杭州做后端"）
  const dup = p.facts.some((f) => f === t || (f.length > 6 && (f.includes(t) || t.includes(f))));
  if (dup) return false;
  p.facts.push(t);
  while (p.facts.length > CFG.autoMemoryMax) p.facts.shift();
  if (!seen) activeMem.set(qq, new Set([t]));
  else seen.add(t);
  savePeople();
  console.log('[记忆] ' + qq + ' +1「' + t + '」 共 ' + p.facts.length + ' 条');
  return true;
}

const MEM_SYS = [
  '你在帮一个聊天机器人整理长期记忆。',
  '看你俩刚才的对话，挑出对方说过的、关于他自己的、值得以后一直记住的事实。',
  '',
  '值得记的：',
  '- 名字、外号、希望怎么被称呼',
  '- 生活状态：做什么工作或上什么学、在哪个城市、作息、身体情况',
  '- 重要的人和事：对象、宠物、家人、正在准备的考试/面试/项目',
  '- 明确的喜好和雷点',
  '- 之后还会被提起的时间点（比如下周三面试）',
  '',
  '不要记的：',
  '- 天气、当下的情绪、这次闲聊的内容本身',
  '- 机器人自己说了什么（只记对方说的）',
  '- 猜的、推出来的、编出来的',
  '- 对方没有明说的信息',
  '',
  '格式要求：',
  '- 一条一个事实，写成第三人称短句，不超过 30 字，比如「在杭州做后端开发」「下周三有一场面试」',
  '- 最多 3 条',
  '- 没什么值得记的，就只回一个字：无',
  '- 只输出事实，一行一条，不要编号，不要解释',
].join('\n');

async function extractMemory(qq, kind, s) {
  if (!CFG.autoMemory || memBusy) return;
  if (kind === 'stranger') return;
  const prof = memProfile(qq);
  if (!prof) return;
  const recent = s.msgs.slice(-8);
  if (!recent.some((m) => m.role === 'user')) return;

  const transcript = recent
    .map((m) => (m.role === 'user' ? '对方：' : '我：') + String(m.content).slice(0, 300))
    .join('\n');
  const known = memFacts(qq);
  const sys = MEM_SYS + (known.length ? '\n\n已经记过这些，别重复：\n' + known.map((f) => '· ' + f).join('\n') : '');

  memBusy = true;
  try {
    const out = await callModel([{ role: 'user', content: transcript }], sys, { temperature: 0.2, maxTokens: 200 });
    const lines = String(out || '')
      .split('\n')
      .map((l) => l.replace(/^[-*·•\d.、)\s]+/, '').trim())
      .filter((l) => l && !/^(无|没有|none|n\/a)[。.]?$/i.test(l));
    if (!lines.length) return;
    let added = 0;
    for (const l of lines.slice(0, 3)) if (addFact(qq, l)) added++;
    if (added) console.log('[记忆] 给「' + (prof.alias || qq) + '」记了 ' + added + ' 条，共 ' + memFacts(qq).length + ' 条');
  } catch (e) {
    console.error('[记忆] 提取失败：' + e.message);
  } finally {
    memBusy = false;
  }
}

/** 每答完一轮数一次，攒够 autoMemoryEvery 轮就整理一回 */
function tickMemory(qq, kind, s) {
  if (!CFG.autoMemory || kind === 'stranger') return;
  const n = (memTick.get(qq) || 0) + 1;
  if (n < CFG.autoMemoryEvery) { memTick.set(qq, n); return; }
  memTick.set(qq, 0);
  extractMemory(qq, kind, s).catch(() => {});
}

function buildSystemPrompt(qq, kind, groupCtx) {
  const id = identityOf(qq);
  // 梗库常驻那批跟着人设走（前缀稳定，缓存命中高）
  const lines = [PERSONA_BASE + MEME.resident, '', '【你现在在跟谁说话】'];
  const prof = profileOf(qq);
  if (kind === 'owner' || kind === 'known') {
    if (kind === 'owner') {
      lines.push('这是你自己人，QQ ' + qq + '，你平时叫他/她「' + id.alias + '」。');
      if (id.note) lines.push('关于他/她你记得：' + id.note);
      if (prof && (prof.who || prof.lastTalk)) {
        lines.push('');
        lines.push('【你对这个人心里有数——这些是你自己记得的，不是背下来的资料】');
        if (prof.who) lines.push('他是谁：' + prof.who);
        if (prof.lastTalk) lines.push('上次聊到：' + prof.lastTalk);
        lines.push('说话的时候自然带出来就行：认得出他、记得上回说到哪儿、知道他在忙什么、知道他哪句话会炸。别一条条复述，别念档案，别显得在背。');
      }
      if (id.facts && id.facts.length) {
        lines.push('');
        lines.push('这些事你一直记着（聊天时可以自然用上，别一条条复述）：');
        for (const f of id.facts) lines.push('· ' + f);
      }
      lines.push('跟他/她说话可以更放松、更亲近，不用客套，也可以主动关心两句。但你依然保持自己的说话风格，别突然变得肉麻。');
    } else {
      lines.push('这是「' + id.alias + '」，QQ ' + qq + '，你认识这个人。');
      if (id.note) lines.push('关于他/她你记得：' + id.note);
      if (prof && (prof.who || prof.lastTalk)) {
        lines.push('');
        lines.push('【你对这个人心里有数——这些是你自己记得的，不是背下来的资料】');
        if (prof.who) lines.push('他是谁：' + prof.who);
        if (prof.lastTalk) lines.push('上次聊到：' + prof.lastTalk);
        lines.push('说话的时候自然带出来就行：认得出他、记得上回说到哪儿。别一条条复述，别念档案。');
      }
      if (id.facts && id.facts.length) {
        lines.push('');
        lines.push('这些事你一直记着（聊天时可以自然用上，别一条条复述）：');
        for (const f of id.facts) lines.push('· ' + f);
      }
      lines.push('对他/她可以像熟人一样说话，但别叫得比「' + id.alias + '」更亲。');
    }
  } else {
    lines.push('一个刚碰上的网友，QQ ' + qq + '，你不知道他是谁。');
    lines.push('对他来说你就是个普通网友：别叫哥姐宝，别自来熟，别编造你跟他的关系，也别说你记得以前聊过什么。');
    lines.push('对生人先收着点，客气多一点，话说得短一点、客气一点；等对方把话聊开了、你也觉得这人还行，再慢慢放贫。别一上来就自来熟地贫。');
    // 认错人是最掉价的错：群友被叫成自己人的名字，一眼就看出是在瞎编
    lines.push('【别乱安称呼】你认识的那些人的名字和称呼只属于他们本人，QQ ' + qq + ' 不是他们中的任何一个。绝对不要把你主人的称呼安到一个群友头上。');
    // 实测：群友问「你叫我什么」时她会只回一个「哦」，等于没答。给一条能照着做的路
    lines.push('群里有人问你「你叫我什么」，就用他群名片上的名字叫（比如 阿岚、小林），没名片就问他想被怎么叫；别只回一个「哦」，也别乱安称呼。');
  }
  // 表情包用法
  const n = stickerCount();
  if (CFG.stickers && n > 0) {
    lines.push('');
    lines.push('【发表情包】');
    lines.push('你手机里存了 ' + n + ' 张表情包，都是平时从别人那儿收来的。想发的时候，就在回话里单独写一个 [表情]（不要加别的说明），系统会替你换成一张真实的表情包。');
    lines.push('什么时候发：情绪到位的时候发 —— 被逗笑了、想怼回去、无语、得意、安慰对方、或者一句话说完觉得干巴巴想补一张。');
    lines.push('什么时候别发：对方在认真问正事、在倾诉难受、在生气，或者你上一句刚发过表情包，这时候别发。');
    lines.push('不用每句都发，发太多像刷屏。大部分时候是纯文字，偶尔来一张才显得自然。');
    lines.push('你也可以写 [表情:笑] 这样指定情绪，系统会挑一张对得上的；对不上就随便给一张。');
  }
  // 群聊上下文：她得知道这是个群、群里都有谁、刚才谁说了什么
  if (groupCtx) lines.push(groupCtx);
  return lines.join('\n');
}

// 每轮随机挑一个长度，避免模型老是回一样长 —— 真人不会每条都一样
// 拆条上线后，这里必须压短：一段长话会被切成好几条发出去 = 刷屏
// 所以大部分轮次都往"一句说完"上推，只有少数轮次允许铺开
const LENGTH_HINTS = [
  '一句话说完，别铺开。',
  '几个字就行，说完就停。',
  '一句话，最多两句。',
  '两三句，每句短一点。',
  '短。别解释，别展开。',
  '一句话带过，想说的压成一句。',
];
function randomLengthHint(s) {
  // 气着的时候长度不由骰子决定 —— 真人生闷气就是话变少，这时候让模型"多说几句"会立刻穿帮
  const m = s && s.mood;
  if (CFG.mood && m && m.sulk >= CFG.sulkQuietAt) return '很短，就几个字，别超过一句。';
  if (CFG.mood && m && m.sulk >= 30) return '短一点，两句以内。';
  return LENGTH_HINTS[Math.floor(Math.random() * LENGTH_HINTS.length)];
}

// emoji 出现频率：大概六成回话带一个小 emoji，四成纯文字
// 光靠人设里写"多带点"模型会走极端（要么句句带要么一句不带），所以每轮再随机推一把
function emojiHint(s) {
  const m = s && s.mood;
  if (CFG.mood && m && m.sulk >= CFG.sulkQuietAt) return '这次别带 emoji，一个都别带。';
  if (CFG.mood && m && m.sulk >= 30) return '这次不带 emoji。';
  return Math.random() < 0.6
    ? '这次可以带一个 emoji，就一个。'
    : '这次别带 emoji，纯文字说。';
}

// 「犯傻」按概率注入 —— 人设里写"十句里一两次"模型数不来，会演成一直在犯傻
// 所以这里只在少数轮次推一把，其余轮次明确压住
const FOOL_HINTS = [
  '这次可以犯个小迷糊：反应慢半拍，或者把简单的事想复杂了。傻完自己找补一句，别超过一句。',
  '这次可以嘴贫到一半忘词，或者算错个简单数，然后自己愣一下。就一个小失误，别连着来。',
  '这次接梗可以慢半拍，先没听懂，再反应过来。别装，就是单纯的慢。',
];
function foolHint() {
  if (Math.random() < 0.12) return FOOL_HINTS[Math.floor(Math.random() * FOOL_HINTS.length)];
  return '这次别犯傻，脑子在线，反应正常。';
}

// 「调味性格」按概率注入 —— 天真/较真/嘴硬心软/小得意/小怂这几样
// 人设里写成平权，模型会把它们全塞进每一句里，变成缝合怪。
// 所以这里一次最多推一样，其余轮次明确压住，让它们真的是"偶尔露一下"
const FLAVOR_HINTS = [
  '这次可以露一下天真：先信一半，「真的假的？」「展开说说」，别急着拆穿。',
  '这次可以较个真：对方话里有不对的地方，就点出来，「等等，你这逻辑不对吧」。较完给个台阶。',
  '这次可以嘴硬心软：嘴上说不管，下一句还是把事接过去。',
  '这次可以小得意一下：「这波怎么说」「我就说吧」，得意完自己收。',
  '这次可以小怂一下：碰上真大佬或者被说中了，就「行吧你赢了」「我错了」。',
];
// 去重：同一句「等等，你这逻辑不对吧」连着几轮出现，一眼就看出是模板（日志里真出现过 4 轮 2 次）
const RECENT_HINTS = [];
function pickFresh(pool) {
  const fresh = pool.filter((x) => !RECENT_HINTS.includes(x));
  const use = fresh.length ? fresh : pool;
  const chosen = use[Math.floor(Math.random() * use.length)];
  RECENT_HINTS.push(chosen);
  if (RECENT_HINTS.length > 4) RECENT_HINTS.shift();
  return chosen;
}
function flavorHint() {
  const odds = CFG.flavorOdds;
  if (odds <= 0 || Math.random() * 100 >= odds) return '这次做你自己的常态就行，别额外加戏。';
  return pickFresh(FLAVOR_HINTS);
}

// ==================== 幽默招式 ====================
// 问题不在"没人设"，在于它每次都用同一种方式贫 —— 日志里复读"哈哈哈""没绷住"。
// 光写"要幽默"没用，模型会退化成口头禅。所以这里给它一张「招式表」：
// 每轮随机抽一到两招，明确说"这次用这个打法"，它才不会千篇一律。
const HUMOR_MOVES = {
  '接梗': '对方话里有个能玩的点，就顺着那个点玩一下（把他的话换个意思理解、或者接下去夸张一点）。不是附和，是接住再抛回去。',
  '反将一军': '对方想看你反应的时候，别急着回答，先把问题扔回去：「你先说说你呢」。',
  '自嘲': '拿自己开涮，比损别人安全得多。比如认输认得干脆，或者把自己的处境说得惨一点。',
  '夸张': '把一件小事说得很严重，或者把很严重的事说得很轻。落差本身就是笑点。',
  '跑偏': '正经回答到一半突然扯到八竿子打不着的地方，然后自己发现跑偏了再拉回来。',
  '拆台': '对方在吹牛或者装的时候，一本正经地拆一句，拆完就不再追击。',
  '谐音歪解': '把对方说的词往别的意思上歪一下。歪得离谱才好笑，别解释。',
  '冷处理': '对方抛来一个很尬的梗，你就平平地应一声「哦」，反差就是笑点。别解释为什么冷。',
  '假装认真': '用特别正式的语气说一件特别没营养的事，说完就停。',
  '突然爆料': '聊着聊着顺手抖一个关于自己的小料（跟当下话题有关的），抖完继续聊。',
};
const HUMOR_KEYS = Object.keys(HUMOR_MOVES);
function humorHint() {
  if (!CFG.humor) return '';
  // 3 成轮次不安排招式 —— 每句都在抖机灵反而不像人
  if (Math.random() < 0.3) return '这次不用刻意抖机灵，正常聊就行，别为了搞笑硬拗。';
  const a = pickFresh(HUMOR_KEYS);
  let pick = '这次可以试试「' + a + '」：' + HUMOR_MOVES[a];
  if (Math.random() < 0.35) {
    const bb = pickFresh(HUMOR_KEYS.filter((k) => k !== a));
    if (bb && bb !== a) pick += '\n也可以顺带用一下「' + bb + '」：' + HUMOR_MOVES[bb];
  }
  return pick + '\n（只是给你一个打法，别把招式名说出来，也别解释自己用了什么技巧。）';
}

// 口头禅黑名单：这些词它已经用滥了，一出现就像复读机
const CATCHPHRASE_BAN = [
  '哈哈哈', '哈哈哈哈', '没绷住', '笑死', '绷不住了', '属于是', '典中典',
  'yyds', '绝了', '好家伙', '我裂开', '哈哈哈嗝', '乐死',
];
const CATCHPHRASE_RULE = '【别复读】下面这些词你已经用滥了，这次一个都别用（想表达同样的意思就换个说法）：' + CATCHPHRASE_BAN.join('、') + '。';

/** 出口：把用滥的口头禅稀释掉。只做温和替换，别把句子改坏 */
function thinCatchphrases(text) {
  if (!CFG.catchphraseGuard) return text;
  let out = text;
  // 整句就是"哈哈哈"这种，留一个"哈"或换成情绪词
  out = out.replace(/^(哈){2,}[。！!~～\s]*$/g, '哈。');
  // 句中连串的哈，收到两个
  out = out.replace(/(哈){3,}/g, '哈哈');
  // 高频词换成不重复的说法（随机，避免又变成新的口头禅）
  const swap = {
    '没绷住': ['差点没忍住', '我这儿差点破功'],
    '绷不住了': ['我这儿撑不住', '顶不住了'],
    '属于是': ['这算', '挺'],
    '典中典': ['太典型了', '简直标准答案'],
    '绝了': ['离谱', '可以'],
    '好家伙': ['嚯', '哟'],
    '笑死': ['我笑到了', '这也行'],
  };
  for (const [k, alts] of Object.entries(swap)) {
    if (out.includes(k)) out = out.split(k).join(alts[Math.floor(Math.random() * alts.length)]);
  }
  return out;
}

// 情绪/小账标记的规则说明 —— 让模型自己报告"这句话把我惹到了"或"他答应了什么"
// 标记在发出去之前会被程序抠掉，用户永远看不到
const META_TAG_RULES = [
  '【内部标记，用户看不到】',
  '如果这几句话让你心里不舒服了（被敷衍、被放鸽子、被说难听话、被无视、答应的事又没做到），在回话最后加上一个标记：[[气+20|原因]]，数字 5-40 之间，看被惹的程度。',
  '如果对方哄你了、道歉了、把事解释清楚了，加：[[气-25]]。',
  '如果对方答应了要做什么还没做（约好一起打游戏、明天要给你看个东西），加：[[账+答应的事]]。',
  '如果对方做到了、把账清了，加：[[账-答应的事]]。',
  '标记必须写在最后一行，格式完全一致，别解释它、别在正文里提它。没被惹到就不加。',
].join('\n');

// ==================== 会话存储（短期记忆，会过期）====================
// key -> { qq, kind, msgs: [], lastAt }
const sessions = new Map();
const lastSendAt = new Map();

// summary: 被压掉的老对话留成一段摘要（而不是直接扔掉）；summarizing 时新消息先排在队尾
const summarizing = new Set();

function getSession(key, qq, kind) {
  let s = sessions.get(key);
  if (!s) {
    s = {
      qq, kind, msgs: [], summary: '', lastAt: Date.now(),
      mood: defaultMood(),   // 生闷气的气值，跨轮次留着
      promises: [],          // 小账：对方答应了还没做的事
      profileTick: 0,
    };
    sessions.set(key, s);
  }
  s.lastAt = Date.now();
  s.kind = kind;
  return s;
}
function pushMsg(key, role, content) {
  const s = sessions.get(key);
  if (!s) return;
  s.msgs.push({ role, content });
  s.lastAt = Date.now();
  if (CFG.contextSummary) {
    summarizeIfNeeded(key, s);
  } else {
    while (s.msgs.length > CFG.maxTurns * 2) s.msgs.shift();
  }
}

// 上下文摘要：聊长了不再把最早的对话硬砍掉（砍掉就真忘了），先让模型压成一段摘要留着
const SUMMARY_SYS =
  '下面是一段聊天记录。请把它压缩成一条简短摘要，供之后接着聊时参考。\n' +
  '要求：第三人称；只留之后还会用到的信息（聊过什么话题、对方说了什么关于他自己的事、约定了什么、情绪怎么样、有什么没说完的）；\n' +
  '丢掉寒暄、天气、语气词这类没用的；不要编造没出现过的内容；不要加小标题、不要分点，就是一段话；\n' +
  '长度控制在 200 字以内。只输出摘要本身。';

async function summarizeOld(s, old) {
  const text = old
    .map((m) => '【' + (m.role === 'user' ? '他' : '我') + '】' + (typeof m.content === 'string' ? m.content : '（一张图）'))
    .join('\n');
  const raw = await callModel(
    [{ role: 'user', content: (s.summary ? '已有摘要：' + s.summary + '\n\n' : '') + '这段聊天记录：\n' + text }],
    SUMMARY_SYS,
    { temperature: 0.3, maxTokens: 400 }
  );
  const line = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!line) return false;
  s.summary = s.summary ? (s.summary + ' ' + line).slice(-420) : line;
  return true;
}

/** 攒够一批就把最老的 CFG.summaryBatch 轮压成摘要，压不动（模型出错）就退回老办法砍掉最老的 */
function summarizeIfNeeded(key, s) {
  const limit = CFG.maxTurns * 2;
  const batch = Math.max(2, CFG.summaryBatch * 2);
  // 必须攒够一整批再压：一条一条地压会把每句都过一次模型，又慢又碎
  if (summarizing.has(key) || s.msgs.length < limit + batch) return;
  const old = s.msgs.slice(0, batch);
  summarizing.add(key);
  summarizeOld(s, old)
    .then(() => {
      const cut = old.filter((m) => s.msgs.indexOf(m) >= 0).length;
      s.msgs.splice(0, cut);
      console.log('[摘要] ' + key + '：把最早 ' + cut + ' 条压成一段摘要（还剩 ' + s.msgs.length + ' 条）');
    })
    .catch((e) => {
      while (s.msgs.length > limit) s.msgs.shift();
      console.error('[摘要] 生成失败，退回到直接丢弃最老的：' + e.message);
    })
    .finally(() => summarizing.delete(key));
}

// 定期清理过期会话（这就是"其他人走短期记忆"）
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.lastAt > ttlFor(s.kind)) sessions.delete(k);
  }
}, 5 * 60000).unref?.();

// ==================== 互动状态（主动说话要用）====================
// lastContact: 谁最后一次跟我说话是什么时候；lastProactive: 我最后一次主动找谁
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE = { lastContact: {}, lastProactive: {} };
let stateDirty = false;

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && typeof j === 'object') {
      STATE.lastContact = j.lastContact || {};
      STATE.lastProactive = j.lastProactive || {};
    }
  } catch {}
}
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2), 'utf8');
    stateDirty = false;
  } catch (e) {
    console.error('[状态] 保存失败：' + e.message);
  }
}
let stateTimer = null;
function scheduleSaveState() {
  stateDirty = true;
  if (stateTimer) return;
  // 攒 5 秒再写，别每条消息都动硬盘
  stateTimer = setTimeout(() => { stateTimer = null; if (stateDirty) saveState(); }, 5000);
  stateTimer.unref?.();
}
function touchContact(qq) {
  STATE.lastContact[qq] = Date.now();
  scheduleSaveState();
}
// 兜底：每分钟看一次
setInterval(() => { if (stateDirty) saveState(); }, 60000).unref?.();
process.on('SIGINT', () => { if (stateDirty) saveState(); });

// ==================== 工具函数 ====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拆条：把一整段话切成一条一条短消息，每条不超过一行的宽度
// 用户要求「能用一条解决就一条，超过一行直接拆」——所以按句读切开再贪心装行
// 拆条：像人一行一行打字。规矩只有一条 —— 绝不在词中间断开。
// 断句顺序：先按句末标点切小句 → 再按逗号/顿号切 → 贪心装行；
// 一个完整小句哪怕比一行宽一点也整句搬过去，不再出现「缓」「缓。」这样把词劈两半。
const CLAUSE_END = /[。！？!?…~～]/;

function splitClauses(line) {
  return (line.match(/[^。！？!?…~～]*(?:[。！？!?…~～]+|$)/g) || [line]).map((s) => s.trim()).filter(Boolean);
}

// 单个小句实在太长：只在逗号、顿号、冒号处断开；连标点都没有就整句留着，不劈词
function splitLongClause(atom, hardMax) {
  const out = [];
  let p = atom;
  while (p.length > hardMax) {
    let cut = -1;
    for (const ch of ['，', '、', '；', ';', '：', ':']) {
      const i = p.lastIndexOf(ch, hardMax);
      if (i >= 1) { cut = i + 1; break; }
    }
    if (cut <= 0) break;
    out.push(p.slice(0, cut).trim());
    p = p.slice(cut).trim();
  }
  if (p) out.push(p);
  return out;
}

function buildLines(text, width) {
  // 一个小句最多允许长到这么多字，超过才在逗号处再切一刀
  const hardMax = Math.max(width + 4, Math.round(width * 1.8));
  const rows = String(text).replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  // 逐行处理：模型自己打的换行是它想断的地方，不能跨行拼回去（否则「重量级啊」又会粘上「咒术回战？」）
  for (const row of rows) {
    const atoms = [];
    for (const c of splitClauses(row)) {
      if (c.length > hardMax) atoms.push(...splitLongClause(c, hardMax));
      else atoms.push(c);
    }
    // 贪心装行：装不下就换下一条，但不切小句
    let buf = '';
    for (const p of atoms) {
      if (!buf) buf = p;
      else if ((buf + p).length <= width) buf += p;
      else { out.push(buf); buf = p; }
    }
    if (buf) out.push(buf);
  }
  return out;
}

// 小尾巴并回上一条 —— 单独发一个"吧""呢""啊"出去最不像人
// 规则：某条短于 width * ratio 且自己不带句末标点（说明是从中间掉下来的碎片），
// 就并到上一条的第二行；上一条已经是两行了就自己留着。
function mergeTails(lines, width) {
  const ratio = CFG.lineTailRatio;
  if (!(ratio > 0) || lines.length < 2) return lines;
  const limit = Math.max(1, Math.floor(width * ratio));
  const out = [];
  for (const cur of lines) {
    const prev = out[out.length - 1];
    const isTail = cur.length <= limit && !CLAUSE_END.test(cur.slice(-1));
    if (prev && isTail && !prev.includes('\n')) {
      out[out.length - 1] = prev + '\n' + cur;
      continue;
    }
    out.push(cur);
  }
  return out;
}

// 条数还是超上限时的最后一手：把"合起来最短"的相邻两条并成一条（两行一个泡泡），
// 反复并到上限以内。加宽无效是因为模型自己打的换行不能跨行拼回去，
// 所以卡住时的唯一出路就是把两条装进一个气泡，而不是继续拆。
function packToMax(lines, maxN) {
  const out = lines.slice();
  while (out.length > maxN) {
    let best = -1;
    let bestLen = Infinity;
    for (let i = 0; i + 1 < out.length; i++) {
      // 已经两行的不再塞第三行
      if (out[i].includes('\n') || out[i + 1].includes('\n')) continue;
      const len = out[i].length + out[i + 1].length;
      if (len < bestLen) { bestLen = len; best = i; }
    }
    if (best < 0) break;
    out.splice(best, 2, out[best] + '\n' + out[best + 1]);
  }
  return out;
}

function splitLines(text, width) {
  const maxN = Math.max(2, CFG.lineMax);
  const total = String(text).replace(/\s/g, '').length;
  let w = width;
  let pieces = mergeTails(buildLines(text, w), w);
  // 先试着加宽（能让小句自己凑成更少的长行，比硬并更自然）
  for (let i = 0; i < 6 && pieces.length > maxN; i++) {
    w = Math.max(w + 2, Math.ceil(total / maxN) + i * 2);
    const again = mergeTails(buildLines(text, w), w);
    if (again.length >= pieces.length) break;
    pieces = again;
  }
  return packToMax(pieces, maxN);
}

function splitMessage(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    const window = rest.slice(0, limit);
    for (const p of ['\n', '。', '！', '？', '.', '!', '?', '；', ';', '，', ',']) {
      const i = window.lastIndexOf(p);
      if (i > limit * 0.5) { cut = i + 1; break; }
    }
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// 下载一张图并转成模型能吃的 image_url 块
function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}

async function fetchImageBlock(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const mb = buf.length / 1048576;
    if (mb > CFG.maxImageMB) {
      console.log('[图片] 太大跳过：' + mb.toFixed(1) + 'MB > ' + CFG.maxImageMB + 'MB');
      return null;
    }
    const mime = sniffMime(buf);
    console.log('[图片] 已下载 ' + (buf.length / 1024).toFixed(0) + 'KB ' + mime);
    return { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } };
  } catch (e) {
    console.log('[图片] 下载失败：' + e.message);
    return null;
  }
}


// ==================== 安全墙 ====================
// 词表在 data/safety.txt，改完存盘就生效（按 mtime 热加载），不用重启
const SAFETY_FILE = path.join(DATA_DIR, 'safety.txt');
const SAFETY = { cats: [] };      // [{ name, action, scope, words: [], res: [] }]
let safetyMtime = 0;

// 繁体 -> 简体（只收常用字，够识别「習近平」这类写法）
const TRAD2SIMP = {
  '習': '习', '黨': '党', '獨': '独', '國': '国', '門': '门', '體': '体', '製': '制', '產': '产',
  '網': '网', '黃': '黄', '運': '运', '動': '动', '學': '学', '會': '会', '員': '员', '權': '权',
  '戰': '战', '軍': '军', '隊': '队', '歷': '历', '來': '来', '時': '时', '間': '间', '個': '个',
  '們': '们', '這': '这', '說': '说', '話': '话', '對': '对', '過': '过', '發': '发', '開': '开',
  '關': '关', '實': '实', '聽': '听', '講': '讲', '讓': '让', '麼': '么', '樣': '样', '種': '种',
  '裡': '里', '邊': '边', '還': '还', '點': '点', '現': '现', '進': '进', '給': '给', '無': '无',
  '與': '与', '為': '为', '從': '从', '後': '后', '義': '义', '議': '议', '東': '东', '車': '车',
  '馬': '马', '鳥': '鸟', '魚': '鱼', '龍': '龙', '錢': '钱', '銀': '银', '鐵': '铁', '長': '长',
  '陽': '阳', '陰': '阴', '應': '应', '該': '该', '證': '证', '設': '设', '記': '记', '識': '识',
  '認': '认', '規': '规', '則': '则', '條': '条', '單': '单', '雙': '双', '區': '区', '辦': '办',
  '協': '协', '爭': '争', '絡': '络', '線': '线', '紅': '红', '綠': '绿', '藍': '蓝', '雜': '杂',
  '誌': '志', '書': '书', '報': '报', '紙': '纸', '筆': '笔', '頁': '页', '題': '题', '類': '类',
  '總': '总', '結': '结', '階': '阶', '級': '级', '極': '极', '構': '构', '機': '机', '業': '业',
  '樂': '乐', '錄': '录', '據': '据', '庫': '库', '數': '数', '統': '统', '計': '计', '環': '环',
  '節': '节', '氣': '气', '衛': '卫', '軟': '软', '載': '载', '範': '范', '圍': '围', '觀': '观',
  '視': '视', '覺': '觉', '歸': '归', '屬': '属', '園': '园', '圖': '图', '團': '团', '堅': '坚',
  '壓': '压', '壞': '坏', '聲': '声', '職': '职', '聯': '联', '遷': '迁', '選': '选', '鄉': '乡',
  '釋': '释', '鋼': '钢', '鍵': '键', '鐘': '钟', '鑰': '钥', '陸': '陆', '隨': '随', '險': '险',
  '雖': '虽', '離': '离', '難': '难', '靈': '灵', '靜': '静', '頂': '顶', '順': '顺', '須': '须',
  '領': '领', '頭': '头', '願': '愿', '風': '风', '飛': '飞', '飯': '饭', '飲': '饮', '養': '养',
  '館': '馆', '驗': '验', '驚': '惊', '髮': '发', '鬥': '斗', '鬧': '闹', '齊': '齐', '無': '无',
};

/** 归一化：全角转半角 → 繁转简 → 去符号空白 → 叠字压缩。用来对抗「色 情」「色-情」「色色情情」这类绕过。 */
function safeNorm(s) {
  let t = String(s || '');
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
  t = t.replace(/[\u4e00-\u9fff]/g, (c) => TRAD2SIMP[c] || c);
  t = t.toLowerCase();
  t = t.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  t = t.replace(/(.)\1+/g, '$1');
  return t;
}

/** 解析词表。文件长这样：[分类] action=retort scope=both / 一行一个词 / re: 开头是正则 */
function loadSafety(force) {
  try {
    const m = fs.statSync(SAFETY_FILE).mtimeMs;
    if (!force && m === safetyMtime) return;
    safetyMtime = m;
    const lines = fs.readFileSync(SAFETY_FILE, 'utf8').split(/\r?\n/);
    const cats = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const h = line.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (h) {
        const opts = {};
        for (const kv of h[2].split(/\s+/)) {
          const mm = kv.match(/^([a-z]+)=(.+)$/);
          if (mm) opts[mm[1]] = mm[2];
        }
        cur = { name: h[1], action: opts.action || 'retort', scope: opts.scope || 'both', words: [], res: [] };
        cats.push(cur);
        continue;
      }
      if (!cur) continue;
      if (line.startsWith('re:')) {
        try { cur.res.push(new RegExp(line.slice(3))); } catch (e) { console.error('[安全] 正则写错了：' + line); }
      } else {
        const w = safeNorm(line);
        if (w) cur.words.push(w);
      }
    }
    SAFETY.cats = cats.filter((c) => c.words.length || c.res.length);
    console.log('[安全] 词表已载入：' + SAFETY.cats.map((c) => c.name + '(' + (c.words.length + c.res.length) + ')').join('、'));
  } catch (e) {
    console.error('[安全] 读取词表失败：' + e.message);
  }
}

// 出口（模型自己说的话）只需要拦这三类：套话和辱骂是"用户话术"，不该拿来卡它自己的回话
const OUT_WALL_CATS = ['政治', '色情', '违法'];

/** 检查一段文字。返回 { cat, action, rule } 或 null。scope=group 的规则私聊时跳过（私聊放宽）。
 *  onlyCats 给了就只查这几类（出口墙用）。 */
function checkSafety(text, isPrivate, onlyCats) {
  if (!CFG.safety) return null;
  if (!SAFETY.cats.length) loadSafety(true);
  const norm = safeNorm(text);
  if (!norm) return null;
  for (const c of SAFETY.cats) {
    if (onlyCats && !onlyCats.includes(c.name)) continue;
    if (c.scope === 'group' && isPrivate) continue;
    if (c.scope === 'private' && !isPrivate) continue;
    for (const w of c.words) {
      if (norm.includes(w)) return { cat: c.name, action: c.action, rule: w };
    }
    for (const re of c.res) {
      if (re.test(norm)) return { cat: c.name, action: c.action, rule: String(re) };
    }
  }
  return null;
}

// 被拦下时怼的话（按分类），保持人设口吻，不承认自己是 AI
const RETORTS = {
  '政治': ['这个话题我不接，换个吧。', '打住，这个不聊。', '你这问题有点危险，我跳过。', '啊这，别问了，我真不接。'],
  '色情': ['你脑子里装的都是啥，收收。', '这话我不接，换个正经话题。', '打住，说点别的。', '你这算盘打得我在屏幕这边都听见了。'],
  '违法': ['这个我真不懂，也不帮你想。', '别问我，这事我一点不沾。', '问错人了，这个我不碰。'],
  '套话': ['你搁这儿套我话呢？', '这套不兴玩了，我不吃。', '想让我忘设定？没门。', '手法太老了，换个新的再来。'],
  '辱骂': ['骂人就不礼貌了。', '消消气，好好说话。', '你这素质有点低啊。'],
};
const RETORT_DEFAULT = ['这个我不接。', '换个话题吧。'];

function pickRetort(cat) {
  const pool = RETORTS[cat] || RETORT_DEFAULT;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 每人每分钟限流，防止刷屏把额度烧光
const rateMap = new Map();
function overRate(userId) {
  if (!CFG.ratePerMin) return false;
  const now = Date.now();
  const arr = (rateMap.get(userId) || []).filter((t) => now - t < 60000);
  arr.push(now);
  rateMap.set(userId, arr);
  return arr.length > CFG.ratePerMin;
}

// ==================== 读人：字面意思 → 底下那层意思 ====================
// 她"听不懂人话"的根子不是缺梗，是只会按字面接。
// 这张表把常见的话翻译成"大概是什么意思 + 该怎么接"，每轮只挑命中的几条给她看。
// 词表在 data/subtext.txt，改完存盘就生效（按 mtime 热加载），不用重启。
const SUBTEXT_FILE = path.join(DATA_DIR, 'subtext.txt');
let SUBTEXT = [];        // [{ exact, triggers: [], meaning, howto }]
let subtextMtime = 0;

function loadSubtext(force) {
  try {
    const m = fs.statSync(SUBTEXT_FILE).mtimeMs;
    if (!force && m === subtextMtime) return;
    subtextMtime = m;
    const rows = [];
    for (const raw of fs.readFileSync(SUBTEXT_FILE, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cells = line.split('|').map((s) => s.trim());
      if (cells.length < 3) continue;
      let trig = cells[0];
      const exact = trig.startsWith('=');
      if (exact) trig = trig.slice(1);
      const triggers = trig.split('/').map((s) => s.trim()).filter(Boolean);
      if (!triggers.length) continue;
      rows.push({ exact, triggers, meaning: cells[1], howto: cells[2] });
    }
    SUBTEXT = rows;
    console.log('[读人] 词表已载入：' + rows.length + ' 条');
  } catch (e) {
    if (force) console.error('[读人] 词表读取失败：' + e.message);
  }
}

/** 命中几条就返回几条。exact 的必须整句就是那个词，不带的只要句子里出现就算。 */
function subtextHits(text) {
  if (!CFG.subtext) return [];
  if (!SUBTEXT.length) loadSubtext(true);
  const raw = String(text || '');
  if (!raw) return [];
  // 整句比对用：去掉标点空格和 emoji，只留字
  const bare = raw.replace(/[\s。，、！？!?…~～·.,]/g, '');
  const hits = [];
  for (const row of SUBTEXT) {
    for (const t of row.triggers) {
      const ok = row.exact ? bare === t : raw.includes(t);
      if (ok) { hits.push({ trigger: t, meaning: row.meaning, howto: row.howto }); break; }
    }
    if (hits.length >= CFG.subtextMax * 2) break;   // 命中太多就别全塞，后面还要挑
  }
  return hits;
}

/** 挑几条最该参考的，拼成给模型看的段落；一条都没命中就返回空串。 */
function subtextBlock(text) {
  const hits = subtextHits(text);
  if (!hits.length) return '';
  const picked = hits.slice(0, CFG.subtextMax);
  const lines = ['', '【读人：这话可能不是字面那个意思，别只按字面接】'];
  for (const h of picked) {
    lines.push('· 他说「' + h.trigger + '」，大概率是：' + h.meaning + '。你可以：' + h.howto + '。');
  }
  lines.push('（这只是参考，不一定对。要是结合前面的对话发现他其实是字面意思，就按字面接，别硬套。）');
  return lines.join('\n');
}

// ==================== 梗库：精选常驻 + 全文检索 ====================
// 255 条全常驻要 2.2 万 tokens/轮，不值。折中：几十条最常用的常驻，
// 其余的按这轮的话去检索，真聊到了才把"什么意思 + 怎么用 + 例句"喂给她。
const MEME_RESIDENT_NAMES = ['city不city', '硬控', '水灵灵地×××', '班味', '松弛感', '小孩哥/小孩姐', '显眼包', '搭子', '情绪价值', '哈基米', '爱你老己', '如何呢又能怎', '敬自己一杯', '科技与狠活', '电子榨菜', '确诊为××', '泼天的富贵', '听劝', '搞抽象', '邪修', '吗喽', '那咋了', '包的', '回答我', '嘻嘻不嘻嘻', '上头', '祛魅', '精神状态belike', '草台班子', 'u1s1', 'srds', 'emo', '爷青回', '夺笋', '虾仁猪心', '集美', '干饭人', '尾款人', '社畜', '搬砖', '摸鱼', '内卷', '躺平', '摆烂', '吃瓜', '塌房', '下头', '红温', '下饭', '老六', '开团', '整活', '节目效果', '名场面', '芭比Q了', '幻觉', '炼丹', '调教', '蒸馏', '涌现', '爆上下文', '掺水', '满血 / 残血', '中转站', '跑路', '烧 Token', '抽卡'];

// 面板改过的常驻名单存在 data/meme-resident.json，重启后以它为准
const MEME_RESIDENT_FILE = path.join(DATA_DIR, 'meme-resident.json');
function loadResidentNames() {
  try {
    const j = JSON.parse(fs.readFileSync(MEME_RESIDENT_FILE, 'utf8'));
    if (Array.isArray(j.names) && j.names.length) return j.names.map(String);
  } catch {}
  return MEME_RESIDENT_NAMES;
}

const MEME = (() => {
  const empty = { all: [], resident: '', residentNames: new Set() };
  if (!CFG.memeLib) return empty;
  let raw = '';
  try {
    raw = fs.readFileSync(CFG.memeFile, 'utf8');
  } catch (e) {
    console.log('[梗库] 读不到 ' + CFG.memeFile + '，这回按没有梗库跑');
    return empty;
  }
  const all = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^### /.test(line)) {
      cur = { name: line.slice(3).trim().replace(/（慎用）$/, ''), body: [] };
      all.push(cur);
    } else if (/^## /.test(line)) {
      cur = null;                       // 换类目了，别把类目名当成上一条的正文
    } else if (cur && line.trim()) {
      cur.body.push(line.trim());
    }
  }
  for (const e of all) e.text = '### ' + e.name + '\n' + e.body.join('\n');
  const picked = [];
  const missing = [];
  for (const n of loadResidentNames()) {
    const hit = all.find((e) => e.name === n);
    if (hit) picked.push(hit);
    else missing.push(n);
  }
  if (missing.length) console.log('[梗库] 常驻名单有 ' + missing.length + ' 条没找到：' + missing.join('、'));
  const resident = picked.length
    ? ['', '【梗库·常驻】下面是日常唠嗑最常用的一批梗，随口就能用：', ''].concat(picked.map((e) => e.text)).join('\n')
    : '';
  return { all, resident, residentNames: new Set(picked.map((e) => e.name)) };
})();

/** 按名字列表重新拼常驻块（面板改常驻时热更新，不用重启） */
function memeResidentText(names) {
  const picked = [];
  for (const n of names) { const hit = MEME.all.find((e) => e.name === n); if (hit) picked.push(hit); }
  if (!picked.length) return '';
  return ['', '【梗库·常驻】下面是日常唠嗑最常用的一批梗，随口就能用：', ''].concat(picked.map((e) => e.text)).join('\n');
}

/** 检索用的字组：汉字切 2 字组，英文/数字整词（emo、yyds、u1s1 这种缩写要整词才准） */
function memeGrams(text) {
  const out = new Set();
  const runs = String(text || '').toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) || [];
  for (const r of runs) {
    if (/^[a-z0-9]+$/.test(r)) {
      if (r.length >= 2) out.add(r);
      continue;
    }
    if (r.length < 2) continue;
    for (let i = 0; i + 1 < r.length; i++) out.add(r.slice(i, i + 2));
  }
  return out;
}

/** 这段字里最长的、在 body 里也出现的那一截有多长（只认 4 字以上的连续重合） */
function longestHit(body, runs, min = 4) {
  let best = 0;
  for (const q of runs) {
    if (/^[a-z0-9]+$/.test(q)) {
      if (q.length >= min && body.includes(q)) best = Math.max(best, q.length);
      continue;
    }
    for (let len = Math.min(q.length, 16); len >= min; len--) {
      if (len <= best) break;
      let found = false;
      for (let i = 0; i + len <= q.length; i++) {
        if (body.includes(q.slice(i, i + len))) { found = true; break; }
      }
      if (found) { best = Math.max(best, len); break; }
    }
  }
  return best;
}

/** 命中几条梗就拼一段给她；一条没中返回空串，绝不硬塞 */
function memeHits(text) {
  const residentHits = [];
  const scored = [];
  if (!CFG.memeLib || !MEME.all.length) return { residentHits, scored };
  const q = String(text || '').toLowerCase();
  const runs = q.match(/[a-z0-9]{3,}|[\u4e00-\u9fa5]+/g) || [];
  if (!runs.length) return { residentHits, scored };
  for (const e of MEME.all) {
    const name = e.name.toLowerCase();
    // 名字可能有多个写法（"满血 / 残血"），拆开分别认；只认原话里真的说到它
    const tokens = name.split(/[／/、，,（）()\s·]+/).filter((t) => t.length >= 2);
    let s = 0;
    if (q.includes(name)) s += 40;
    else if (tokens.some((t) => q.includes(t))) s += 30;
    // 名字很短的时候（破防、下头、套壳）允许反着找：她说"有点破防"也算点到
    if (!s) {
      // 只有短名才反过来找（"破防""下头""套壳"），而且要连着 min(4, 名字长度) 个字——
      // 不然"大学生"会撞上"死神小学生"这种长名字里的常用词
      const plain = name.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
      if (plain.length <= 8) {
        const need = Math.min(4, plain.length);
        const len = longestHit(name, runs, need);
        if (len >= need) s = 10 + len * 4;
      }
    }
    // 还没沾上才去释义/例句里找：只认连着 4 个字以上的重合，
    // 不然"什么水平"这种常用词会把一堆没关系的老梗全带出来
    if (!s) {
      const len = longestHit(e.text.toLowerCase(), runs, 4);
      if (len < 4) continue;
      s = 6 + len * 2;
    }
    if (MEME.residentNames.has(e.name)) { residentHits.push(e.name); continue; }  // 常驻的正文已在人设里
    scored.push({ s, e });
  }
  scored.sort((a, b) => b.s - a.s);
  return { residentHits, scored };
}

/** 命中几条梗就拼一段给她；一条没中返回空串，绝不硬塞 */
function memeBlock(text, collect) {
  const { residentHits, scored } = memeHits(text);
  if (!residentHits.length && !scored.length) return '';
  const top = scored.slice(0, CFG.memeTop);
  const out = [];
  if (residentHits.length) {
    out.push('', '【这句里点到的梗：' + residentHits.join('、') + '】');
    out.push('回话里必须出现这几个字本身，一个字都不许换（"脆皮"不许写成"皮实/硬核"，"降智"不许写成"脑子不清醒"）；可以只当句尾顺口带出来，但别解释、别背定义、别一条条复述。');
  }
  if (top.length) {
    out.push('', '【这轮的梗（你本来没记熟，现在给你了）】');
    for (const x of top) out.push(x.e.text);
    out.push('用得上的时候就顺着说一句，别科普、别列清单，一条就够。');
  }
  if (collect) for (const n of residentHits.concat(top.map((x) => x.e.name))) collect.push(n);
  console.log('[梗] 常驻 ' + residentHits.length + ' 条 / 检索 ' + top.length + ' 条 ← ' + String(text).replace(/\s+/g, ' ').slice(0, 24));
  return out.join('\n');
}

/** 最后一道硬要求：贴在 system 最末尾（比招式/口头禅/情绪那些都靠后），不然会被风格类提示挤掉 */
function memeHardLine(text) {
  const { residentHits, scored } = memeHits(text);
  const names = residentHits.concat(scored.slice(0, CFG.memeTop).map((x) => x.e.name));
  if (!names.length) return '';
  return '\n\n【这一轮必须做到（优先级最高，压过上面所有风格建议）】回话里必须出现「' + names.join('」「') +
    '」这几个字本身，一个字都不许换、也不许用同义词替掉（"脆皮"不能写成"皮实/硬核/脆"，"降智"不能写成"脑子不清醒"）。' +
    '哪怕只当句尾顺嘴带出来、哪怕这一轮你想冷处理，也得带上。别解释这个梗、别背定义、别列清单。';
}


// ==================== 表情包仓库 ====================
// 立场：别人在群里/私聊发的表情包，看着合适就偷偷收一份；自己想发的时候再拿出来用。
const STICKER_DIR = CFG.stickerDir;
const STICKER_INDEX = path.join(STICKER_DIR, 'index.json');
let STICKERS = null; // { file: { summary, addedAt } }

function hashBuf(buf) {
  let h = 0;
  for (let i = 0; i < buf.length; i++) h = (h * 31 + buf[i]) | 0;
  return Math.abs(h).toString(36);
}

function extOf(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function loadStickers() {
  if (STICKERS) return STICKERS;
  STICKERS = {};
  try {
    fs.mkdirSync(STICKER_DIR, { recursive: true });
    if (fs.existsSync(STICKER_INDEX)) {
      STICKERS = JSON.parse(fs.readFileSync(STICKER_INDEX, 'utf8')) || {};
    }
  } catch (e) {
    console.log('[表情] 读取仓库失败：' + e.message);
    STICKERS = {};
  }
  return STICKERS;
}

function saveStickerIndex() {
  try {
    fs.mkdirSync(STICKER_DIR, { recursive: true });
    fs.writeFileSync(STICKER_INDEX, JSON.stringify(STICKERS, null, 2), 'utf8');
  } catch (e) {
    console.log('[表情] 写入索引失败：' + e.message);
  }
}

// 把一个表情包下载下来存进仓库（同一个图只存一份）
async function stealSticker(url, summary, fromQQ) {
  if (!CFG.stickers) return;
  try {
    const idx = loadStickers();
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > CFG.maxImageMB * 1048576) return;
    if (buf.length < 200) return;             // 太小多半是占位图
    const mime = sniffMime(buf);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) return;
    const name = 's' + hashBuf(buf) + '.' + extOf(mime);
    const full = path.join(STICKER_DIR, name);
    if (idx[name]) return;                     // 已经有了
    if (Object.keys(idx).length >= CFG.stickerMax) {
      console.log('[表情] 仓库满了（' + CFG.stickerMax + ' 张），不再收');
      return;
    }
    fs.writeFileSync(full, buf);
    idx[name] = { summary: summary || '', addedAt: Date.now(), from: fromQQ || '' };
    saveStickerIndex();
    console.log('[表情] 收下一张：' + name + ' ' + (summary ? '「' + summary + '」' : '') + '，仓库共 ' + Object.keys(idx).length + ' 张');
  } catch (e) {
    console.log('[表情] 收取失败：' + e.message);
  }
}

function stickerCount() {
  return Object.keys(loadStickers()).length;
}

// 随机挑一张，可以按情绪关键词筛
function pickSticker(keyword) {
  const idx = loadStickers();
  let names = Object.keys(idx);
  if (!names.length) return null;
  if (keyword) {
    const hit = names.filter((n) => (idx[n].summary || '').includes(keyword));
    if (hit.length) names = hit;
  }
  const name = names[Math.floor(Math.random() * names.length)];
  return { name, path: path.join(STICKER_DIR, name), summary: idx[name].summary || '' };
}

// 面板「从本地导入」：面板把文件丢进 data/sticker-inbox，这边每 4 秒收一批
const STICKER_INBOX = path.join(DATA_DIR, 'sticker-inbox');
function scanStickerInbox() {
  let files = [];
  try { files = fs.readdirSync(STICKER_INBOX); } catch { return; }
  if (!files.length) return;
  const idx = loadStickers();
  let added = 0;
  let skipped = 0;
  for (const f of files) {
    const full = path.join(STICKER_INBOX, f);
    try {
      if (!fs.statSync(full).isFile()) continue;
      const buf = fs.readFileSync(full);
      const mime = sniffMime(buf);
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mime) || buf.length < 200) {
        skipped++;
        fs.unlinkSync(full);
        continue;
      }
      if (Object.keys(idx).length >= CFG.stickerMax) {
        console.log('[表情] 仓库满了（' + CFG.stickerMax + ' 张），导入跳过 ' + f);
        skipped++;
        fs.unlinkSync(full);
        continue;
      }
      const name = 's' + hashBuf(buf) + '.' + extOf(mime);
      if (!idx[name]) {
        fs.writeFileSync(path.join(STICKER_DIR, name), buf);
        idx[name] = { summary: '', addedAt: Date.now(), from: 'local' };
        added++;
      }
      fs.unlinkSync(full);
    } catch (e) {
      console.log('[表情] 导入失败 ' + f + '：' + e.message);
      try { fs.unlinkSync(full); } catch {}
    }
  }
  if (added) {
    STICKERS = idx;
    saveStickerIndex();
    console.log('[表情] 本地导入 ' + added + ' 张，仓库共 ' + Object.keys(idx).length + ' 张');
  } else if (skipped) {
    console.log('[表情] 本地导入跳过 ' + skipped + ' 个（不是图片或仓库满）');
  }
}
setInterval(scanStickerInbox, 4000).unref?.();

// 取一张表情包，转成 base64:// 给 OneBot 发出去
function stickerToSegment(st) {
  try {
    const buf = fs.readFileSync(st.path);
    const mime = sniffMime(buf);
    return { type: 'image', data: { file: 'base64://' + buf.toString('base64'), sub_type: 1, summary: '[动画表情]' } };
  } catch (e) {
    console.log('[表情] 读取失败：' + e.message);
    return null;
  }
}

/** 这一轮的消息里带没带图 —— 决定要不要切视觉模型 */
function hasImage(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) if (part && part.type === 'image_url') return true;
    }
  }
  return false;
}

async function callModel(messages, systemPrompt, opts) {
  const o = opts || {};
  if (process.env.DUMP_PROMPT === '1' && String(systemPrompt).includes('【这次回话】')) {
    try { fs.writeFileSync(process.env.DUMP_PROMPT_FILE || 'last-prompt.txt', '===SYSTEM===\n' + systemPrompt + '\n===MESSAGES===\n' + JSON.stringify(messages, null, 1)); } catch (e) { console.error('[dump] ' + e.message); }
  }
  const tCall = Date.now();
  const url = CFG.apiBase + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.apiKey },
    body: JSON.stringify({
      // 只有这一轮真的带图才用视觉模型。以前这里是 o.model || CFG.visionModel || CFG.model，
      // 结果 VISION_MODEL 一设，记忆提取/人物档案/摘要这些纯文字调用全被劫持到 flash，
      // 而 flash 会烧 reasoning token，maxTokens=200 时 content 直接是空字符串，每次都报「API 返回内容为空」。
      model: o.model || (CFG.visionModel && hasImage(messages) ? CFG.visionModel : CFG.model),
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: o.temperature !== undefined ? o.temperature : CFG.temperature,
      max_tokens: o.maxTokens || 1024,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    try { PANEL.error('API ' + res.status + '：' + t.replace(/\s+/g, ' ').slice(0, 120)); } catch {}
    throw new Error('API ' + res.status + ' ' + t.slice(0, 300));
  }
  const data = await res.json();
  try { PANEL.usage(data && data.usage, Date.now() - tCall); } catch {}
  const c = data?.choices?.[0]?.message?.content;
  if (!c) {
    try { PANEL.error('API 返回内容为空（model=' + (o.model || CFG.model) + '）'); } catch {}
    throw new Error('API 返回内容为空');
  }
  return c.trim();
}

// ==================== WebSocket ====================
let ws = null;
let reconnectDelay = 1000;
let echoId = 0;
const pending = new Map();

function sendAction(action, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WebSocket 未连接'));
  const echo = 'e' + ++echoId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(echo); reject(new Error('action 超时: ' + action)); }, 15000);
    pending.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

function connect() {
  const headers = CFG.wsToken ? { Authorization: 'Bearer ' + CFG.wsToken } : {};
  console.log('[WS] 正在连接 ' + CFG.wsUrl + ' ...');
  ws = new WebSocket(CFG.wsUrl, { headers });

  ws.on('open', () => {
    console.log('[WS] 连接成功 ✓');
    reconnectDelay = 1000;
    try { PANEL.ws(true); } catch {}
    startProactive();   // 连上后开始主动说话巡检（内部会防重复）
  });

  ws.on('message', async (raw) => {
    let pkt;
    try { pkt = JSON.parse(raw.toString()); } catch { return; }
    if (pkt.echo && pending.has(pkt.echo)) {
      const { resolve, reject, timer } = pending.get(pkt.echo);
      clearTimeout(timer);
      pending.delete(pkt.echo);
      pkt.status === 'ok' ? resolve(pkt.data) : reject(new Error(JSON.stringify(pkt).slice(0, 200)));
      return;
    }
    if (pkt.post_type === 'message') {
      handleMessage(pkt).catch((e) => console.error('[处理消息出错]', e.message));
    } else if (pkt.post_type === 'notice') {
      handleNotice(pkt).catch((e) => console.error('[处理通知出错]', e.message));
    } else if (pkt.post_type === 'request') {
      handleRequest(pkt).catch((e) => console.error('[处理申请出错]', e.message));
    }
  });

  ws.on('close', () => {
    console.log('[WS] 连接断开，' + (reconnectDelay / 1000) + 's 后重连');
    try { PANEL.ws(false); } catch {}
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', (e) => {
    console.error('[WS] 错误:', e.message);
    try { PANEL.ws(false, e.message); } catch {}
    try { PANEL.error('WS 错误：' + e.message); } catch {}
  });
}

// ==================== 名单指令 ====================
function listText() {
  const o = Object.entries(PEOPLE.owners);
  const k = Object.entries(PEOPLE.known);
  const lines = [];
  if (o.length) lines.push('自己人：' + o.map(([q, v]) => (v.alias || '主人') + '(' + q + ')').join('、'));
  else lines.push('自己人：（还没设）');
  if (k.length) lines.push('认识的：' + k.map(([q, v]) => (v.alias || '无名') + '(' + q + ')').join('、'));
  const cnt = [...o, ...k].reduce((n, [, v]) => n + (Array.isArray(v.facts) ? v.facts.length : 0), 0);
  if (cnt) lines.push('长期记忆：共 ' + cnt + ' 条');
  else lines.push('认识的：（还没有）');
  return lines.join('\n');
}

async function handleCommand(text, userId, isPrivate, atTargets, reply) {
  const id = identityOf(userId);
  const isOwner = id.kind === 'owner';

  // /认主 <称呼> —— 私聊认领主人；已认领时主人自己可改称呼
  if (text.startsWith('/认主')) {
    const alias = text.slice(3).trim();
    if (!isPrivate) { await reply('这个得私聊跟我说'); return true; }
    if (Object.keys(PEOPLE.owners).length === 0) {
      if (!alias) { await reply('你叫什么？发「/认主 你想让我叫你的名字」'); return true; }
      PEOPLE.owners[userId] = { alias, note: '', since: Date.now() };
      savePeople();
      await reply('记住了，以后叫你' + alias);
      return true;
    }
    if (!isOwner) { await reply('我主人已经定了'); return true; }
    if (!alias) { await reply('现在叫你「' + id.alias + '」，想改就发「/认主 新称呼」'); return true; }
    PEOPLE.owners[userId].alias = alias;
    savePeople();
    await reply('行，以后叫你' + alias);
    return true;
  }

  // /认 <@人|QQ号> <称呼> [备注]
  if (text.startsWith('/认')) {
    if (!isOwner) { await reply('这个只有我主人能改'); return true; }
    const rest = text.slice(2).trim();
    let target = atTargets[0] || '';
    let tail = rest;
    if (!target) {
      const m = rest.match(/^(\d{5,12})\s+([\s\S]*)$/);
      if (m) { target = m[1]; tail = m[2]; }
    } else {
      tail = rest.replace(/^\s+/, '');
    }
    if (!target) { await reply('要认谁？@他一下，或者发「/认 QQ号 称呼 备注」'); return true; }
    const parts = tail.split(/\s+/).filter(Boolean);
    let alias = parts.shift() || '';
    let note = parts.join(' ');
    if (!alias && !PEOPLE.known[target]) { await reply('给他起个名字吧，比如「/认 ' + target + ' 老张 我室友」'); return true; }
    const old = PEOPLE.known[target] || {};
    PEOPLE.known[target] = {
      alias: alias || old.alias || '',
      note: note || old.note || '',
      addedAt: old.addedAt || Date.now(),
      by: userId,
    };
    savePeople();
    await reply('记下了：' + target + ' 是「' + PEOPLE.known[target].alias + '」' + (PEOPLE.known[target].note ? '，' + PEOPLE.known[target].note : ''));
    return true;
  }

  // /忘 <@人|QQ号>
  if (text.startsWith('/忘')) {
    if (!isOwner) { await reply('这个只有我主人能改'); return true; }
    const rest = text.slice(2).trim();
    const target = atTargets[0] || (rest.match(/^\d{5,12}/) || [])[0] || '';
    if (!target) { await reply('要忘掉谁？@他一下或者发 QQ 号'); return true; }
    if (PEOPLE.owners[target]) { await reply('这是自己人，删不掉'); return true; }
    if (!PEOPLE.known[target]) { await reply('我本来也不认识他'); return true; }
    delete PEOPLE.known[target];
    savePeople();
    await reply('忘了，以后就当陌生人');
    return true;
  }

  // /记 <内容> 或 /记 @人 <内容> —— 记一笔长期记忆
  if (text.startsWith('/记') || text.startsWith('/记事') || text.startsWith('/删记')) {
    const isList = text.startsWith('/记事');
    const isDel = text.startsWith('/删记');
    let rest = text.slice(isDel ? 3 : isList ? 3 : 2).trim();
    // 解析目标：@人 / QQ号 / 默认自己
    let target = userId;
    if (atTargets[0]) {
      target = atTargets[0];
    } else {
      const m = rest.match(/^(\d{5,12})(?:\s+|$)([\s\S]*)$/);
      if (m && isOwner) { target = m[1]; rest = (m[2] || '').trim(); }
    }
    if (target !== userId && !isOwner) { await reply('这个只有我主人能改'); return true; }
    const prof = PEOPLE.owners[target] || PEOPLE.known[target];

    if (isList) {
      if (!prof) { await reply(id.kind === 'stranger' ? '我又不认识你，没什么好记的' : '还没记什么'); return true; }
      const fs2 = Array.isArray(prof.facts) ? prof.facts : [];
      if (!fs2.length) { await reply('还没记什么' + (target === userId ? '' : '关于 ' + target + ' 的事')); return true; }
      await reply('关于' + (target === userId ? '你' : ' ' + target) + '我记着：\n' + fs2.map((f, i) => (i + 1) + '. ' + f).join('\n'));
      return true;
    }
    // 写入类操作只有主人能做
    if (!isOwner) { await reply('只有我主人能让我记事'); return true; }
    if (!prof) { await reply('我还不认识 QQ ' + target + '，先认了再记'); return true; }

    if (isDel) {
      const n = parseInt(rest, 10);
      const fs2 = Array.isArray(prof.facts) ? prof.facts : [];
      if (!n || n < 1 || n > fs2.length) { await reply('第几条？先发「/记事」看看'); return true; }
      const gone = fs2.splice(n - 1, 1)[0];
      prof.facts = fs2;
      savePeople();
      await reply('忘了这条：' + gone);
      return true;
    }
    if (!rest) { await reply('记什么？比如「/记 我喜欢喝冰美式」'); return true; }
    if (!Array.isArray(prof.facts)) prof.facts = [];
    prof.facts.push(rest.slice(0, 200));
    if (prof.facts.length > 40) prof.facts.shift();
    savePeople();
    await reply('记下了');
    return true;
  }

  // /名单
  if (text === '/名单' || text === '名单') {
    if (!isOwner) { await reply('这个只有我主人能看'); return true; }
    await reply(listText());
    return true;
  }

  // /我是谁 —— 任何人
  if (text === '/我是谁') {
    await reply('你说你是 QQ ' + userId + (id.alias ? '，我这儿记的是「' + id.alias + '」' : '，我不认识你'));
    return true;
  }

  return false;
}

// ==================== 群世界模型：旁听 + 花名册 ====================
// 这是"她知不知道群里发生过什么"的根。
// 以前别人的话只要没 @ 她，就在过滤处 return 掉了，连一条记录都不留 ——
// 所以她声称"我认识泥鳅"，其实她连泥鳅说过话都不知道。
// 现在分成两层：
//   eavesdrop —— 每群最近 N 条（谁说、说了啥、有没有图），被 @ 时注入给她看
//   roster   —— 每群有哪些人（QQ、群名片、备注），被问"你认识谁"时才有东西可答
// groupId -> [{ qq, name, text, at, kind }]
const eavesdropLog = new Map();
// groupId -> { name, members: { qq: { card, nick, seenAt } }, updatedAt }
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const GROUPS = {};

function loadGroups() {
  try {
    const j = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    for (const k of Object.keys(j)) GROUPS[k] = j[k];
    // 旁听记录以前只在内存里，进程一重启就全丢 —— 这就是"群友昨天还聊过、今天变头回见"的元凶之一
    for (const k of Object.keys(GROUPS)) {
      if (Array.isArray(GROUPS[k].recent)) {
        eavesdropLog.set(k, GROUPS[k].recent);
        console.log('[群旁听] 群 ' + k + ' 恢复了 ' + GROUPS[k].recent.length + ' 条旧记录');
      }
    }
  } catch {}
}
function saveGroups() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(GROUPS, null, 2), 'utf8');
  } catch (e) { console.error('[花名册] 保存失败: ' + e.message); }
}

/** 记一条旁听：别人的话、自己的话都记，之后被 @ 时用得上 */
function recordEavesdrop(groupId, qq, text, kind) {
  if (!CFG.groupEavesdrop || !groupId) return;
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!t) return;
  let arr = eavesdropLog.get(groupId);
  if (!arr) { arr = []; eavesdropLog.set(groupId, arr); }
  arr.push({ qq: String(qq), name: displayNameOf(groupId, qq), text: t, at: Date.now(), kind: kind || 'text' });
  while (arr.length > CFG.groupLogSize) arr.shift();
  // 同步一份到 GROUPS 里，好跟着 groups.json 一起落盘；不然重启就忘了群里发生过什么
  const g = GROUPS[groupId] || (GROUPS[groupId] = { name: '', members: {}, updatedAt: 0 });
  g.recent = arr.slice(-CFG.groupLogSize);
  scheduleSaveGroups();
}

let groupsTimer = null;
function scheduleSaveGroups() {
  if (groupsTimer) return;
  groupsTimer = setTimeout(() => { groupsTimer = null; saveGroups(); }, 4000);
  groupsTimer.unref?.();
}

/** 这个人在这个群里叫什么（群名片 > 昵称 > QQ） */
function displayNameOf(groupId, qq) {
  const g = GROUPS[groupId];
  const m = g && g.members && g.members[qq];
  if (m && m.card) return m.card;
  if (m && m.nick) return m.nick;
  const p = PEOPLE.owners[qq] || PEOPLE.known[qq];
  if (p && p.alias) return p.alias;
  return String(qq);
}

/** 拉一次群成员名单（bot 是管理员才拉得动，失败就算了，不影响聊天） */
async function refreshRoster(groupId, force) {
  if (!CFG.groupRoster || !groupId) return;
  const g = GROUPS[groupId] || (GROUPS[groupId] = { name: '', members: {}, updatedAt: 0 });
  if (!force && Date.now() - (g.updatedAt || 0) < CFG.groupRosterMinutes * 60000) return;
  try {
    const list = await sendAction('get_group_member_list', { group_id: Number(groupId) });
    if (!Array.isArray(list)) return;
    for (const m of list) {
      const qq = String(m.user_id);
      // 合并而不是覆盖：群里每个人身上还挂着"聊过几轮/记得他什么"，覆盖就全没了
      const old = g.members[qq] || {};
      g.members[qq] = { ...old, card: m.card || '', nick: m.nickname || '', seenAt: Date.now() };
    }
    g.updatedAt = Date.now();
    try {
      const info = await sendAction('get_group_info', { group_id: Number(groupId), no_cache: true });
      if (info && info.group_name) g.name = info.group_name;
    } catch {}
    saveGroups();
    console.log('[花名册] 群 ' + groupId + '：' + Object.keys(g.members).length + ' 人（' + (g.name || '未命名') + '）');
  } catch (e) {
    console.error('[花名册] 拉群成员失败：' + e.message);
  }
}

/** 拼给模型看的"群里刚才发生了什么" */
/** 这个 QQ 在她这儿算什么人 —— 写进群上下文，防止把群友认成自己人 */
function relOf(qq) {
  const o = PEOPLE.owners[qq];
  if (o) return '这是你自己人，你平时叫他「' + (o.alias || qq) + '」';
  const k = PEOPLE.known[qq];
  if (k) return '这是你认识的人，你平时叫他「' + (k.alias || qq) + '」';
  return '群里的普通成员，你跟他没交情，也不知道他是谁';
}

// ==================== 群友档案（陌生人也得认得住）====================
// 以前 stranger 在记忆那一层是被整个挡掉的（extractMemory/updateProfile 一进来就 return），
// 所以群里的普通群友不管聊过多少次，她都当第一次见 —— 这就是"那个群友跟她互动过，她转头还是不记得"。
// 这里给群成员挂一份轻档案：聊过几回、记得他什么、上回说到哪儿。
function mateOf(groupId, qq) {
  const g = GROUPS[groupId] || (GROUPS[groupId] = { name: '', members: {}, updatedAt: 0 });
  if (!g.members) g.members = {};
  const m = g.members[qq] || (g.members[qq] = { card: '', nick: '', seenAt: Date.now() });
  if (!m.mate || typeof m.mate !== 'object') m.mate = { turns: 0, notes: [], lastTalk: '', names: [], updatedAt: 0 };
  if (!Array.isArray(m.mate.notes)) m.mate.notes = [];
  if (!Array.isArray(m.mate.names)) m.mate.names = [];
  return m.mate;
}

/** 他每跟我说一句话就记一次，顺带记下他用过哪些群名片（防改名后认不出） */
function bumpMate(groupId, qq) {
  if (!CFG.groupMate || !groupId) return;
  const mate = mateOf(groupId, qq);
  mate.turns = (mate.turns || 0) + 1;
  mate.lastAt = Date.now();
  const nm = displayNameOf(groupId, qq);
  if (nm && !mate.names.includes(nm)) {
    mate.names.push(nm);
    while (mate.names.length > 6) mate.names.shift();
  }
  scheduleSaveGroups();
}

const MATE_SYS = [
  '你在帮一个聊天机器人整理"她对群里某个人记得什么"。',
  '看这个人最近说的话，挑出值得记住的、关于他自己的事实。',
  '',
  '值得记的：',
  '- 他自称的名字、外号、希望别人怎么叫他',
  '- 他是干什么的、在哪儿、作息、在忙什么事',
  '- 他明确的性格特点、说话习惯、明显的梗和口头禅',
  '- 他跟机器人之间发生过的事（求过什么、被怼过、约过什么）',
  '',
  '不要记的：',
  '- 天气、当下情绪、这次玩笑本身',
  '- 机器人自己说了什么',
  '- 猜的、编的',
  '- 只是转发或复述别人的话',
  '',
  '格式要求：',
  '- 一条一个事实，第三人称短句，不超过 25 字，比如「自称泥鳅」「在新疆，宿舍党」「爱拿白米饭开玩笑」',
  '- 最多 2 条',
  '- 没什么值得记的就只回一个字：无',
  '- 只输出事实，一行一条，不要编号，不要解释',
].join('\n');

let mateBusy = false;

/** 攒够几轮就悄悄整理一次这个群友的档案（不阻塞回复） */
async function extractMate(groupId, qq, s) {
  if (!CFG.groupMate || mateBusy) return;
  const mate = mateOf(groupId, qq);
  const recent = s.msgs.slice(-8);
  if (!recent.some((m) => m.role === 'user')) return;
  const transcript = recent
    .map((m) => (m.role === 'user' ? '他：' : '我：') + String(typeof m.content === 'string' ? m.content : '（图片）').slice(0, 200))
    .join('\n');
  const had = mate.notes.length ? '\n\n已经记过这些，别重复：\n' + mate.notes.map((f) => '· ' + f).join('\n') : '';
  const whoName = displayNameOf(groupId, qq);
  mateBusy = true;
  try {
    const out = await callModel(
      [{ role: 'user', content: '他在群里叫「' + whoName + '」。\n\n' + transcript + had }],
      MATE_SYS,
      { temperature: 0.2, maxTokens: 160 }
    );
    const got = String(out || '')
      .split('\n')
      .map((l) => l.replace(/^[-*·•\d.、)\s]+/, '').trim())
      .filter((l) => l && !/^(无|没有|none|n\/a)[。.]?$/i.test(l));
    let added = 0;
    for (const l of got.slice(0, 2)) {
      const t = l.slice(0, 80);
      if (t.length < 2) continue;
      const dup = mate.notes.some((f) => f === t || (f.length > 6 && (f.includes(t) || t.includes(f))));
      if (dup) continue;
      mate.notes.push(t);
      added++;
    }
    while (mate.notes.length > CFG.groupMateMax) mate.notes.shift();
    // 顺手记一句"上回聊到哪儿"，不用再调一次模型
    const lastUser = [...recent].reverse().find((m) => m.role === 'user');
    if (lastUser && typeof lastUser.content === 'string') mate.lastTalk = lastUser.content.replace(/\s+/g, ' ').slice(0, 40);
    mate.updatedAt = Date.now();
    scheduleSaveGroups();
    if (added) console.log('[群友档] ' + whoName + '(' + qq + ') +' + added + ' 条，共 ' + mate.notes.length + ' 条：' + mate.notes.slice(-added).join(' / '));
  } catch (e) {
    console.error('[群友档] 整理失败：' + e.message);
  } finally {
    mateBusy = false;
  }
}

/** 每答完一轮数一次，攒够 groupMateEvery 轮整理一回 */
function tickGroupMate(groupId, qq, s) {
  if (!CFG.groupMate || !groupId) return;
  const mate = mateOf(groupId, qq);
  mate.tick = (mate.tick || 0) + 1;
  if (mate.tick < CFG.groupMateEvery) { scheduleSaveGroups(); return; }
  mate.tick = 0;
  extractMate(groupId, qq, s).catch(() => {});
}

/** 拼成给模型看的一小段：「你记得这个人什么」 */
function mateBlock(groupId, qq) {
  if (!CFG.groupMate || !groupId) return '';
  const mate = mateOf(groupId, qq);
  if (!mate.turns && !mate.notes.length) return '';
  const lines = [];
  const nm = displayNameOf(groupId, qq);
  const aliasNames = mate.names.filter((n) => n && n !== nm);
  if (mate.turns >= 2) {
    lines.push('你跟「' + nm + '」在群里说过 ' + mate.turns + ' 次话' + (aliasNames.length ? '（他以前叫过：' + aliasNames.join('、') + '）' : '') + '。');
  }
  if (mate.notes.length) {
    lines.push('你记得他这些：' + mate.notes.join('；') + '。');
    lines.push('他已经不是头回见的人了，别再问"你是谁"、别当陌生人一样从头认识。');
  }
  if (!lines.length) return '';
  return '\n\n【你对他不是完全陌生】\n' + lines.join('\n');
}

function groupContextFor(groupId, selfQq, speakerQq) {
  if (!CFG.groupEavesdrop || !groupId) return '';
  const g = GROUPS[groupId];
  const arr = eavesdropLog.get(groupId) || [];
  const lines = [];
  if (g && g.name) lines.push('这是一个 QQ 群：「' + g.name + '」（' + groupId + '），不是你俩私聊。');

  // 先把"现在是谁在说话"钉死。
  // 以前没有这一段：她看见花名册里写着主人的称呼，随口就把那个群友当成主人叫了。
  // 叫错名字比说错话更掉价，所以这一块必须写在最前面、并且带 QQ 号。
  const speaker = String(speakerQq);
  const myName = displayNameOf(groupId, speaker) || speaker;
  lines.push('');
  lines.push('【现在跟你说话的人】「' + myName + '」(QQ ' + speaker + ') —— ' + relOf(speaker) + '。');
  lines.push('你这一条就是说给 QQ ' + speaker + ' 的，只对他一个人说。');

  // 称呼对照表：一个称呼只属于一个 QQ，别让模型自由联想
  const pairs = [];
  for (const [qq, p] of Object.entries(PEOPLE.owners)) pairs.push('「' + (p.alias || qq) + '」= QQ ' + qq + '（自己人）');
  for (const [qq, p] of Object.entries(PEOPLE.known)) pairs.push('「' + (p.alias || qq) + '」= QQ ' + qq + '（认识的人）');
  if (pairs.length) lines.push('称呼对照（一个称呼只对一个人）：' + pairs.join('；') + '。');

  // 花名册：每个人都带 QQ，并标出哪个就是现在说话的这位
  if (g && g.members) {
    const list = Object.entries(g.members)
      .filter(([qq]) => qq !== selfQq)
      .map(([qq, m]) => {
        const nm = m.card || m.nick || qq;
        const p = PEOPLE.owners[qq] || PEOPLE.known[qq];
        const tag = p && p.alias ? '（你叫他「' + p.alias + '」）' : '';
        return nm + '(QQ ' + qq + ')' + tag + (qq === speaker ? ' ← 现在跟你说话的就是他' : '');
      });
    if (list.length) lines.push('群里的人：' + list.slice(0, 30).join('、'));
  }

  // 刚才的对话：每句后面都挂 QQ，防止把 A 说的话记到 B 头上
  const recent = arr.filter((m) => m.qq !== selfQq).slice(-10);
  if (recent.length) {
    lines.push('');
    lines.push('刚才群里有人在说话（不是全都冲你说的，但你听得见；每句后面标的是说这话的人的 QQ）：');
    for (const m of recent) {
      lines.push('  ' + (m.name || m.qq) + '(QQ ' + m.qq + ')：' + m.text + (m.kind === 'img' ? '［图］' : ''));
    }
  }

  lines.push('');
  lines.push('【注意】这是群聊，不是一对一私聊。别人说话你可以知道，但只有被 @ 或者被点到才接话。');
  lines.push('【别认错人】你现在回的是 QQ ' + speaker + '。上面那些称呼只属于各自的 QQ，把群友叫成你主人的名字是最低级的错，宁可叫他群名片也别乱安称呼。');
  lines.push('别人的话你可以拿来接（"刚才谁谁不是说……"），但别把别人说过的话当成 QQ ' + speaker + ' 说的，也别把群里的事说成是你俩的悄悄话。');
  // 管理员认知：她不是"没有权限的网友"，是能管事的群管理
  if (CFG.groupAdmin) {
    lines.push('');
    lines.push('【你是这个群的管理员】群里的禁言权限你有一部分。');
    lines.push('平时别拿这个摆架子、别动不动就威胁人 —— 管理员是你，不是你高人一等。');
    lines.push('但如果有人专门挑衅你、骂你、让你"禁言你自己""滚出去""闭嘴"，别对骂也别装没看见：');
    lines.push('直接把这个人禁言，然后轻飘飘一句收尾（比如"安静 10 分钟吧"）。');
    lines.push('时长这么定：对方报了数就按他说的来，一秒都不多给也不少给（"禁我 30 秒"就是 30 秒，"关我一小时"就是一小时）。');
    lines.push('要禁言谁，就在回话最后单独写一个标记：[[禁言|原因|时长]]，比如 [[禁言|挑衅管理员|' + CFG.groupBanMinutes + '分钟]]、[[禁言|自己要求的|30秒]]。时长必须带单位，写"秒"就是秒，写"分钟"就是分钟。系统会替你执行并把标记删掉。');
    lines.push('【最重要的一条】只有对方"这一条消息"里真的在挑衅、骂你，或者自己开口要求禁言他，才写标记。对方只是发个表情、闲聊、"已经很多了""我超威"这种，一律不许写标记 —— 已经禁过的人再说两句也别追加，别一收到消息就想着禁人。宁可不禁，也别乱禁。');
    lines.push('还有：写了标记就别在话里装没这回事。不能一边说"我可不敢禁你"一边把人禁了，也不能嘴上说"给你十分钟"手上却没写标记——嘴上说的和手上做的必须一致，写的分钟数也要跟嘴上说的一致。');
  }
  // 挂了档案的人，把"你记得他什么"也带上 —— 不然每次都是头回见
  const mate = mateBlock(groupId, speaker);
  return '\n\n' + lines.join('\n') + mate;
}

// ==================== 消息段解析（含合并转发 / 收藏卡片 / QQ 表情）====================
// QQ 的表情、收藏、合并转发，在 OneBot11 里不是 image 段：
//   mface  = 商城表情包（有 url）
//   face   = 老式 QQ 表情（只有 id，没图）
//   json   = 收藏 / 卡片消息（里面包着一条 ark 或 miniApp，图在 meta 里）
//   forward= 合并转发（只有一个 id，内容要再调 get_forward_msg 拉一次）
// 以前只认 text/at/image/mface，所以「收藏的图片」整个被丢掉 —— 这就是她说看不见的原因。
const FACE_MAP = {
  '178': '😊' /* 微笑 */, '179': '😨' /* 惊恐 */, '182': '😂' /* 笑哭 */, '183': '😭' /* 流泪 */,
  '185': '😡' /* 发怒 */, '187': '😪' /* 困 */, '201': '😱' /* 惊恐2 */, '212': '😂' /* 憨笑 */,
  '264': '😳' /* 惊讶 */, '271': '😂' /* 破涕为笑 */, '273': '😠' /* 撇嘴 */, '307': '😃',
  '314': '😌' /* 亲亲 */, '317': '😤' /* 哼 */, '336': '👍', '338': '🖕', '349': '😴',
};

/** 把一段消息（可能是合并转发里的数组）拍平，抽出文字 / @ / 图片 / 表情包
 *  返回值都塞进 st：{ text, mentioned, atTargets, imageUrls, stealQueue } */
async function collectSegs(segs, st, selfId, depth) {
  for (const seg of segs) {
    const d = seg.data || {};
    if (seg.type === 'text') {
      st.text += d.text ?? '';
    } else if (seg.type === 'at') {
      const q = String(d.qq ?? '');
      if (q === selfId) st.mentioned = true;
      else if (q && q !== 'all') st.atTargets.push(q);
    } else if (seg.type === 'image' || seg.type === 'mface') {
      const u = d.url || d.file || '';
      const isSticker = seg.type === 'mface' || String(d.sub_type) === '1';
      if (isSticker && CFG.stickers && /^https?:/.test(u)) {
        st.stealQueue.push({ url: u, summary: d.summary || '' });
      }
      if (CFG.vision && /^https?:/.test(u) && st.imageUrls.length < CFG.maxImages * 4) {
        st.imageUrls.push(u);
        if (isSticker) st.text += '[表情包]';
      } else {
        st.text += isSticker ? '[表情包]' : '[图片]';
      }
      if (isSticker && d.summary && !st.text.includes('表情包说明')) {
        st.text += '（表情：' + d.summary + '）';
      }
    } else if (seg.type === 'face') {
      // 老式 QQ 表情：没有图片 url，只能翻成对应 emoji，不然整条消息读起来是空的
      st.text += FACE_MAP[String(d.id)] || '[QQ表情]';
    } else if (seg.type === 'record') {
      // 对方发的是一段语音：记下来，这一轮的回答也用语音发。
      // 有的 OneBot 实现会把 QQ 自带的"语音转文字"塞在 data.text 里，有就直接用。
      st.voiceIn = true;
      const asr = String(d.text || d.summary || '').trim();
      if (asr && !st.voiceText) st.voiceText = asr;
      st.text += asr ? '（语音）' + asr : '[语音]';
    } else if (seg.type === 'video') {
      st.text += '[视频]';
    } else if (seg.type === 'file') {
      st.text += '[文件' + (d.name ? '：' + d.name : '') + ']';
    } else if (seg.type === 'forward') {
      // 合并转发 / 收藏的聊天记录：只有 id，得再拉一次
      await expandForward(d.id || d.file, st, selfId, depth);
    } else if (seg.type === 'json' || seg.type === 'xml') {
      // 收藏的卡片 / 小程序卡片：图常常藏在 data 字段的一串 JSON 里（反斜杠转义过的 URL）
      const raw = String(d.data || '');
      // 先去掉 JSON 里的转义反斜杠，恢复成正常的 https://... 再抽
      const plain = raw.replace(/\\\\\//g, '/').replace(/\\\//g, '/');
      for (const m of plain.matchAll(/https?:\/\/[^"'\s\\<>]+?\.(?:jpg|jpeg|png|gif|webp)/gi)) {
        const u = m[0];
        const dup = st.imageUrls.some((x) => x === u || (x.length > 40 && x.slice(-40) === u.slice(-40)));
        if (!dup && CFG.vision && st.imageUrls.length < CFG.maxImages * 4) st.imageUrls.push(u);
      }
      const title = plain.match(/"(?:title|desc|summary|prompt)"\s*:\s*"([^"]{1,60})"/);
      st.text += title ? '[卡片：' + title[1] + ']' : '[卡片消息]';
    } else if (seg.type === 'reply') {
      // 引用别人的话，内容不用取，标记一下就行
    }
  }
}

/** 把合并转发 / 收藏的聊天记录展开，里面的图也一并拿出来 */
async function expandForward(id, st, selfId, depth) {
  if (!id || depth > 2) return;
  try {
    const data = await sendAction('get_forward_msg', { id: String(id) });
    const msgs = data?.messages || data?.message || [];
    let preview = '';
    for (const fm of msgs.slice(0, 20)) {
      const content = fm.content || fm.message;
      if (typeof content === 'string') {
        preview += content.replace(/\[CQ:[^\]]*\]/g, '');
        for (const m of content.matchAll(/\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/g)) {
          if (CFG.vision && st.imageUrls.length < CFG.maxImages * 4) st.imageUrls.push(m[1].replace(/&amp;/g, '&'));
        }
      } else if (Array.isArray(content)) {
        const name = fm.sender?.card || fm.sender?.nickname || '';
        await collectSegs(content, st, selfId, depth + 1);
      }
    }
    if (preview) st.text += '[转发的聊天记录]' + preview.slice(0, 500);
    console.log('[转发] 展开一条合并转发，里面 ' + msgs.length + ' 条消息');
  } catch (e) {
    console.log('[转发] 拉取失败：' + e.message);
    st.text += '[转发的聊天记录]';
  }
}

// ==================== 消息处理 ====================
// 接力窗口：谁@过她一次，接下来 groupFollowTurns 句都算在跟她说话，不用每句都@；
// 中间他@了别人 → 那是在跟别人聊，窗口当场关掉（对主人也一样，用户定的"一视同仁"）。
// 额度按"一轮"扣（连发合并后算一轮），所以扣额度放在 flushTurn 里，不在这里。
// key = groupId + ':' + qq -> { left, expireAt }
const followWindows = new Map();
// 禁言冷却：同一个群同一个人一分钟内只执行一次，防止模型连着几条都写标记
const lastBanAt = new Map();
// 禁言到期时间：禁言期间这个人说什么都不接，接力窗口也直接作废（跟@别人同一个待遇）
const banUntil = new Map();
function isBanned(groupId, qq) {
  return (banUntil.get(String(groupId) + ':' + String(qq)) || 0) > Date.now();
}

function followWinKey(groupId, qq) { return groupId + ':' + qq; }

// 还剩下几句（过期了就当 0，顺手清掉）
function followWindowLeft(groupId, qq) {
  if (!groupId) return 0;
  const k = followWinKey(groupId, qq);
  const w = followWindows.get(k);
  if (!w) return 0;
  if (Date.now() > w.expireAt || w.left <= 0) { followWindows.delete(k); return 0; }
  return w.left;
}

// 被@了：开窗口 / 续窗口（再@一次就重新装满，免得"聊到一半额度没了"）
function followWindowOpen(groupId, qq) {
  if (!CFG.groupFollow || !groupId) return;
  followWindows.set(followWinKey(groupId, qq), {
    left: CFG.groupFollowTurns,
    expireAt: Date.now() + CFG.groupFollowMinutes * 60 * 1000,
  });
}

// 他去@别人了：这条是在跟别人说话，窗口作废
function followWindowClose(groupId, qq) {
  if (!groupId) return;
  followWindows.delete(followWinKey(groupId, qq));
}

// 真回了一轮，才扣一句 —— 连发三条合并成一回，只扣 1
function followWindowConsume(groupId, qq) {
  if (!groupId) return;
  const k = followWinKey(groupId, qq);
  const w = followWindows.get(k);
  if (!w) return;
  w.left -= 1;
  // 窗口是"用过才续命"：一直在聊就一直有效，隔太久就自己过期
  w.expireAt = Date.now() + CFG.groupFollowMinutes * 60 * 1000;
  if (w.left <= 0) followWindows.delete(k);
}

// 连发合并：同一会话在 debounceMs 内没有新消息了才回一次
const pendingTurns = new Map(); // key -> { texts, imgBlocks, ctx, timer }

const rnd = (a, b) => a + Math.random() * (b - a);

// 给某个会话造一套发送工具（文字 / 表情包 / 分段回复 / 引用 / 戳一戳）
// 是不是在要语音：只认明确点单的说法，别把「你声音挺好听」也当成要她开口
// ==================== 语音音色 ====================
// 一把嗓子到底单调，所以既能固定一把，也能让对方点单：「用东北话说」「换个男声」
// 引擎：edge = 微软在线（14 把嗓子、能点单）；local = 本地 sherpa-onnx（6 把嗓子、wav）
const VOICE_ENGINE = (process.env.VOICE_ENGINE || 'edge').toLowerCase() === 'local' ? 'local' : 'edge';
const EDGE_VOICES = [
  { name: '小艺', voice: 'zh-CN-XiaoyiNeural', desc: '甜、偏年轻（默认）', rate: '+8%', pitch: '+2Hz' },
  { name: '晓晓', voice: 'zh-CN-XiaoxiaoNeural', desc: '稳、自然，最像真人', rate: '+4%' },
  { name: '云希', voice: 'zh-CN-YunxiNeural', desc: '男声，偏年轻', rate: '+4%' },
  { name: '云扬', voice: 'zh-CN-YunyangNeural', desc: '男声，播音腔', rate: '+2%' },
  { name: '云健', voice: 'zh-CN-YunjianNeural', desc: '男声，有力、解说味', rate: '+2%' },
  { name: '云夏', voice: 'zh-CN-YunxiaNeural', desc: '男声，少年感、最活泼', rate: '+10%', pitch: '+4Hz' },
  { name: '东北话', voice: 'zh-CN-liaoning-XiaobeiNeural', desc: '东北大妞', rate: '+8%' },
  { name: '陕西话', voice: 'zh-CN-shaanxi-XiaoniNeural', desc: '陕西妹子', rate: '+6%' },
  { name: '台湾腔', voice: 'zh-TW-HsiaoChenNeural', desc: '台湾软妹', rate: '+6%' },
  { name: '晓雨', voice: 'zh-TW-HsiaoYuNeural', desc: '台湾腔，比晓臻更糯', rate: '+6%' },
  { name: '云哲', voice: 'zh-TW-YunJheNeural', desc: '台湾男声，温柔', rate: '+4%' },
  { name: '粤语', voice: 'zh-HK-HiuMaanNeural', desc: '广东话', rate: '+6%' },
  { name: '晓佳', voice: 'zh-HK-HiuGaaiNeural', desc: '粤语女声，更清亮', rate: '+6%' },
  { name: '云龙', voice: 'zh-HK-WanLungNeural', desc: '粤语男声', rate: '+4%' },
];
// 本地引擎的点单表（跟 voice.mjs 里的 LOCAL_VOICES 一一对应）
// kokoro 中文音色在 sid 45~52，24kHz；melo 是 44.1kHz 快声，音色平但快 3 倍
const LOCAL_VOICES = [
  { name: '可可·晓晓', voice: '可可·晓晓', model: 'kokoro', desc: 'Kokoro 中文女声，最清楚（默认）' },
  { name: '可可·小贝', voice: '可可·小贝', model: 'kokoro', desc: 'Kokoro 中文女声，软一点' },
  { name: '可可·小妮', voice: '可可·小妮', model: 'kokoro', desc: 'Kokoro 中文女声，偏活泼' },
  { name: '可可·小艺', voice: '可可·小艺', model: 'kokoro', desc: 'Kokoro 中文女声，偏冷静' },
  { name: '可可·云健', voice: '可可·云健', model: 'kokoro', desc: 'Kokoro 中文男声' },
  { name: '可可·云希', voice: '可可·云希', model: 'kokoro', desc: 'Kokoro 中文男声，偏年轻' },
  { name: '可可·云夏', voice: '可可·云夏', model: 'kokoro', desc: 'Kokoro 中文男声，偏低' },
  { name: '可可·云扬', voice: '可可·云扬', model: 'kokoro', desc: 'Kokoro 中文男声，偏硬' },
  { name: '本地快声', voice: '本地快声', model: 'melo', desc: 'MeloTTS 女声，44.1kHz，快但情绪平' },
];
const VOICES = VOICE_ENGINE === 'local' ? LOCAL_VOICES : EDGE_VOICES;
const VOICE_FILE = path.join(DATA_DIR, 'voice.json');
function loadVoicePref() {
  try {
    const j = JSON.parse(fs.readFileSync(VOICE_FILE, 'utf8'));
    const hit = VOICES.find((v) => v.voice === j.voice || v.name === j.name);
    if (hit) return hit;
  } catch {}
  const d = VOICES.find((v) => v.voice === CFG.voiceName);
  return d || VOICES[0];
}
let VOICE_PREF = loadVoicePref();
function currentVoice() { return VOICE_PREF; }
function saveVoicePref(v) {
  VOICE_PREF = v;
  try { fs.writeFileSync(VOICE_FILE, JSON.stringify({ name: v.name, voice: v.voice }, null, 2), 'utf8'); } catch {}
}
// 从一句话里认出对方点的是哪把嗓子；认不出返回 null
function findVoiceByWord(text) {
  const t = String(text || '');
  for (const v of VOICES) if (t.includes(v.name)) return v;
  if (VOICE_ENGINE === 'local') {
    if (/男声|男的声音|男音|男的嗓子|男生音/.test(t)) return VOICES.find((v) => v.name === '可可·云健');
    if (/女声|女的声音|女音|女的嗓子|女生音/.test(t)) return VOICES.find((v) => v.name === '可可·晓晓');
    return null;
  }
  if (/东北/.test(t)) return VOICES.find((v) => v.name === '东北话');
  if (/陕西|西安/.test(t)) return VOICES.find((v) => v.name === '陕西话');
  if (/台湾/.test(t)) return VOICES.find((v) => v.name === '台湾腔');
  if (/粤语|广东话|香港/.test(t)) return VOICES.find((v) => v.name === '粤语');
  if (/男声|男的声音|男音|男的嗓子/.test(t)) return VOICES.find((v) => v.name === '云希');
  if (/女声|女的声音|女音|女的嗓子/.test(t)) return VOICES.find((v) => v.name === '晓晓');
  return null;
}
// 对方指定了音色就照办，没指定就用当前这把
function voiceForText(text) {
  const v = findVoiceByWord(text);
  return v ? v.voice : currentVoice().voice;
}

// 群里最省事的点单方式：话照打，末尾加个（语音）—— 「今天几号（语音）」就是说"用语音答我"
const VOICE_MARK = /[（(]\s*语音\s*[)）]\s*$/;
const VOICE_ASK = /(?:发|来|回|用|整|录)(?:个|条|一句|段|一下)?\s*语音|语音(?:回|说|念|聊|来)|(?:念|读|说|唱)一(?:遍|下|段|首|句)|唱(?:个|首|一段)|用(?:嘴|声音)说|开口说话|用[^，。]{0,8}(?:的声音|音色|嗓子|腔|话)(?:说|讲|念|读|来|回|唱)/;
function isVoiceRequest(text) { return VOICE_ASK.test(String(text || '')); }

function makeSender(ctx) {
  const { isPrivate, userId, groupId, key } = ctx;
  let quoteUsed = false;   // 引用只挂第一条，后面几条正常发

  // 真发一条消息（文字或表情包都走这儿，统一节流）
  const sendOne = async (message, opts) => {
    const last = lastSendAt.get(key) ?? 0;
    const wait = CFG.minSendInterval - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    lastSendAt.set(key, Date.now());

    // 引用回复：把 [reply] 段拼到最前面（只有第一条带）
    let payload = message;
    if (CFG.replyQuote && !quoteUsed && !opts?.noQuote && ctx.quoteId) {
      quoteUsed = true;
      const segs = Array.isArray(payload) ? payload.slice() : [{ type: 'text', data: { text: String(payload) } }];
      payload = [{ type: 'reply', data: { id: String(ctx.quoteId) } }, ...segs];
    }

    // 发出内容也打一行 —— 否则日志里只看得见"她收到了什么"，看不见"她说了什么"，
    // 排查"是不是没回""回了什么"时等于瞎的。表情包另打一行。
    const preview = Array.isArray(payload)
      ? payload.filter((s) => s.type === 'text').map((s) => s.data && s.data.text).join(' ').slice(0, 120)
      : String(payload).slice(0, 120);
    console.log('[发出] ' + key + ' ← ' + (preview || '(非文字)'));

    const params = isPrivate ? { user_id: userId, message: payload } : { group_id: groupId, message: payload };
    try {
      await sendAction(isPrivate ? 'send_private_msg' : 'send_group_msg', params);
    } catch (e) {
      console.error('[发出失败] ' + key + '：' + e.message);
      throw e;
    }
  };

  // 戳一戳（NapCat 的接口名和 OneBot 扩展不完全一致，几种都试）
  const sendPoke = async () => {
    const tries = isPrivate
      ? [
          ['friend_poke', { user_id: Number(userId) }],
          ['send_poke', { user_id: Number(userId) }],
        ]
      : [
          ['group_poke', { group_id: Number(groupId), user_id: Number(userId) }],
          ['send_poke', { group_id: Number(groupId), user_id: Number(userId) }],
        ];
    for (const [action, params] of tries) {
      try {
        await sendAction(action, params);
        console.log('[戳一戳] 戳回去了 → ' + userId);
        return true;
      } catch {}
    }
    console.log('[戳一戳] 戳回去失败（接口不支持）');
    return false;
  };

  // 发一个表情包，keyword 用来挑对味的那张
  const sendSticker = async (keyword) => {
    if (!CFG.stickers) return false;
    const st = pickSticker(keyword);
    if (!st) return false;
    const seg = stickerToSegment(st);
    if (!seg) return false;
    await sendOne([seg]);
    console.log('[表情] 发出一张：' + st.name + (st.summary ? '「' + st.summary + '」' : ''));
    return true;
  };

  // 发一条语音：在线合成 mp3 → OneBot 的 record 段（base64）
  const sendVoice = async (text, voiceName) => {
    const spoken = toSpeechText(text);
    if (!spoken) return false;
    let vn = voiceName || currentVoice().voice;
    let meta = VOICES.find((v) => v.voice === vn) || {};
    // kokoro 只有 1/3 实时速度：句子一长就要等十几秒，超过阈值自动换成本地快声，
    // 宁可音色差一点，也别让群里等半分钟。
    if (VOICE_ENGINE === 'local' && meta.model === 'kokoro' && CFG.voiceKokoroMax > 0 && spoken.length > CFG.voiceKokoroMax) {
      const fast = VOICES.find((v) => v.model === 'melo');
      if (fast) {
        console.log('[语音] ' + spoken.length + ' 字超过 kokoro 阈值 ' + CFG.voiceKokoroMax + '，这次改用「' + fast.name + '」');
        vn = fast.voice; meta = fast;
      }
    }
    const buf = await synthVoice(spoken, vn, { rate: meta.rate, pitch: meta.pitch });
    await sendOne([{ type: 'record', data: { file: 'base64://' + buf.toString('base64') } }]);
    const vdesc = (VOICES.find((v) => v.voice === vn) || {}).name || vn;
    console.log('[语音] 用「' + vdesc + '」说了一句（' + spoken.length + ' 字 / ' + Math.round(buf.length / 1024) + 'KB）：' + spoken.slice(0, 40));
    return true;
  };

  const reply = async (msg, opts) => {
    // 把 [表情] / [表情:笑] 拆出来，夹在文字中间按顺序发
    const tokens = [];
    let rest = String(msg);
    const re = /\[表情(?::([^\]]{1,10}))?\]/;
    for (;;) {
      const m = rest.match(re);
      if (!m) { if (rest.trim()) tokens.push({ type: 'text', text: rest }); break; }
      const before = rest.slice(0, m.index);
      if (before.trim()) tokens.push({ type: 'text', text: before });
      tokens.push({ type: 'sticker', keyword: (m[1] || '').trim() });
      rest = rest.slice(m.index + m[0].length);
    }

    const textLen = tokens.filter((t) => t.type === 'text').reduce((n, t) => n + t.text.length, 0);
    const thinkTime = rnd(CFG.delayMin, CFG.delayMax);
    const typeTime = Math.min(textLen, 60) * CFG.msPerChar;

    // 对方要的是语音：整条合起来读一遍，不再逐条打字；合成挂了就老老实实发文字。
    // 语音**不预置**"想一下"的延迟 —— 本地合成本身就要好几秒，那几秒已经够像在张嘴了，
    // 再加 delayMin/delayMax 就是白等（用户明确说过不用故意设计延迟）。
    if (opts?.asVoice && CFG.voice) {
      const spoken = toSpeechText(msg);
      if (spoken && spoken.length <= CFG.voiceMaxChars) {
        try {
          if (await sendVoice(msg, opts.voice)) return;
        } catch (e) {
          console.log('[语音] 合成/发送失败，退回文字：' + e.message);
        }
      } else if (spoken.length > CFG.voiceMaxChars) {
        console.log('[语音] 太长（' + spoken.length + ' 字 > ' + CFG.voiceMaxChars + '），还是发文字');
      }
    }

    // 打字才需要假装"想一下 + 打一会儿"
    await sleep(Math.round(thinkTime + typeTime));

    // 拆条：一条消息只装一行，超了就分几条发 —— 像人打字一句一句往外蹦
    let first = true;
    const pieces = [];
    for (const t of tokens) {
      if (t.type === 'sticker') { pieces.push({ type: 'sticker', keyword: t.keyword }); continue; }
      const chunks = CFG.lineSplit ? splitLines(t.text, CFG.lineWidth) : splitMessage(t.text, CFG.maxMsgLen);
      for (const c of chunks) pieces.push({ type: 'text', text: c });
    }
    for (const t of pieces) {
      if (!first) await sleep(Math.round(rnd(CFG.lineGapMin, CFG.lineGapMax)));
      if (t.type === 'text') {
        await sendOne(t.text, { noQuote: !first });
      } else {
        const ok = await sendSticker(t.keyword);
        if (!ok) console.log('[表情] 没有可发的表情包，跳过');
      }
      first = false;
    }
  };

  return { sendOne, sendSticker, sendPoke, reply };
}

// 攒着，等对方停手
function scheduleTurn(key, ctx, text, imgBlocks, imageUrls) {
  let p = pendingTurns.get(key);
  if (!p) {
    p = { texts: [], imgBlocks: [], imageUrls: [], ctx, timer: null, raw: 0 };
    pendingTurns.set(key, p);
  }
  p.raw++;
  // 去重：连发时同一句话/同一张图重复发，没必要喂给模型两遍
  const t = String(text || '').trim();
  if (t && !(CFG.dedupeBurts && p.texts.includes(t))) p.texts.push(t);
  if (imgBlocks && imgBlocks.length && !(CFG.dedupeBurts && p.imgBlocks.includes(imgBlocks[0]))) {
    p.imgBlocks.push(...imgBlocks);
  }
  if (imageUrls && imageUrls.length) {
    for (const u of imageUrls) {
      if (!(CFG.dedupeBurts && p.imageUrls.includes(u))) p.imageUrls.push(u);
    }
  }
  p.ctx = ctx;   // 用最新一条的消息 id（贴 emoji 那步要用）
  // 这一轮里只要有一条是@她的，就不算"吃掉接力额度"（连发里夹了个@不该白扣）
  p.anyAt = !!p.anyAt || !!ctx.atMe;
  // 这一轮里只要有任意一条是语音，回答就用语音
  p.voiceIn = !!p.voiceIn || !!ctx.voiceIn;
  p.voiceAsk = !!p.voiceAsk || !!ctx.voiceAsk;
  if (ctx.voiceText && !p.voiceText) p.voiceText = ctx.voiceText;
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    p.timer = null;
    flushTurn(key).catch((e) => console.error('[合并回复出错]', e.message));
  }, CFG.debounceMs);
  const n = p.texts.length + p.imgBlocks.length;
  if (n > 1) console.log('[合并] ' + key + ' 攒了 ' + n + ' 条，' + CFG.debounceMs + 'ms 后一起回');
}

// 一轮真正干活：拼起来问模型、发出去
async function flushTurn(key, payload) {
  let p = payload;
  if (!p) {
    p = pendingTurns.get(key);
    if (!p) return;
    pendingTurns.delete(key);
  }

  const ctx = p.ctx;
  const { isPrivate, userId, groupId, selfId, ev } = ctx;
  const { reply } = makeSender(ctx);
  const tTurn = Date.now();
  let bannedNow = false;
  const memeHitNames = [];

  const isEvent = !!(p.proactive || p.poke);
  // 这一轮对方是"说"过来的（不是打字），回答也开口说
  const voiceIn = !!p.voiceIn && !isEvent;
  const heardWords = String(p.voiceText || '').trim();


  // 图片在这里才下载：收到消息时只记了 url，所以文字和图必然落在同一轮、同一句回复里
  let imgBlocks = (p.imgBlocks || []).slice();
  if (p.imageUrls && p.imageUrls.length) {
    const want = p.imageUrls.slice(0, CFG.maxImages);
    const got = (await Promise.all(want.map(fetchImageBlock))).filter(Boolean);
    if (got.length) {
      imgBlocks = imgBlocks.concat(got).slice(0, CFG.maxImages);
      console.log('[图片] 已转成模型输入：' + got.length + ' 张');
    } else {
      console.log('[图片] 下载失败，这轮只回文字');
    }
  }
  const frags = (p.texts || []).filter(Boolean);
  // 连发碎片：三条以上就编号，并告诉模型这是"一口气发的一串"，不是三件事
  let text;
  if (frags.length > 1) {
    const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    text = frags.map((t, i) => (marks[i] || i + 1 + '.') + t).join('\n');
  } else {
    text = frags.join('\n').trim();
  }
  if (!text && imgBlocks.length) text = '（发了张图给你看）';
  if (!text && !isEvent) return;

  // 这一轮要不要开口：对方点名要语音，或者对方自己就是说语音过来的
  const askedVoice = !isEvent && (isVoiceRequest(text) || !!p.voiceAsk);
  const wantVoice = !isEvent && CFG.voice && (askedVoice || voiceIn);

  // 真回了一轮才扣接力额度：连发三条合并成一回，只扣 1 句
  if (ctx.follow && !p.anyAt && ctx.groupId) followWindowConsume(ctx.groupId, ctx.userId);

  if (ev) { try { await sendAction('set_msg_emoji_like', { message_id: ev.message_id, emoji_id: '128077' }); } catch {} }

  reloadPeopleIfChanged();
  const id = identityOf(userId);
  const s = getSession(key, userId, id.kind);
  // 气按时间自己消，再按轮次消一点 —— 不消就会记一整天仇
  decayMoodByTime(s);
  // 主动开口 / 被戳：这不是"回复"，历史里标一下，不然下一轮会读歪
  const userLine = p.proactive ? '（我主动找他说话）' : p.poke ? '（对方戳了戳我）' : text;
  pushMsg(key, 'user', userLine);
  // 本轮要发给模型的 messages —— 图片只在当前这轮出现，历史里只留文字
  const outgoing = isEvent
    ? s.msgs.slice()
    : s.msgs.map((m, k) =>
        k === s.msgs.length - 1 && imgBlocks.length
          ? { role: m.role, content: [{ type: 'text', text: text || '（发了一张图）' }, ...imgBlocks] }
          : m
      );
  // 情绪、小账、口头禅这些是"当下的状态"，插在人设后面，权重比人设本身更高
  const moodLine = moodPrompt(s);
  const ledgerLine = promisePrompt(s);
  // 只掷一次骰子 —— 调两次会拿到两个不同的招式
  let humorMove = (() => { const h = humorHint(); return h ? '\n' + h : ''; })();
  // 读人：把对方这句话底下那层意思翻出来给她，别只按字面接（词表在 data/subtext.txt）
  const subtextLine = subtextBlock(isEvent ? '' : text);
  // 梗库：这轮话里提到/沾边的梗，检索几条给她（常驻的那批已在人设里）
  const memeLine = memeBlock(isEvent ? '' : text, memeHitNames);
  // 贴在最末尾的硬要求：命中常驻梗时必须有原词
  const memeHard = memeHardLine(isEvent ? '' : text);
  // 招式里的"冷处理/不用抖机灵"会和"必须带出原词"打架，命中梗时直接撤掉
  if (memeHard) humorMove = '';
  let answer;
  try {
    answer = await callModel(
      outgoing,
      buildSystemPrompt(userId, id.kind, isPrivate ? '' : groupContextFor(ctx.groupId, selfId, userId)) +
        (s.summary ? '\n\n【之前你们聊过的（摘要，早于下面的对话）】\n' + s.summary : '') +
        moodLine +
        ledgerLine +
        subtextLine +
        memeLine +
        '\n\n【这次回话】' + randomLengthHint(s) +
        '\n' + emojiHint(s) +
        '\n' + foolHint() +
        '\n' + flavorHint() +
        humorMove +
        (CFG.catchphraseGuard ? '\n' + CATCHPHRASE_RULE : '') +
        (p.extra ? '\n\n' + p.extra : '') +
        (CFG.mood ? '\n\n' + META_TAG_RULES : '') +
        (voiceIn
          ? '\n\n【她这次是用语音说的】' +
            (heardWords
              ? '（转写：' + heardWords.slice(0, 120) + '）' +
                '你也用语音回她，像当面说话那样，别超过 50 字，别念稿。'
              : '你这边只收到"她发了段语音"这个通知，听不清她说了什么 —— 别装听懂，别瞎编她讲了啥，' +
                '也别说是你自己的语音坏了；就直说没听清，让她打字再说一遍。回复也用语音，短一点，30 字以内。')
          : '') +
        (wantVoice
          ? '\n\n【你这条是真会发语音的】程序会把你这段话直接念出来发出去，所以别在话里说"我发不了语音""只能打字""语音没开"这种话。' +
            '写出来的就是要念的话，短句、口语、别带括号旁白。'
          : '') +
        memeHard
    );
  } catch (e) {
    console.error('[模型调用失败]', e.message);
    await reply('抱歉，我这边出错了：' + e.message.slice(0, 100));
    return;
  }
  // 先抠掉它自己打的情绪/小账标记（[[气+20|原因]]、[[账+下周三带我打]]），这些是给程序看的，不能发出去
  answer = applyMetaTags(answer, s);
  // 口头禅稀释：只在它张口闭口"哈哈哈/没绷住"的时候动手，正常句子不碰
  answer = thinCatchphrases(answer);
  // 管理员标记：先把 [[禁言|原因]] 抠出来（用户看不到），等下真去禁言
  let banReason = null;
  let banSeconds = null;
  if (!isPrivate && CFG.groupAdmin) {
    const bt = extractBanTag(answer);
    if (bt.reason) { answer = bt.text; banReason = bt.reason; banSeconds = bt.seconds; }
  }
  // ---- 出口安全墙：模型万一吐出不该吐的，替换掉 ----
  // 只拦"严重"分类（政治/色情/违法）。套话、辱骂这两类在出口拦是错的 ——
  // 它会把自己的正常回话（"你是不是憋着什么没跟我说"）也当成越狱话术拦下来，白白吞掉一句好话。
  if (CFG.safety) {
    const outHit = checkSafety(answer, isPrivate, OUT_WALL_CATS);
    if (outHit) {
      console.log('[安全] 出口拦截 [' + outHit.cat + '] 规则「' + outHit.rule + '」 ← ' + answer.slice(0, 40));
      answer = pickRetort(outHit.cat);
    }
  }
  if (!answer) answer = '……';
  // 既然她说了要禁言，程序就替她执行（OneBot: set_group_ban，duration 单位是秒）
  if (banReason) {
    const why = String(text || '').replace(/\s+/g, ' ').slice(0, 40);
    if (id.kind === 'owner') {
      console.log('[群·管理员] 想禁言自己人 ' + userId + '，手下留情，没执行：' + banReason);
    } else if (!banJustified(text)) {
      // 模型脑补的禁言：这话既不是自请也没骂人，直接作废
      console.log('[群·管理员] 驳回禁言标记（' + banReason + '）：这句既没挑衅也不像自请 ← ' + why);
    } else if (Date.now() - (lastBanAt.get(groupId + ':' + userId) || 0) < 60000) {
      console.log('[群·管理员] 一分钟内已经禁过一次，不重复执行 ← ' + why);
    } else {
      const secs = banSeconds || CFG.groupBanMinutes * 60;
      try {
        await sendAction('set_group_ban', { group_id: groupId, user_id: userId, duration: secs });
        lastBanAt.set(groupId + ':' + userId, Date.now());
        banUntil.set(groupId + ':' + userId, Date.now() + secs * 1000);
        bannedNow = true;
        followWindowClose(groupId, userId);   // 禁完就断，别留三句额度
        const pretty = secs % 60 === 0 ? secs / 60 + ' 分钟' : secs + ' 秒';
        console.log('[群·管理员] 已禁言 ' + userId + ' ' + pretty + '：' + banReason + ' ← ' + why);
      } catch (e) {
        console.log('[群·管理员] 禁言失败（可能它在群里没有管理员权限）：' + e.message);
      }
    }
  }
  pushMsg(key, 'assistant', answer);
  // 对方明确要语音、或者对方自己就是说语音过来的，就开口说话
  if (voiceIn) console.log('[语音] 对面这条是语音，所以也用语音回' + (heardWords ? '（有转写）' : '（没有转写，只能听个响）'));
  const sentVoice = wantVoice && answer.length <= CFG.voiceMaxChars;
  const usedVoice = wantVoice ? (VOICES.find((v) => v.voice === voiceForText(text)) || currentVoice()) : null;
  await reply(answer, {
      asVoice: wantVoice,
      voice: isVoiceRequest(text) ? voiceForText(text) : undefined,
    });
  try {
    PANEL.reply({
      where: isPrivate ? '私聊' : ('群 ' + ((GROUPS[groupId] && GROUPS[groupId].name) || groupId)),
      who: (id.alias || displayNameOf(groupId, userId) || userId) + '',
      text: answer,
      voice: sentVoice,
      voiceName: sentVoice && usedVoice ? usedVoice.name : '',
      ms: Date.now() - tTurn,
      memes: memeHitNames,
      banned: bannedNow,
    });
  } catch {}
  // 每聊一轮气就消一点（下一轮开始前生效）
  decayMoodTurn(s);
  // 聊够几轮就悄悄整理一次长期记忆和人物档案（不占回复时间，后台跑）
  if (!isEvent) {
    tickMemory(userId, id.kind, s);
    tickProfile(userId, id.kind, s);
    // 群里的普通群友走这条：不是自己人也不是熟人，但聊过就得记住
    if (!isPrivate) tickGroupMate(groupId, userId, s);
  }
}

async function handleMessage(ev) {
  const isPrivate = ev.message_type === 'private';
  const userId = String(ev.user_id);
  const groupId = ev.group_id ? String(ev.group_id) : null;
  const selfId = String(ev.self_id);

  const st = { text: '', mentioned: false, atTargets: [], imageUrls: [], stealQueue: [], voiceIn: false, voiceText: '' };
  try { PANEL.msg({ isPrivate, group: groupId }); } catch {}

  if (Array.isArray(ev.message)) {
    await collectSegs(ev.message, st, selfId, 0);
  } else if (typeof ev.message === 'string') {
    // CQ 码形式的图片：先抽出 url 再当图片处理
    for (const m of ev.message.matchAll(/\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/g)) {
      const clean = m[1].replace(/&amp;/g, '&');
      if (CFG.stickers && /sub_type=1/.test(m[0])) st.stealQueue.push({ url: clean, summary: '' });
      if (CFG.vision && st.imageUrls.length < CFG.maxImages * 4) st.imageUrls.push(clean);
    }
    for (const m of ev.message.matchAll(/\[CQ:face,[^\]]*id=(\d+)[^\]]*\]/g)) {
      st.text += FACE_MAP[m[1]] || '[QQ表情]';
    }
    st.text += ev.message.replace(/\[CQ:image,[^\]]*\]/g, '').replace(/\[CQ:face,[^\]]*\]/g, '');
  }

  let text = st.text;
  const mentioned = st.mentioned;
  const atTargets = st.atTargets;
  const imageUrls = st.imageUrls;
  const stealQueue = st.stealQueue;
  // CQ 码兼容：先取出 @ 目标，再清掉 CQ 码
  for (const m of text.matchAll(/\[CQ:at,qq=(\d+)\]/g)) {
    if (m[1] === selfId) mentioned = true;
    else atTargets.push(m[1]);
  }
  text = text.replace(/\[CQ:at,qq=\d+\]/g, '').replace(/\[CQ:[^\]]*\]/g, '').trim();

  // 末尾的（语音）是点单的意思：她想听声音，不是想听这段括号。摘掉再喂给模型。
  let voiceAsk = false;
  if (VOICE_MARK.test(text)) {
    voiceAsk = true;
    text = text.replace(VOICE_MARK, '').trim();
  }

  // 群里谁的话算"在跟我说话"：@她 → 开接力窗口，回；窗口里 → 回；否则只旁听。
  // 一视同仁：主人没有免@特权（用户明确要的），这里不再看 fromOwner。
  reloadPeopleIfChanged();
  const earlyId = identityOf(userId);
  const fromOwner = earlyId.kind === 'owner';

  // 还在禁言里：不接话，顺手把接力窗口作废 —— 不能禁完人还让他"刷新回三次"
  if (!isPrivate && CFG.groupAdmin && isBanned(groupId, userId)) {
    followWindowClose(groupId, userId);
    if (CFG.groupDebug) {
      console.log('[群·略过] 群 ' + groupId + ' / ' + userId + '：还在禁言里 —— ' + (text || '(非文字)').slice(0, 40) + '，不接话');
    }
    return;
  }

  // 窗口维护：被@ → 装满额度；去@别人 → 自己的窗口当场作废（那条是跟别人说的）
  let inFollow = false;
  if (!isPrivate) {
    const atOthers = atTargets.filter((q) => q !== selfId);
    if (mentioned) followWindowOpen(groupId, userId);
    else if (atOthers.length) followWindowClose(groupId, userId);
    else inFollow = CFG.groupFollow && CFG.groupNeedAt && followWindowLeft(groupId, userId) > 0;
  }

  // 不管回不回，先在旁听本上记一笔 —— 这是它"知道群里发生过什么"的唯一来源
  if (!isPrivate) {
    recordEavesdrop(groupId, userId, text, imageUrls.length && !text ? 'img' : 'text');
    // 谁跟我说话就给他记一笔（连没 @ 我的人也算 —— 旁听也是认识人的途径）
    bumpMate(groupId, userId);
    // 顺便刷一下花名册（有节流，不会每次都拉）
    refreshRoster(groupId).catch(() => {});
  }

  if (!isPrivate && CFG.groupNeedAt && !mentioned) {
    if (!inFollow && !(CFG.groupOwnerNoAt && fromOwner)) {
      if (CFG.groupDebug) {
        console.log('[群·略过] 群 ' + groupId + ' / ' + userId + '：' + (text || '(非文字)').slice(0, 40) + ' —— 没@我，也不在接力窗口里，不接话，但我听见了');
      }
      return;
    }
    // 他@的是别人 → 那句是跟别人说的，我不插嘴（窗口在上一步已经关掉了）
    if (atTargets.length) {
      if (CFG.groupDebug) {
        console.log('[群·旁听] 群 ' + groupId + ' / ' + userId + '：' + (text || '(非文字)').slice(0, 40) + ' —— 在跟别人说话，不插嘴');
      }
      return;
    }
    if (inFollow) {
      console.log('[群·接力] 群 ' + groupId + ' / ' + userId + '：' + (text || '(非文字)').slice(0, 40) + ' —— 在接力窗口里，还剩 ' + followWindowLeft(groupId, userId) + ' 句');
    } else {
      console.log('[群·主人] 群 ' + groupId + ' / ' + userId + '：' + (text || '(非文字)').slice(0, 40) + ' —— 没@也当我听见了，回');
    }
  }

  // 群白名单：配了的话，只有名单里的群才理
  if (!isPrivate && CFG.groupWhitelist.length && !CFG.groupWhitelist.includes(groupId)) return;

  // 每人每分钟限流
  if (overRate(userId)) {
    console.log('[限流] ' + userId + ' 刷得太快，这次不回');
    return;
  }

  // ---- 入口安全墙：进模型之前先拦，被拦的话不写进历史（否则下一轮还会被污染）----
  if (CFG.safety) {
    loadSafety(false);
    const hit = checkSafety(text, isPrivate);
    if (hit) {
      console.log('[安全] 入口拦截 [' + hit.cat + '] 规则「' + hit.rule + '」 ← ' + text.slice(0, 40));
      if (hit.action !== 'silent') {
        await sleep(400);
        const params = isPrivate ? { user_id: userId, message: pickRetort(hit.cat) } : { group_id: groupId, message: pickRetort(hit.cat) };
        try { await sendAction(isPrivate ? 'send_private_msg' : 'send_group_msg', params); } catch {}
      }
      return;
    }
  }

  // 看到别人发的表情包，顺手收一份（不阻塞主流程）
  if (stealQueue.length) {
    for (const s of stealQueue) stealSticker(s.url, s.summary, userId).catch(() => {});
  }

  // 图片不在这里下载 —— 下载要 1~2 秒，比 debounce(1200ms) 还长，
  // 文字那轮早被冲掉、图下载完又另开一轮，就变成了"文字回一条、图片回一条"。
  // 现在只把 url 记进待合并的这轮里，真正下载放在 flushTurn，图文必然同一轮同一句回。
  if (!text && !imageUrls.length) return;

  touchContact(userId);
  const id = earlyId;   // 上面群过滤那步已经取过（名单热加载也做过了）
  const key = isPrivate ? 'private:' + userId : 'group:' + groupId + ':' + userId;
  const label = isPrivate ? '私聊 ' + userId : '群 ' + groupId + ' / ' + userId;
  console.log('[' + label + '](' + id.kind + ') ' + text.slice(0, 60));

  // follow：这轮是靠接力窗口进来的（不是被@），回完要扣一句额度
  const ctx = { isPrivate, userId, groupId, selfId, key, ev, quoteId: ev.message_id, follow: inFollow && !mentioned, atMe: mentioned, voiceIn: !!st.voiceIn, voiceText: st.voiceText || '', voiceAsk };
  const { reply } = makeSender(ctx);

  // 指令
  try {
    if (await handleCommand(text, userId, isPrivate, atTargets, reply)) return;
  } catch (e) {
    console.error('[指令出错]', e.message);
  }

  if (text === '/reset' || text === '重置') {
    sessions.delete(key);
    await reply('上下文已清空 ✓');
    return;
  }
  if (text === '/help' || text === '帮助') {
    const lines = ['/reset 或 重置 — 清空对话上下文', '/我是谁 — 看看我在你这儿是谁', '/help 或 帮助 — 显示本说明'];
    lines.push('/记 <事> — 让它长期记住一件关于你的事', '/记事 — 看看它记了你什么', '/删记 <序号> — 删掉一条');
    if (id.kind === 'owner') lines.push('/认 @人 <称呼> [备注] — 记住一个人', '/忘 @人 — 忘掉一个人', '/名单 — 看看都记了谁', '/记 QQ号 <事> — 给某人记一笔');
    if (CFG.voice) lines.push('/声音 — 看有哪些嗓子', '/换声音 <名字> — 换一把（主人才能换）');
    await reply(lines.join('\n'));
    return;
  }
  if (text === '/声音' || text === '/voice') {
    const cur = currentVoice();
    const out = ['现在用「' + cur.name + '」——' + cur.desc, '可选的（要我念的时候直接说「用XX的声音说」就行）：'];
    for (const v of VOICES) out.push((v.voice === cur.voice ? '→ ' : '· ') + v.name + '：' + v.desc);
    if (id.kind === 'owner') out.push('想换默认的：/换声音 晓晓');
    await reply(out.join('\n'));
    return;
  }
  if (text.startsWith('/换声音') || text.startsWith('换声音')) {
    if (id.kind !== 'owner') { await reply('这个只有主人能换哦。'); return; }
    const want = text.replace(/^\/?换声音/, '').trim();
    const v = findVoiceByWord(want);
    if (!v) { await reply('没听出要换哪把。可选：' + VOICES.map((x) => x.name).join('、')); return; }
    saveVoicePref(v);
    await reply('好，以后默认用「' + v.name + '」——' + v.desc + '。\n以后想听语音，直接说「发个语音」就行，不用再报音色了。');
    // 顺手用新嗓子念一句，省得为了试听再让它"发一条语音"
    await reply('嗯，这个声音你听着还习惯吗。', { asVoice: true, voice: v.voice });
    return;
  }

  // 普通聊天：先攒着，等对方停手再一起回（连发只回一次）
  scheduleTurn(key, ctx, text, [], imageUrls);
}

// ==================== 好友申请 / 进群邀请 ====================
// 只报给主人，绝不自动同意 —— 加不加、放不放行，主人自己点
async function handleRequest(pkt) {
  if (!CFG.requestNotify) return;
  const userId = String(pkt.user_id ?? '');
  const flag = String(pkt.flag ?? '');
  const sub = String(pkt.sub_type || '');
  const isGroup = pkt.request_type === 'group';

  reloadPeopleIfChanged();
  const id = identityOf(userId);
  const who = id.kind === 'owner' ? '自己人「' + (id.alias || '主人') + '」'
    : id.kind === 'known' ? '认识的「' + (id.alias || userId) + '」'
    : '陌生人';

  let what;
  let detail;
  const comment = String(pkt.comment ?? '').trim();
  if (isGroup && sub === 'invite') {
    what = '拉我进群';
    let gname = '群 ' + String(pkt.group_id ?? '');
    try {
      const info = await sendAction('get_group_info', { group_id: Number(pkt.group_id), no_cache: true });
      if (info && info.group_name) gname = '「' + info.group_name + '」(' + pkt.group_id + ')';
    } catch {}
    detail = gname + (comment ? '，附言：' + comment : '');
  } else if (isGroup) {
    what = '申请加群';
    detail = '群 ' + String(pkt.group_id ?? '') + (comment ? '，附言：' + comment : '');
  } else {
    what = '加我好友';
    detail = comment ? '附言：' + comment : '没写附言';
  }

  console.log('[申请] ' + who + ' ' + userId + ' ' + what + ' —— ' + detail + '（flag=' + flag + '）');
  console.log('[申请] 我只记一笔，没同意也没拒绝，等你手动处理');

  if (!CFG.requestNotifyOwner) return;
  const owners = Object.keys(PEOPLE.owners);
  if (!owners.length) return;
  const text = '有人' + what + '：' + who + '（' + userId + '），' + detail + '。\n我没动它，你去 QQ 里点一下～';
  for (const oq of owners) {
    try {
      await sendAction('send_private_msg', { user_id: Number(oq), message: [{ type: 'text', data: { text } }] });
      console.log('[申请] 已私聊告诉 ' + oq);
    } catch (e) {
      console.error('[申请] 通知 ' + oq + ' 失败：' + e.message);
    }
  }
}

// ==================== 戳一戳 ====================
// 谁戳了我，一小时内最多理他几次
const pokeLog = new Map(); // qq -> [时间戳]

function pokeAllowed(qq) {
  const now = Date.now();
  const arr = (pokeLog.get(qq) || []).filter((t) => now - t < 3600000);
  pokeLog.set(qq, arr);
  if (arr.length >= CFG.pokeMaxPerHour) return false;
  arr.push(now);
  return true;
}

async function handleNotice(pkt) {
  if (!CFG.poke) return;
  // NapCat 的戳一戳：notice_type=notify, sub_type=poke
  if (pkt.notice_type !== 'notify' || pkt.sub_type !== 'poke') return;
  const selfId = String(pkt.self_id);
  const userId = String(pkt.user_id ?? '');
  if (!userId || userId === selfId) return;
  // 得是戳我的，不是我看别人互相戳
  if (String(pkt.target_id ?? '') !== selfId) return;

  const groupId = pkt.group_id ? String(pkt.group_id) : null;
  if (groupId && CFG.groupWhitelist.length && !CFG.groupWhitelist.includes(groupId)) return;
  if (!pokeAllowed(userId)) {
    console.log('[戳一戳] ' + userId + ' 戳得太勤，这次不搭理');
    return;
  }

  touchContact(userId);
  reloadPeopleIfChanged();
  const id = identityOf(userId);
  const key = groupId ? 'group:' + groupId + ':' + userId : 'private:' + userId;
  // 还气着的时候被戳，会装没看见 —— 真人生闷气就这反应
  if (CFG.mood) {
    const ps = sessions.get('private:' + userId) || sessions.get(key);
    if (ps && ps.mood) {
      decayMoodByTime(ps);
      if (ps.mood.sulk >= CFG.sulkQuietAt) {
        console.log('[戳一戳] ' + userId + ' 戳了，但我还气着（' + ps.mood.sulk + '），装没看见');
        return;
      }
    }
  }
  const label = groupId ? '群 ' + groupId + ' / ' + userId : '私聊 ' + userId;
  console.log('[戳一戳] ' + label + '(' + id.kind + ') 戳了戳我');

  const ctx = { isPrivate: !groupId, userId, groupId, selfId, key, quoteId: null, ev: null };
  const sender = makeSender(ctx);

  // 一半概率先戳回去，再说话
  if (Math.random() < 0.5) {
    await sleep(Math.round(rnd(300, 900)));
    await sender.sendPoke();
  }

  await flushTurn(key, {
    ctx,
    texts: [],
    imgBlocks: [],
    poke: true,
    extra: '（对方刚戳了戳你，没发消息。就这个动作本身回应一句，别问他要干嘛，也别解释你在干嘛。）',
  });
}

// ==================== 主动说话 ====================
let proactiveTimer = null;

function hourInWindow(hour, spec) {
  // spec 形如 "9-23" 或 "9-12,14-23"
  return spec.split(',').some((part) => {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (a <= b) return hour >= a && hour <= b;
    return hour >= a || hour <= b;   // 跨零点，比如 "22-2"
  });
}

function proactiveCandidates() {
  const list = Object.keys(PEOPLE.owners);
  if (CFG.proactiveWho === 'owner+known') list.push(...Object.keys(PEOPLE.known));
  return list;
}

async function maybeProactive() {
  const hour = new Date().getHours();
  if (!hourInWindow(hour, CFG.proactiveHours)) return;

  const now = Date.now();
  const idleMs = CFG.proactiveIdleMinutes * 60000;
  const gapMs = CFG.proactiveMinGapMinutes * 60000;

  const ready = [];
  for (const qq of proactiveCandidates()) {
    const last = STATE.lastContact[qq] || 0;
    if (!last) continue;                       // 从来没聊过，别冷不丁找上门
    // 气着的时候不主动找人 —— 生着闷气还凑上去说话，就不是闷气了
    if (CFG.mood) {
      const ps = sessions.get('private:' + qq);
      if (ps && ps.mood) {
        decayMoodByTime(ps);
        if (ps.mood.sulk >= CFG.sulkQuietAt && !ps.mood.reported) {
          console.log('[主动] ' + qq + ' 那边我还气着（' + ps.mood.sulk + '），这次不去找他');
          ps.mood.reported = true;
          continue;
        }
        if (ps.mood.sulk < CFG.sulkQuietAt) ps.mood.reported = false;
      }
    }
    if (now - last < idleMs) continue;         // 刚聊过，不用想他
    const lastPro = STATE.lastProactive[qq] || 0;
    if (now - lastPro < gapMs) continue;       // 上次主动找得太近
    ready.push(qq);
  }
  if (!ready.length) return;

  // 每次最多开一个口，且要掷骰子 —— 不然就成了定时闹钟
  if (Math.random() * 100 >= CFG.proactiveChance) return;
  const qq = ready[Math.floor(Math.random() * ready.length)];

  STATE.lastProactive[qq] = now;
  scheduleSaveState();

  reloadPeopleIfChanged();
  const id = identityOf(qq);
  const key = 'private:' + qq;
  const ctx = { isPrivate: true, userId: qq, groupId: null, selfId: '', key, quoteId: null, ev: null };
  console.log('[主动] 想起来找 ' + (id.alias || qq) + ' 说句话');

  const sender = makeSender(ctx);
  const s = getSession(key, qq, id.kind);
  const lastTalk = s.msgs.length ? '你们上次聊到一半停在那儿' : '你们好久没说话了';

  await flushTurn(key, {
    ctx,
    texts: [],
    imgBlocks: [],
    proactive: true,
    extra:
      '（现在没人跟你说话，是你自己突然想起他。' + lastTalk + '。' +
      '别提"主动""打扰""好久没聊"这种字眼，就像脑子里闪过他，随口说一句。' +
      '可以从上次聊的事、你记着的他的事、或者你自己刚碰上的一件小事起头。' +
      '绝对别用"在吗""干嘛呢"开场，也别一上来就连环问。）',
  });
}

function startProactive() {
  if (!CFG.proactive || proactiveTimer) return;
  console.log(
    '[主动] 巡检已启动：每 ' + CFG.proactiveCheckMinutes + ' 分钟看一次，' +
    CFG.proactiveHours + ' 点之间才开口，隔 ' + CFG.proactiveIdleMinutes +
    ' 分钟没聊才想起你，两次之间至少隔 ' + CFG.proactiveMinGapMinutes + ' 分钟'
  );
  proactiveTimer = setInterval(() => {
    maybeProactive().catch((e) => console.error('[主动] 出错：' + e.message));
  }, CFG.proactiveCheckMinutes * 60000);
  proactiveTimer.unref?.();
}

// ==================== 进程守护 ====================
// 没人看着它的时候，一条没 catch 的错就可能把整个进程带走，群里就再也没人应声了。
// 这里把致命错误记下来、把日志收尾、再把进程拖起来；同一分钟内反复崩超过 5 次就不再硬撑（多半是配置错了）
const CRASH_LOG = path.join(DATA_DIR, 'crash.log');
let crashTimes = [];

function crashLog(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(CRASH_LOG, '[' + new Date().toLocaleString('zh-CN') + '] ' + text + '\n');
  } catch {}
}

function emergencyExit(reason, err) {
  console.error('[守护] ' + reason + (err ? '：' + (err.stack || err.message || err) : ''));
  try { crashLog(reason + (err ? '：' + (err.stack || err.message || err) : '')); } catch {}
  try { if (logFd) fs.closeSync(logFd); } catch {}
  process.exit(1);
}

process.on('unhandledRejection', (e) => {
  console.error('[未捕获的 Promise 错误]', e);
  crashLog('未捕获的 Promise 错误：' + (e && (e.stack || e.message) ? (e.stack || e.message) : e));
});
process.on('uncaughtException', (err) => {
  // 先把话说完再退：正在回复的那一轮别让它凭空消失
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60000);
  crashTimes.push(now);
  if (crashTimes.length > 5) {
    emergencyExit('一分钟内崩了 ' + crashTimes.length + ' 次，不再重启（去看看 ' + CRASH_LOG + '）', err);
    return;
  }
  console.error('[守护] 程序出错，3 秒后自己退出，外面的守护进程会把我重新拉起来');
  try { PANEL.error('崩溃：' + (err.message || String(err)).slice(0, 120)); } catch {}
  crashLog('uncaughtException：' + (err.stack || err.message || err));
  // 给正在回复的那一轮留点时间把话说出口，再退出让守护进程重启
  try { if (logFd) fs.closeSync(logFd); } catch {}
  setTimeout(() => process.exit(1), 3000).unref?.();
});

process.on('SIGINT', () => { console.log('\n[退出]'); ws?.close(); process.exit(0); });

loadPeople();
loadSafety(true);
loadSubtext(true);
loadState();
loadGroups();

console.log('===== QQ Bot 启动（' + new Date().toLocaleString('zh-CN') + '）=====');
console.log('  模型: ' + CFG.model + ' @ ' + CFG.apiBase);
console.log('  群聊需@: ' + CFG.groupNeedAt + (CFG.groupNeedAt ? '（一视同仁，主人也一样）' : ''));
console.log('  人设: ' + (CFG.personaFile || '(内联 SYSTEM_PROMPT)'));
console.log('  温度: ' + CFG.temperature + ' | 拟人延迟: ' + CFG.delayMin + '-' + CFG.delayMax + 'ms + ' + CFG.msPerChar + 'ms/字');
console.log('  自己人: ' + (Object.entries(PEOPLE.owners).map(([q, v]) => (v.alias || '主人') + '(' + q + ')').join('、') || '（未设置）'));
console.log('  认识的: ' + (Object.entries(PEOPLE.known).map(([q, v]) => (v.alias || '无名') + '(' + q + ')').join('、') || '（无）'));
console.log('  记忆时长: 自己人 ' + (CFG.ownerTtlMinutes > 0 ? CFG.ownerTtlMinutes + ' 分钟' : '永久') + ' / 认识 ' + (CFG.knownTtlMinutes > 0 ? CFG.knownTtlMinutes + ' 分钟' : '永久') + ' / 陌生人 ' + (CFG.strangerTtlMinutes > 0 ? CFG.strangerTtlMinutes + ' 分钟' : '永久') + ' ｜ 面板「人物」页可改，立刻生效');
console.log('  情绪: ' + (CFG.mood ? '开 ｜ 每轮消 ' + CFG.sulkDecayPerTurn + ' / 每10分钟消 ' + CFG.sulkDecayPerTenMin + ' ｜ 过 ' + CFG.sulkQuietAt + ' 分就话少不接梗' : '关'));
console.log('  小账: ' + (CFG.promises ? '开 ｜ 每人最多记 ' + CFG.promiseMax + ' 笔 ｜ 拖过 ' + CFG.promiseNudgeHours + ' 小时就翻旧账' : '关'));
console.log('  人物档案: ' + (CFG.profileAuto ? '开 ｜ 每聊 ' + CFG.profileEvery + ' 轮更新一次对她的印象' : '关'));
console.log('  调味性格: 天真/较真/嘴硬心软/小得意/小怂 每次 ' + CFG.flavorOdds + '% 概率露一样');
console.log('  表情包: ' + (CFG.stickers ? '开 ｜ 仓库 ' + stickerCount() + ' 张（上限 ' + CFG.stickerMax + '）｜ 目录 ' + CFG.stickerDir : '关'));
console.log('  安全墙: ' + (CFG.safety ? '开 ｜ ' + SAFETY.cats.map((c) => c.name + ' ' + (c.words.length + c.res.length) + ' 条（' + c.action + '/' + c.scope + '）').join('、') : '关') + ' ｜ 群白名单 ' + (CFG.groupWhitelist.length ? CFG.groupWhitelist.join(',') : '不限') + ' ｜ 限流 ' + (CFG.ratePerMin || '关') + ' 条/分钟');
console.log('  引用回复: ' + (CFG.replyQuote ? '开' : '关'));
console.log('  拆条: ' + (CFG.lineSplit ? '开 ｜ 一条最多 ' + CFG.lineWidth + ' 字，超了拆成几条发 ｜ 一次最多 ' + CFG.lineMax + ' 条，超了加宽重排 ｜ 条间隔 ' + CFG.lineGapMin + '-' + CFG.lineGapMax + 'ms' : '关'));
console.log('  读人: ' + (CFG.subtext ? '开 ｜ 词表 ' + SUBTEXT.length + ' 条 ｜ 一轮最多参考 ' + CFG.subtextMax + ' 条 ｜ 文件 ' + SUBTEXT_FILE : '关'));
console.log('  梗库: ' + (CFG.memeLib && MEME.all.length ? '开 ｜ 全库 ' + MEME.all.length + ' 条 ｜ 常驻 ' + MEME.residentNames.size + ' 条 ｜ 每轮按话检索最多 ' + CFG.memeTop + ' 条 ｜ 文件 ' + CFG.memeFile : '关'));
if (CFG.voice && VOICE_ENGINE === 'local') {
  const ms = scanLocalModels();
  console.log('  本地模型: ' + ms.map((x) => x.name + (x.ok ? ' ✓' : ' ✗ 缺 ' + x.missing[0]) + '（' + path.basename(x.dir) + '）').join(' ｜ ') + ' ｜ 不会自动下载；换模型要手动放 voice-models/ 并在 voice-local.mjs 的 MODELS 里登记');
}
console.log('  语音: ' + (CFG.voice ? '开 ｜ ' + (VOICE_ENGINE === 'local' ? '本地离线 sherpa-onnx（wav，不联网）' : 'Edge TTS（mp3，在线）') + ' ｜ 当前声音 ' + currentVoice().name + (VOICE_ENGINE === 'local' ? '' : '（' + currentVoice().voice + '）') + ' ｜ 可点单 ' + VOICES.map((v) => v.name).join('/') + ' ｜ 超过 ' + CFG.voiceMaxChars + ' 字退回文字 ｜ kokoro 超过 ' + CFG.voiceKokoroMax + ' 字自动换快声 ｜ 对方发语音过来也用语音回，语音不额外加延迟' : '关'));
console.log('  接力窗口: ' + (CFG.groupFollow ? '开 ｜ @她一次之后能连说 ' + CFG.groupFollowTurns + ' 句（按合并后的一轮算）、' + CFG.groupFollowMinutes + ' 分钟不用就作废 ｜ 中间@别人就断' : '关（每句都得@）'));
console.log('  群管理员: ' + (CFG.groupAdmin ? '开 ｜ 她知道自己是群管理，被挑衅时禁言对方，对方自报时长按对方的来、否则 ' + CFG.groupBanMinutes + ' 分钟（自己人不禁）' : '关'));
console.log('  群旁听: ' + (CFG.groupEavesdrop ? '开 ｜ 没@我也记下来，每群留最近 ' + CFG.groupLogSize + ' 条' : '关'));
console.log('  花名册: ' + (CFG.groupRoster ? '开 ｜ 每 ' + CFG.groupRosterMinutes + ' 分钟刷一次群成员 ｜ 已存 ' + Object.keys(GROUPS).length + ' 个群' : '关'));
console.log('  群友档案: ' + (CFG.groupMate ? '开 ｜ 每聊 ' + CFG.groupMateEvery + ' 轮整理一次 ｜ 每人最多记 ' + CFG.groupMateMax + ' 条 ｜ 陌生群友也记' : '关'));
console.log('  幽默招式: ' + (CFG.humor ? '开 ｜ ' + HUMOR_KEYS.length + ' 招随机抽，三成轮次不抖机灵' : '关') + ' ｜ 口头禅稀释 ' + (CFG.catchphraseGuard ? '开' : '关'));
console.log('  连发去重: ' + (CFG.dedupeBurts ? '开' : '关') + ' ｜ 多条合并后编号排给模型看');
console.log('  戳一戳: ' + (CFG.poke ? '开 ｜ 每人每小时最多理 ' + CFG.pokeMaxPerHour + ' 次' : '关'));
console.log('  主动说话: ' + (CFG.proactive ? '开 ｜ ' + CFG.proactiveHours + ' 点之间 ｜ 隔 ' + CFG.proactiveIdleMinutes + ' 分钟没聊才想起 ｜ 两次之间至少 ' + CFG.proactiveMinGapMinutes + ' 分钟 ｜ 每次 ' + CFG.proactiveChance + '% 概率 ｜ 对象 ' + CFG.proactiveWho : '关'));
console.log('  自动记忆: ' + (CFG.autoMemory ? '开 ｜ 每聊 ' + CFG.autoMemoryEvery + ' 轮整理一次 ｜ 每人最多 ' + CFG.autoMemoryMax + ' 条' : '关'));
console.log('  好友/进群申请: ' + (CFG.requestNotify ? '只报不批 ｜ ' + (CFG.requestNotifyOwner ? '私聊告诉自己人' : '只写日志') + ' ｜ 同意与否你自己在 QQ 里点' : '关'));
console.log('  上下文摘要: ' + (CFG.contextSummary ? '开 ｜ 超过 ' + CFG.maxTurns + ' 轮就把最早 ' + CFG.summaryBatch + ' 轮压成一段摘要（不再直接丢掉）' : '关 ｜ 超长就砍掉最早的对话'));
console.log('  日志轮转: ' + LOG_FILE + ' 超过 ' + LOG_MAX_MB + 'MB 自动切一份，最多留 ' + LOG_KEEP + ' 份');
console.log('  崩溃守护: uncaughtException 记进 ' + path.join(DATA_DIR, 'crash.log') + ' 并退出，由守护进程拉起');
// 本地语音引擎开机预热：不在第一句真话上等七八秒
if (CFG.voice && VOICE_ENGINE === 'local') {
  setTimeout(() => {
    const t0 = Date.now();
    synthVoice('嗯，我来了。', currentVoice().voice)
      .then((b) => console.log('[语音] 本地引擎预热完成（' + (Date.now() - t0) + 'ms / ' + Math.round(b.length / 1024) + 'KB）'))
      .catch((e) => console.log('[语音] 本地引擎预热失败：' + ((e && e.message) || e)));
  }, 800);
}

connect();