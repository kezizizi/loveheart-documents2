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
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-extensions-with-background-pages',
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

/* ── 4. 导出产物：必须真的是 PNG，且要能解码 ────────────────────
 * 用户明确要求「确保实际产物是 PNG」，所以这里不验「事件接上了」，
 * 而是把 Blob **读出来**验三件事：
 *   ① blob.type === 'image/png'（MIME）；
 *   ② 文件头是 PNG 的魔数 \x89PNG\r\n\x1a\n（内容，防止有人把 JPEG 装进 PNG 的 MIME）；
 *   ③ 用它 new Image() 能解码出正尺寸（真能被相册/微信打开）；
 *   ④ 下载文件名以 .png 结尾且带姓名学号。
 * 顺带把这张 PNG 落盘到 e2e-shots/export-card.png —— 肉眼看一眼是最强的验证。
 * 组件框的 sandbox 里有 allow-downloads（CSV blob）。print/PDF 那条路已删除。 */
await open(`${BASE}/?still=1&view=export&name=${NAME}&sid=${SID}`, 8000);
await waitForFrame(20000, false);
const actions = JSON.parse(await evalJs(`(async () => {
  ${PICK_FRAME}
  const d = f.contentDocument, w = f.contentWindow;
  const seen = { png: 0, csv: 0, csvName: null, pngName: null, err: null,
                 pngBtn: false, fired: 0, type: null, magic: null, dataUrl: null,
                 natural: null, size: null, hasPrintBtn: !!d.getElementById('print') };
  try {
    seen.pngBtn = !!d.getElementById('pngBtn');
    if (seen.pngBtn) {
      d.getElementById('pngBtn').addEventListener('click', function () { seen.fired += 1; }, true);
    }
    /* 拦住下载：拿到真正的 Blob 而不是让它落进下载目录 */
    const origCreate = w.URL.createObjectURL;
    const origClick = w.HTMLAnchorElement.prototype.click;
    let blob = null;
    w.URL.createObjectURL = function (b) { blob = b; return origCreate.call(w.URL, b); };
    w.HTMLAnchorElement.prototype.click = function () { seen.pngName = this.getAttribute('download'); };
    if (seen.pngBtn) {
      d.getElementById('pngBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    /* 生图是异步的（fetch 图片 → 画 → toBlob），轮询等 Blob 出现 */
    for (let i = 0; i < 60 && !blob; i++) await new Promise(r => setTimeout(r, 250));
    if (blob) {
      seen.type = blob.type;
      seen.size = blob.size;
      const buf = new Uint8Array(await blob.arrayBuffer());
      seen.magic = Array.from(buf.slice(0, 8)).join(',');
      seen.dataUrl = await new Promise(res => {
        const fr = new w.FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
      seen.natural = await new Promise(res => {
        const im = new w.Image();
        im.onload = () => res([im.naturalWidth, im.naturalHeight]);
        im.onerror = () => res(null);
        im.src = URL.createObjectURL(blob);
      });
    }
    w.URL.createObjectURL = origCreate;
    w.HTMLAnchorElement.prototype.click = origClick;
  } catch (e) { seen.err = String(e); }
  return JSON.stringify(seen);
})()`));
const PNG_MAGIC = '137,80,78,71,13,10,26,10';   /* \x89 P N G \r \n \x1a \n */
ok('导出视图有「保存为长图（PNG）」按钮', actions.pngBtn === true);
ok('导出视图不再有打印 / 存为 PDF 按钮（那条路已删除）', actions.hasPrintBtn === false);
ok('点按钮真的触发了一次导出', actions.fired === 1 && !actions.err,
  `fired=${actions.fired}${actions.err ? ' err=' + actions.err : ''}`);
ok('产物 MIME 是 image/png', actions.type === 'image/png', String(actions.type));
ok('产物文件头是 PNG 魔数（不是把别的格式装进 PNG 的 MIME）',
  actions.magic === PNG_MAGIC, String(actions.magic));
ok('产物能被浏览器解码成正尺寸位图', Array.isArray(actions.natural) &&
  actions.natural[0] > 400 && actions.natural[1] > 400,
  String(actions.natural));
ok('下载文件名以 .png 结尾且带姓名与学号',
  !!actions.pngName && actions.pngName.endsWith('.png') &&
  actions.pngName.includes('张三') && actions.pngName.includes(SID), actions.pngName);
/* 把 PNG 落盘：肉眼看一眼是最终验证，也留作回归证据 */
if (actions.dataUrl && actions.dataUrl.startsWith('data:image/png')) {
  const file = resolve(OUT, 'export-card.png');
  writeFileSync(file, Buffer.from(actions.dataUrl.split(',')[1], 'base64'));
  console.log('SHOT ' + file + '  (' + Math.round(actions.size / 1024) + ' KB)');
}

/* CSV 是已有功能，别让它被 PNG 的改动带坏 */
const csvSeen = JSON.parse(await evalJs(`(() => {
  ${PICK_FRAME}
  const d = f.contentDocument, w = f.contentWindow;
  const out = { name: null, fired: 0, bytes: 0, err: null };
  try {
    const b = d.getElementById('csvBtn');
    if (!b) return JSON.stringify(out);
    b.addEventListener('click', function () { out.fired += 1; }, true);
    const origCreate = w.URL.createObjectURL;
    const origClick = w.HTMLAnchorElement.prototype.click;
    let blob = null;
    w.URL.createObjectURL = function (x) { blob = x; return origCreate.call(w.URL, x); };
    w.HTMLAnchorElement.prototype.click = function () { out.name = this.getAttribute('download'); };
    b.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    out.bytes = blob ? blob.size : 0;
    w.URL.createObjectURL = origCreate;
    w.HTMLAnchorElement.prototype.click = origClick;
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()`));
ok('「下载 CSV」仍然生成非空的 CSV 文件',
  csvSeen.fired === 1 && csvSeen.bytes > 0 && !!csvSeen.name && csvSeen.name.endsWith('.csv'),
  `fired=${csvSeen.fired} bytes=${csvSeen.bytes} name=${csvSeen.name}${csvSeen.err ? ' err=' + csvSeen.err : ''}`);

/* 时间口径：导出卡片必须写「2025秋至 <今天>」（不是「数据截至」） */
const todayDot = (() => {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
})();
const scopeCard = await evalJs(`(() => {
  ${PICK_FRAME}
  const el = f.contentDocument.querySelector('#panel-export .card-foot .asof');
  return el ? el.textContent : null;
})()`);
ok('导出卡片写的是「2025秋至 <今天>」（不再是「数据截至」）',
  scopeCard === '2025秋至 ' + todayDot, `${scopeCard}（期望 2025秋至 ${todayDot}）`);

/* ── 4. 宿主滚动 + 组件内交互状态（这两条是补上的回归）────────────
 * 两个都真实出过事故，而且**只靠肉眼看渲染结果是发现不了的**：
 * ① 我在外壳 CSS 里把 stMain 的 overflow 设成 visible，而它就是唯一的滚动容器
 *    （父级 stAppViewContainer 是 hidden、文档本身不滚）→ 整页完全滚不动。
 * ② Streamlit 会在组件元素自身重排时重发 render；若见 render 就重建 DOM，
 *    用户在页面里的状态会被抹掉 → 档案里点开部组「展开又立刻收回」。
 * 这里用**真实滚轮事件**和**等待**来验，而不是只看样式表。 */
console.log('\n===== 宿主滚动与交互状态 =====');
/* 滚动必须在**真的比视口高**的页面上验：档案视图只有几百像素，
   在它上面测「能不能滚」会得到「没东西可滚」的假阴性 —— 第一次就栽在这。
   足迹视图是最高的那个（1600+px）。 */
p = await openResult(`${BASE}/?still=1&view=trail&name=${NAME}&sid=${SID}`);
await waitForFit();

const scrollInfo = JSON.parse(await evalJs(`(() => {
  const box = (sel) => { const el = document.querySelector(sel); return el
    ? { sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop, ov: getComputedStyle(el).overflowY } : null; };
  return JSON.stringify({
    docEl: box('html'), body: box('body'),
    appView: box('[data-testid="stAppViewContainer"]'),
    stMain: box('[data-testid="stMain"]')
  });
})()`));
ok('页面内容比视口高（前提：确实有东西可滚）',
  Math.max(scrollInfo.stMain?.sh || 0, scrollInfo.appView?.sh || 0) >
  Math.max(scrollInfo.stMain?.ch || 0, scrollInfo.appView?.ch || 0) + 50,
  `stMain ${scrollInfo.stMain?.sh}/${scrollInfo.stMain?.ch}`);

const scrollableBox = (scrollInfo.stMain?.sh > scrollInfo.stMain?.ch && ['auto', 'scroll'].includes(scrollInfo.stMain?.ov))
  ? 'stMain'
  : (scrollInfo.appView?.sh > scrollInfo.appView?.ch && ['auto', 'scroll'].includes(scrollInfo.appView?.ov)) ? 'appView' : null;
ok('存在一个允许用户滚动的容器（overflow 是 auto/scroll，不是 hidden/visible）',
  scrollableBox !== null,
  `stMain.ov=${scrollInfo.stMain?.ov} appView.ov=${scrollInfo.appView?.ov}`);

/* 真的滚一次。用 Input.synthesizeScrollGesture（合成真实手势，会走 Chrome 的
   滚动链），而不是 Input.dispatchMouseEvent('mouseWheel') —— 后者在无头下
   实测派发不到任何元素（位移恒为 0），拿它做断言只能得到假阴性。 */
await send('Input.synthesizeScrollGesture', {
  x: 640, y: 400, xDistance: 0, yDistance: -600, speed: 2000, gestureSourceType: 'mouse'
});
await sleep(900);
const afterWheel = JSON.parse(await evalJs(`(() => {
  const box = (sel) => { const el = document.querySelector(sel); return el ? el.scrollTop : null; };
  const f = [...document.querySelectorAll('iframe')].find(x => (x.getAttribute('src') || '').includes('/component/'));
  let frameTop = null;
  try { frameTop = f.contentWindow.scrollY ?? f.contentDocument.documentElement.scrollTop; } catch (e) { /* 忽略 */ }
  return JSON.stringify({
    stMain: box('[data-testid="stMain"]'), appView: box('[data-testid="stAppViewContainer"]'),
    win: window.scrollY, doc: document.documentElement.scrollTop, frame: frameTop
  });
})()`));
const movedBy = Math.abs(afterWheel.stMain || 0) + Math.abs(afterWheel.appView || 0)
  + Math.abs(afterWheel.win || 0) + Math.abs(afterWheel.doc || 0) + Math.abs(afterWheel.frame || 0);
ok('滚动一次真的能滚起来', movedBy > 0, `位移=${movedBy} ${JSON.stringify(afterWheel)}`);
await shot('05-scrolled');

/* 档案：点开一个部组，等 2.5 秒后它必须还开着 */
p = await openResult(`${BASE}/?still=1&view=dossier&name=${NAME}&sid=${SID}`);
const expandCheck = JSON.parse(await evalJs(`(() => {
  ${PICK_FRAME}
  const d = f.contentDocument;
  const btns = d.querySelectorAll('.views button');
  for (const b of btns) if (b.dataset.view === 'dossier') b.click();
  const plate = d.querySelector('#panel-dossier .gplate');
  if (!plate) return JSON.stringify({ err: '没有部组文件头' });
  plate.click();
  return JSON.stringify({ open: d.querySelectorAll('#panel-dossier .gsec.open').length,
                          name: (d.querySelector('#panel-dossier .gsec.open .gname') || {}).textContent || null });
})()`));
await sleep(2500);
const expandAfter = JSON.parse(await evalJs(`(() => {
  ${PICK_FRAME}
  const d = f.contentDocument;
  return JSON.stringify({ open: d.querySelectorAll('#panel-dossier .gsec.open').length,
                          view: [...d.querySelectorAll('.views button')].find(b => b.classList.contains('on'))?.dataset.view });
})()`));
ok('档案里点开部组后它保持展开（不被重渲染收回）',
  expandCheck.open === 1 && expandAfter.open === 1,
  `点击后 ${expandCheck.open} → 2.5s 后 ${expandAfter.open}（${expandCheck.name || ''}）`);
ok('等候期间视图没有跳回去', expandAfter.view === 'dossier', expandAfter.view);
await shot('06-dossier-expanded');

/* 足迹：展开一条感想，同样必须保持 */
p = await openResult(`${BASE}/?still=1&view=trail&name=${NAME}&sid=${SID}`);
const noteCheck = JSON.parse(await evalJs(`(() => {
  ${PICK_FRAME}
  const d = f.contentDocument;
  const dot = d.querySelector('#panel-trail .stop .ndot.solid');
  if (!dot) return JSON.stringify({ err: '没有实心圆点' });
  dot.dispatchEvent(new d.defaultView.PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true }));
  return JSON.stringify({ open: d.querySelectorAll('#panel-trail .stop.open').length });
})()`));
await sleep(2500);
const noteAfter = JSON.parse(await evalJs(`(() => {
  ${PICK_FRAME}
  const d = f.contentDocument;
  return JSON.stringify({ open: d.querySelectorAll('#panel-trail .stop.open').length });
})()`));
ok('足迹里展开一条感想后它保持展开', noteCheck.open === 1 && noteAfter.open === 1,
  `展开后 ${noteCheck.open} → 2.5s 后 ${noteAfter.open}`);

/* ── 5. 在页面里提交一次，验证组件回传 → Python → 重新渲染 ───── */
consoleErrors.length = 0;
await open(`${BASE}/?still=1`, 7000);
await waitForFrame();
/* 入口页（查询界面）必须体现时间口径「2025秋至 <今天>」 */
const entryScope = await evalJs(`(() => {
  ${PICK_FRAME}
  const el = f.contentDocument.getElementById('scopeLine');
  return el ? el.textContent : null;
})()`);
ok('查询界面（入口页）写明了收录范围「2025秋至 <今天>」',
  !!entryScope && entryScope.indexOf('2025秋') >= 0 && entryScope.indexOf(todayDot) >= 0,
  String(entryScope));
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

/* 回入口页再提交**同一个人** —— 这是去重守卫最容易出错的那一格：
   载荷与上一次一模一样，但那一次必须重新渲染，不能卡在加载态。 */
await evalJs(`(() => {
  ${PICK_FRAME}
  f.contentDocument.getElementById('again').click();
  return 'ok';
})()`);
await sleep(600);
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
ok('同一个人再查一次仍然出结果（不会卡在加载态）',
  p.resultShown && p.name === '张三', `result=${p.resultShown} loading=${p.loading} name=${p.name}`);

browser.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 占用中，交给系统清理 */ }
console.log('');
console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log('');
console.log(failed === 0 ? `RESULT ALL PASS  (${results.length} checks)`
  : `RESULT ${failed} FAILED / ${results.length} checks`);
process.exit(failed === 0 ? 0 : 1);
