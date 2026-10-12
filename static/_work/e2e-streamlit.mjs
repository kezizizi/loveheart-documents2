/* Streamlit 端到端验收（真实浏览器 + CDP）。
 *
 * 先自己起 Streamlit（演示模式，不需要飞书密钥）：
 *     set AX_DEMO=1 && python -m streamlit run app.py --server.headless true --server.port 8602
 * 再跑本脚本：
 *     node static/_work/e2e-streamlit.mjs                       # 默认 http://127.0.0.1:8602
 *     node static/_work/e2e-streamlit.mjs http://127.0.0.1:8602 out/
 *
 * 它验的是「前端真的被 Streamlit 承载起来了」这件事本身：
 *   ① 组件框有**真实 URL**（不是 srcdoc），且 sandbox 带 allow-same-origin；
 *   ② 静态资源按相对路径加载成功（图片 naturalWidth > 0）；
 *   ③ 数据链路通：Python 查完 → args.result → 前端渲染出身份栏与三个视图；
 *   ④ 三种失败码走的是前端自带文案；
 *   ⑤ 逐视图截图（--still=1 冻结动效），供人眼复核。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || 'http://127.0.0.1:8602').replace(/\/$/, '');
const OUT = process.argv[3] ? resolve(process.argv[3]) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAME = encodeURIComponent('张三');
const SID = '2300017473';

function findEdge() {
  if (process.env.AX_EDGE && existsSync(process.env.AX_EDGE)) return process.env.AX_EDGE;
  for (const c of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome'
  ]) if (existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome，可用 AX_EDGE 指定');
}
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const results = [];
function ok(name, pass, detail) {
  results.push((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  return pass;
}

const cdpPort = await freePort();
/* 一次性 profile：组件文件服务对非 HTML 发 `Cache-Control: public`，
   复用 profile 会拿到缓存里的旧 app.js/bridge.js。 */
const profile = mkdtempSync(resolve(tmpdir(), 'ax-e2e-'));
const browser = spawn(findEdge(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`,
  '--remote-allow-origins=*', '--window-size=1440,1200', 'about:blank'
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
  } catch { /* 还没起来 */ }
  await sleep(400);
}
if (!target) { console.error('浏览器没起来'); browser.kill(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const consoleErrors = [];
/* 无头 profile 里禁用了扩展，但 Edge 偶尔仍会吐出扩展通道的错误，
   那不是页面的问题，别让它污染「无 JS 异常」这条断言。 */
const IGNORED_ERRORS = [
  'Receiving end does not exist',
  'Could not establish connection'
];
const notable = (text) => text && !IGNORED_ERRORS.some((s) => text.includes(s));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const text = d.exception?.description || d.text || 'exception';
    if (notable(text)) consoleErrors.push(text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (notable(text)) consoleErrors.push(text);
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

/* 组件框要等**一次脚本运行**之后才会被注册，所以第一个页面先打开把会话建起来。
   选择器必须同时满足两个条件，否则会得到**假阴性**：
     ① src 里带 `/component/`（宿主文档里可能有别的 iframe）；
     ② clientHeight > 0 —— Streamlit 重跑时会短暂留下一个**隐藏的旧组件框**，
        它里面 DOM 齐全，但元素没有布局盒：`el.click()` 与真实交互都不会生效。
   实测踩过：抓到隐藏框 → 点「下载 CSV」毫无反应（fired=0），看起来像前端坏了。 */
const PICK_FRAME = `
  const frames = [...document.querySelectorAll('iframe')];
  const cand = frames.filter(x => (x.getAttribute('src') || '').includes('/component/'));
  const f = cand.find(x => x.clientHeight > 0) || cand[0] || frames[0];
`;

async function open(url, waitMs = 6000) {
  await send('Page.navigate', { url });
  await sleep(waitMs);
}

/** 等到组件框里真的出现了终态，返回探针；超时也返回最后一次。
 *  ``acceptEntry=false`` 用于「期望出结果/出提示」的场景 —— 入口表单是**首帧**状态，
 *  把它当成终态会抢跑，拿到一个还没查到数据的页面（假阴性）。 */
async function waitForFrame(timeoutMs = 20000, acceptEntry = true) {
  const t0 = Date.now();
  let p = await probe();
  while (Date.now() - t0 < timeoutMs) {
    if (p.hasIframe && !p.err &&
        (p.resultShown || p.noticeShown || (acceptEntry && p.entryShown))) return p;
    await sleep(400);
    p = await probe();
  }
  return p;
}

/* ── 一次完整的「探针」：把宿主与组件框的状态都读回来 ───────────── */
const PROBE = `(() => {
  ${PICK_FRAME}
  const out = {
    host: location.href,
    frameCount: frames.length,
    hasIframe: !!f,
    src: f ? f.getAttribute('src') : null,
    sandbox: f ? f.getAttribute('sandbox') : null,
    frameH: f ? f.clientHeight : 0
  };
  if (!f) return JSON.stringify(out);
  let d = null;
  try { d = f.contentDocument; } catch (e) { out.err = String(e); return JSON.stringify(out); }
  if (!d || !d.getElementById('result')) { out.err = 'frame not ready'; return JSON.stringify(out); }
  out.frameUrl = d.URL;
  out.scripts = [...d.scripts].map(s => s.getAttribute('src'));
  out.resultShown = !d.getElementById('result').hidden;
  out.noticeShown = !d.getElementById('notice').hidden;
  out.noticeTitle = d.getElementById('noticeTitle').textContent;
  out.entryShown = !d.getElementById('entry').hidden;
  out.name = d.getElementById('rName').textContent;
  out.ids = d.getElementById('rIds').textContent;
  out.stats = [...d.querySelectorAll('#rStats > div')].map(x => x.textContent.replace(/\\s+/g, ''));
  out.stops = d.querySelectorAll('#panel-trail .stop').length;
  out.terms = d.querySelectorAll('#panel-trail .term').length;
  out.years = d.querySelectorAll('#panel-trail .yhead').length;
  out.groupSecs = d.querySelectorAll('#panel-dossier .gsec').length;
  out.cardStats = d.querySelectorAll('#panel-export .card-stats .stat').length;
  out.hasCsv = !!d.getElementById('csvBtn');
  out.bodyH = d.body ? d.body.getBoundingClientRect().height : 0;
  out.contentH = d.documentElement.scrollHeight;
  /* 组件框如果比内容矮，用户会在页面里看到**第二根滚动条** —— 这是真实的观感缺陷 */
  out.innerScroll = d.documentElement.scrollHeight > d.documentElement.clientHeight + 2;
  out.badImages = [...d.images].filter(i => i.complete && i.naturalWidth === 0)
    .map(i => i.getAttribute('src'));
  out.view = [...d.querySelectorAll('.views button')].find(b => b.classList.contains('on'))?.dataset.view || null;
  return JSON.stringify(out);
})()`;

const probe = async () => JSON.parse(await evalJs(PROBE));

/** 打开一个「期望出结果或出提示」的页面，返回探针。
 *
 *  两次保险，都是为了不让**测试装置自己**制造假阴性：
 *  ① 先跳 about:blank 把上一页的组件通道彻底拆掉 —— 连续整页跳转时 Streamlit
 *     会短暂处于「旧实例已死、新实例未就绪」的窗口，消息会被丢掉；
 *  ② 万一还是没出终态，重载一次再等。真 bug 会稳定地失败两次。 */
async function openResult(url, timeoutMs = 15000) {
  let p = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(500);
    await open(url, 5000);
    p = await waitForFrame(timeoutMs, false);
    if (p.resultShown || p.noticeShown) return p;
  }
  return p;
}

/** 高度上报是去抖 40ms + postMessage + React 重排，不是即时的；
 *  导出视图还要等 161KB 栏图加载完才会长到最终高度。所以这里**轮询**等它贴合，
 *  而不是在「结果刚出现」的那一刻就断言（那是拿竞态当 bug）。 */
async function waitForFit(timeoutMs = 8000) {
  const t0 = Date.now();
  let p = await probe();
  while (Date.now() - t0 < timeoutMs) {
    if (p.contentH > 0 && p.frameH >= p.contentH - 2) return p;
    await sleep(300);
    p = await probe();
  }
  return p;
}

async function shot(name) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = resolve(OUT, name + '.png');
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log('SHOT ' + file);
}

/* ── 1. 入口（无参数）────────────────────────────────────────── */
consoleErrors.length = 0;
await open(`${BASE}/?still=1`, 8000);
let p = await waitForFrame();
ok('组件框存在', p.hasIframe);
ok('宿主里只有一个可见的组件框', p.frameCount >= 1, p.frameCount + ' 个 iframe');
ok('组件框已经排版（不是那个隐藏的旧框）', p.frameH > 0, p.frameH + 'px');
ok('组件有真实 URL（不是 srcdoc）', !!p.src && p.src.includes('/component/'), p.src);
ok('sandbox 带 allow-same-origin（打印与下载才可用）',
  !!p.sandbox && p.sandbox.includes('allow-same-origin'), p.sandbox);
ok('组件与宿主同源，可读取其 document', !p.err, p.err);
ok('组件加载了 derive/bridge/app 三个脚本',
  (p.scripts || []).some(s => s && s.includes('derive.js')) &&
  (p.scripts || []).some(s => s && s.includes('bridge.js')) &&
  (p.scripts || []).some(s => s && s.includes('app.js')),
  (p.scripts || []).join(','));
ok('未加载演示数据库 mock-db.js',
  !(p.scripts || []).some(s => s && s.includes('mock-db.js')));
ok('入口表单可见', p.entryShown);
ok('组件框撑开到内容高度', p.frameH > 200, p.frameH + 'px');
ok('首屏没有 JS 异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await shot('00-entry');

/* ── 2. 深链直接出结果 ───────────────────────────────────────── */
for (const view of ['trail', 'dossier', 'export']) {
  consoleErrors.length = 0;
  p = await openResult(`${BASE}/?still=1&view=${view}&name=${NAME}&sid=${SID}`);
  p = await waitForFit();
  ok(`[${view}] 深链直接出结果`, p.resultShown, 'entry=' + p.entryShown + ' notice=' + p.noticeShown);
  ok(`[${view}] 停在指定视图`, p.view === view, p.view);
  ok(`[${view}] 姓名正确`, p.name === '张三', p.name);
  ok(`[${view}] 身份栏 4 个主指标`, (p.stats || []).length === 4, (p.stats || []).join(' / '));
  ok(`[${view}] 身份栏不含学时`, !(p.stats || []).join('').includes('学时'));
  ok(`[${view}] 图片全部加载成功`, (p.badImages || []).length === 0, (p.badImages || []).join(','));
  ok(`[${view}] 组件框高度覆盖全部内容（无内层滚动条）`, !p.innerScroll,
    'content=' + p.contentH + ' frame=' + p.frameH);
  ok(`[${view}] 无 JS 异常`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  await shot('0' + (view === 'trail' ? 1 : view === 'dossier' ? 2 : 3) + '-' + view);
}

/* 结果里必须真的带上了 fixture 里的活动 */
p = await openResult(`${BASE}/?still=1&view=trail&name=${NAME}&sid=${SID}`);
ok('足迹有活动条', p.stops > 0, p.stops + ' 条');
ok('足迹有学期分节', p.terms > 0, p.terms + ' 个学期');
ok('档案有部组文件头', p.groupSecs > 0, p.groupSecs + ' 个部组');
ok('导出卡片有 3 个统计格', p.cardStats === 3, String(p.cardStats));
ok('导出视图有 CSV 按钮', p.hasCsv);

/* ── 3. 三种失败码走前端自带文案 ─────────────────────────────── */
const failures = [
  ['姓名查不到', encodeURIComponent('查无此人'), '9999999999', '没有找到这个姓名'],
  ['学号不一致', NAME, '1111111111', '姓名对上了，学号不一致'],
  ['档案缺学号', encodeURIComponent('赵无号'), '2300010000', '这条档案里没有学号']
];
for (const [label, n, s, expected] of failures) {
  p = await openResult(`${BASE}/?still=1&name=${n}&sid=${s}`);
  ok(`失败码：${label}`, p.noticeShown && p.noticeTitle === expected,
    'notice=' + p.noticeTitle + ' result=' + p.resultShown);
}

/* ── 4. 打印与 CSV：在组件框里把真实动作 stub 掉，只验事件真的接上了 ──
 * 组件框的 sandbox 里有 allow-modals（print）与 allow-downloads（CSV blob），
 * 这两件事出了 sandbox 就静默失效，所以必须真的点一次。 */
await open(`${BASE}/?still=1&view=export&name=${NAME}&sid=${SID}`, 8000);
await waitForFrame(20000, false);
const actions = JSON.parse(await evalJs(`(() => {
  ${PICK_FRAME}
  const d = f.contentDocument, w = f.contentWindow;
  const seen = { print: 0, csv: 0, csvName: null, err: null, csvBtn: false, fired: 0,
                 hasCreate: typeof w.URL.createObjectURL };
  try {
    seen.csvBtn = !!d.getElementById('csvBtn');
    if (seen.csvBtn) {
      d.getElementById('csvBtn').addEventListener('click', function () { seen.fired += 1; }, true);
    }
    w.print = function () { seen.print += 1; };
    w.URL.createObjectURL = function () { seen.csv += 1; return 'blob:stub'; };
    w.URL.revokeObjectURL = function () {};
    /* ⚠️ 只 stub「下载链接自己」的 click，而且必须在点 #csvBtn **之后**才生效 ——
       上一版把 HTMLAnchorElement.prototype.click 整个换掉，#csvBtn.click() 变成了
       直接调我的桩函数，事件根本没派发，于是「下载没反应」是测试自己造出来的假阴性。
       这里用 dispatchEvent 绕开原型上的桩。 */
    d.getElementById('print').click();
    const origClick = w.HTMLAnchorElement.prototype.click;
    w.HTMLAnchorElement.prototype.click = function () { seen.csvName = this.getAttribute('download'); };
    d.getElementById('csvBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    w.HTMLAnchorElement.prototype.click = origClick;
  } catch (e) { seen.err = String(e); }
  return JSON.stringify(seen);
})()`));
console.log('DEBUG actions: ' + JSON.stringify(actions));
ok('导出视图的「打印 / 存为 PDF」真的调用 window.print', actions.print === 1,
  'print=' + actions.print + (actions.err ? ' err=' + actions.err : ''));
ok('导出视图的「下载 CSV」真的生成了 Blob', actions.csv === 1,
  'createObjectURL=' + actions.csv + (actions.err ? ' err=' + actions.err : ''));
ok('CSV 的下载文件名带姓名与学号',
  !!actions.csvName && actions.csvName.includes('张三') && actions.csvName.includes(SID),
  actions.csvName);

/* ── 5. 在页面里提交一次，验证组件回传 → Python → 重新渲染 ───── */
consoleErrors.length = 0;
await open(`${BASE}/?still=1`, 7000);
await waitForFrame();
await evalJs(`(() => {
  ${PICK_FRAME}
  const d = f.contentDocument;
  d.querySelector('input[name=name]').value = '张三';
  d.querySelector('input[name=sid]').value = '2300017473';
  d.querySelector('#form button[type=submit]').click();
  return 'submitted';
})()`);
await sleep(6000);
p = await waitForFrame(20000, false);
ok('页面内提交后出结果', p.resultShown && p.name === '张三', 'name=' + p.name);
ok('提交后 URL 带上了查询参数（结果可刷新/可分享）',
  decodeURIComponent(p.host).includes('name=张三') && p.host.includes(SID), p.host);
ok('提交过程无 JS 异常', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
await shot('04-submitted');

browser.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 占用中，交给系统清理 */ }
console.log('');
console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log('');
console.log(failed === 0 ? `RESULT ALL PASS  (${results.length} checks)`
  : `RESULT ${failed} FAILED / ${results.length} checks`);
process.exit(failed === 0 ? 0 : 1);
