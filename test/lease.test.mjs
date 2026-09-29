// 失联自动释放集成测试：
// 启动一个 800ms 心跳超时的独立服务实例，持有者停止心跳（模拟失联），
// 验证租约在超时后自动释放且广播 locked=false，其他控制台可接管。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_PORT || 3199;
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  });
}
async function next(inbox, type, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT), HEARTBEAT_TIMEOUT_MS: '800', HEARTBEAT_REAPER_MS: '200' },
  stdio: 'ignore',
});

try {
  // 等服务起来
  for (let i = 0; i < 50; i++) {
    try { await connect().then((c) => c.ws.close()); break; } catch { await sleep(100); }
  }

  const holder = await connect();
  await next(holder.inbox, 'hello');
  await next(holder.inbox, 'snapshot');
  holder.ws.send(JSON.stringify({ command: 'acquire' }));
  const g = await next(holder.inbox, 'control');
  if (!g.granted) throw new Error('获取控制权失败');
  console.log('  ✓ 控制台获得控制权');

  const watcher = await connect();
  await next(watcher.inbox, 'hello');
  await next(watcher.inbox, 'snapshot');

  // 持有者既不心跳也不主动断开 —— 模拟进程挂起/网络静默
  console.log('  · 模拟持有者失联（停发心跳）…');
  const t0 = Date.now();
  const releasedSnap = await next(watcher.inbox, 'snapshot', 5000);
  const elapsed = Date.now() - t0;

  if (releasedSnap.locked !== false) throw new Error('失联后未释放 locked=true');
  console.log(`  ✓ 约 ${elapsed}ms 后服务端自动释放（locked=false）`);

  // 持有者自己应收到释放通知
  const notice = await next(holder.inbox, 'control', 2000).catch(() => null);
  if (!notice || notice.granted !== false) throw new Error('持有者未收到释放通知');
  console.log('  ✓ 失联方收到释放通知 reason=' + notice.reason);

  // 其他控制台立刻可接管
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  other.ws.send(JSON.stringify({ command: 'acquire' }));
  const take = await next(other.inbox, 'control', 2000);
  if (!take.granted) throw new Error('释放后其他控制台无法接管');
  console.log('  ✓ 其他控制台成功接管');

  holder.ws.close();
  watcher.ws.close();
  other.ws.close();
  console.log('\n失联释放测试：4 通过，0 失败');
} catch (e) {
  console.error('  ✗', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
