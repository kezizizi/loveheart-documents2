/* 爱心社「爱心足迹」—— **演示用**自造假数据库
 *
 * ⚠️ 这个文件只在**独立页面形态**（本地设计、`_work/selftest.html` 自检）下才会被
 * `data/bridge.js` 动态加载。生产形态（Streamlit 组件）下**永远不会被加载** ——
 * 假数据不可能盖住真实数据。这是交接文档 §4.1 第 6 步那条坑的正面解法。
 *
 * 它只负责「查得到谁」，派生（stats / groups / terms / years）一律交给
 * `data/derive.js` —— 全站只有那一份派生实现。
 *
 * ⚠️ 全部为虚构数据，不对应任何真实社员。姓名、学号、院系、感想均为编造。
 */
(function (global) {
  'use strict';

  var D = global.AX_DERIVE;

  var MEMBERS = [
    {
      name: '林知遥', sid: '2300015108', college: '中国语言文学系',
      joinDate: '2023-09-16', joinDateSource: 'filled', companions: 47,
      /* 入社问卷里「你想对爱心社说的话」—— 社员自己写的那句话。 */
      joinMessage: '希望四年之后回头看，我做的每一件小事都还站在某个人身边。',
      activities: [
        { name: '迎新会', term: '2023秋', group: '组织部', hours: 2.0, date: '2023-09-16' },
        { name: '夕阳再晨·智能手机教学', term: '2023秋', group: '护老部', hours: 6.0, date: '2023-10-14',
          note: '教张奶奶存了第一个联系人。她存的是我。' },
        { name: '手语课堂（入门）', term: '2023秋', group: '手语分社', hours: 4.5, date: '2023-11-25' },

        { name: '无障碍电影讲解', term: '2024春', group: '无障碍部', hours: 5.0, date: '2024-03-23' },
        { name: '流动儿童课业辅导', term: '2024春', group: '儿童部', hours: 8.0, date: '2024-04-13',
          note: '他妈妈加了微信，第一句是「他今天写完了作业」。' },
        { name: '敬老院探访', term: '2024春', group: '护老部', hours: 4.0, date: '2024-05-18',
          note: '她一直问我们下次什么时候来。我说下周三。她说那我从今天开始数。' },
        { name: '手语歌会', term: '2024春', group: '手语分社', hours: 3.0, date: '2024-06-01' },

        { name: '爱心包裹分装', term: '2024秋', group: '资助部', hours: 4.5, date: '2024-09-21' },
        { name: '夕阳再晨·智能手机教学', term: '2024秋', group: '护老部', hours: 6.0, date: '2024-10-19' },
        { name: '盲文图书馆整理', term: '2024秋', group: '无障碍部', hours: 3.5, date: '2024-11-16' },
        { name: '公益市集', term: '2024秋', group: '外联部', hours: 5.0, date: '2024-12-07' },

        { name: '陪伴独居老人', term: '2025春', group: '护老部', hours: 4.0, date: '2025-03-15' },
        { name: '手语课堂（助教）', term: '2025春', group: '手语分社', hours: 6.0, date: '2025-04-12',
          note: '助教比学员紧张。打错一个手势，台下有人跟着我一起打错了。' },
        { name: '儿童医院陪伴', term: '2025春', group: '儿童部', hours: 5.0, date: '2025-05-10' },
        { name: '助学走访', term: '2025春', group: '资助部', hours: 7.0, date: '2025-06-07' },

        { name: '1+n 陪伴计划', term: '2025秋', group: '项目组', hours: 12.0, date: '2025-10-25',
          note: '陪到第二年，他把期末成绩单拍给我看。数学从 62 到 81。' },
        { name: '无障碍电影讲解', term: '2025秋', group: '无障碍部', hours: 5.5, date: '2025-11-22' },
        { name: '公众号推文排版', term: '2025秋', group: '宣传部', hours: 3.0, date: '2025-12-13' },

        { name: '星空计划·陪伴', term: '2026春', group: '项目组', hours: 8.0, date: '2026-03-21',
          note: '他问星星为什么不会掉下来。我说因为有人一直在看。他说那我看你。' },
        { name: '手语歌会', term: '2026春', group: '手语分社', hours: 3.0, date: '2026-05-16' },
        { name: '社员大会', term: '2026春', group: '组织部', hours: 2.0, date: '2026-06-06' }
      ]
    },
    {
      name: '陈屿', sid: '2500012345', college: '信息科学技术学院',
      joinDate: '2025-09-14', joinDateSource: 'created', companions: 12,
      activities: [
        { name: '迎新会', term: '2025秋', group: '组织部', hours: 2.0, date: '2025-09-14' },
        { name: '夕阳再晨·智能手机教学', term: '2025秋', group: '护老部', hours: 5.0, date: '2025-10-18',
          note: '第一次去，奶奶把水果洗了三遍。' },
        { name: '手语课堂（入门）', term: '2025秋', group: '手语分社', hours: 4.0, date: '2025-11-15' },
        { name: '无障碍电影讲解', term: '2026春', group: '无障碍部', hours: 5.0, date: '2026-03-28' },
        { name: '流动儿童课业辅导', term: '2026春', group: '儿童部', hours: 6.0, date: '2026-04-18' }
      ]
    },
    {
      /* 25-26 主表里没有填学号的历史记录 → NOT_FOUND_SID_MISSING */
      name: '周叙白', sid: null, college: '社会学系',
      joinDate: '2024-05-18', joinDateSource: 'created', companions: 8,
      activities: [
        { name: '敬老院探访', term: '2024春', group: '护老部', hours: 4.0, date: '2024-05-18' },
        { name: '手语歌会', term: '2024春', group: '手语分社', hours: 3.0, date: '2024-06-01' }
      ]
    },
    {
      /* 已入档但还没有任何关联到活动表的记录 → 空记录态 */
      name: '沈砚', sid: '2600016789', college: '元培学院',
      joinDate: '2026-09-12', joinDateSource: 'created', companions: 0,
      activities: []
    },
    {
      /* 边界形状：只参加过一个部组、只有一个学期、只有两场。
         新社员多数长这样，用来验证「单一部组 / 单一学期」不会把版面撑坏。 */
      name: '苏晚', sid: '2600023456', college: '外国语学院',
      joinDate: '2026-09-14', joinDateSource: 'created', companions: 5,
      joinMessage: '想认识一些会为别人的事认真起来的人。',
      activities: [
        { name: '夕阳再晨·智能手机教学', term: '2026秋', group: '护老部', hours: 5.0, date: '2026-09-20',
          note: '第一次去，奶奶把水果洗了三遍。' },
        { name: '敬老院探访', term: '2026秋', group: '护老部', hours: 4.0, date: '2026-10-11' }
      ]
    }
  ];

  /* 认人：姓名 + 学号必须同时命中（与后端 3.5 同口径，失败时给同一套归因码）。 */
  function lookup(name, sid) {
    var n = D.normalizeName(name), s = D.normalizeSid(sid);
    if (!n || !s) return { status: 'INVALID_INPUT' };

    var byName = MEMBERS.filter(function (m) { return D.normalizeName(m.name) === n; });
    if (byName.length === 0) return { status: 'NOT_FOUND_NAME' };

    var withSid = byName.filter(function (m) { return m.sid !== null; });
    if (withSid.length === 0) return { status: 'NOT_FOUND_SID_MISSING' };

    var hit = withSid.filter(function (m) { return D.normalizeSid(m.sid) === s; });
    if (hit.length === 0) return { status: 'NOT_FOUND_SID' };

    return { status: 'OK', member: hit[0] };
  }

  function query(name, sid) {
    var r = lookup(name, sid);
    if (r.status !== 'OK') return r;
    return D.build(r.member, false);
  }

  global.MOCK_DB = {
    members: MEMBERS,
    lookup: lookup,
    query: query,
    degrade: D.degrade,
    /* 下面这些是给自检页与旧调用点留的转发，避免出现第二份实现 */
    KNOWN_GROUPS: D.KNOWN_GROUPS,
    GROUP_MARK: D.GROUP_MARK,
    markFile: D.markFile,
    normalizeSid: D.normalizeSid,
    normalizeName: D.normalizeName,
    daysSince: D.daysSince
  };
})(window);
