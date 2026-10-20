import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_DIR = path.join(DIR, 'personas');
const ENV_PATH = path.join(DIR, '.env');
const PID_PATH = path.join(DIR, '.bot.pid');
const LOG_PATH = path.join(DIR, 'bot.log');
const HTML_PATH = path.join(DIR, 'persona-form.html');
const PORT = 8799;

function stopBot() {
  // 先挂上"是我让它停的"这面旗，守护逻辑看到它就不当成崩溃
  stoppedByUs = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  try {
    const pid = currentChild ? currentChild.pid
      : (fs.existsSync(PID_PATH) ? Number(fs.readFileSync(PID_PATH, 'utf8').trim()) : 0);
    if (pid) { try { process.kill(pid); } catch (e) {} }
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  } catch (e) {}
}
// bot 自己会写日志（含轮转），这里只在启动前做个体积兜底：日志大得离谱就先归档一份
function trimLogIfHuge() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const mb = fs.statSync(LOG_PATH).size / 1048576;
    if (mb <= 20) return;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    fs.renameSync(LOG_PATH, LOG_PATH + '.' + stamp);
    console.log('[日志] bot.log 已经 ' + mb.toFixed(1) + 'MB，先归档为 bot.log.' + stamp);
  } catch (e) {}
}

// ==================== 进程守护 ====================
// 以前 bot 一崩就永远躺在那儿，得有人手动点重启。
// 现在由这里盯着：它自己退出（崩溃 / 未捕获异常 / 被系统杀掉）就自动拉起来，
// 但"我主动停它"（换人设、改配置）不算崩溃，不会触发自动重启。
let currentChild = null;
let stoppedByUs = false;
let restartTimer = null;
let restartTimes = [];
const RESTART_LOG = path.join(DIR, 'data', 'restart.log');

function logRestart(text) {
  try {
    fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
    fs.appendFileSync(RESTART_LOG, '[' + new Date().toLocaleString('zh-CN') + '] ' + text + '\n');
  } catch (e) {}
}

function spawnBot() {
  trimLogIfHuge();
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, ['--env-file=.env', 'bot.mjs'], {
    cwd: DIR, detached: true, stdio: ['ignore', out, out]
  });
  currentChild = child;
  fs.writeFileSync(PID_PATH, String(child.pid));
  child.unref();

  child.on('exit', (code, signal) => {
    if (stoppedByUs) { stoppedByUs = false; return; }
    if (currentChild !== child) return;   // 已经是上一个了，别重复处理
    currentChild = null;
    // 一分钟内崩超过 5 次就当是配置写错了，别无限重启刷屏
    const now = Date.now();
    restartTimes = restartTimes.filter((t) => now - t < 60000);
    restartTimes.push(now);
    if (restartTimes.length > 5) {
      console.error('[守护] 一分钟内崩了 ' + restartTimes.length + ' 次，先不重启了，去看看 bot.log 和 data/crash.log');
      logRestart('放弃重启：一分钟内崩了 ' + restartTimes.length + ' 次（exit ' + code + ' / ' + signal + '）');
      return;
    }
    const wait = Math.min(30000, 1000 * Math.pow(2, restartTimes.length - 1));
    console.log('[守护] Bot 意外退出（exit ' + code + ' / ' + signal + '），' + (wait / 1000) + ' 秒后自动拉起');
    logRestart('Bot 意外退出（exit ' + code + ' / ' + signal + '），' + (wait / 1000) + ' 秒后重启');
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stoppedByUs || currentChild) return;
      const pid = spawnBot();
      console.log('[守护] 已重新拉起 pid=' + pid);
    }, wait);
  });

  return child.pid;
}

function startBot() {
  stoppedByUs = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  return spawnBot();
}
function setPersonaInEnv(relFile) {
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  env = env.replace(/^SYSTEM_PROMPT_FILE=.*$/m, 'SYSTEM_PROMPT_FILE=' + relFile);
  fs.writeFileSync(ENV_PATH, env);
}
const PEOPLE_PATH = path.join(DIR, 'data', 'people.json');

function readPeople() {
  try {
    const j = JSON.parse(fs.readFileSync(PEOPLE_PATH, 'utf8'));
    return { owners: j.owners || {}, known: j.known || {} };
  } catch (e) { return { owners: {}, known: {} }; }
}
function writePeople(p) {
  fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
  fs.writeFileSync(PEOPLE_PATH, JSON.stringify(p, null, 2), 'utf8');
}

function listPersonas() {
  try { return fs.readdirSync(PERSONA_DIR).filter(f => f.endsWith('.txt')).sort(); }
  catch (e) { return []; }
}
function currentPersona() {
  try {
    const m = fs.readFileSync(ENV_PATH, 'utf8').match(/^SYSTEM_PROMPT_FILE=(.*)$/m);
    return m ? m[1].trim().replace(/^personas\//, '') : '';
  } catch (e) { return ''; }
}

const server = http.createServer((req, res) => {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && (req.url === '/' || req.url.indexOf('/?') === 0)) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    return res.end(fs.readFileSync(HTML_PATH));
  }
  if (req.method === 'GET' && req.url === '/api/people') {
    const p = readPeople();
    return sendJson(200, {
      owners: Object.entries(p.owners).map(([qq, v]) => ({ qq, alias: v.alias || '主人', note: v.note || '', facts: Array.isArray(v.facts) ? v.facts : [] })),
      known: Object.entries(p.known).map(([qq, v]) => ({ qq, alias: v.alias || '', note: v.note || '', facts: Array.isArray(v.facts) ? v.facts : [] })),
    });
  }
  if (req.method === 'GET' && req.url === '/api/personas') {
    return sendJson(200, { files: listPersonas(), current: currentPersona() });
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let d = {};
    try { d = JSON.parse(body || '{}'); } catch (e) {}
    if (req.method === 'POST' && req.url === '/api/save') {
      try {
        const safe = String(d.name || '').replace(/[\\/:*?"<>|\s]/g, '').slice(0, 16);
        if (!safe || !d.text) return sendJson(400, { ok: false, error: '名字或内容为空' });
        const hit = listPersonas().filter(f => f.slice(3, -4) === safe);
        let file = hit[0];
        if (!file) {
          const nums = listPersonas().map(f => parseInt(f.slice(0, 2), 10) || 0);
          const next = String(Math.max(5, nums.length ? Math.max.apply(null, nums) : 5) + 1).padStart(2, '0');
          file = next + '_' + safe + '.txt';
        }
        fs.writeFileSync(path.join(PERSONA_DIR, file), d.text, 'utf8');
        setPersonaInEnv('personas/' + file);
        stopBot();
        const pid = startBot();
        return sendJson(200, { ok: true, file, pid });
      } catch (e) { return sendJson(500, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && req.url === '/api/people') {
      try {
        const qq = String(d.qq || '').replace(/\D/g, '');
        if (!/^\d{5,12}$/.test(qq)) return sendJson(400, { ok: false, error: 'QQ 号不对' });
        const kind = d.kind === 'owner' ? 'owners' : 'known';
        const alias = String(d.alias || '').trim().slice(0, 20) || (kind === 'owners' ? '主人' : '');
        const note = String(d.note || '').trim().slice(0, 200);
        const p = readPeople();
        const cur = p.owners[qq] || p.known[qq] || {};
        const facts = Array.isArray(cur.facts) ? cur.facts : [];
        if (kind === 'owners') {
          p.owners[qq] = { alias, note, facts, since: cur.since || Date.now() };
          delete p.known[qq];
        } else {
          if (p.owners[qq]) return sendJson(400, { ok: false, error: '这个人已经是自己人了' });
          p.known[qq] = { alias, note, facts, addedAt: cur.addedAt || Date.now(), by: cur.by || 'form' };
        }
        writePeople(p);
        return sendJson(200, { ok: true });
      } catch (e) { return sendJson(500, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && req.url === '/api/people-del') {
      try {
        const qq = String(d.qq || '').replace(/\D/g, '');
        const p = readPeople();
        if (d.kind === 'owner') delete p.owners[qq];
        else delete p.known[qq];
        writePeople(p);
        return sendJson(200, { ok: true });
      } catch (e) { return sendJson(500, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && req.url === '/api/use') {
      try {
        const f = String(d.file || '');
        if (listPersonas().indexOf(f) < 0) return sendJson(400, { ok: false, error: '文件不存在' });
        setPersonaInEnv('personas/' + f);
        stopBot();
        const pid = startBot();
        return sendJson(200, { ok: true, file: f, pid });
      } catch (e) { return sendJson(500, { ok: false, error: e.message }); }
    }
    sendJson(404, { ok: false, error: 'not found' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('人设填空表: http://127.0.0.1:' + PORT);
  const pid = startBot();
  console.log('Bot 已启动 pid=' + pid + ' 人设=' + currentPersona());
});