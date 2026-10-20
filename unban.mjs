import WebSocket from 'ws';

const [g, u] = process.argv.slice(2);
if (!g || !u) { console.error('用法: node unban.mjs <群号> <QQ号>'); process.exit(1); }
const ws = new WebSocket(process.env.WS_URL || 'ws://127.0.0.1:3001', { headers: { Authorization: 'Bearer ' + (process.env.WS_TOKEN || '') } });
const timer = setTimeout(() => { console.log('超时'); process.exit(1); }, 8000);
ws.on('open', () => {
  ws.send(JSON.stringify({
    action: 'set_group_ban', params: { group_id: Number(g), user_id: Number(u), duration: 0 },
    echo: 'unban-' + Date.now(),
  }));
});
ws.on('message', (raw) => {
  let pkt; try { pkt = JSON.parse(raw.toString()); } catch (e) { return; }
  if (!pkt.echo || !String(pkt.echo).startsWith('unban-')) return;
  console.log('结果: ' + JSON.stringify(pkt));
  clearTimeout(timer); ws.close(); process.exit(pkt.status === 'ok' ? 0 : 1);
});
ws.on('error', (e) => { console.log('连接出错: ' + e.message); process.exit(1); });
