// panel-bridge.mjs —— 给面板用的状态快照 + 控制指令通道。
// 设计：不开放任何网络端口。bot 每 5 秒把现场写进 data/panel-state.json，
// 每 2 秒读一次 data/panel-control.json 执行指令并回写状态。
// 面板（panel.mjs）是独立进程，读这两个文件 + tail bot.log。
// 所有写操作都吞异常：面板坏了绝不能把她带崩。
import fs from 'node:fs';
import path from 'node:path';

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function createPanel(opts) {
  const dir = opts.dir || process.cwd();
  const dataDir = path.join(dir, 'data');
  const snapFile = path.join(dataDir, 'panel-state.json');
  const ctrlFile = path.join(dataDir, 'panel-control.json');
  const handlers = opts.handlers || {};
  const getInfo = opts.getInfo || (() => ({}));

  const bootAt = Date.now();
  const T = {
    date: todayKey(), msgs: 0, msgsPrivate: 0, msgsGroup: 0,
    replies: 0, repliesVoice: 0, bans: 0, memeTurns: 0, groups: {},
  };
  const tokens = { calls: 0, prompt: 0, completion: 0, cached: 0, lastMs: 0 };
  const ws = { online: false, reconnects: 0, since: 0, lastError: '' };
  const errors = { n: 0, last: '' };
  let recent = [];
  let lastControl = null;
  let lastHandled = '';
  let timer = null;
  let ctrlTimer = null;

  // 重启后接着算今天的数（不然点一次重启，今日统计就归零了）
  try {
    const j = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    if (j && j.today && j.today.date === T.date) {
      Object.assign(T, j.today);
      if (j.tokens) Object.assign(tokens, j.tokens);
      if (Array.isArray(j.recent)) recent = j.recent.slice(0, 30);
    }
  } catch {}

  function rollDate() {
    const k = todayKey();
    if (k === T.date) return;
    const empty = { date: k, msgs: 0, msgsPrivate: 0, msgsGroup: 0, replies: 0, repliesVoice: 0, bans: 0, memeTurns: 0, groups: {} };
    Object.assign(T, empty);
    tokens.calls = 0; tokens.prompt = 0; tokens.completion = 0; tokens.cached = 0;
  }

  function snapshot() {
    rollDate();
    let extra = {};
    try { extra = getInfo() || {}; } catch (e) { extra = { infoError: e.message }; }
    return {
      at: Date.now(),
      boot: bootAt,
      pid: process.pid,
      upMs: Date.now() - bootAt,
      model: extra.model || '',
      ws: { ...ws },
      today: { ...T },
      tokens: { ...tokens },
      counts: extra.counts || {},
      cfg: extra.cfg || {},
      follow: extra.follow || [],
      bans: extra.bans || [],
      recent,
      lastControl,
      errors: { ...errors },
    };
  }

  function flush() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      atomicWrite(snapFile, JSON.stringify(snapshot()));
    } catch (e) { /* 静默 */ }
  }

  async function runControl(j) {
    const ack = (status, result) => {
      const rec = { id: j.id, cmd: j.cmd, status, result: String(result == null ? '' : result).slice(0, 300), at: Date.now() };
      lastControl = rec;
      try { atomicWrite(ctrlFile, JSON.stringify({ ...j, status, result: rec.result, at: rec.at })); } catch {}
      flush();
    };
    const h = handlers[j.cmd];
    if (!h) return ack('error', '不认识的指令：' + j.cmd);
    try {
      const r = await h(j);
      ack('done', r || 'ok');
    } catch (e) {
      ack('error', e.message || String(e));
    }
  }

  function pollControl() {
    let j;
    try { j = JSON.parse(fs.readFileSync(ctrlFile, 'utf8')); } catch { return; }
    if (!j || !j.id || j.id === lastHandled) return;
    if (j.status && j.status !== 'pending') { lastHandled = j.id; return; }
    lastHandled = j.id;
    runControl(j);
  }

  return {
    // ---- bot 侧埋点 ----
    msg(o) { rollDate(); T.msgs++; if (o && o.isPrivate) T.msgsPrivate++; else T.msgsGroup++; const g = o && o.group; if (g) T.groups[g] = (T.groups[g] || 0) + 1; },
    reply(o) {
      rollDate(); T.replies++;
      if (o.voice) T.repliesVoice++;
      if (o.memes && o.memes.length) T.memeTurns++;
      if (o.banned) T.bans++;
      recent.unshift({ t: Date.now(), where: (o.where || '').slice(0, 40), who: (o.who || '').slice(0, 24), text: String(o.text || '').slice(0, 200), voice: !!o.voice, voiceName: o.voiceName || '', ms: o.ms || 0, memes: (o.memes || []).slice(0, 6), banned: !!o.banned });
      if (recent.length > 30) recent = recent.slice(0, 30);
    },
    usage(u, ms) {
      rollDate();
      if (!u) return;
      tokens.calls++;
      tokens.prompt += Number(u.prompt_tokens || 0);
      tokens.completion += Number(u.completion_tokens || 0);
      tokens.cached += Number(u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0);
      if (ms) tokens.lastMs = ms;
    },
    ws(online, err) {
      if (online) { ws.online = true; ws.since = Date.now(); ws.reconnects = 0; }
      else { if (ws.online) ws.reconnects++; ws.online = false; }
      if (err) { ws.lastError = String(err).slice(0, 160); }
    },
    error(m) { errors.n++; errors.last = String(m || '').slice(0, 240); },
    flush,
    start() {
      timer = setInterval(flush, 5000);
      timer.unref?.();
      ctrlTimer = setInterval(() => { try { pollControl(); } catch {} }, 2000);
      ctrlTimer.unref?.();
      flush();
    },
  };
}
