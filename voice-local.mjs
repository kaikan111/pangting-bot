// 本地离线语音：sherpa-onnx，纯 Node，不用 Python、不用联网。
// 三套模型：
//   kokoro —— 24kHz，54 个音色（中文 8 把），最自然，但 CPU 上约 1/3 实时速度
//   melo   —— 44.1kHz 中文女声，快（接近 1 倍实时），音色平
//   ll     —— 16kHz 五音色，最快，音色闷
// 合成时按标点切句、句间留停顿、首尾补静音，再做响度归一化 —— 这几步是"像人"的关键，
// 光换模型不解决，VITS 一口气念完是最大的机器味。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MODEL_ROOT = path.join(HERE, 'voice-models');

// 停顿（毫秒）：句末比逗号长，句与句之间要留出"换气"的空当
const GAP_END = 280;    // 句号/问号/感叹号之后
const GAP_COMMA = 150;  // 逗号/顿号之后
const GAP_HEAD = 120;   // 开头
const GAP_TAIL = 300;   // 收尾（留一点回声感，别一刀切断）

// 线程数：实测 4 线程最快，再往上反而更慢（超订）；
// 留两核给 bot 主线程，别把她的文字回复卡死。VOICE_THREADS 可以硬指定。
const THREADS = Number(process.env.VOICE_THREADS || 0) || Math.max(2, Math.min(4, (os.cpus() || []).length - 2));

// 每个模型：目录名 + 类型 + 有没有 jieba 词典（Melo 需要）
const MODELS = {
  kokoro: { dir: 'kokoro-int8-multi-lang-v1_0', kind: 'kokoro', name: 'Kokoro 多语' },
  melo: { dir: 'melo', kind: 'vits', name: 'Melo 中文女声' },
  ll: { dir: 'll', kind: 'vits', name: 'LL 五音色' },
};

let SHERPA = null;
function sherpa() {
  if (!SHERPA) SHERPA = require('sherpa-onnx-node');
  return SHERPA;
}

const ENGINE_CACHE = new Map(); // modelKey -> OfflineTts

function modelFiles(key) {
  const m = MODELS[key] || MODELS.kokoro;
  const dir = path.join(MODEL_ROOT, m.dir);
  const need = m.kind === 'kokoro'
    ? ['model.int8.onnx', 'voices.bin', 'tokens.txt']
    : ['model.onnx', 'lexicon.txt', 'tokens.txt'];
  for (const f of need) if (!fs.existsSync(path.join(dir, f))) throw new Error('缺模型文件 ' + path.join(dir, f));
  return { m, dir };
}

// 扫一遍 voice-models/：哪些模型真的在盘上（不会联网下载，也不会自己加新模型）
export function scanLocalModels() {
  const out = [];
  for (const key of Object.keys(MODELS)) {
    const m = MODELS[key];
    const dir = path.join(MODEL_ROOT, m.dir);
    const need = m.kind === 'kokoro'
      ? ['model.int8.onnx', 'voices.bin', 'tokens.txt']
      : ['model.onnx', 'lexicon.txt', 'tokens.txt'];
    const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)));
    let mb = 0;
    try {
      const st = fs.statSync(path.join(dir, missing[0] || need[0]));
      mb = Math.round((st.size / 1048576) * 10) / 10;
    } catch {}
    out.push({ key, name: m.name, dir, ok: missing.length === 0, missing, mb });
  }
  return out;
}

export function localModelInfo(key) {
  const m = MODELS[key] || MODELS.kokoro;
  return { key, name: m.name, dir: path.join(MODEL_ROOT, m.dir) };
}

function getEngine(key) {
  if (ENGINE_CACHE.has(key)) return ENGINE_CACHE.get(key);
  const { m, dir } = modelFiles(key);
  let tts;
  if (m.kind === 'kokoro') {
    const kokoro = {
      model: path.join(dir, 'model.int8.onnx'),
      voices: path.join(dir, 'voices.bin'),
      tokens: path.join(dir, 'tokens.txt'),
      dataDir: path.join(dir, 'espeak-ng-data'),
      lexicon: [path.join(dir, 'lexicon-us-en.txt'), path.join(dir, 'lexicon-zh.txt')].join(','),
      lang: 'zh',
    };
    const dictDir = path.join(dir, 'dict');
    if (fs.existsSync(dictDir)) kokoro.dictDir = dictDir;
    // 注意：numThreads / provider 必须放在 model 这一层，放顶层会被忽略（走单线程，慢一倍）
    tts = new (sherpa().OfflineTts)({
      model: { kokoro, numThreads: THREADS, provider: 'cpu' },
      maxNumSentences: 1,
      silenceScale: 0.2,
    });
  } else {
    const vits = {
      model: path.join(dir, 'model.onnx'),
      lexicon: path.join(dir, 'lexicon.txt'),
      tokens: path.join(dir, 'tokens.txt'),
    };
    const dictDir = path.join(dir, 'dict');
    if (fs.existsSync(dictDir)) vits.dictDir = dictDir;
    tts = new (sherpa().OfflineTts)({
      model: { vits, numThreads: THREADS, provider: 'cpu' },
      maxNumSentences: 1,
      silenceScale: 0.2,
    });
  }
  ENGINE_CACHE.set(key, tts);
  return tts;
}

// 切句：按标点断开，太短的片段并进上一句（免得"哦。"单独成句一顿一顿），
// 句末留长停顿、逗号留短停顿。maxLen 是单个片段的字数上限。
const STRONG_PUNCT = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n']);
const WEAK_PUNCT = new Set(['，', '、', ',', ':', '：']);

function visibleLen(s) {
  return String(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length;
}

export function splitSpeech(text, maxLen = 60) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  const chunks = [];
  let buf = '';
  const flush = (gap) => {
    const t = buf.trim();
    buf = '';
    if (!t) return;
    const last = chunks[chunks.length - 1];
    if (last && (visibleLen(t) < 5 || visibleLen(last.text) < 5) && last.text.length + t.length <= maxLen) {
      last.text += t;
      last.gap = Math.max(last.gap, gap);
      return;
    }
    chunks.push({ text: t, gap });
  };
  for (const ch of src) {
    if (STRONG_PUNCT.has(ch)) {
      if (ch !== '\n') buf += ch;
      flush(GAP_END);
      continue;
    }
    if (WEAK_PUNCT.has(ch)) {
      buf += ch;
      if (visibleLen(buf) >= 8) flush(GAP_COMMA);
      continue;
    }
    buf += ch;
    if (buf.length >= maxLen) flush(GAP_COMMA);
  }
  flush(GAP_TAIL);
  return chunks;
}

function toWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// 响度归一化：不同嗓子、不同模型出来的电平差得挺明显（kokoro 峰值只有 0.3~0.55，
// melo 接近 0.9），不处理就会出现"换个人说话音量突然变大变小"。
function normalize(samples) {
  let peak = 0, sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  if (!peak) return samples;
  const rms = Math.sqrt(sum / samples.length);
  const targetRms = 0.13;
  let gain = rms > 0 ? targetRms / rms : 1;
  const ceiling = 0.95 / peak;      // 不许削顶
  if (gain > ceiling) gain = ceiling;
  if (gain < 0.5) gain = 0.5;
  if (gain > 6) gain = 6;
  if (Math.abs(gain - 1) < 0.05) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

// 首尾各做 8ms 淡入淡出，避免"咔"的一下
function fadeEdges(pcm, sr) {
  const n = Math.min(Math.round(sr * 0.008), Math.floor(pcm.length / 2));
  for (let i = 0; i < n; i++) {
    const k = i / n;
    pcm[i] *= k;
    pcm[pcm.length - 1 - i] *= k;
  }
  return pcm;
}

// 返回 wav Buffer；sid 是说话人编号（kokoro 中文在 45~52，ll 有 5 个，melo 只有 0）
export function synthVoiceLocal(text, { model = 'kokoro', sid = 0, speed = 1.0 } = {}) {
  const key = String(model || 'kokoro');
  const tts = getEngine(key);
  const sr = tts.sampleRate;
  const maxLen = key === 'kokoro' ? 60 : key === 'melo' ? 40 : 32;
  const chunks = splitSpeech(String(text || ''), maxLen);
  if (!chunks.length) throw new Error('没有可念的字');

  const headSamples = Math.round((GAP_HEAD / 1000) * sr);
  const totalGap = chunks.reduce((n, c) => n + Math.round((c.gap / 1000) * sr), 0);
  const parts = [];
  let speechLen = 0;
  for (const c of chunks) {
    const audio = tts.generate({ text: c.text, sid: Number(sid) || 0, speed: Number(speed) || 1.0 });
    if (!audio || !audio.samples || !audio.samples.length) throw new Error('本地合成出来是空的');
    parts.push({ samples: audio.samples, gap: Math.round((c.gap / 1000) * sr) });
    speechLen += audio.samples.length;
  }

  const pcm = new Float32Array(headSamples + speechLen + totalGap);
  let at = headSamples;
  for (const p of parts) {
    pcm.set(p.samples, at);
    at += p.samples.length + p.gap;
  }
  return toWav(fadeEdges(normalize(pcm), sr), sr);
}

export function localSpeakerCount(key) {
  try { return getEngine(key).numSpeakers; } catch { return 0; }
}

// ---- worker 封装：主线程只等 Promise，推理在 worker 里同步跑 ----
let WORKER = null;
let SEQ = 0;
const PENDING = new Map();
let CHAIN = Promise.resolve();

function ensureWorker() {
  if (WORKER) return WORKER;
  const w = new Worker(new URL('./voice-local-worker.mjs', import.meta.url));
  w.on('message', (m) => {
    const p = PENDING.get(m.id);
    if (!p) return;
    PENDING.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(Buffer.from(m.buf));
  });
  w.on('error', (e) => {
    for (const [, p] of PENDING) p.reject(e);
    PENDING.clear();
    WORKER = null;
  });
  WORKER = w;
  return w;
}

export function synthVoiceLocalAsync(text, opts = {}) {
  const run = () => new Promise((resolve, reject) => {
    const id = ++SEQ;
    PENDING.set(id, { resolve, reject });
    try { ensureWorker().postMessage({ id, text: String(text || ''), opts }); }
    catch (e) { PENDING.delete(id); reject(e); }
  });
  const p = CHAIN.then(run, run);
  CHAIN = p.catch(() => {});
  return p;
}
