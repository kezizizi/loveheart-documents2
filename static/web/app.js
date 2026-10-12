/* 爱心社「爱心足迹」—— 渲染层
 *
 * 数据来源**不在这里**：全部经 `data/bridge.js` 的 `AX_SOURCE`。
 * 生产形态下由 Streamlit 组件协议回传（宿主是仓库根目录的 app.py），
 * 独立形态下用 data/mock-db.js 的假数据。本文件对两者一视同仁。
 * 派生（stats / groups / terms / years）来自 `data/derive.js`，全站只有一份实现。
 *
 * 硬约束（贯穿全部渲染函数）：不突出「志愿学时」。学时只作为每条记录的一个
 * 灰色小字段出现；主视图不做任何学时求和展示。导出卡片里的「累计学时」是三个
 * 同权重统计格中的第三格，不与另两项区分大小。
 */
(function () {
  'use strict';

  var SRC = window.AX_SOURCE;
  var Q = SRC.params;
  var D = window.AX_DERIVE;
  var STILL = Q.get('still') === '1';
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (STILL) document.body.classList.add('still');

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  /* 日期格式化一律容错：真实档案里「入社日期」可能压根没有（后端会发 null），
     缺了就显示「—」—— 不编造、也不让整页因为一个 null 崩掉。 */
  var cnd = function (s) {
    if (!s) return '—';
    var p = String(s).split('-');
    return p[0] + ' 年 ' + (+p[1]) + ' 月 ' + (+p[2]) + ' 日';
  };
  var dotd = function (s) { return s ? String(s).replace(/-/g, '.') : '—'; };
  var md = function (s) { return s ? String(s).slice(5).replace('-', ' / ') : ''; };

  var state = { result: null, view: Q.get('view') || 'trail' };

  /* 部组宗旨（只放宗旨，不放使命）。这是纯展示常量，因此放在视图层。
     另注：原先这里还有一份「部组目录序号」（GROUP_NO），建好后从没被读过 —— 已删。
     不再使用从学号拼出来的自造档案号 —— 那是系统无法担保的凭证。 */
  var GROUP_MOTTO = {
    '护老部': '温暖暮年，让夕阳再晨；点亮青春，迎朝阳初升',
    '无障碍部': '让“爱”来，让“碍”走',
    '儿童部': '“童”行一段路，“童”画一个梦',
    '手语分社': '让无声的爱在指尖流淌',
    '资助部': '跨越山海，筑桥传爱',
    '组织部': '将你我钩织成网，用爱心凝聚爱心',
    '宣传部': '宣传爱心事业，培养宣传技能',
    '项目组': '爱行万里，筹划为先；教无远近，历历千山',
    '外联部': '联结内外，汇爱成海'
  };

  /* ── 状态切换 ─────────────────────────────────────── */
  /* focusIt：把焦点交到新出现的内容上，键盘与读屏用户才不会停在原地。
     深层链接首次渲染不抢焦点，避免页面一加载就跳。 */
  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  function show(which, focusIt) {
    $('entry').hidden = which !== 'entry';
    $('loading').hidden = which !== 'loading';
    $('notice').hidden = which !== 'notice';
    $('result').hidden = which !== 'result';
    $('again').hidden = which === 'entry';
    window.scrollTo(0, 0);
    if (!focusIt) return;
    if (which === 'notice') focusEl($('notice'));
    else if (which === 'result') focusEl($('result'));
    else if (which === 'entry') focusEl($('form').elements.namedItem('name'));
  }

  /* ── 查不到 / 空记录 的文案 ───────────────────────── */
  var NOTICES = {
    INVALID_INPUT: {
      t: '姓名和学号都要填',
      b: '两项同时匹配才会返回记录。',
      l: ['学号填 10 位数字即可，不要带空格或字母']
    },
    NOT_FOUND_NAME: {
      t: '没有找到这个姓名',
      b: '档案主表里没有这个名字。姓名要和入社时填写的完全一致。',
      l: [
        '试试去掉首尾空格，英文名注意大小写',
        '刚入社或刚改过名字，可能还没进档案',
        '确认无误仍查不到，联系社里的骨干'
      ]
    },
    NOT_FOUND_SID: {
      t: '姓名对上了，学号不一致',
      b: '档案里这个姓名对应的学号和输入的不一致。',
      l: [
        '学号要 10 位，注意别多打空格',
        '用入社时填写的那个学号',
        '姓名相同时系统不会只按姓名认定，以免认成别人的记录'
      ]
    },
    NOT_FOUND_SID_MISSING: {
      t: '这条档案里没有学号',
      b: '找到了这个名字，但档案上没填学号，所以没法确认是你。',
      l: [
        '系统刻意不做「只按姓名匹配」，同名会认错人',
        '请联系骨干在档案里补填学号',
        '补填后就能用姓名 + 学号查到'
      ]
    },
    EMPTY: {
      t: '档案找到了，还没有关联到活动',
      b: '活动记录要和你的档案建立关联，查得到你才看得到。这条档案目前还没关联到任何一场活动。',
      l: [
        '确实参加过活动的话，说明那几条记录还没建立关联',
        '这是数据补录的事，不是你的操作问题',
        '请联系骨干补上关联，之后这里就会出现'
      ]
    },
    /* 「读到了档案，但有的库没读到」时用这一档。
       🚩 绝不与 EMPTY 合并：EMPTY 说的是「你的记录还没建关联，去找骨干补」，
       而这里的问题在系统这一侧（限流 / 网络 / 权限）。把后者说成前者，社员会
       白跑去找骨干，而真正该做的是稍等重试 —— 这正是用户报过的那次。 */
    INCOMPLETE: {
      t: '这次没能读全你的档案',
      b: '有个学年的库这次没读到，和你的信息无关。',
      l: [
        '稍等一会儿再点一次「查看我的足迹」',
        '一直这样的话，请把当时的页面截图发给社里的骨干'
      ]
    },
    /* 后端「检索一次都没成功」时用这一档。
       绝不与 NOT_FOUND_NAME 合并 —— 把「我们没查成」说成「没有这个姓名」，
       会把社员引向补录问卷，而问题其实在系统这一侧。 */
    ERROR: {
      t: '这次没能读到你的档案',
      b: '系统取数时出了点问题，和你的信息无关。',
      l: [
        '稍等一会儿再点一次「查看我的足迹」',
        '一直这样的话，请把当时的页面截图发给社里的骨干'
      ]
    }
  };

  function notice(kind) {
    var n = NOTICES[kind] || NOTICES.ERROR;
    $('noticeTitle').textContent = n.t;
    $('noticeBody').textContent = n.b;
    $('noticeList').innerHTML = n.l.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    show('notice', true);
  }

  /* ── 查询 ─────────────────────────────────────────── */
  /* 提交只负责「把姓名学号交出去」；结果什么时候回来、从哪来，由数据通道决定。
     生产形态：组件把值交给 Python，Python 查完用 args.result 推回来；
     独立形态：bridge 加载演示数据库，模拟一次耗时后回调。 */
  function submit(name, sid) {
    show('loading');
    SRC.query(name, sid);
  }

  /* 数据到达 —— 两种形态共用同一个出口。
     ⚠️ 这里必须先判断「要不要重建 DOM」：
     Streamlit 会在**组件元素自身重排**时重发 render（例如我们上报了新高度之后），
     而重建 DOM 会把用户在页面里的状态全部抹掉 —— 实测症状是
     「档案里点开一个部组，展开了又立刻自己收回去」，足迹里展开的感想同理。
     判据两条，缺一不可：
       ① 这条载荷是在回答用户刚提交的那次查询吗（由数据通道按**身份**判断）→ 是则一定要渲染；
       ② 否则，载荷内容和上一次完全一样 → 是自发重渲染，什么都不做，保住页面状态。
     只看 ② 会坏在「同一个人连查两次」：载荷一模一样，但那一次必须重新渲染。 */
  var lastPayloadJson = null;
  SRC.onResult(function (r) {
    var answersQuery = SRC.claimPending(r);
    var json = JSON.stringify(r);
    if (!answersQuery && json === lastPayloadJson) return;
    lastPayloadJson = json;

    if (!r || r.status !== 'OK') return notice((r && r.status) || 'NOT_FOUND_NAME');
    /* 高度与动效开关可能在首帧之后才随 args 到达，这里再对齐一次 */
    if (Q.get('still') === '1') { STILL = true; document.body.classList.add('still'); }
    if (Q.get('view')) state.view = Q.get('view');
    /* 后端告诉我们：这次**有的库没读到**（unreadBases 非空）→ 结果不完整。
       这时「一场活动都没有」有两种完全不同的解释，必须分开说：
         · 没读全  → 系统侧问题，稍等重试（不许说「去补关联」）
         · 读全了却为空 → 才是数据侧没建关联，让用户去找骨干
       这是用户真实报过的那次：他把 25-26 库没读到，误报成了「记录没建关联」。 */
    var unread = (r.unreadBases || []).slice();
    if (r.stats.count === 0) return notice(unread.length ? 'INCOMPLETE' : 'EMPTY');
    state.result = r;
    render(r);
    showBanners(r, unread);
    show('result', true);
    SRC.reportHeight();
  });

  /* 结果页顶部的说明条：把「不完整」如实说出来，不藏。
     两类事实合成一条，各自独立：部组降级（缺 base:block:read）与库没读到。 */
  function showBanners(r, unread) {
    var lines = [];
    if (r.degraded) lines.push('部组信息暂时取不到，活动记录不受影响。');
    if (unread.length) {
      lines.push('这次没能读全你的档案（' + esc(unread.join('、')) +
        ' 没读到），下面可能少了部分活动。');
    }
    var el = $('degraded');
    el.hidden = lines.length === 0;
    el.innerHTML = lines.map(esc).join('<br>');
  }

  /* ── 身份栏 ───────────────────────────────────────── */
  function renderIdent(r) {
    var m = r.member, s = r.stats;
    $('rName').textContent = m.name;
    /* 院系可能没有（真实档案缺列），缺了就不占位 —— 不要出现「23000… · undefined」 */
    $('rIds').textContent = [m.sid, m.college].filter(function (x) { return !!x; }).join(' · ');
    /* 主指标刻意不含学时：学时不是成绩，不该被摆在最上面。
       同行伙伴统计不到时是 null，显示「—」而不是 0 —— 0 会谎称「没有伙伴」。 */
    $('rStats').innerHTML = [
      ['在社', s.days, '天'],
      ['参与', s.count, '场'],
      ['涉及', s.groupCount, '个部组'],
      ['同行', (s.companions === null || s.companions === undefined) ? '—' : s.companions, '位伙伴']
    ].map(function (x) {
      return '<div><span class="k">' + x[0] + '</span><span class="v">' + x[1] +
        '</span><span class="u">' + x[2] + '</span></div>';
    }).join('');
  }

  /* ── 视图一 · 足迹 ────────────────────────────────── */
  function renderTrail(r) {
    var m = r.member, s = r.stats, total = s.count, n = 0;
    var acts = (m.activities || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var lastAct = acts.length ? acts[acts.length - 1] : null;
    var h = '';
    /* 起点：黑球也是可交互的 —— 悬停让曲线从起点向下起涟漪，点击收起/展开
       「入社日期 + 提问 + 寄语」。默认展开（日期是核心信息，不该默认藏起来）。
       取不到寄语就留空 —— 不编造。 */
    h += '<div class="origin">' +
      '<button type="button" class="ndot ndot-big" aria-expanded="true"' +
        ' aria-controls="origin-detail" aria-label="入社第一天，' + cnd(m.joinDate) +
        '，展开或收起入社寄语"></button>' +
      '<div class="body">' +
      /* 日期在前、与「从这里开始」同级（都是 30px）。收起区放「提问 + 寄语」：
         日期若也一起收起，就与「放大到和从这里开始一样大」互相矛盾了 —— 见交付说明。 */
      '<div class="when">' + cnd(m.joinDate) + '</div>' +
      '<h2>从这里开始</h2>' +
      '<div class="notewrap open" id="origin-detail"><div class="detail">' +
        '<p class="ask">这一天，你的心情是怎样的呢？</p>' +
        (m.joinMessage ? '<blockquote class="joinmsg">' + esc(m.joinMessage) + '</blockquote>' : '') +
      '</div></div>' +
      '<img class="path-art" src="assets/trail-path-ink.png?v=20261013f" alt=""></div></div>';

    r.years.forEach(function (y) {
      h += '<div class="yhead"><span class="yn">' + esc(y.year) + ' 学年</span></div>';
      y.terms.forEach(function (t) {
        h += '<div class="term"><span class="t">' + esc(t.term) + '</span>' +
          '<span class="r"><span class="cnt">' + t.items.length + ' 场</span></span></div>';
        t.items.forEach(function (a, ai) {
          n += 1;
          var w = Math.round(n / total * 100);
          var id = 'n-' + n;
          var what = dotd(a.date) + ' ' + a.name;
          h += '<div class="stop" data-n="' + n + '">' +
            '<div class="g"><span class="gd">' + md(a.date) + '</span>' +
              /* 方案 C：日期下方的压痕方框 + 部组徽记 */
              '<span class="seal"><img src="' + D.markFile(a.group) + '" alt=""></span></div>' +
            /* 圆圈改成按钮：键盘焦点、触摸、aria 全都要靠它。
               solid = 有感想（可展开），hollow = 无感想 */
            '<button type="button" class="ndot' + (a.note ? ' solid' : '') + '"' +
              (a.note
                ? ' aria-expanded="false" aria-controls="' + id +
                  '" aria-label="展开 ' + esc(what) + ' 的感想"'
                : ' aria-label="' + esc(what) + '（这场没有留下感想）"') +
              '></button>' +
            '<div class="b">' +
              '<div class="line1">' +
                '<span class="nm">' + esc(a.name) + '</span>' +
                '<span class="track"><i data-w="' + w + '" style="width:' + w + '%"></i></span>' +
                '<span class="cn"><b>' + n + '</b>/' + total + '</span>' +
              '</div>' +
              '<div class="meta"><span>' + esc(a.group) + '</span>' +
                '<span class="sep">·</span><span class="hrs">' + a.hours.toFixed(1) + ' 学时</span></div>' +
              (a.note
                ? '<div class="notewrap" id="' + id + '"><div class="note">' + esc(a.note) + '</div></div>'
                : '') +
            '</div></div>';
        });
      });
    });

    h += '<div class="today"><div class="node big"></div><div class="body">' +
      '<div class="when">今天 · ' + dotd(new Date().toISOString().slice(0, 10)) + '</div>' +
      '<p class="line">这一路：<span class="nw"><b>' + s.count + '</b> 场</span>' +
      '<span class="nw">· <b>' + s.groupCount + '</b> 个部组</span>' +
      '<span class="nw">· <b>' + s.companions + '</b> 位伙伴</span></p>' +
      (lastAct ? '<p class="sub">最近一次是 ' + dotd(lastAct.date) + ' 的 ' + esc(lastAct.name) + '</p>' : '') +
      '</div></div>';

    $('panel-trail').innerHTML = '<div class="walk">' +
      '<svg class="tl" aria-hidden="true"><path class="tl-path" d=""></path></svg>' + h + '</div>';
    stagger($('panel-trail').querySelectorAll('.origin, .today, .yhead, .term'), 0.05, 0.35);
    observeBars($('panel-trail'));
    bindDots();
    /* 注意：这里【不能】量时间轴 —— render() 是在 setView() 之前跑的，
       此刻面板还是 hidden，scrollHeight 为 0，量出来的全是 0。
       真正的测量放在 setView('trail') 里（面板可见之后）。 */
    armReveal();
  }

  /* ── 时间轴：波动曲线 ─────────────────────────────────
     关键设计决定：曲线的横坐标与圆圈的位置由【同一个函数】给出，
     所以圆圈永远贴在曲线上，不会因为行高变化而漂浮。
     曲线不是穿过固定圆圈的折线 —— 而是先定义波，再把圆点搬到波上。 */
  var TL = { cx: 0, amp: 0, lam: 0, h: 0, ripple: null, raf: 0 };

  function tlWave(y) {
    return TL.cx + TL.amp * Math.sin(2 * Math.PI * y / TL.lam);
  }
  /* 局部涟漪：空心球与实心球【完全同一套算法】，只有参数不同。
     形态 = 行进波。三要素：
       ① 环形包络 ring = exp(−(|d| − speed·t)² / 2w²)：扰动从落点向上下两侧传播；
       ② 空间窗口 q³：振幅随距离渐弱，且在 ad=maxR 处值与一阶导同时归零，不会一刀切；
       ③ 时间脉冲 pulse：缓入缓出，起手为 0。
     波形本身是 sin(2πd/λ − t/105)：沿线的多个波瓣 + 相位随时间推进，
     因此【每一个固定高度都会随波瓣经过而来回摆几次】——这才是波浪感。
     反面教材（上一版我做错的方向）：把 λ 放到远大于波及宽度，整段就会同向偏移，
     看起来像单摆整体左右摆、或像两条线在切换。λ 必须显著小于波及范围。
     旧的振荡形态（mode:'osc'）已删除：它正是"整条曲线像单摆"的来源。 */
  function tlRippleX(y, r, t) {
    if (!r) return 0;
    var d = y - r.y;
    if (r.dir === 'down' && d < 0) return 0;
    var ad = Math.abs(d);
    if (ad > r.maxR) return 0;

    var ring = ad - r.speed * t;
    var env = Math.exp(-(ring * ring) / (2 * r.w * r.w));
    var q = 1 - (ad / r.maxR) * (ad / r.maxR);
    env *= q * q * q;
    var u = t / r.peak;
    var pulse = u < 1 ? u * u * (3 - 2 * u) : Math.exp(-(u - 1) * 1.9);
    return r.amp * env * pulse * Math.sin(2 * Math.PI * d / r.lam - t / r.ph);
  }
  function tlPath(t) {
    var pts = [];
    for (var y = 0; y <= TL.h; y += 6) {
      pts.push((tlWave(y) + tlRippleX(y, TL.ripple, t)).toFixed(1) + ' ' + y);
    }
    return 'M' + pts.join(' L');
  }

    /* 量一次、摆一次。行高变化（比如感想展开）时必须重新调用。 */
  function layoutTimeline() {
    var walk = $('panel-trail').querySelector('.walk');
    if (!walk) return;
    var svg = walk.querySelector('.tl'), path = walk.querySelector('.tl-path');
    if (!svg || !path) return;
    /* 面板还隐藏时没有布局盒，量出来是 0 —— 直接不画，等可见后再来一次 */
    if (walk.scrollHeight < 40) {
      if (!layoutTimeline.retry) {
        layoutTimeline.retry = requestAnimationFrame(function () {
          layoutTimeline.retry = 0; layoutTimeline();
        });
      }
      return;
    }
    var cs = window.getComputedStyle(walk);
    var gut = parseFloat(cs.getPropertyValue('--gut')) || 112;
    var node = parseFloat(cs.getPropertyValue('--node')) || 34;
    var W = walk.clientWidth || 852;
    TL.cx = gut + node / 2;
    TL.amp = W < 720 ? 4 : 7;             /* 幅度克制：不变成波浪装饰 */
    TL.lam = W < 720 ? 300 : 430;
    TL.h = walk.scrollHeight;
    svg.setAttribute('width', W);
    svg.setAttribute('height', TL.h);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + TL.h);
    /* 【必须画当前相位，不能画 0】。
       原来这里写的是 tlPath(0)，也就是静止曲线 —— 而感想展开会调 relayoutFor()
       逐帧重排时间轴，于是涟漪刚由 pulse() 画上就被这行覆盖掉。
       实心球才会触发展开，所以症状正是「实心红球完全没有波动、空心球正常」。 */
    path.setAttribute('d', tlPath(TL.phase || 0));
    walk.dataset.tlPhase = String(TL.phase || 0);

    /* 圆圈与学期分隔线搬到波上：位移量 = 波在该高度的横坐标 - 基准轴横坐标 */
    var i, el, y;
    var dots = walk.querySelectorAll('.ndot, .node');
    for (i = 0; i < dots.length; i++) {
      el = dots[i];
      y = el.offsetTop + el.offsetHeight / 2;
      el.style.transform = 'translateX(' + (tlWave(y) - TL.cx).toFixed(1) + 'px)';
    }
    /* 学期细线只移动左端，右端保持贴齐正文右边缘 */
    var rules = walk.querySelectorAll('.term .r');
    for (i = 0; i < rules.length; i++) {
      el = rules[i];
      y = el.offsetTop + el.offsetHeight / 2;
      el.style.setProperty('--wave', (tlWave(y) - TL.cx).toFixed(1) + 'px');
    }
  }

  /* 行高变化期间持续重排，否则感想一展开，下面的圆圈就与曲线脱开 */
  function relayoutFor(ms) {
    var t0 = performance.now();
    if (TL.raf) cancelAnimationFrame(TL.raf);
    (function step() {
      layoutTimeline();
      if (performance.now() - t0 < ms) TL.raf = requestAnimationFrame(step);
      else TL.raf = 0;
    })();
  }

  /* 三种触发源【同一套算法】，差异只在参数：
       实心球 = 振幅更大、范围更广（超过左右两个节点）、持续时间更长（速率更慢）。
     λ（波长）必须显著小于 maxR，否则整段同向偏移、退化成单摆式整体摆动。
     ph 是相位推进速率（`t/ph`）：整套时间常数必须一起缩放，否则会出现
     「慢包络里套着快抖动」的不协调观感。 */
  var RIPPLE = {
    hollow: { amp: 2.6, w: 47, maxR: 120, lam: 22, peak: 480, tau: 340, ph: 105 },
    solid:  { amp: 4.8, w: 88, maxR: 250, lam: 30, peak: 1080, tau: 760, ph: 210 },
    origin: { amp: 3.2, w: 66, maxR: 190, lam: 26, peak: 500, tau: 360, ph: 105, dir: 'down' }
  };
  function rippleDur(r) { return r.peak + r.tau * 4; }

  function pulse(dot, kind) {
    if (REDUCED) return;
    var walk = $('panel-trail').querySelector('.walk');
    if (!walk || !dot) return;
    var base = RIPPLE[kind] || RIPPLE.hollow;
    var r = {
      y: dot.offsetTop + dot.offsetHeight / 2,
      amp: base.amp, w: base.w, maxR: base.maxR, lam: base.lam,
      peak: base.peak, tau: base.tau, dir: base.dir,
      /* 环在「脉冲仍强」的时候走完全程，否则远端会被时间衰减吃掉 */
      speed: base.maxR / (base.peak * 1.6), ph: base.ph
    };
    r.dur = rippleDur(r);
    r.el = dot;                     /* 记住圆点：行高变化时它的位置会移动，要每帧重读 */
    TL.ripple = r;
    TL.phase = 0;
    var pathEl = walk.querySelector('.tl-path');
    /* 把这次涟漪的真实参数与状态写到 DOM 上：既是调试用的可见状态，
       也让自检能直接对「真正跑着的参数」验证包络数学，而不是照抄一份常量。 */
    walk.dataset.ripple = kind;
    walk.dataset.rippleAmp = r.amp;
    walk.dataset.rippleMaxR = r.maxR;
    walk.dataset.ripplePeak = r.peak;
    walk.dataset.rippleTau = r.tau;
    walk.dataset.rippleLam = r.lam;
    walk.dataset.rippleW = r.w;
    walk.dataset.rippleDur = r.dur;
    walk.dataset.rippleDir = r.dir || 'both';
    walk.dataset.rippleMode = 'wave';   /* 空心与实心共用同一套行进波算法 */
    walk.dataset.rippleY = r.y;
    var t0 = performance.now();
    if (TL.praf) cancelAnimationFrame(TL.praf);
    (function step() {
      var t = performance.now() - t0;
      if (t > r.dur) {
        TL.ripple = null; TL.praf = 0; TL.phase = 0;
        pathEl.setAttribute('d', tlPath(0));
        walk.dataset.tlPhase = '0';
        delete walk.dataset.ripple;
        return;
      }
      /* 每帧重读圆点位置：感想展开会把下面的行整体下移，涟漪的落点必须跟着走 */
      r.y = r.el.offsetTop + r.el.offsetHeight / 2;
      TL.phase = t;
      pathEl.setAttribute('d', tlPath(t));
      TL.praf = requestAnimationFrame(step);
    })();
  }

  /* 调试用：?rip=solid@180 把涟漪冻结在指定相位，便于截图看清波形。
     纯展示开关，不参与任何数据逻辑。 */
  function freezeRipple(spec) {
    var m = /^(hollow|solid|origin)@(\d+)$/.exec(spec || '');
    if (!m) return;
    var walk = $('panel-trail').querySelector('.walk');
    if (!walk) return;
    var kind = m[1], t = Number(m[2]);
    var base = RIPPLE[kind];
    var dot = kind === 'origin' ? walk.querySelector('.ndot-big')
      : walk.querySelector('.stop .ndot' + (kind === 'solid' ? '.solid' : ':not(.solid)'));
    if (!base || !dot) return;
    TL.ripple = {
      y: dot.offsetTop + dot.offsetHeight / 2,
      amp: base.amp, w: base.w, maxR: base.maxR, lam: base.lam,
      peak: base.peak, tau: base.tau, dir: base.dir,
      speed: base.maxR / (base.peak * 1.6), ph: base.ph
    };
    TL.ripple.dur = rippleDur(TL.ripple);
    TL.phase = t;               /* 冻结相位也要写进 TL.phase，否则一次重排就会把它复位 */
    walk.querySelector('.tl-path').setAttribute('d', tlPath(t));
  }

  function closeNotes(except) {
    Array.prototype.forEach.call(
      $('panel-trail').querySelectorAll('.stop.open'), function (s) {
        if (s === except) return;
        s.classList.remove('open');
        var d = s.querySelector('.ndot');
        if (d && d.hasAttribute('aria-expanded')) d.setAttribute('aria-expanded', 'false');
      });
  }

  /* 圆圈交互：鼠标悬停 / 键盘焦点 / 触摸点击，三者行为一致 */
  function bindDots() {
    var walk = $('panel-trail').querySelector('.walk');
    if (!walk) return;
    var lastPointer = 'mouse';
    walk.addEventListener('pointerdown', function (e) { lastPointer = e.pointerType; });

    /* 起点黑球：悬停 → 曲线从起点【向下】起涟漪；点击 → 收起/展开「入社日期 + 寄语」。
       它不在 .stop 里，所以单独绑；也不涉及任何取数。 */
    (function bindOrigin() {
      var dot = walk.querySelector('.ndot-big');
      var detail = walk.querySelector('#origin-detail');
      if (!dot || !detail) return;
      function setOpen(v) {
        detail.classList.toggle('open', v);
        dot.setAttribute('aria-expanded', v ? 'true' : 'false');
        relayoutFor(420);            /* 收起会改行高，时间轴要跟着重排 */
      }
      dot.addEventListener('pointerenter', function (e) {
        if (e.pointerType !== 'mouse') return;
        pulse(dot, 'origin');
      });
      dot.addEventListener('focus', function () { pulse(dot, 'origin'); });
      dot.addEventListener('click', function () {
        if (lastPointer === 'mouse') return;   /* 鼠标的开关交给 hover 之外不重复处理 */
        setOpen(!detail.classList.contains('open'));
        pulse(dot, 'origin');
      });
      dot.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen(!detail.classList.contains('open'));
          pulse(dot, 'origin');
        }
      });
      /* 鼠标：悬停展开、移出收起（与感想一致的手感） */
      dot.addEventListener('pointerenter', function (e) {
        if (e.pointerType === 'mouse') setOpen(true);
      });
      dot.addEventListener('pointerleave', function (e) {
        if (e.pointerType === 'mouse') setOpen(false);
      });
    })();

    Array.prototype.forEach.call(walk.querySelectorAll('.stop'), function (stop) {
      var dot = stop.querySelector('.ndot');
      if (!dot) return;
      var openable = dot.hasAttribute('aria-expanded');
      var closeTimer = 0;

      function open() {
        clearTimeout(closeTimer);
        if (openable) {
          closeNotes(stop);
          stop.classList.add('open');
          dot.setAttribute('aria-expanded', 'true');
          relayoutFor(420);
        }
      }
      function close() {
        if (!openable) return;
        stop.classList.remove('open');
        dot.setAttribute('aria-expanded', 'false');
        relayoutFor(420);
      }
      /* 展开/收起会让下面的行整体下移，用一次轻微波动作为过渡的视觉线索 */
      dot.addEventListener('pointerenter', function (e) {
        if (e.pointerType !== 'mouse') return;
        pulse(dot, openable ? 'solid' : 'hollow');
        if (openable) open();
      });
      dot.addEventListener('focus', function () {
        pulse(dot, openable ? 'solid' : 'hollow'); if (openable) open();
      });
      dot.addEventListener('blur', close);
      stop.addEventListener('pointerleave', function (e) {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(close, 140);   /* 留一点余量，避免移向感想时闪断 */
      });
      dot.addEventListener('click', function () {
        /* 鼠标的开关由 hover 负责，这里只处理触摸/键盘触发的 click */
        if (lastPointer === 'mouse') return;
        if (!openable) { pulse(dot, 'hollow'); return; }
        if (stop.classList.contains('open')) close();
        else { open(); pulse(dot, 'solid'); }
      });
    });

    /* 点击别处收起 */
    if (!bindDots.bound) {
      bindDots.bound = true;
      document.addEventListener('pointerdown', function (e) {
        if (!e.target.closest || !e.target.closest('#panel-trail .stop')) closeNotes(null);
      });
      var rt = 0;
      window.addEventListener('resize', function () {
        clearTimeout(rt); rt = setTimeout(layoutTimeline, 140);
      });
    }
  }

  /* ── 视图二 · 档案（按部组归档） ──────────────────── */
  function renderDossier(r) {
    var m = r.member, s = r.stats;
    var h = '';

    /* 档案头：只放身份栏没有的信息。原来还有个自造的「档案号 AK-…」（从学号拼出来的），
       那和已经被删掉的「已核验」印章是同一类问题 —— 系统无法担保的权威标记，不要。 */
    h += '<div class="fields">' +
      /* 说明只在**确实是回退值**时才出现：填写值不加说明，压根没日期则显示「—」
         且不能挂一句「取自首次入档时间」—— 那是错的。 */
      field('入社日期', dotd(m.joinDate),
        m.joinDateSource === 'created' ? '缺该字段，取自首次入档时间' : '') +
      field('首次参与', s.firstDate ? dotd(s.firstDate) : '—') +
      field('最近参与', s.lastDate ? dotd(s.lastDate) : '—') +
      '</div>';

    /* 部组文件头：纵向堆叠，初始全部收起（看不到任何具体活动）。
       排序按参与数量降序。原来的标签导航已删除 —— 改为直接点文件头展开。 */
    var sorted = r.groups.slice().sort(function (a, b) {
      return b.count - a.count || (a.group < b.group ? -1 : 1);
    });
    h += '<div class="doc" id="docStack">';
    sorted.forEach(function (g, i) {
      var rows = '';
      g.items.forEach(function (a) {
        /* 学时不下放到右侧「数值列」——在列表里右对齐的数值列是最强的版面位置，
           把学时放那儿等于把它当成绩。改成跟标题同行的灰色小字，与足迹视图一致。 */
        rows += '<div class="gact"><div class="d">' + dotd(a.date) + '</div>' +
          '<div class="bd"><div class="nm">' + esc(a.name) +
          '<span class="term">' + esc(a.term) + '</span>' +
          '<span class="hrs">' + a.hours.toFixed(1) + ' 学时</span></div>' +
          (a.note ? '<div class="note">' + esc(a.note) + '</div>' : '') + '</div></div>';
      });
      h += '<section class="gsec" data-g="' + esc(g.group) + '">' +
        /* 整个文件头就是按钮：键盘、触摸、aria-expanded 都靠它。
           里面用 span 而不是 div —— button 的内容模型只允许短语内容。 */
        '<button type="button" class="gplate" aria-expanded="false" aria-controls="gb-' + i + '">' +
          '<span class="holes" aria-hidden="true"><i></i><i></i></span>' +
          '<img class="gmark" src="' + D.markFile(g.group) + '" alt="">' +
          '<span class="gmain">' +
            '<span class="gname">' + esc(g.group) +
              (GROUP_MOTTO[g.group] ? '<span class="gmotto">' + esc(GROUP_MOTTO[g.group]) + '</span>' : '') +
            '</span>' +
            /* 去掉「No. 01」；日期只留起始年月 */
            '<span class="gmeta">' + g.count + ' 场 · ' + dotd(g.first).slice(0, 7) + '始</span>' +
          '</span>' +
          '<span class="gchev" aria-hidden="true"></span>' +
        '</button>' +
        '<div class="gbody" id="gb-' + i + '"><div class="gbodyin">' + rows + '</div></div>' +
        '</section>';
    });
    h += '</div>';
    h += '<div class="docfoot"><button type="button" class="allbtn" id="allBtn"' +
      ' aria-controls="docStack">全部展开</button></div>';

    $('panel-dossier').innerHTML = '<div class="dossier">' + h + '</div>';
    bindStack();
    /* 调试用：?open=2 展开第三个文件头，?open=all 全部展开（纯展示开关） */
    var op = Q.get('open');
    if (op) {
      var secs0 = $('panel-dossier').querySelectorAll('.gsec');
      if (op === 'all') {
        Array.prototype.forEach.call(secs0, function (s2) { setSecOpen(s2, true); });
        syncAllBtn();
      } else if (secs0[Number(op)]) {
        setSecOpen(secs0[Number(op)], true); syncAllBtn();
      }
    }
    stagger($('panel-dossier').querySelectorAll('.fields, .gsec, .docfoot'), 0.05, 0.3);
  }

  function setSecOpen(sec, on) {
    sec.classList.toggle('open', on);
    var pl = sec.querySelector('.gplate');
    if (pl) pl.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function syncAllBtn() {
    var panel = $('panel-dossier');
    var b = panel.querySelector('.allbtn');
    if (!b) return;
    var any = !!panel.querySelector('.gsec.open');
    b.textContent = any ? '归档' : '全部展开';
    b.classList.toggle('on', any);
  }

  /* 部组文件头的展开 / 收回：同一时刻最多一个展开。
     用 grid-template-rows 0fr→1fr 做高度过渡（max-height 不是匀速也无法自适应内容高度），
     所以是「徐徐展开」而不是瞬切。 */
  function bindStack() {
    var panel = $('panel-dossier');
    var secs = panel.querySelectorAll('.gsec');
    var allBtn = panel.querySelector('.allbtn');
    if (!secs.length) return;

    function setOpen(sec, on) { setSecOpen(sec, on); }
    function anyOpen() { return !!panel.querySelector('.gsec.open'); }
    function syncBtn() { syncAllBtn(); }

    Array.prototype.forEach.call(secs, function (sec) {
      var pl = sec.querySelector('.gplate');
      if (!pl) return;
      pl.addEventListener('click', function () {
        var willOpen = !sec.classList.contains('open');
        /* 先收回其他所有部组，再展开当前 —— 始终最多一个展开 */
        Array.prototype.forEach.call(secs, function (o) { if (o !== sec) setOpen(o, false); });
        setOpen(sec, willOpen);
        syncBtn();
      });
    });

    if (allBtn) {
      allBtn.addEventListener('click', function () {
        var target = !anyOpen();          /* 有展开的 → 全部收回；全收起 → 全部展开 */
        Array.prototype.forEach.call(secs, function (s) { setOpen(s, target); });
        syncBtn();
      });
    }
    syncBtn();
  }

  function field(k, v, cav) {
    return '<div class="f"><div class="k">' + esc(k) + '</div><div class="v"><span>' + esc(v) +
      '</span>' + (cav ? '<span class="cav">' + esc(cav) + '</span>' : '') + '</div></div>';
  }

  /* ── 视图三 · 导出卡片 ────────────────────────────── */
  function renderCard(r) {
    var m = r.member, s = r.stats;
    var h = '<div class="card">';

    h += '<div class="card-head">' +
      /* 栏图整幅显示：不加遮罩、不裁切、上面不压任何东西。
         原图自带的二维码已单独抠出（assets/export-qr.png?v=20261013f）并放到卡片右下角。 */
      '<img class="art" src="assets/export-banner.jpg?v=20261013f" alt="">' +
      '<div class="tit"><h2>' + esc(m.name) + '的爱心足迹</h2>' +
      '<div class="when">' + dotd(m.joinDate) + ' 入社</div></div>' +
      '</div>';

    /* 三个统计格：细线分格（不是圆角卡片），同权重，学时排在最后 */
    h += '<div class="card-stats">' +
      stat('参与活动', s.count, '场') +
      stat('足迹部组', s.groupCount, '个') +
      stat('累计学时', (r.groups.reduce(function (x, g) { return x + g.hours; }, 0)).toFixed(1), '小时') +
      '</div>';

    h += '<div class="card-list"><h3>爱心足迹</h3>';
    r.terms.forEach(function (t) {
      t.items.forEach(function (a) {
        h += '<div class="crow' + (a.note ? ' noted' : '') + '">' +
          '<span class="dot"></span>' +
          '<span class="d">' + dotd(a.date) + '</span>' +
          '<span class="nm">' + esc(a.name) + '</span>' +
          '<span class="grp">' + esc(a.group) + '</span>' +
          '<span class="h">' + a.hours.toFixed(1) + 'h</span></div>';
      });
    });
    h += '</div>';

    h += '<div class="card-foot">' +
      /* 左下角的社团三字图（用户提供）；文字全部移到中列，不会被它压住 */
      '<img class="sealimg" src="assets/club-seal.png?v=20261013f" alt="">' +
      '<div class="motto">奉献爱心，呼唤爱心，自我教育</div>' +
      '<div class="org">北京大学学生爱心社</div>' +
      '<div class="asof">' + esc(D.scopeText()) + '</div>' +
      '<div class="qr"><img src="assets/export-qr.png?v=20261013f" alt="爱心社关注二维码"></div>' +
      '</div>';

    h += '</div>';

    h += '<div class="card-actions">' +
      '<button type="button" id="pngBtn">保存为长图（PNG）</button>' +
      '<a class="csv" href="#" id="csvBtn">下载 CSV</a>' +
      '<span class="hint" id="pngHint" role="status" aria-live="polite"></span>' +
      '</div>';

    $('panel-export').innerHTML = '<div class="exportview">' + h + '</div>';
    $('pngBtn').addEventListener('click', function () { downloadPng(); });
    $('csvBtn').addEventListener('click', function (e) { e.preventDefault(); downloadCsv(); });
    stagger($('panel-export').querySelectorAll('.card, .card-actions'), 0.06, 0.2);
  }

  function stat(k, v, u) {
    return '<div class="stat"><span class="k">' + esc(k) + '</span>' +
      '<span class="v">' + esc(v) + '<i>' + esc(u) + '</i></span></div>';
  }

  /* ── 页脚 ─────────────────────────────────────────── */
  /* 原来这里有一段「数据来源 / 隐私说明」的细字。用户要求删除：
     这些说明影响观感，且不属于使用者要看的内容。 */

  /* ── 导出长图（PNG）────────────────────────────────────
     管线：克隆 .card → <img> 换成 data URI → 取样式表里**非媒体查询**的规则
           → 塞进 SVG 的 foreignObject → 画到 canvas → toBlob('image/png')。

     为什么是「快照」而不是用 canvas 重画一遍：重画等于给版式写第二份实现，
     改一次样式就得同步改两处 —— 本仓库已经为「同一件事两份实现」修过两次 bug
     （前后端各算一套派生、旧 UI 与新 UI 各一份部组名单）。快照天生只有一份版式。

     三个必须踩对的点（都真实踩过或差点踩到）：
     ① **图片要内联成 data URI**。SVG 里的外链图片渲染成位图时不会加载（安全限制），
        结果是一张没有栏图、没有二维码、没有社徽的空白卡。
     ② **样式表里的 @media 规则要丢掉**。渲染成位图时媒体查询按 SVG 自己的宽度求值，
        540px 会命中手机版样式，版式整个变样。
     ③ **动画要钉死在终态**。卡片带 anim-rise（opacity 从 0 起），
        快照赶在动画中途就会拍到半透明的卡。
     另外 <style> 是按 SVG 文档生效的，那里没有 body，所以 body 上的继承属性
     （字体、文字颜色）必须显式搬到快照根节点上，否则卡片会变成 Times 衬线黑字。 */
  var PNG_SCALE = 2;   /* 2 倍像素：微信里放大看文字不糊 */

  function loadImage(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('快照渲染失败（SVG 没能当图片解码）')); };
      im.src = src;
    });
  }

  /* SVG 走 <img> 加载时是按 **XML** 解析的，不是 HTML。
     所以拼进去的东西必须是合法 XML：
     · 克隆节点要用 XMLSerializer，**不能** outerHTML —— outerHTML 是 HTML 序列化，
       `<img>` 不会被自闭合，XML 解析立刻失败（实测症状：img.onerror，
       提示只有「快照渲染失败」，看不出任何原因）。XMLSerializer 还会顺手补上
       xmlns="http://www.w3.org/1999/xhtml"，foreignObject 正需要它。
     · 样式文本与内联 style 属性都要做 XML 转义：CSS 里可能有 `<` / `&`，
       而 computed 的 font-family 带**双引号**，直接塞进 style="…" 会把属性截断。 */
  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function xmlAttr(s) {
    return xmlEscape(s).replace(/"/g, '&quot;');
  }

  function inlineImage(im) {
    var src = im.getAttribute('src');
    if (!src) return Promise.resolve(null);
    if (src.slice(0, 5) === 'data:') return Promise.resolve(src);
    return fetch(src, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error(src + ' → HTTP ' + r.status);
        return r.blob();
      })
      .then(function (b) {
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res(fr.result); };
          fr.onerror = function () { rej(new Error(src + ' 读不出来')); };
          fr.readAsDataURL(b);
        });
      })
      .catch(function () { return null; });   /* 单张失败不拖垮整张图 */
  }

  function collectCss() {
    var out = '';
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      var rules;
      try { rules = sheet.cssRules; } catch (e) { return; }   /* 跨域表读不到，跳过 */
      if (!rules) return;
      Array.prototype.forEach.call(rules, function (rule) {
        /* 只取普通样式规则（type 1）。@media 会被 SVG 的宽度重新求值（见 ②），
           @keyframes / @font-face 对一张静态快照没有意义。 */
        if (rule.type === 1) out += rule.cssText + '\n';
      });
    });
    return out;
  }

  function snapshotBaseStyle(width) {
    var out = 'width:' + width + 'px;background:#fbfaf7;';
    var rootCs = window.getComputedStyle(document.documentElement);
    for (var i = 0; i < rootCs.length; i++) {
      var p = rootCs[i];
      if (p.slice(0, 2) === '--') out += p + ':' + rootCs.getPropertyValue(p).trim() + ';';
    }
    var body = window.getComputedStyle(document.body);
    ['font-family', 'font-size', 'font-weight', 'line-height', 'color',
      'letter-spacing', 'font-variant-numeric'].forEach(function (k) {
      var v = body.getPropertyValue(k);
      if (v) out += k + ':' + v + ';';
    });
    return out;
  }

  function snapshotCard(card) {
    var W = Math.round(card.offsetWidth), H = Math.round(card.offsetHeight);
    if (!W || !H) return Promise.reject(new Error('卡片还没布局，量不到尺寸'));

    var clone = card.cloneNode(true);
    clone.classList.add('snapping');

    var imgs = Array.prototype.slice.call(card.querySelectorAll('img'));
    var cloned = Array.prototype.slice.call(clone.querySelectorAll('img'));

    return Promise.all(imgs.map(inlineImage)).then(function (uris) {
      uris.forEach(function (uri, i) {
        if (uri) cloned[i].setAttribute('src', uri);
        else cloned[i].removeAttribute('src');     /* 取不到就去掉，别留个裂图占位 */
      });
      var css = collectCss() +
        '\n.snapping,.snapping *,.snapping *:before,.snapping *:after' +
        '{animation:none !important;transition:none !important;}';
      /* 必须是 XML 序列化 —— 见上面 xmlEscape 的说明 */
      var markup = new XMLSerializer().serializeToString(clone);
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + (W * PNG_SCALE) +
        '" height="' + (H * PNG_SCALE) + '" viewBox="0 0 ' + W + ' ' + H + '">' +
        '<foreignObject x="0" y="0" width="' + W + '" height="' + H + '">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" style="' + xmlAttr(snapshotBaseStyle(W)) + '">' +
        '<style>' + xmlEscape(css) + '</style>' + markup +
        '</div></foreignObject></svg>';

      return loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    }).then(function (img) {
      var cv = document.createElement('canvas');
      cv.width = W * PNG_SCALE;
      cv.height = H * PNG_SCALE;
      var ctx = cv.getContext('2d');
      /* 先铺白底：PNG 的透明区在微信/相册里常常显示成黑块 */
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      return cv;
    });
  }

  function pngHint(text, isError) {
    var el = $('pngHint');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('err', !!isError);
  }

  function downloadPng() {
    var r = state.result;
    if (!r) return;
    var card = $('panel-export').querySelector('.card');
    var btn = $('pngBtn');
    if (!card || !btn) return;
    if (btn.disabled) return;                 /* 连点两次会生成两张，禁掉 */
    btn.disabled = true;
    pngHint('正在生成…', false);

    snapshotCard(card).then(function (canvas) {
      return new Promise(function (res, rej) {
        canvas.toBlob(function (blob) {
          /* 如实断言产物：拿不到编码器时 toBlob 会给 null，
             这里绝不能把「没生成」当成「生成好了」 */
          if (!blob) return rej(new Error('toBlob 没有给出图像'));
          if (blob.type !== 'image/png') return rej(new Error('产物不是 PNG：' + blob.type));
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = '爱心足迹-' + r.member.name + '-' + r.member.sid + '.png';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
          res(blob);
        }, 'image/png');
      });
    }).then(function (blob) {
      pngHint('已保存 PNG（' + Math.round(blob.size / 1024) + ' KB）', false);
      setTimeout(function () { if (!btn.disabled) pngHint('', false); }, 4000);
    }).catch(function (err) {
      /* 失败必须说话：静默什么都不发生，用户只会以为按钮坏了 */
      pngHint('生成失败：' + (err && err.message ? err.message : '未知原因'), true);
      if (window.console && console.error) console.error('[导出 PNG] 失败', err);
    }).then(function () { btn.disabled = false; });
  }

  /* ── CSV ──────────────────────────────────────────── */
  function downloadCsv() {
    var r = state.result;
    if (!r) return;
    var m = r.member;
    /* 列与展示口径一致；不再带恒定取值的「置信度」列 */
    var head = ['姓名', '学号', '学期', '部组', '活动名', '参与时间', '学时', '感想'];
    var rows = [head];
    r.terms.forEach(function (t) {
      t.items.forEach(function (a) {
        rows.push([m.name, m.sid, a.term, a.group, a.name, a.date, a.hours.toFixed(1), a.note || '']);
      });
    });
    var csv = rows.map(function (cols) {
      return cols.map(function (c) {
        var s = String(c === null || c === undefined ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '爱心足迹-' + m.name + '-' + m.sid + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ── 动效工具：一次即止 ───────────────────────────── */
  /* 只在动画真正结束时摘掉类：留着的动画（fill-mode: both）会让元素一直停在合成层，
     文字会从次像素抗锯齿退化成灰度抗锯齿。必须判断 e.target，否则子元素（累计条）
     的 animationend 会冒泡上来，把父元素还没播完的动画提前剪掉。 */
  function once(el, cls) {
    el.addEventListener('animationend', function handler(e) {
      if (e.target !== el) return;
      el.removeEventListener('animationend', handler);
      el.classList.remove(cls);
      el.style.animationDelay = '';
    });
  }
  function stagger(nodes, step, cap) {
    if (STILL || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    Array.prototype.forEach.call(nodes, function (el, i) {
      el.classList.add('anim-rise');
      el.style.animationDelay = Math.min(i * step, cap) + 's';
      once(el, 'anim-rise');
    });
  }
  /* 累计条：滚动进入视口才生长，每个只播一次 */
  function observeBars(root) {
    var bars = root.querySelectorAll('.track i');
    if (STILL || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    function play(b) { b.classList.add('anim'); once(b, 'anim'); }
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(bars, play);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { play(e.target); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
    Array.prototype.forEach.call(bars, function (b) { io.observe(b); });
  }

  /* 活动记录自右向左流体滑入：滚动进入视口才触发，一次即止。
     两条硬性要求：
     ① 默认态必须可见 —— 只有加了 reveal-ready 才隐藏，JS 未跑 / 减少动效时不会白屏；
     ② 视口内（及以上）的记录必须【同步】放行，不能把「可见」押在 IntersectionObserver
        的异步回调上：它在某些时序下不触发，那样记录就是隐形的。观察器只负责视口外的。 */
  function armReveal() {
    var walk = $('panel-trail').querySelector('.walk');
    if (!walk) return;
    if (STILL || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var stops = walk.querySelectorAll('.stop:not(.in)');
    if (!stops.length) return;
    walk.classList.add('reveal-ready');
    void walk.offsetWidth;                 /* 强制一次重排，否则同步放行不会产生过渡 */

    var vh = window.innerHeight || 800;
    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        var batch = entries.filter(function (e) { return e.isIntersecting; });
        batch.forEach(function (e, i) {
          var el = e.target;
          el.style.transitionDelay = Math.min(i * 60, 340) + 'ms';
          el.classList.add('in');
          io.unobserve(el);
          setTimeout(function () { el.style.transitionDelay = ''; }, 1300);
        });
      }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    }
    Array.prototype.forEach.call(stops, function (s, i) {
      if (s.getBoundingClientRect().top < vh * 0.92) {
        s.style.transitionDelay = Math.min(i * 60, 340) + 'ms';
        s.classList.add('in');
        setTimeout(function () { s.style.transitionDelay = ''; }, 1300);
      } else if (io) {
        io.observe(s);
      } else {
        s.classList.add('in');
      }
    });
  }

  /* ── 渲染总入口 ───────────────────────────────────── */
  function render(r) {
    renderIdent(r);
    renderTrail(r);
    renderDossier(r);
    renderCard(r);
    /* 顶部说明条（部组降级 / 库没读到）由 showBanners 统一负责 ——
       它要同时考虑两个事实，散在这里会和那边互相覆盖。 */
    setView(state.view);
  }

  function setView(v) {
    state.view = v;
    ['trail', 'dossier', 'export'].forEach(function (k) {
      $('panel-' + k).hidden = k !== v;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.views button'), function (b) {
      var on = b.dataset.view === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;             /* WAI-ARIA tabs：只有选中的 tab 在 Tab 序列里 */
    });
    /* 切回足迹时：面板此刻才可见，时间轴要在这里量；滑入观察器同理要重新武装
       （隐藏期间元素没有布局盒，观察器不会触发）。 */
    if (v === 'trail') { layoutTimeline(); armReveal(); freezeRipple(Q.get('rip')); }
  }

  /* 行高还会被两件事改掉：图片加载完、字体加载完。两者都让 y 变化，
     时间轴必须重量一次，否则圆点会与曲线脱开（实测偏差可达 14px）。 */
  function relayoutLater() {
    if (state.view !== 'trail') return;
    layoutTimeline();
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayoutLater);
  window.addEventListener('load', relayoutLater);
  Array.prototype.forEach.call(document.images, function (im) {
    if (!im.complete) im.addEventListener('load', relayoutLater);
  });

  var viewBtns = Array.prototype.slice.call(document.querySelectorAll('.views button'));
  viewBtns.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.dataset.view); });
  });
  /* 左右方向键在 tab 之间移动（WAI-ARIA tabs 的标准键盘行为） */
  document.querySelector('.tablist').addEventListener('keydown', function (e) {
    var i = viewBtns.indexOf(document.activeElement);
    if (i < 0) return;
    var n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % viewBtns.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + viewBtns.length) % viewBtns.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = viewBtns.length - 1;
    if (n === null) return;
    e.preventDefault();
    viewBtns[n].focus();
    setView(viewBtns[n].dataset.view);
  });
  /* 顶部原来还有一个「下载 CSV」链接，与「导出」tab 是同一个动作、只隔几百像素 —— 去掉，
     CSV 入口只留在导出视图里。 */

  /* ── 表单 ─────────────────────────────────────────── */
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    /* 用显式 namedItem：form.name 与表单自身的 name 属性同名，行为依赖浏览器细节，不赌 */
    var name = f.elements.namedItem('name').value.trim();
    var sid = f.elements.namedItem('sid').value.trim();
    if (!name || !sid) return notice('INVALID_INPUT');
    submit(name, sid);
  });
  $('noticeBack').addEventListener('click', function () { show('entry', true); });
  $('again').addEventListener('click', function (e) { e.preventDefault(); show('entry', true); });

  /* ── 启动 ─────────────────────────────────────────────
     深链 ?name=&sid=：先回填表单，再按形态分流。
     · 独立形态：直接查（数据在本地假数据库里）。
     · 组件形态：宿主（app.py）已经读到同样的查询参数并把结果放进 args.result，
       结果会在 render 消息里到达 —— 这里【不能】再提交一次，否则会平白多一轮
       飞书查询。深链的「loading」画面也由宿主那一轮负责。 */
  /* 入口页的收录范围：2025秋至 <今天>（口径只有 derive.js 一份，今天动态生成） */
  var scopeEl = $('scopeLine');
  if (scopeEl) scopeEl.textContent = '收录范围 ' + D.scopeText();

  var deepName = Q.get('name'), deepSid = Q.get('sid');
  if (deepName && deepSid) {
    $('form').elements.namedItem('name').value = deepName;
    $('form').elements.namedItem('sid').value = deepSid;
  }
  if (SRC.standalone && deepName && deepSid) {
    submit(deepName, deepSid);
  } else {
    show('entry');
  }
})();
