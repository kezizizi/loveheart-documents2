/* 爱心社「爱心足迹」—— 数据通道层（全站唯一的数据来源抽象）
 *
 * 只有两种运行形态：
 *
 * ① Streamlit 组件形态（生产）
 *    index.html 由 `streamlit.components.v1.declare_component(path="static/web")`
 *    提供，因此它有一个**真实 URL**：
 *        http://<host>/component/<模块>.ax_footprint/index.html?streamlitUrl=…
 *    于是 style.css / app.js / assets/** 的相对路径原样可用，一个字都不用改。
 *    查询经官方组件协议回传 Python：{name, sid} → Python 查飞书 → 用 args.result 推回来。
 *
 * ② 独立页面形态（本地设计、_work/selftest.html 自检）
 *    数据来自 data/mock-db.js（**动态加载**）。
 *
 * ⚠️ 假数据库只在形态②才会被加载。生产形态下它连请求都不会发生 ——
 *    交接文档 §4.1 第 6 步那条「接口通了却永远显示演示数据」的坑从结构上被排除。
 *
 * 形态判据（踩过的坑）
 * --------------------
 * 只判 `window.parent !== window` 是**错的**：`_work/selftest.html` 就是把页面放进
 * iframe 里跑的，那样会被误判成组件，于是永远等不到宿主消息，自检在第一句就超时。
 * 所以判据是「被嵌入」**且**「宿主留下了组件的正标记」：URL 上的 `streamlitUrl`
 * 参数，或 iframe 上的 `sandbox` 属性 —— 两者都是 Streamlit 建组件框时必然带上的，
 * 而自检的 iframe 两者都没有。
 * 另外还有一层保险：只要真收到过组件协议的 render 消息，就**永久锁死**演示数据，
 * 之后即便判据失效也只会显示「查不到」，不会拿假数据冒充。
 *
 * 高度回传的坑（实测踩过）
 * ------------------------
 * 组件 iframe 的高度由前端上报。若在收到 render 时**改写 DOM 并立刻回传高度**，
 * 会形成 render → 撑高 iframe → 宿主重排 → 再 render 的自激回路：实测 18 秒内
 * 收到 1149 次 render。因此这里两道闸：40ms 去抖 + **高度没变就不回传**。
 */
(function (global) {
  'use strict';

  var ASSET_V = global.AX_DERIVE.ASSET_V;

  var EMBEDDED = window.parent !== window;
  var MARKED = /[?&]streamlitUrl=/.test(window.location.search) ||
    !!(window.frameElement && window.frameElement.hasAttribute('sandbox'));
  var component = EMBEDDED && MARKED;
  /* locked = 绝不允许使用演示数据。一旦确认为组件形态（或真收到过 render），就上锁。 */
  var locked = component;

  /* ── 调试开关 ──────────────────────────────────────────
     组件形态下，`?still=1&view=…` 这些开关挂在**宿主页面**的 URL 上；
     组件 iframe 自己的 search 里只有 Streamlit 附加的 streamlitUrl。
     宿主地址从 document.referrer 读到（iframe 的 referrer 就是父文档 URL）；
     读不到时再退回 args.params（Python 会把 st.query_params 一并送来）。 */
  var store = {};
  function absorbSearch(search) {
    if (!search) return;
    search.replace(/^\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = i < 0 ? pair : pair.slice(0, i);
      var v = i < 0 ? '' : pair.slice(i + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); v = decodeURIComponent(v.replace(/\+/g, ' ')); }
      catch (e) { /* 保留原样 */ }
      store[k] = v;
    });
  }
  function absorbObject(obj) {
    if (!obj) return;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v === null || v === undefined || v === '') continue;
      store[k] = String(v);
    }
  }
  if (component) {
    try { absorbSearch(new URL(document.referrer).search); } catch (e) { /* 无 referrer */ }
  } else {
    absorbSearch(window.location.search);
  }

  /* 与 URLSearchParams 同形，app.js 不必知道自己跑在哪种形态里 */
  var params = {
    get: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    has: function (k) { return Object.prototype.hasOwnProperty.call(store, k); },
    all: function () { var o = {}; for (var k in store) o[k] = store[k]; return o; }
  };

  /* ── 与宿主通信 ──────────────────────────────────────── */
  function back(type, data) {
    var msg = { isStreamlitMessage: true, type: type };
    for (var k in (data || {})) {
      if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k];
    }
    window.parent.postMessage(msg, '*');
  }

  /* 高度上报：40ms 去抖 + 高度没变就不发（否则自激） */
  var lastH = 0, ht = 0;
  function contentHeight() {
    /* 量 body 每个子元素的底边，而不是 documentElement.scrollHeight：
       内容比视口矮时后者等于视口高，会一路只增不减，切回入口页就留一片空白。 */
    var kids = document.body.children, max = 0;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      var bottom = r.bottom + (window.scrollY || 0);
      if (bottom > max) max = bottom;
    }
    return Math.ceil(max);
  }
  function reportHeight() {
    if (!component) return;
    clearTimeout(ht);
    ht = setTimeout(function () {
      var h = contentHeight();
      if (h < 1 || Math.abs(h - lastH) < 2) return;
      lastH = h;
      back('streamlit:setFrameHeight', { height: h });
    }, 40);
  }

  /* ── 数据 ────────────────────────────────────────────── */
  var sink = null;
  function onResult(fn) { sink = fn; }

  /* 后端只给「原始记录 + 状态」（交接文档 §3.3.1），派生在这里补齐 ——
     两条数据路径都过这一道，所以 stats/groups/terms/years 全站只有 derive.js 一份实现。
     失败码（NOT_FOUND_* / INVALID_INPUT / ERROR）没有 member，原样透传。 */
  function normalize(payload) {
    if (!payload || payload.status !== 'OK' || !payload.member) return payload;
    return global.AX_DERIVE.build(payload.member, payload.degraded);
  }

  function deliver(payload) { if (sink && payload) sink(payload); }

  var seq = 0;
  function query(name, sid) {
    if (component) {
      /* nonce 不可省：Streamlit 把组件当控件，值没变就不会重跑。
         同一个人连查两次（点了「重新查询」再提交相同姓名学号）会被吞掉。 */
      seq += 1;
      back('streamlit:setComponentValue', {
        value: { name: name, sid: sid, nonce: Date.now() + '-' + seq },
        dataType: 'json'
      });
      return;
    }
    loadMock(function (err) {
      if (err) { deliver({ status: 'ERROR' }); return; }
      var d = params.has('delay') ? Number(params.get('delay')) : 700;
      if (!isFinite(d) || d < 0) d = 700;
      setTimeout(function () {
        var r = normalize(global.MOCK_DB.lookup(name, sid));
        /* ?degraded=1 演示「缺 base:block:read 时部组全判其他」这一态 */
        if (params.get('degraded') === '1') r = global.AX_DERIVE.degrade(r);
        deliver(r);
      }, d);
    });
  }

  function loadMock(cb) {
    if (global.MOCK_DB) return cb(null);
    /* 保险：只要确认过宿主是 Streamlit，演示数据一律不许加载 */
    if (locked) return cb(new Error('组件形态下不加载演示数据'));
    var s = document.createElement('script');
    s.src = 'data/mock-db.js?v=' + ASSET_V;
    s.onload = function () { cb(null); };
    s.onerror = function () { cb(new Error('演示数据库加载失败')); };
    document.head.appendChild(s);
  }

  /* ── 握手 ────────────────────────────────────────────── */
  var heightObserved = false;
  function subscribeHeight() {
    if (heightObserved) return;
    heightObserved = true;
    if (global.ResizeObserver) {
      try { new ResizeObserver(reportHeight).observe(document.body); } catch (e) { /* 老浏览器 */ }
    }
    window.addEventListener('load', reportHeight);
    window.addEventListener('resize', reportHeight);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(reportHeight);
    reportHeight();
  }

  if (EMBEDDED) {
    /* 无条件打个招呼：万一判据失效（未来 Streamlit 改了组件框的构造方式），
       宿主仍会回一条 render，那条消息会立刻把演示数据锁死。 */
    back('streamlit:componentReady', { apiVersion: 1 });
    subscribeHeight();

    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object' || d.type !== 'streamlit:render') return;
      if (!component) {
        /* 收到组件协议消息 = 宿主确实是 Streamlit，纠正判据并永久上锁 */
        component = true;
        locked = true;
        try { absorbSearch(new URL(document.referrer).search); } catch (err) { /* 无 referrer */ }
      }
      absorbObject(d.args && d.args.params);
      reportHeight();
      var payload = d.args && d.args.result;
      /* result 为空（首次进入、或用户还没提交）：交给 app.js 显示入口表单 */
      if (payload) deliver(normalize(payload));
    });
  }

  global.AX_SOURCE = {
    /* 用取值函数而不是快照：app.js 在启动时读它决定要不要自动提交深链，
       而这个判据在极端情况下会被 render 消息纠正。 */
    get standalone() { return !component; },
    params: params,
    query: query,
    onResult: onResult,
    reportHeight: reportHeight
  };
})(window);
