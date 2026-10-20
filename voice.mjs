// 语音合成：走微软 Edge TTS 的在线接口（node-edge-tts，纯 JS，不用装 Python）
// 合成结果按「声音 + 文本」缓存，同一句话不重复花时间；返回 mp3 Buffer，
// 由 bot.mjs 包成 OneBot 的 record 段发出去。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EdgeTTS } from 'node-edge-tts';
import { synthVoiceLocalAsync, scanLocalModels } from './voice-local.mjs';

export { scanLocalModels };

// 本地引擎能"点"的几把嗓子（模型 + 说话人编号）。名字就是 bot 里 VOICES 的 voice 字段。
export const LOCAL_VOICES = [
  { name: '可可·晓晓', voice: '可可·晓晓', model: 'kokoro', sid: 47, speed: 1.0, desc: 'Kokoro 中文女声，最清楚（默认）' },
  { name: '可可·小贝', voice: '可可·小贝', model: 'kokoro', sid: 45, speed: 1.0, desc: 'Kokoro 中文女声，软一点' },
  { name: '可可·小妮', voice: '可可·小妮', model: 'kokoro', sid: 46, speed: 1.0, desc: 'Kokoro 中文女声，偏活泼' },
  { name: '可可·小艺', voice: '可可·小艺', model: 'kokoro', sid: 48, speed: 1.0, desc: 'Kokoro 中文女声，偏冷静' },
  { name: '可可·云健', voice: '可可·云健', model: 'kokoro', sid: 49, speed: 1.0, desc: 'Kokoro 中文男声' },
  { name: '可可·云希', voice: '可可·云希', model: 'kokoro', sid: 50, speed: 1.0, desc: 'Kokoro 中文男声，偏年轻' },
  { name: '可可·云夏', voice: '可可·云夏', model: 'kokoro', sid: 51, speed: 1.0, desc: 'Kokoro 中文男声，偏低' },
  { name: '可可·云扬', voice: '可可·云扬', model: 'kokoro', sid: 52, speed: 1.0, desc: 'Kokoro 中文男声，偏硬' },
  { name: '本地快声', voice: '本地快声', model: 'melo', sid: 0, speed: 1.0, desc: 'MeloTTS 女声，44.1kHz，快但情绪平' },
];

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TMP_DIR = path.join(HERE, 'data', 'voice-tmp');
const CACHE = new Map();
const CACHE_MAX = 40;

export async function synthVoice(text, voiceName = 'zh-CN-XiaoyiNeural', opts = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('空文本');
  // 语速/音高/音量：'%' 相对值（'+10%' / '-4%'），音高用 'Hz'（'+4Hz'）
  const rate = opts.rate || '';
  const pitch = opts.pitch || '';
  const volume = opts.volume || '';
  // 本地离线引擎（VOICE_ENGINE=local）：模型在 voice-models/ 里，跑不动就退回 Edge
  if ((process.env.VOICE_ENGINE || 'edge').toLowerCase() === 'local') {
    const lv = LOCAL_VOICES.find((v) => v.name === voiceName || v.voice === voiceName);
    const model = lv ? lv.model : (process.env.VOICE_LOCAL_MODEL || 'melo');
    const sid = lv ? lv.sid : Number(process.env.VOICE_LOCAL_SID || 0);
    const speed = (lv && lv.speed) || 1.0;
    const lkey = ['local', model, sid, speed, clean].join('|');
    if (CACHE.has(lkey)) return CACHE.get(lkey);
    try {
      const buf = await synthVoiceLocalAsync(clean, { model, sid, speed: opts.speed || speed });
      CACHE.set(lkey, buf);
      if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
      return buf;
    } catch (e) {
      console.log('[语音] 本地合成失败，这次改用 Edge：' + ((e && e.message) || e));
    }
  }

  const key = [voiceName, rate, pitch, volume, clean].join('|');
  if (CACHE.has(key)) return CACHE.get(key);

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, crypto.createHash('md5').update(key).digest('hex') + '.mp3');
  const tts = new EdgeTTS({
    voice: voiceName,
    lang: 'zh-CN',
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    saveSubtitles: false,
    ...(rate ? { rate } : {}),
    ...(pitch ? { pitch } : {}),
    ...(volume ? { volume } : {}),
  });
  await tts.ttsPromise(clean, file);
  const buf = fs.readFileSync(file);
  try { fs.unlinkSync(file); } catch {}
  if (!buf.length) throw new Error('合成出来是空文件');

  CACHE.set(key, buf);
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return buf;
}

// 把一句回话洗成适合朗读的纯文本：去掉表情包标记、emoji、多余的标点
export function toSpeechText(text) {
  return String(text || '')
    .replace(/\[表情(?::[^\]]{1,10})?\]/g, '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[~～]+/g, '，')
    .replace(/\s*\n+\s*/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/^[，。！？]+/, '')
    .trim();
}
