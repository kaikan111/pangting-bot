// 本地合成放在 worker 线程里跑：模型加载和推理都是同步重活，放主线程会把整个 bot 卡住几秒
import { parentPort } from 'node:worker_threads';
import { synthVoiceLocal } from './voice-local.mjs';

parentPort.on('message', (m) => {
  try {
    const buf = synthVoiceLocal(m.text, m.opts || {});
    parentPort.postMessage({ id: m.id, buf });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) });
  }
});
