// panel.mjs —— 旁听生控制台（独立进程，只绑 127.0.0.1）
// 数据来源：bot 写的 data/panel-state.json + bot.log + data/voice-demo-*.wav
// 控制通道：往 data/panel-control.json 写指令，bot 每 2 秒取一次
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PANEL_PORT || 3010);
const HOST = '127.0.0.1';
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'panel-state.json');
const CTRL_FILE = path.join(DATA, 'panel-control.json');
const LOG_FILE = path.join(ROOT, process.env.LOG_FILE || 'bot.log');
const PAUSE_FILE = path.join(ROOT, '.paused');
const STICKER_DIR = path.join(ROOT, 'stickers');
const MEME_FILE = path.join(DATA, '梗库.md');
const OK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function tailLog(n, q) {
  let buf = '';
  try {
    const st = fs.statSync(LOG_FILE);
    const size = Math.min(st.size, 3 * 1024 * 1024);
    const fd = fs.openSync(LOG_FILE, 'r');
    const b = Buffer.alloc(size);
    fs.readSync(fd, b, 0, size, st.size - size);
    fs.closeSync(fd);
    buf = b.toString('utf8');
  } catch {
    return { lines: [], error: '读不到 ' + path.basename(LOG_FILE) };
  }
  let lines = buf.split(/\r?\n/).filter((l) => l.trim());
  if (q) lines = lines.filter((l) => l.includes(q));
  return { lines: lines.slice(-n) };
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

function readBodyBig(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > maxBytes) { dead = true; req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve(null));
  });
}

// 导出用：零依赖、只存储不压缩的 zip（表情包都是已压过的图，压缩没意义）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

const ALLOWED_CMDS = new Set(['restart', 'voice-test', 'set-voice', 'backup', 'clear-memory', 'meme-resident', 'sticker-tag', 'sticker-del', 'bot-pause', 'bot-resume', 'persona-save', 'people-save', 'set-cfg']);

// 人物：直接读 people.json（只读展示，写入一律交给 bot，避免两边同时写把文件盖坏）
function readPeople() {
  let j = { owners: {}, known: {} };
  try { j = JSON.parse(fs.readFileSync(path.join(DATA, 'people.json'), 'utf8')) || j; } catch {}
  const shape = (pool, kind) => Object.keys(pool || {}).map((qq) => {
    const v = pool[qq] || {};
    const prof = v.profile && typeof v.profile === 'object' ? v.profile : {};
    return {
      qq, kind,
      alias: v.alias || '',
      note: v.note || '',
      facts: Array.isArray(v.facts) ? v.facts : [],
      who: prof.who || '',
      lastTalk: prof.lastTalk || '',
      updatedAt: prof.updatedAt || 0,
      since: v.since || 0,
    };
  }).sort((a, b) => (b.updatedAt || b.since) - (a.updatedAt || a.since));
  let ownerQq = '';
  try { const st = readState(); ownerQq = (st && st.cfg && st.cfg.owner) || ''; } catch {}
  return { owners: shape(j.owners, 'owner'), known: shape(j.known, 'known'), ownerQq };
}

// 人设文件：路径由 bot 写进 state.cfg.personaFile（相对 ROOT 或绝对路径都认）
function readPersona() {
  let rel = '';
  try { const st = readState(); rel = (st && st.cfg && st.cfg.personaFile) || ''; } catch {}
  if (!rel) return { ok: false, file: '', text: '', error: '现在的人设来自 .env 的 SYSTEM_PROMPT，没有独立文件可改。想让面板能改，把 .env 的 SYSTEM_PROMPT_FILE 指向 personas/00_示例人设.txt 再重启一次。' };
  const f = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  try { return { ok: true, file: rel, text: fs.readFileSync(f, 'utf8') }; }
  catch (e) { return { ok: false, file: rel, text: '', error: '读不到 ' + rel + '：' + e.message }; }
}

// 梗库全文（面板自己解析，不用过 bot）
function readMemes() {
  let raw = '';
  try { raw = fs.readFileSync(MEME_FILE, 'utf8'); } catch { return { categories: [], total: 0, error: '读不到 data/梗库.md' }; }
  const cats = [];
  let cat = { name: '未分类', entries: [] };
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^### /.test(line)) {
      cur = { name: line.slice(3).trim().replace(/（慎用）$/, ''), snippet: '' };
      cat.entries.push(cur);
    } else if (/^## /.test(line)) {
      if (cat.entries.length) cats.push(cat);
      cat = { name: line.slice(3).trim(), entries: [] };
      cur = null;
    } else if (cur && line.trim()) {
      if (!cur.snippet) cur.snippet = line.trim().slice(0, 90);
    }
  }
  if (cat.entries.length) cats.push(cat);
  return { categories: cats, total: cats.reduce((n, c) => n + c.entries.length, 0) };
}

function readStickers() {
  let idx = {};
  try { idx = JSON.parse(fs.readFileSync(path.join(STICKER_DIR, 'index.json'), 'utf8')) || {}; } catch {}
  const list = Object.keys(idx).map((f) => {
    let size = 0;
    try { size = fs.statSync(path.join(STICKER_DIR, f)).size; } catch {}
    return { file: f, summary: idx[f].summary || '', addedAt: idx[f].addedAt || 0, from: idx[f].from || '', size };
  }).sort((a, b) => b.addedAt - a.addedAt);
  return { list, total: list.length };
}

// 群旁听：bot 每群留最近 N 条（groups.json 的 recent，只读，不改）
function readEaves() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(DATA, 'groups.json'), 'utf8')) || {}; } catch {}
  const groups = Object.keys(j).map((g) => {
    const v = j[g] || {};
    const recent = Array.isArray(v.recent) ? v.recent : [];
    return {
      group: g,
      name: v.name || '',
      members: v.members && typeof v.members === 'object' ? Object.keys(v.members).length : 0,
      updatedAt: v.updatedAt || 0,
      n: recent.length,
      recent: recent.slice(-20).map((r) => ({
        qq: String((r && r.qq) || ''),
        name: String((r && r.name) || ''),
        text: String((r && r.text) || '').slice(0, 120),
        at: (r && r.at) || 0,
        kind: String((r && r.kind) || 'text'),
      })),
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  return { groups, total: groups.reduce((n, g) => n + g.n, 0) };
}

const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '').split(':')[0];
  if (!OK_HOSTS.has(host)) return sendJson(res, 403, { error: '只接受本机访问' });

  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try { return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'panel.html'))); }
    catch (e) { return send(res, 500, 'text/plain; charset=utf-8', 'panel.html 不见了：' + e.message); }
  }

  if (req.method === 'GET' && p === '/api/state') {
    const state = readState();
    const now = Date.now();
    const paused = fs.existsSync(PAUSE_FILE);
    // 暂停时她也写得慢不下来 —— 直接按「不在线」显示，别让人以为卡住了
    const alive = !paused && !!(state && now - state.at < 15000);
    return sendJson(res, 200, {
      state,
      alive,
      paused,
      staleSec: state ? Math.round((now - state.at) / 1000) : null,
      now,
      pid: (() => { try { return Number(fs.readFileSync(path.join(ROOT, '.bot.pid'), 'utf8').trim()); } catch { return 0; } })(),
    });
  }

  if (req.method === 'GET' && p === '/api/log') {
    const n = Math.min(500, Math.max(10, Number(url.searchParams.get('n') || 200)));
    return sendJson(res, 200, tailLog(n, url.searchParams.get('q') || ''));
  }

  if (req.method === 'GET' && p === '/api/eaves') return sendJson(res, 200, readEaves());

  if (req.method === 'GET' && p === '/api/memes') {
    let resident = [];
    try {
      const st = readState();
      resident = (st && st.cfg && st.cfg.memesResident) || [];
    } catch {}
    return sendJson(res, 200, Object.assign(readMemes(), { resident }));
  }

  if (req.method === 'GET' && p === '/api/stickers') {
    return sendJson(res, 200, readStickers());
  }

  if (req.method === 'GET' && p === '/api/people') {
    return sendJson(res, 200, readPeople());
  }

  if (req.method === 'GET' && p === '/api/persona') {
    return sendJson(res, 200, readPersona());
  }

  // 从本地导入：浏览器把图转 base64 丢进 data/sticker-inbox，bot 每 4 秒收一批
  if (req.method === 'POST' && p === '/api/stickers/import') {
    const body = await readBodyBig(req, 30 * 1024 * 1024);
    if (!body) return sendJson(res, 413, { error: '文件太大了（一次最多 30MB）' });
    const files = Array.isArray(body.files) ? body.files.slice(0, 40) : [];
    if (!files.length) return sendJson(res, 400, { error: '没有收到文件' });
    const inbox = path.join(DATA, 'sticker-inbox');
    const bad = [];
    let queued = 0;
    try { fs.mkdirSync(inbox, { recursive: true }); } catch {}
    files.forEach((f, i) => {
      try {
        const buf = Buffer.from(String(f.b64 || ''), 'base64');
        if (!buf.length) throw new Error('空文件');
        if (buf.length > 8 * 1048576) throw new Error('单张超过 8MB');
        const m = String(f.name || '').match(/\.(png|jpe?g|gif|webp)$/i);
        const ext = m ? m[1].toLowerCase() : 'png';
        const name = 'i' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 5) + '.' + ext;
        fs.writeFileSync(path.join(inbox, name), buf);
        queued++;
      } catch (e) { bad.push(String(f.name || '(无名)') + '：' + e.message); }
    });
    return sendJson(res, 200, { ok: true, queued, skipped: bad });
  }

  // 导出到本地：真 zip（图片 + 清单.txt），浏览器直接下载
  if (req.method === 'GET' && p === '/api/stickers/export') {
    const list = readStickers().list;
    const entries = [];
    const date = new Date().toISOString().slice(0, 10);
    const lines = ['表情包导出 · ' + date, '共 ' + list.length + ' 张', '', '文件名\t摘要\t收录日期'];
    for (const s of list) {
      try {
        entries.push({ name: 'stickers/' + s.file, data: fs.readFileSync(path.join(STICKER_DIR, s.file)) });
        lines.push(s.file + '\t' + (s.summary || '') + '\t' + (s.addedAt ? new Date(s.addedAt).toISOString().slice(0, 10) : ''));
      } catch {}
    }
    entries.push({ name: '清单.txt', data: Buffer.from(lines.join('\n'), 'utf8') });
    const zip = zipStore(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="stickers-' + date + '.zip"',
      'Content-Length': zip.length,
    });
    return res.end(zip);
  }

  if (req.method === 'GET' && p.startsWith('/sticker/')) {
    const f = p.slice('/sticker/'.length);
    if (!/^[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i.test(f) || f.includes('..')) return sendJson(res, 400, { error: '文件名字不对' });
    try {
      const buf = fs.readFileSync(path.join(STICKER_DIR, f));
      const ext = f.split('.').pop().toLowerCase();
      const type = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return send(res, 200, type, buf);
    } catch { return sendJson(res, 404, { error: '没有这张' }); }
  }

  if (req.method === 'GET' && p.startsWith('/demo/')) {
    const tag = p.slice('/demo/'.length).replace(/[^a-z0-9]/gi, '');
    const f = path.join(DATA, 'voice-demo-' + tag + '.wav');
    try { return send(res, 200, 'audio/wav', fs.readFileSync(f)); }
    catch { return sendJson(res, 404, { error: '没有这条试听' }); }
  }

  if (req.method === 'POST' && p === '/api/control') {
    const body = await readBody(req);
    if (!ALLOWED_CMDS.has(body.cmd)) return sendJson(res, 400, { error: '不认识的指令' });
    // 暂停/继续是面板自己的事（写/删 .paused 标志，守护进程看到就不拉起她）
    if (body.cmd === 'bot-resume') {
      try { fs.unlinkSync(PAUSE_FILE); } catch {}
      return sendJson(res, 200, { ok: true, id: 'local-resume', note: '已撤销暂停，守护进程 2 秒内把她叫起来' });
    }
    if (body.cmd === 'bot-pause') {
      try { fs.writeFileSync(PAUSE_FILE, JSON.stringify({ at: Date.now() })); }
      catch (e) { return sendJson(res, 500, { error: '写不了暂停标志：' + e.message }); }
    }
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = { id, cmd: body.cmd === 'bot-pause' ? 'bot-stop' : body.cmd, status: 'pending', at: Date.now() };
    if (body.scope) rec.scope = String(body.scope);
    if (body.group) rec.group = String(body.group);
    if (body.name) rec.name = String(body.name);
    if (body.op) rec.op = String(body.op);
    if (body.file) rec.file = String(body.file);
    if (body.summary) rec.summary = String(body.summary).slice(0, 120);
    // 人设是整篇文本，别按 200 字截断；其他指令的 text 仍然简短
    const textMax = body.cmd === 'persona-save' ? 20000 : 200;
    if (body.text) rec.text = String(body.text).slice(0, textMax);
    if (body.qq) rec.qq = String(body.qq).replace(/\D/g, '');
    if (body.alias) rec.alias = String(body.alias).slice(0, 40);
    if (body.note !== undefined) rec.note = String(body.note).slice(0, 600);
    if (body.who !== undefined) rec.who = String(body.who).slice(0, 200);
    if (body.lastTalk !== undefined) rec.lastTalk = String(body.lastTalk).slice(0, 200);
    if (Array.isArray(body.facts)) rec.facts = body.facts.map((x) => String(x).slice(0, 200)).slice(0, 120);
  // 运行时配置：接力窗口 / 禁言时长 / 三种关系的记忆时长（数值，交给 bot 校验范围）
  for (const k of ['followTurns', 'followMinutes', 'banMinutes', 'ownerTtl', 'knownTtl', 'strangerTtl']) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '') rec[k] = Number(body[k]);
  }
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(CTRL_FILE, JSON.stringify(rec), 'utf8');
    } catch (e) { return sendJson(res, 500, { error: '写不了指令文件：' + e.message }); }
    return sendJson(res, 200, { ok: true, id });
  }

  return sendJson(res, 404, { error: '没有这个地址' });
});

server.listen(PORT, HOST, () => {
  console.log('[面板] http://' + HOST + ':' + PORT + '  （只绑本机，局域网访问不到）');
});
