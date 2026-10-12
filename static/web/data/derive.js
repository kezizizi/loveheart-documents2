/* 爱心社「爱心足迹」—— 派生层
 *
 * 这一层是**唯一**一份派生实现：把后端给的一份原始活动记录
 * （`{name, sid, college, joinDate, joinDateSource, companions, joinMessage, activities[]}`）
 * 算成视图要用的形状（stats / groups / terms / years）。
 *
 * 为什么要单独拆出来
 * ------------------
 * 交接文档 §3.3.3 规定「派生留给前端」，但原先这份逻辑长在 `data/mock-db.js` 里，
 * 而 mock-db 正是接入真实后端时要被换掉的那一层 —— 换掉它等于把派生逻辑一起换掉。
 * 拆出来之后：
 *   · 真实数据（Streamlit 组件回传）与演示假数据（mock-db）走**同一份**派生代码；
 *   · 不会出现「后端算一套、前端再算一套」的自相矛盾（§2.3②）。
 *
 * 硬约束（沿用）：任何视图都不得突出「志愿学时」。本层只做加总供导出卡片使用，
 * 主视图不消费任何学时合计。
 */
(function (global) {
  'use strict';

  /* 资源版本号：只要改了任何图片或样式就必须推进它，否则浏览器旧缓存会盖住修改。
     ⚠️ 这里的值必须与 index.html / app.js / style.css 里的 `?v=` 保持一致。 */
  var ASSET_V = '20261013c';

  /* 社团固定 9 个部组。注意：它【不是】用来判定某条记录属于哪个部组的 ——
     判定权在后端 config.GROUP_COLORS（交接文档 §3.3 / §3.6）。前端保留这份清单
     只用于「编号感」与徽记映射，不再把不认识的部组改写成「其他」。 */
  var KNOWN_GROUPS = ['护老部', '无障碍部', '儿童部', '手语分社', '资助部',
    '组织部', '宣传部', '项目组', '外联部'];
  var UNKNOWN_GROUP = '其他';

  /* 部组徽记：每个部组一枚线描小图 */
  var GROUP_MARK = {
    '护老部': 'hulao', '无障碍部': 'wuzhangai', '儿童部': 'ertong', '手语分社': 'shouyu',
    '资助部': 'zizhu', '组织部': 'zuzhi', '宣传部': 'xuanchuan', '项目组': 'xiangmu',
    '外联部': 'wailian', '其他': 'qita'
  };
  function markFile(group) {
    /* 带版本号：徽章文件名固定不变，浏览器会一直用缓存里那张旧图 ——
       换了新徽章却看不到，就是这个原因。 */
    return 'assets/marks/' + (GROUP_MARK[group] || GROUP_MARK[UNKNOWN_GROUP]) +
      '-ink.png?v=' + ASSET_V;
  }

  /* ── 归一化（与后端 services/identity.py 同口径） ─────── */
  function normalizeSid(value) {
    if (value === null || value === undefined) return '';
    var s = String(value).trim();
    var m = s.match(/^(\d+)(?:\.0+)?$/);
    if (m) return m[1];
    return s.replace(/\D/g, '');
  }
  function normalizeName(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\s+/g, '');
  }

  /* 部组：**信任后端**。后端按「文件夹层级」判定，认不出的一律已经发成「其他」；
     前端再做一次映射只会多出一份需要同步的清单，并制造「后端认得出、前端归其他」的
     静默偏差（交接文档 §3.6）。这里只兜住缺失值。 */
  function groupOf(a) {
    return (a && a.group) ? a.group : UNKNOWN_GROUP;
  }

  function activities(member) {
    return (member && member.activities) ? member.activities : [];
  }
  function sorted(member) {
    return activities(member).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }

  /* ── 聚合 ─────────────────────────────────────────────── */

  /* 部组聚合：以「参与场次」为主序（学时只是随行字段，不做排序依据） */
  function groupTotals(member) {
    var map = {};
    sorted(member).forEach(function (a) {
      var g = groupOf(a);
      if (!map[g]) map[g] = { group: g, hours: 0, count: 0, first: a.date, last: a.date, items: [] };
      map[g].hours += a.hours;
      map[g].count += 1;
      map[g].last = a.date;
      map[g].items.push(a);
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      if (a.group === UNKNOWN_GROUP) return 1;
      if (b.group === UNKNOWN_GROUP) return -1;
      if (b.count !== a.count) return b.count - a.count;
      return b.hours - a.hours;
    });
  }

  function terms(member) {
    var order = [], map = {};
    sorted(member).forEach(function (a) {
      if (!map[a.term]) { map[a.term] = []; order.push(a.term); }
      map[a.term].push(a);
    });
    return order.map(function (t) {
      var items = map[t], groups = [];
      items.forEach(function (a) { if (groups.indexOf(groupOf(a)) < 0) groups.push(groupOf(a)); });
      return {
        term: t, items: items, groups: groups,
        hours: items.reduce(function (s, a) { return s + a.hours; }, 0)
      };
    });
  }

  /* 学年：把学期按四位年份 + 季节归入学年（秋属于当年，春/暑假属于上一学年） */
  function schoolYears(member) {
    var ts = terms(member), order = [], map = {};
    ts.forEach(function (t) {
      var m = t.term.match(/^(\d{4})(.*)$/);
      var y = m ? parseInt(m[1], 10) : 0;
      var season = m ? m[2] : '';
      var start = season.indexOf('春') >= 0 || season.indexOf('暑') >= 0 ? y - 1 : y;
      var key = start + '–' + (start + 1);
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(t);
    });
    return order.map(function (k) {
      var list = map[k], items = [];
      list.forEach(function (t) { items = items.concat(t.items); });
      var groups = [];
      items.forEach(function (a) { if (groups.indexOf(groupOf(a)) < 0) groups.push(groupOf(a)); });
      return { year: k, terms: list, items: items, groups: groups };
    });
  }

  function daysSince(dateStr, now) {
    return Math.max(0, Math.floor(((now || new Date()) - new Date(dateStr + 'T00:00:00')) / 86400000));
  }

  /* ── 组装成视图消费的完整结果 ─────────────────────────── */

  function buildStats(member) {
    var all = sorted(member);
    var groups = groupTotals(member);
    var active = all.length > 0;
    return {
      days: member.joinDate ? daysSince(member.joinDate) : 0,
      /* 主指标是「参与场次 / 涉及部组 / 同行伙伴 / 在社天数」，不是学时 */
      count: all.length,
      groupCount: groups.length,
      /* 同行伙伴由后端统计（只出人数不出姓名）。拿不到时是 null —— 视图显示「—」，
         绝不用 0 冒充「没有伙伴」。 */
      companions: (typeof member.companions === 'number') ? member.companions : null,
      noted: all.filter(function (a) { return a.note; }).length,
      firstDate: active ? all[0].date : null,
      lastDate: active ? all[all.length - 1].date : null,
      firstTerm: active ? all[0].term : null,
      lastTerm: active ? all[all.length - 1].term : null
    };
  }

  /* member 的原始记录 → 视图结果。degraded 由数据来源决定（后端会带）。 */
  function build(member, degraded) {
    return {
      status: 'OK',
      member: member,
      groups: groupTotals(member),
      terms: terms(member),
      years: schoolYears(member),
      degraded: !!degraded,
      stats: buildStats(member)
    };
  }

  /* 降级演示 / 后端报缺 base:block:read：所有部组判为「其他」。
     身份栏的部组数必须跟着重算，否则会出现「涉及 9 个部组」而下面全是「其他」的矛盾。 */
  function degrade(result) {
    if (!result || result.status !== 'OK') return result;
    var m = {};
    for (var k in result.member) m[k] = result.member[k];
    m.activities = activities(result.member).map(function (a) {
      var c = {}; for (var kk in a) c[kk] = a[kk];
      c.group = UNKNOWN_GROUP;
      return c;
    });
    var copy = build(m, true);
    copy.status = result.status;
    return copy;
  }

  global.AX_DERIVE = {
    ASSET_V: ASSET_V,
    KNOWN_GROUPS: KNOWN_GROUPS,
    UNKNOWN_GROUP: UNKNOWN_GROUP,
    GROUP_MARK: GROUP_MARK,
    markFile: markFile,
    normalizeSid: normalizeSid,
    normalizeName: normalizeName,
    groupOf: groupOf,
    groupTotals: groupTotals,
    terms: terms,
    schoolYears: schoolYears,
    daysSince: daysSince,
    buildStats: buildStats,
    build: build,
    degrade: degrade
  };
})(window);
