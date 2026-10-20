#!/usr/bin/env node
// 下载本地语音模型（sherpa-onnx 的 tts-models release）。不联网也能跑 bot，只是没有本地语音。
// 用法：
//   node fetch-models.mjs            下载全部三个（约 400MB）
//   node fetch-models.mjs kokoro     只下 kokoro（最好听，也最慢）
// 下载完把 .env 的 VOICE_ENGINE 设成 local，VOICE_LOCAL_MODEL 设成 kokoro / melo / ll。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(ROOT, 'voice-models');
const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';

const PLAN = [
  {
    key: 'kokoro',
    asset: 'kokoro-int8-multi-lang-v1_0.tar.bz2',
    extract: 'kokoro-int8-multi-lang-v1_0',
    keep: 'kokoro-int8-multi-lang-v1_0',
    mb: 126,
    check: ['model.int8.onnx', 'voices.bin', 'tokens.txt'],
    note: '54 个音色（中文 8 把，sid 45~52），24kHz，CPU 上约 1/3 实时',
  },
  {
    key: 'melo',
    asset: 'vits-melo-tts-zh_en.tar.bz2',
    extract: 'vits-melo-tts-zh_en',
    keep: 'melo',
    mb: 159,
    check: ['model.onnx', 'lexicon.txt', 'tokens.txt'],
    note: '中文女声，44.1kHz，接近 1 倍实时',
  },
  {
    key: 'll',
    asset: 'sherpa-onnx-vits-zh-ll.tar.bz2',
    extract: 'sherpa-onnx-vits-zh-ll',
    keep: 'll',
    mb: 113,
    check: ['model.onnx', 'lexicon.txt', 'tokens.txt'],
    note: '五个音色（sid 0~4），16kHz，最快',
  },
];

function ok(dir, checks) {
  return checks.every((f) => fs.existsSync(path.join(dir, f)));
}

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向太多次'));
    https.get(url, { headers: { 'User-Agent': 'pangting-bot/fetch-models' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, file, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, last = 0;
      const out = fs.createWriteStream(file);
      res.on('data', (c) => {
        got += c.length;
        if (total && got - last > total / 20) {
          last = got;
          process.stdout.write('  ' + (got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB\r');
        }
      });
      res.pipe(out);
      out.on('finish', () => { process.stdout.write('\n'); resolve(); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

function extract(file, into) {
  // Windows 10 起自带 bsdtar，Linux/macOS 也都有 tar
  const r = spawnSync('tar', ['-xjf', file, '-C', into], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error('解压失败：系统里没有可用的 tar（Windows 可用 7-Zip 手动解压到 voice-models/）');
  }
}

async function one(p) {
  const target = path.join(DEST, p.keep);
  if (ok(target, p.check)) { console.log('[跳过] ' + p.key + ' 已经有了：' + target); return; }
  fs.mkdirSync(DEST, { recursive: true });
  const tar = path.join(DEST, p.asset);
  console.log('[下载] ' + p.key + '（约 ' + p.mb + 'MB）：' + p.asset);
  if (!fs.existsSync(tar)) await download(BASE + '/' + p.asset, tar);
  console.log('[解压] ' + p.asset);
  extract(tar, DEST);
  const extracted = path.join(DEST, p.extract);
  if (p.extract !== p.keep && fs.existsSync(extracted) && !fs.existsSync(target)) {
    fs.renameSync(extracted, target);
  }
  fs.rmSync(tar, { force: true });
  if (!ok(target, p.check)) throw new Error(p.key + ' 解压后缺文件，请检查 ' + target);
  console.log('[完成] ' + p.key + ' → ' + target + '　' + p.note);
}

const want = process.argv[2] || 'all';
const list = want === 'all' ? PLAN : PLAN.filter((p) => p.key === want);
if (!list.length) {
  console.error('用法：node fetch-models.mjs [kokoro|melo|ll|all]');
  process.exit(1);
}
for (const p of list) {
  try { await one(p); } catch (e) { console.error('[失败] ' + p.key + '：' + e.message); process.exitCode = 1; }
}
console.log('\n模型在 voice-models/ 里了。要启用本地语音：.env 里设 VOICE_ENGINE=local、VOICE_LOCAL_MODEL=kokoro（或 melo / ll）。');
console.log('模型版权归上游（hexgrad/Kokoro-82M、myshell-ai/MeloTTS、k2-fsa）；商用前请自行核对各自的 LICENSE。');
