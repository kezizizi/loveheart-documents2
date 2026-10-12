/* 前端自检的一键跑法（真实浏览器 + CDP）。
 *
 * 为什么不用文档里原来那条 `msedge --headless=new --virtual-time-budget=… --dump-dom`：
 * `/web/index.html` 会在运行时**动态加载** data/mock-db.js（独立形态才加载）。
 * 虚拟时间预算会在动态脚本到位之前就把页面判定为「没有待办任务」而收工，
 * 于是自检拿到的是一个还没出结果的页面，报 `EXCEPTION timeout` —— 是跑法的假阴性，
 * 不是前端坏了。这里改用 CDP：等 `#report` 里真的出现 RESULT 再收。
 *
 * 用法（自带静态服务器，自选空闲端口，不碰任何已有进程）：
 *     node static/_work/run-selftest.mjs
 *
 * 可选环境变量：
 *     AX_EDGE    指定 msedge.exe 路径
 *     AX_PYTHON  指定 python 可执行文件（默认 "python"）
 *     AX_TIMEOUT 等待毫秒数（默认 180000）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));      // <static>/_work
const STATIC_DIR = resolve(HERE, '..');
const PYTHON = process.env.AX_PYTHON || 'python';
const TIMEOUT = Number(process.env.AX_TIMEOUT || 180000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  if (process.env.AX_EDGE && existsSync(process.env.AX_EDGE)) return process.env.AX_EDGE;
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome'
  ];
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome，可用 AX_EDGE 指定');
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function json(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return r.json();
}

const webPort = await freePort();
const cdpPort = await freePort();
const children = [];
let profileDir = null;
function cleanup() {
  for (const c of children) { try { c.kill(); } catch { /* 已退出 */ } }
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 占用中 */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

/* 1) 静态服务器：只挂 static/，与生产「只公开组件目录」的口径一致 */
const serve = spawn(PYTHON, [resolve(HERE, 'serve.py'), STATIC_DIR, String(webPort)], { stdio: 'ignore' });
children.push(serve);
for (let i = 0; i < 40; i++) {
  try { await fetch(`http://127.0.0.1:${webPort}/web/index.html`); break; } catch { await sleep(250); }
}

/* 2) 浏览器。用**全新的一次性 profile**：组件文件服务对非 HTML 资源发的是
 * `Cache-Control: public`，复用 profile 会让浏览器拿缓存里的旧 app.js/bridge.js，
 * 于是「改了代码却看到旧行为」—— 这个坑真的踩过。 */
const profile = mkdtempSync(resolve(tmpdir(), 'ax-selftest-'));
profileDir = profile;
const edge = spawn(findEdge(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-extensions-with-background-pages',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*',
  '--window-size=1440,1000', 'about:blank'
], { stdio: 'ignore' });
children.push(edge);

let target = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await json(cdpPort, '/json/list');
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
  } catch { /* 还没起来 */ }
  await sleep(400);
}
if (!target) { console.error('浏览器没起来'); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
/* 无头浏览器默认「窗口没有焦点」，于是 `el.focus()` 不会派发 focus 事件 ——
 * 自检里「键盘聚焦圆点等价于悬停」那一条必然假阴性（在**未改动**的原版前端上
 * 同样复现，不是前端的问题）。打开焦点模拟，让无头会话等价于一个真实的前台窗口。 */
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.navigate', { url: `http://127.0.0.1:${webPort}/_work/selftest.html` });

/* 3) 等报告出现终局结论 */
const t0 = Date.now();
let report = '';
while (Date.now() - t0 < TIMEOUT) {
  const r = await send('Runtime.evaluate', {
    expression: 'document.getElementById("report") ? document.getElementById("report").textContent : ""',
    returnByValue: true
  });
  report = r.result?.result?.value || '';
  if (/^RESULT /m.test(report)) break;
  await sleep(1000);
}
ws.close();
cleanup();

if (!/^RESULT /m.test(report)) {
  console.error('自检没有给出结论（超时）。当前报告：\n' + report);
  process.exit(2);
}
console.log(report);
process.exit(/^RESULT ALL PASS/m.test(report) ? 0 : 1);
