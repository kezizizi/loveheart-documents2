# CLAUDE.md · 爱心社「爱心足迹」查询系统

> **这份文件是本仓库唯一的交接文档（仓库里没有 README，也不要有）。**  
> 写给 AI 协作者：读完这一份就该能安全地改这个仓库，不必先读完全部代码。  
> 改动代码后请**同步更新本文件**，尤其是第 3 节的红线与第 6 节的口径。  
> 工程类 skill 的仓库配置（issue tracker / 标签词表 / 领域文档）见文末「Agent skills」一节。

---

## 1. 一句话定位

北京大学学生爱心社的社员活动记录查询系统。社员输入**姓名 + 学号**，得到自己跨两个学年库  
的完整足迹：活动时间轴、部组分布、感想，以及可导出的 CSV 与一张可分享的卡片。

技术栈：**Streamlit（外壳 + 查数） + 零依赖静态前端（界面本体） + 飞书多维表格 Base（数据源）**。

### 1.1 界面现在长什么样（2026-10 起）

界面**不是** Streamlit 画的。它在 `static/web/` 里，是一套原生 HTML/CSS/JS 的静态站  
（无框架、无构建、无 npm）。Streamlit 只做三件事：**读 URL 参数 → 查飞书 → 把结果交给前端渲染**。

```
浏览器 ──► Streamlit 页面（app.py，只有一层空壳）
              └─ 自定义组件 iframe ──► /component/ui.embed.ax_footprint/index.html
                     │                        └─ style.css / app.js / data/*.js / assets/**
                     │                             （相对路径原样可用，因为它是真实 URL）
                     │
                     ├─ setComponentValue {name, sid} ──► Python 查飞书
                     └─ ◄── render {result: {status, member, degraded}, params}
```

**为什么用自定义组件而不是别的路**

| 方案 | 结论 |
| --- | --- |
| `st.components.v1.html`（srcdoc 内联整站） | srcdoc **没有真实 URL**，相对路径资源全废，得加 `<base>` 或把 654KB 图片全 base64；`location.search` 失效；**否决** |
| 另起一个 HTTP 服务挂静态站 + `POST /api/footprint` | 用户要的是「在 Streamlit 上呈现」，多一个进程就多一个部署面；**否决** |
| **自定义组件 `declare_component(path="static/web")`** | 前端拿到真实 URL，设计一字不改；**采用** |

**顺带解决的安全问题**：交接文档里那条「唯一可能造成真实安全事故」的红线（不要把仓库根目录  
挂成静态目录，否则 `.streamlit/secrets.toml` 可被下载）**在这个架构下不存在** ——  
被 HTTP 公开的只有组件根目录 `static/web/` 一个目录，而且 Streamlit 的组件文件服务会挡住 `..` 越界。  
`/.streamlit/secrets.toml`、`/config.py` 这些路径只会返回 Streamlit 自己的 SPA 外壳页，不是文件内容。

---

## 2. 当前规模（实测值，会随数据增长，用第 8 节的命令重新量）

| 指标 | 值 |
| --- | --- |
| Python 测试 | **199 项**，全绿，不触网、不需密钥 |
| 前端自检 | **156 项**，在真实浏览器里跑（`static/_work/run-selftest.mjs`） |
| Streamlit 端到端验收 | **49 项**（`static/_work/e2e-streamlit.mjs`） |
| 自动发现的活动问卷表 | **171 张**（25-26 学年 125 + 26-27 学年 46） |
| 注册表构建耗时 | 约 13 秒（约 175 次 API 请求） |
| 单次社员查询 | 约 5 秒（**开同行伙伴后约翻倍请求量**，见 3.11） |
| 代码量 | Python 约 4300 行 + 前端约 1500 行（不含测试与资源） |

活动表数量、部组分布、数据库字段都会随时间变化 —— **任何写死的数字都只当参考**，  
以 `scripts/verify_live.py` 的实时输出为准。

---

## 3. 🚩 不可违反的硬约束

按重要性排序。每条都对应某次真实事故或用户的明确指令，**不要凭直觉放宽**。

### 3.1 取数范围 = 只访问「主表里已关联」的活动表

查询某人的参与记录时，**只访问该人主表记录里确实关联了 record_id 的那几张活动表**，  
其余一张都不碰。实现是 `feishu/member_query.py::linked_tables`，  
它是在 `collect_records` 里**唯一**的取数范围来源。

- **不许**扩大到「该人有档案的库里的全部活动表」。
- **不许**扩大到「全部库」。
- **不许**为了「多扫一点更全」而新增按姓名扫描的兜底通道 —— 那种通道曾经存在，已被用户要求删除。

**原因**：活动表访问是整条链路里最贵的一步，而**飞书 API 调用量有月度上限**。  
对只在 26-27 有档案的社员（本届新生多数如此）擅自加扫 25-26，就是每次查询白打 125 张表。  
守卫测试：`tests/test_member_query.py::test_collect_participations_never_widens_scope`，  
以及 `tests/test_partners.py::test_partner_scan_never_widens_scope`（守住 3.11 新开的那条路）。  
（它们不是恒真的：把 `tables_of` 改成返回全库会立刻失败。）

**代价（已知并接受）**：活动记录必须都已建立关联，否则那条记录对该社员不可见。  
这不是 bug，是刻意的取舍 —— 覆盖率情况见第 12 节。

### 3.2 不许硬编码活动表 id 或活动名映射

活动表 100% 靠「遍历 Block 树 + 找有没有指向主表的 link 字段」动态识别  
（`feishu/registry.py`）。主表侧指向活动表的 link 字段用于建立取数索引。  
历史上有一张 80 条的手工映射表，其中两处 id 错位（扫雪与爱心驿站指向同一张表），  
**这是重写的直接动因** —— 不要走回头路。骨干新增活动表后无需改任何代码。

### 3.3 部组只能来自文件夹层级

`resolve_group` 只认 `config.GROUP_COLORS` 里的 **9 个已知部组**（护老部 / 无障碍部 /  
儿童部 / 手语分社 / 资助部 / 组织部 / 宣传部 / 项目组 / 外联部），支持子串匹配  
（如「组织部26春」）。**认不出的一律返回 `None`，归入“其他”** ——  
不要拿最外层文件夹名顶替，否则「1+n第二期」这类专项工作流会伪装成部组。

也**不要**用入社问卷里填的「感兴趣的部组」——那是意愿，不是事实。

**前端不再有第二份部组清单**：`derive.js` 的 `groupOf()` 原样返回后端给的规范名，  
只兜住空值。判定权唯一在后端。**不要**在前端重新加一份「认识的部组」名单 ——  
那会制造「后端认得出、前端却归其他」的静默偏差。

### 3.4 敏感字段永不进入请求投影或结果

唯一黑名单来源是 `config.SENSITIVE_FIELDS`（身份证 / 志愿者编号 / 微信号等）。  
`feishu/client.py` 里有**两道断言**（出站字段名、入站字段字段），命中即抛  
`SensitiveFieldError`。注册表阶段也会把这些字段从 `safe_fields` 里剔掉。  
改了任何字段相关代码，必须让隐私回归用例保持通过（`tests/test_payload.py` 里也有针对  
**接口响应**的泄漏断言）。

### 3.5 主表认人：姓名与学号必须同时命中

`lookup_member` 只认「姓名归一后相等 **且** 学号归一后相等」的记录，只看姓名一律不算。  
查不到时按 `NOT_FOUND_*` 归因（`name` / `sid` / `sid_missing`），交给前端给对应文案。

**注意区分两件事**（历史上混淆过一次）：

- **主表认人** → 姓名 + 学号必须同时命中，不可放宽。
- ~~参与判定~~ → 已随扫表通道一起删除，现在**不存在**任何「仅姓名匹配」的路径。

**归因拿不到时不许编**：`pick_not_found_reason` 返回 `None` 表示「检索压根没成功」，  
这时 `ui/payload.py` 发 `status: "ERROR"`，前端显示「这次没能读到你的档案」。  
**绝不**降级成 `NOT_FOUND_NAME` —— 那会把社员引向补录问卷，而问题在系统这一侧。

### 3.6 学号必须过 `normalize_sid`

25-26 库的「学号」是**数字字段**，26-27 库是**文本字段**。  
`services/identity.normalize_sid` 把它们统一成纯数字字符串（`2024001.0` → `"2024001"`）。  
绕过它做比较会让跨库匹配永远失败。前端 `derive.js` 有一份同口径的实现（用于演示数据）。

### 3.7 演示数据绝不能出现在生产形态里

`static/web/data/mock-db.js` 是假数据库，**只在独立形态**（本地直接打开页面、跑自检）加载。  
生产形态（Streamlit 组件）下它**永远不会被请求**，这是结构上的保证，不是靠「记得删那行 `<script>`」：

1. `index.html` **本来就没有**静态引入它（`tests/test_frontend_contract.py` 守着）；
2. `bridge.js` 只在判定为独立形态时才动态加载它；
3. **第二道保险**：只要真收到过组件协议的 `streamlit:render`，就永久锁死演示数据  
   （`locked`），之后即便形态判据失效也只会显示「查不到」，不会拿假数据冒充。

形态判据本身也踩过坑：**只判 `window.parent !== window` 是错的** ——  
`_work/selftest.html` 就是把页面放进 iframe 里跑的，会被误判成组件，于是永远等不到宿主消息，  
自检第一句就超时。所以判据是「被嵌入」**且**「宿主留下了正标记」（URL 上的 `streamlitUrl`  
参数，或 iframe 上的 `sandbox` 属性）。

### 3.8 组件高度回传必须「去抖 + 高度没变就不发」

组件 iframe 的高度由前端上报（`bridge.js::reportHeight`），因为里面没有滚动条。  
**如果在收到 `streamlit:render` 时改写 DOM 并立刻回传高度，会形成自激回路**：  
render → 撑高 iframe → 宿主重排 → 再 render。实测 18 秒内收到 **1149 次** render。  
两道闸：`setTimeout` 40ms 去抖、`Math.abs(h - lastH) < 2` 就不发。  
改 `bridge.js` 的高度逻辑前先把 `e2e-streamlit.mjs` 的「无内层滚动条」几条断言跑一遍。

高度用 `body` 各子元素底边的最大值，**不要**用 `documentElement.scrollHeight`：  
内容比视口矮时后者等于视口高，会只增不减，切回入口页就留一片空白。

### 3.9 后端只发「原始记录 + 状态」，派生只在前端算一次

载荷**只有** `{status, member, degraded}`。`stats` / `groups` / `terms` / `years`  
一律由 `static/web/data/derive.js` 在前端算，全站只有那一份实现。

- **不要**为了「让前端省点事」在后端也算一份 —— 两边各算一套必然出现自相矛盾  
  （历史上正是这样出现过「身份栏写着涉及 9 个部组，下面每个活动却都是『其他』」）。
- 反过来也成立：如果哪天决定挪到后端算，就必须**同时删掉前端的派生**，  
  不能两条路并存。守卫测试：`tests/test_frontend_contract.py`。
- 派生的唯一入口是 `derive.js::build(member, degraded)`，两条数据路径  
  （组件回传 / 演示数据）都必须过它。

### 3.10 不要「丢掉未知字段继续查」

字段被改名或删列后，接口会返回 `FieldNameNotFound`（1254045）。正确动作是抛  
`SchemaChangedError` → 重建注册表 → **只重试一次**（`services/schema_refresh.py`）。  
**绝不**把未知字段悄悄丢掉继续查 —— 学时字段一旦被改名，那样做会让整张表学时**静默变成 0**，  
比报错危险得多。宁可报错，不给错数字。

单表失败要隔离，但 `SchemaChangedError` 必须**穿透**（包括扫姓名列那条路，  
见 `scan_table_names`），否则自动重建触发不了。

### 3.11 同行伙伴：范围不许多、只投影姓名列、统计不到给 `None`

新前端的身份栏默认就显示「同行 N 位伙伴」，所以这项统计**每次查询都要做**，  
不是「用户点按钮才做」。三条边界钉死：

1. **范围**：扫姓名的表集合必须**恰好落在**本来就要取数的那几张关联表里（红线 3.1）。  
   多扫一张都是烧配额。
2. **投影**：只投影**姓名一列**（`scan_table_names`）。绝不能顺带把别人的感想、正文拉进内存。
3. **口径**：一张表都扫不动时返回 `None`（前端显示「—」），**不能退回 `0`** ——  
   0 会谎称「一个同场伙伴都没有」。

成本是**每张相关表 +1 次请求**（上限 `CO_PARTNER_CAP = 30` 张）；因为和取数共用同一个  
线程池、每张表的两次请求在同一个任务里顺序执行，所以**墙钟时间几乎不变**。  
`want_partners=True` 才会做这件事，默认关闭；结果有 10 分钟缓存。

**不要**把姓名花名册缓存下来长期驻留 —— 那意味着其他社员的姓名在服务端内存里留存，  
与「不展示任何其他社员信息」的口径有张力。

### 3.12 「没查成」不许被当成查询结果，也不许被缓存住

`pick_not_found_reason` 返回 `None` ⟺ **每个库的检索都失败了**。  
所以「`found=False` 且归因是 `None`」的含义是「我们根本不知道这个人在不在档案里」，  
**不是**一个查询结果。`ui/embed.py` 用一个专门的异常来表达它：

| 事项 | 做法 | 为什么 |
| --- | --- | --- |
| 表达 | 抛 `QueryUnavailable`，不返回失败值 | 见下一行 |
| **不许缓存** | 必须**抛异常**：`st.cache_data` 只缓存返回值，**不缓存抛异常的调用** | 返回失败值会被冻住 10 分钟，用户「再试一次」拿到的还是同一个失败 —— 实测复现过（2 次调用只真的跑了 1 次）。这正是「一直这样的话」的成因 |
| 重试 | `query_with_retry`：**只对「没查成」**等 1.5 秒重试一次 | 限流与网络抖动都是秒级的。而「查无此人」是确定答案，**不许**重试（白烧配额） |
| 诊断 | 记 `WARNING`，带上脱敏姓名 + 底层错误原文（Feishu 的 code / 表名） | 光回一句「系统取数出了点问题」等于没有信息 —— 排查时完全没法定位 |
| 用户文案 | 仍是前端自带的 `NOTICES.ERROR` | 「稍等一会儿再点一次」对瞬时失败就是正确建议；技术细节不该给社员看 |

守卫测试：`tests/test_query_unavailable.py`（含「失败没被缓存住」那条）。

**另外**：`ui/embed.query_payload` 里 `build_payload` 也必须在 `try` **里面**。  
它是我们自己的翻译代码，真出 bug 时用户该看到一条正常提示、完整栈进服务端日志，  
而不是整页变成 Streamlit 的「启动失败」。

---

## 4. 数据流与分层

```
飞书 Block 树（含文件夹）
  └─ 逐表探测：有 link 字段指回主表？ → 是活动问卷表
       └─ 文件夹层级 → 部组；文件夹名/表名 → 学期
       └─ 字段名正则 → 学时字段 / 时间字段
                    ↓  产出 ActivityRegistry（可缓存快照）
主表记录（姓名+学号命中）
  └─ 主表 link 字段 → 活动表 record_id 列表
       └─ 每张表两个请求（同一个线程池任务内）：
            batch_get_records → 本人参与记录
            search_records(仅姓名列) → 同场伙伴姓名（可选）
            └─ collect_records() → CollectedRecords
                 └─ ui/payload.build_payload() → 前端契约 JSON
                      └─ 组件 render 消息 → derive.js 派生 → 渲染
```

**严格四层，依赖单向**：

| 层 | 目录 | 允许做什么 |
| --- | --- | --- |
| 数据层 | `feishu/` | **唯一**发网络请求的地方；把两种接口形态归一化 |
| 业务层 | `services/` | **纯函数**：无网络、无 Streamlit，便于单测 |
| 适配层 | `ui/payload.py` | 后端模型 → 前端契约 JSON。**纯函数**，不 import streamlit |
| 宿主层 | `ui/embed.py` + `app.py` + `static/web/` | 组件声明、缓存装配、前端渲染 |

**唯一缝（seam）**：`feishu/protocol.BitableClient`。上层只依赖这个 Protocol，  
真实实现走飞书 HTTP（`feishu/client.py`），测试与演示实现读本地 fixture  
（`feishu/fake.py`，**同一份**，避免两套假实现漂移）。

---

## 5. 文件地图

```
app.py                      Streamlit 入口；只调用 ui.embed.render() + 页面级异常兜底（避免白屏）
config.py                   纯常量 + 容错配置加载器。字段白名单/敏感黑名单、部组清单与配色、
                            学期归一、活动名清洗、字段探测正则、TTL/并发默认值
CLAUDE.md                   本文件（唯一交接文档）

feishu/  ── 数据层（唯一网络出口）
  protocol.py               BitableClient 协议 —— 测试与真实的唯一缝
  client.py                 HTTP 客户端：token 单例复用、退避重试、v3→v1 回退、字段投影守卫
  schema.py                 把 base/v3 与 bitable/v1 两种 JSON 归一成同一种形状；单元格取值工具
  registry.py               活动注册表：遍历 Block 树 + 探测 link 字段 + 文件夹推导部组 + 字段探测
  member_query.py           单成员跨库查询：认人、归因、只按关联取数、汇总参与记录、
                            scan_table_names / collect_records（同行伙伴）
  models.py                 不可变 dataclass：ActivityTable / ActivityRegistry / MemberRecord /
                            Participation / Footprint / MembershipDate / TimelineItem / CollectedRecords
  fake.py                   内存版客户端，测试与演示共用

services/  ── 业务层（纯函数）
  identity.py               学号/姓名归一化、跨库合并（MergedMember）
  membership_date.py        入社日期口径、日期格式化、入社天数
  footprint.py              时间轴排序、学时汇总、部组聚合、count_co_partners
  schema_refresh.py         with_schema_refresh：命中 SchemaChangedError 时重建并只重试一次

ui/  ── 表现层
  payload.py                后端模型 → 前端契约 JSON（纯函数，唯一翻译点）
  embed.py                  组件声明（declare_component(path=static/web)）、缓存装配、编排；
                            QueryUnavailable / is_unavailable / query_with_retry（见 3.12）

static/web/  ── 组件根目录（**会被 HTTP 公开**，只放运行期文件）
  index.html                入口骨架：品牌栏、入口表单、加载/提示区、三个视图面板
  style.css                 全部样式：设计令牌、三视图、打印样式、动效
  app.js                    全部渲染逻辑：视图、时间轴曲线、交互、CSV、打印
  data/derive.js            **唯一**一份派生实现（stats/groups/terms/years）+ 徽记路径
  data/bridge.js            **唯一**数据通道：组件形态 / 独立形态、高度上报、形态判据
  data/mock-db.js           演示用假数据库。**只在独立形态动态加载**（见 3.7）
  assets/**                 10 枚部组徽记、小径插画、纸纹、社徽、卡片栏图与二维码

static/前端契约.md           更细的前端契约与实现说明（时间轴数学、动效、可访问性、踩过的坑）
                            ← 放在组件目录**同级**，因为组件目录里的东西会被 HTTP 公开

static/_work/  ── 开发与验证工具（同样不会被公开）
  run-selftest.mjs          一键跑前端自检（自带静态服务器 + 一次性浏览器 profile）
  e2e-streamlit.mjs         Streamlit 端到端验收 + 逐视图截图
  selftest.html             156 项前端回归断言（在真实浏览器里驱动 web/index.html）
  serve.py                  静态服务器（对所有响应发 no-store）
  pdfcheck.py / shot.ps1 / phone-shot.ps1 / measure*.html   打印差分与截图工具

docs/                       设计源文件、飞书结构分析报告，以及工程类 skill 的仓库配置
  ├ 爱心社社员档案_飞书多维表格结构分析.md   ← 想了解 Base 的真实结构看这份
  └ agents/                 工程类 skill 的仓库配置（见文末「Agent skills」）
      ├ issue-tracker.md    任务/bug 记在哪、怎么用 gh 操作
      ├ triage-labels.md    五个 triage 角色 ↔ 实际标签字符串
      └ domain.md           领域文档放哪、怎么用它的词汇
scripts/verify_live.py      真实接口联调自检（用真实密钥，只打印结论不做断言）
tests/                      199 项单元测试 + 录制的 JSON fixture（blocks/fields/records）
.github/workflows/ci.yml    跑测试 + 密钥泄漏扫描
```

---

## 6. 领域口径（改数据相关代码前必读）

| 项目 | 口径 |
| --- | --- |
| 主键 | 归一化后的「姓名 + 学号」；学号统一成纯数字字符串 |
| 活动表识别 | Block 树里的 table 且**有 link 字段指回主表**；排除主表自身、`FORBIDDEN_TABLE_IDS`、模板/反馈渠道类表名 |
| 活动名 | 剥掉「反馈、学时问卷」「问卷」「副本」「-结果分析」等后缀（`config.ACTIVITY_NAME_SUFFIXES`） |
| 部组 | 表格在 Base 里的**文件夹归属**；只认 9 个已知部组，其余归「其他」；前端不再二次判定 |
| 学期 | 由文件夹名或表名里的「2025秋 / 26春 / 暑假」推导，统一成四位年份 + 季节；缺失时发 `未标注学期`（**不能编四位年份**，那会凭空造出一个学年） |
| 入社日期 | 两库全部记录取最早：优先「入社日期」字段真实值（25-26 库有）→ `joinDateSource = "filled"`；缺该字段则回退 **Base 记录 `created_time`** → `"created"`；都没有 → `joinDate = null` / `"none"`（前端显示「—」）。⚠️ 批量导入的行 created_time 是导入时刻，可能晚于实际入社时间 |
| 志愿学时 | 字段名不统一（志愿时长 / 志愿学时 / 工时），按 `HOURS_RE` 正则探测；同条记录多个学时字段则**求和** |
| 参与时间 | 字段名更野（参与时间 / 填写日期 / 签到时间），`TIME_RE` 同时认「时间」与「日期」；`TIME_STRONG_HINTS` 排序 |
| 时间轴排序 | 参与时间 → 学期标签 → 记录创建时间，三级回退 |
| 感想（前端 `note`） | **只取 `reflection`（感想类字段），不取 `content`（核心内容/环节）**。实心圆点的语义是「这一场留下了你的感想」，把活动描述塞进去等于替社员编造语气。取不到就留空 → 前端画空心圆点 |
| 置信度 | 取数只走关联后**恒为 high**；`medium` / `low` 是历史遗留。前端 CSV **已不再输出**「置信度」列（恒定的列没有信息量） |
| 同行伙伴 | 每张相关表扫一次姓名列，上限 `CO_PARTNER_CAP = 30` 张；人数按姓名去重、排除本人；**只出人数不出姓名**；统计不到发 `null` |
| 缓存 | 注册表 24 小时（**全局共用**）；单次查询结果 10 分钟 |
| 海报 | **已删除**（`services/poster.py` 与服务端 Pillow 拼版）。导出改成前端 HTML 卡片 + 浏览器打印/存 PDF |

---

## 7. 飞书接口的坑（每条都是一次真实事故）

代码里都已处理。**改数据层之前先看这张表**，否则很容易把已修好的东西改坏。

| 现象 | 根因 | 现在的处理 |
| --- | --- | --- |
| **部分活动表凭空消失**，且每次消失的还不一样 | 旧版接口把**限流**报成 `HTTP 400` + `code 99991400`（**不是 429**）。只按状态码判断会把请求直接判死，被限流的那张表被丢掉，而注册表要缓存 24 小时。修复前连跑三次得到 169 / 165 / 171 张 | `99991400 / 99991404 / 1254290` 纳入可重试判定 + 退避重试 |
| **整张表的数据一条都拿不到** | 请求投影 `field_names` 里带**超过 50 字**的字段名，飞书会拒掉**整个请求**（`field validation failed`，`99992402`），而不是忽略那一个字段。触发源是有人把问卷题干当成了列名（最长 78 字） | API 边界 `client.usable_names()` 统一剔除；注册表侧 `safe_fields` / 学时 / 时间 / 主表投影同步过滤。投影被剔空则**宁可报错**，也不退化成「不带 field_names」（那会拉回全部字段、越过隐私边界） |
| 骨干改个列名，那张表就整体报错 | 缓存 24 小时的旧字段名触发 `FieldNameNotFound`（`1254045`） | 抛 `SchemaChangedError`，穿透单表隔离，重建注册表后**只重试一次** |
| 关联取不到任何数据 | link 单元格的键名是 `link_record_ids`（不是旧文档里的 `record_ids`） | 两种键名都兼容（`schema.cell_link_record_ids`） |
| 按姓名筛选失效、返回整表 | 旧版 `records/search` **不认 `keyword`**（传了也返回整表） | 翻译成 `filter` 条件下推到服务端；再不行退化为全量拉取 + 客户端筛 |
| 新版接口整体不可用 | 新版 v3 需要 4 个独立 scope（`base:block:read` / `base:table:read` / `base:field:read` / `base:record:read`） | 自动回退到旧版 `bitable/v1`。**只有 `base:block:read` 没有旧版对应**（文件夹树只存在于新版），缺它会降级为「扁平表列表」、部组退化为「其他」并在页面提示（`degraded: true`） |
| 读不到某个库的数据 | 该库没把应用加为**协作者**（`1254302 RolePermNotAllow`） | 见第 8.4 节的飞书后台配置 |

---

## 8. 环境、命令与调试

### 8.1 跑测试（**固定用系统 Python 3.9**）

```bash
"C:/Users/gzk16/AppData/Local/Programs/Python/Python39/python.exe" -m pytest
```

系统 Python 3.9 已装齐 pytest / streamlit / requests。  
**本机 pip 装包被沙箱拦**（curl 通但 pip 报 no versions）—— 不要折腾新建 venv。  
前端**不需要**任何 Python 依赖（`pillow` 已随海报一起删掉）。

### 8.2 本地看界面

```bash
# 演示模式：用 tests/fixtures 里录制的真实响应形状，不需要密钥
AX_DEMO=1 "C:/Users/gzk16/AppData/Local/Programs/Python/Python39/python.exe" -m streamlit run app.py

# 真实模式（需要 .streamlit/secrets.toml）
"C:/Users/gzk16/AppData/Local/Programs/Python/Python39/python.exe" -m streamlit run app.py
```

带参进入（便于分享与截图）：`http://localhost:8501/?name=张三&sid=2300017473`  
（组件形态下这些开关由 **Python 从 `st.query_params` 读出来再透传**给前端；  
前端自己读的是 `document.referrer`，因为组件 iframe 的 search 里只有 Streamlit 附加的 `streamlitUrl`。）

**演示账号有两套，别混**：

| 场景 | 可用账号 |
| --- | --- |
| `AX_DEMO=1`（真实后端代码路径 + 录制 fixture） | 张三 / 2300017473、李四 / 2500018888、钱只二五 / 2300018888、赵无号 / 任意（缺学号） |
| 独立打开 `static/web/index.html`（假数据库） | 林知遥 / 2300015108（21 场主演示）、陈屿、苏晚（边界）、沈砚（空记录）、周叙白（缺学号）、张三 / 1234567890（查不到姓名） |

### 8.3 前端自检与端到端验收（**别靠肉眼**）

```bash
# 前端回归：156 项断言，自带静态服务器与一次性浏览器 profile，跑完自动清理
node static/_work/run-selftest.mjs

# Streamlit 端到端：先起 Streamlit，再跑（49 项 + 逐视图截图）
AX_DEMO=1 python -m streamlit run app.py --server.headless true --server.port 8602
node static/_work/e2e-streamlit.mjs http://127.0.0.1:8602 static/_work/e2e-shots
```

> 别照抄老文档里那条 `msedge --headless=new --virtual-time-budget=… --dump-dom`：  
> `index.html` 会在运行时**动态加载** `mock-db.js`，虚拟时间预算会在动态脚本到位之前  
> 就把页面判定为「没有待办任务」而收工，于是拿到一个还没出结果的页面，报  
> `EXCEPTION timeout` —— 是跑法的假阴性，不是前端坏了。`run-selftest.mjs` 改成等  
> `#report` 里真的出现 `RESULT` 再收，并打开 `Emulation.setFocusEmulationEnabled`  
> （不开的话 `el.focus()` 不派发 focus 事件，「键盘聚焦圆点等价于悬停」那条会在  
> **完全未改动的原版前端上同样失败**）。

**改前端时最容易骗到自己的三件事**（都真实踩过，`e2e-streamlit.mjs` 里都有对应处理）：

1. **抓到隐藏的旧组件框。** Streamlit 重跑时会短暂留下一个隐藏 iframe，里面 DOM 齐全但  
   没有布局盒，`el.click()` 与真实交互都不生效。选择器必须挑 `clientHeight > 0` 的那个。
2. **测试把要验的东西自己 stub 掉了。** 想验「点下载链接会不会生成 Blob」，就不能把  
   `HTMLAnchorElement.prototype.click` 整个换掉 —— 那样被点的元素根本不派发事件。  
   用 `dispatchEvent` 绕开自己装的桩。
3. **拿竞态当 bug。** 高度上报是去抖 40ms + postMessage + React 重排，导出卡还要等  
   161KB 栏图加载完才长到最终高度。断言前要**轮询等它贴合**。

### 8.4 真实接口联调自检

改了数据层代码后必跑（**需要真实密钥，只读不写**）：

```bash
python scripts/verify_live.py              # 全量自检
python scripts/verify_live.py --skip-query # 只建注册表，不查具体社员
```

它会打印：接口版本、是否降级、两个库各发现多少张活动表、部组分布、字段探测抽样、  
敏感字段泄漏检查、一次真实社员查询结果。打印姓名时做脱敏。  
**判断改动是否无损，就看这里的活动表数量与命中数是否与改前一致。**

新版前端已经在线上真实库上**只读**跑通（10 个社员、两库各 5 个，10/10 出结果；
172 张活动表、无敏感字段泄漏）。但**还没有真人从头到尾用过一遍**，所以这几项仍值得核对：  
`院系` 是否为空、`想对爱心社说的话` 是否取到、活动条数是否与骨干手工数的一致。

### 8.4.1 社员报「这次没能读到你的档案」时怎么查

那个提示就是 `status: "ERROR"`，含义是「**我们没查成**」，不是「查无此人」。  
现在它在服务端控制台一定会留下可执行的原因（在**应用日志**里搜 `ui.embed`）：

```
WARNING ui.embed: 取数失败（非查无此人）｜高＊＊｜[25-26 学年] 检索主表失败：<飞书返回的原文>
```

* 带 `WARNING` 的是**基础设施失败**（限流 / 网络 / 权限）—— 会**自动重试一次**，  
  且**不会被缓存**，所以「稍等再点一次」真的会重新查（见红线 3.12）。
* 带 `Traceback` 的是**我们自己的代码出错**（翻译层 / 编排）—— 按栈去改代码。
* 一条日志都没有？那说明前端根本没把请求发出来（看浏览器控制台），与数据层无关。

Streamlit Community Cloud 上在 **Manage app → Logs** 里看同一份日志。

### 8.5 飞书后台配置（新克隆仓库必做，最容易漏）

1. **开通权限并创建版本发布**（不发布不生效）：`bitable:app` 必需；  
   `base:block:read` 强烈建议（**这是部组标签的唯一来源**，缺了部组全变「其他」）。
2. **把应用加为每个库的协作者**。⚠️ 入口**不在「分享」面板**（那里只搜成员和用户组，  
   搜不到应用）：
   > 打开多维表格 → 右上角 **「···」→「···更多」→「添加文档应用」** → 搜应用名 →  
   > 权限选 **「可管理」**。
   两个库都要做。**这两个库都开了高级权限，必须给「可管理」**，给「可编辑」仍报 `1254302`。  
   若「添加文档应用」里也搜不到：① 发布版本的「可用范围」需包含该库所有者；  
   ② 应用至少开通任意一个云文档 API 权限。

   **API 加协作者走不通，别再试**：`member_type: "appid"` 被无条件拒绝（`1063001`）；  
   用应用 open_id 需要机器人能力，本应用没开（`bot/v3/info` 返回 `11205`）。**只能走 UI。**

### 8.6 密钥与配置

`.streamlit/secrets.toml` **不在仓库里**（`.gitignore` 排除，CI 还有一道扫描）。  
新克隆需自建：

```toml
[feishu]
app_id = "cli_你的应用ID"
app_secret = "你的应用密钥"

[base_25_26]
base_token = "第一个多维表格的 base_token"
main_table_id = "「社员档案」主表的 table_id"

[base_26_27]
base_token = "第二个多维表格的 base_token"
main_table_id = "「社员档案」主表的 table_id"
```

`base_token` / `main_table_id` 从 URL 里取：`https://<租户>.feishu.cn/base/<base_token>?table=<table_id>`。  
也可用环境变量：`APP_ID` / `APP_SECRET` / `BASE_25_26_TOKEN` / `BASE_25_26_TABLE_ID` /  
`BASE_26_27_TOKEN` / `BASE_26_27_TABLE_ID` / `REGISTRY_TTL` / `MEMBER_TTL` / `MAX_WORKERS`。

**配置缺失时，报错必须说清「到底读到了什么」**（`config.describe_source`）：它会列出实际  
读到的**段名与字段名**，从而把三种完全不同的情况区分开 —— ① 只粘了 `key = "value"` 而没写  
`[feishu]` 段头（报错里会显示「顶层」）；② 段名拼错或大小写不对（会显示 `[Feishu]`）；  
③ TOML 语法错（会带出解析器异常）。**绝不要把配置的值打进报错**，并在渲染处转义。  
`tests/test_config.py` 守着这些。`app.py` 最外层还有一道兜底，异常文本用 `html.escape` 转义。

### 8.7 Windows 上的坑

- **没有 watchdog**：Streamlit 不监听被导入模块的改动。**改完 Python 代码必须手动重启服务**。  
  （改 `static/web/**` 不用重启：组件文件是每次请求现读的，但**浏览器会缓存非 HTML 资源**，  
  所以要推进 `?v=` 版本号或强制刷新。）
- **旧进程占端口**：旧进程还占着端口时，新起的会**静默失败**（Windows 的 `SO_REUSEADDR`  
  允许两个进程绑同一端口），你看到的仍是旧页面。实测踩过：8777 上蹲着一个几小时前启动、  
  根目录还挂在别处的服务器，新服务器打印了「serving …」却收不到任何请求。  
  用 `netstat -ano | findstr :<port>` 找 PID 再 `taskkill /F /PID <pid>`，**或者干脆换个端口**。
- 界面验收必须走 `static/_work/` 里那两个脚本：它们是「无头 Edge + CDP + 一次性 profile」，  
  `--screenshot` 只能拍到骨架屏。

---

## 9. 改代码时的契约

- **要发网络请求 → 只加在 `feishu/`**。业务层与视图层不许直接 import `requests`。
- **新数据源 → 实现 `feishu/protocol.BitableClient`**，不要改上层调用。
- **所有新字段名先进 `config.MEMBER_READ_WHITELIST`**，否则不会被请求；  
  同步隐私清单与测试。想让它进入接口响应，再在 `ui/payload.py` 里翻译一下。
- **前端契约只有一处翻译点**：`ui/payload.py`。改载荷键名必须同时改  
  `tests/test_frontend_contract.py` 里的键集合。
- **派生逻辑只加在 `static/web/data/derive.js`**（红线 3.9）。
- **改 `static/web/**` 的任何图片或样式 → 必须推进版本号**（红线：`derive.js` 的 `ASSET_V`、  
  `index.html` 的 `?v=`、`app.js`/`style.css` 里的图片引用，四处必须一致，  
  `tests/test_frontend_contract.py` 会检查）。
- **不要往组件目录 `static/web/` 里放开发工具**：那个目录会被 HTTP 公开。
- **单表失败要隔离**，但 `SchemaChangedError` 必须**穿透**（`raise`），否则自动重建触发不了。
- **新错误码 → 先判断它属于哪一类**：可重试（限流）/ 走 v1 回退（新版不可用）/ 语义化（结构变更）。  
  分错类会造成静默丢数据。
- **`load_registry` 的签名里不许有任何参数**（红线见下）。缓存键里一旦掺进会话级的东西  
  （如 nonce），每个新访客都会重建一次注册表（约 175 次请求）。所有会话共用同一份（TTL 24 小时）。  
  **代价（有意接受）**：点「刷新数据」对所有人都生效。  
  （`ui/embed.py::refresh()` 是那个入口，新前端没有按钮，需要时从代码或 REPL 调。）

---

## 10. 常见任务 → 改哪里

| 想做的事 | 动哪里 |
| --- | --- |
| 骨干新增了活动表，让它出现 | 不用改代码；调 `ui.embed.refresh()`（注册表 TTL 24h，且**全局生效**） |
| 调整学时/时间字段的识别规则 | `config.HOURS_RE` / `TIME_RE` / `TIME_STRONG_HINTS` + `registry.detect_*` |
| 改部组清单或配色 | `config.GROUP_COLORS` / `GROUP_FALLBACK_COLOR` |
| 改前端样式/版式 | `static/web/style.css`（记得推进 `?v=`） |
| 改前端某个视图的渲染 | `static/web/app.js` |
| 改派生口径（场次/部组汇总/学年分组） | `static/web/data/derive.js` |
| 改数据来源或形态判据 | `static/web/data/bridge.js` |
| 改接口载荷 | `ui/payload.py` + `tests/test_frontend_contract.py` |
| 改入社寄语取哪个字段 | `ui/payload.JOIN_MESSAGE_FIELDS`（已在白名单内，不需要改 config） |
| 改「查不到」时的文案 | `static/web/app.js` 的 `NOTICES`（**后端不传文案**） |
| 改补录问卷链接 | `config.SUPPLEMENT_FORM_URL`（当前前端文案里未使用，属待办） |
| 改活动名清洗规则 | `config.clean_activity_name` + `ACTIVITY_NAME_SUFFIXES` |
| 改同行伙伴逻辑 | `feishu/member_query.py` 的 `scan_table_names` / `collect_records` |
| 改缓存时长 | `config.DEFAULT_REGISTRY_TTL` / `DEFAULT_MEMBER_TTL`（或 secrets） |
| 新增可查询字段 | `config.MEMBER_READ_WHITELIST`（记得同步隐私清单与测试） |

---

## 11. 隐私

- 只查询用户本人输入的那一条记录，**不展示任何其他社员的信息**。
- 身份证号、志愿者编号、微信号等敏感字段，在代码层就被排除在请求投影之外 ——  
  既不读取，也不进入内存、页面或导出文件。唯一黑名单来源是 `config.SENSITIVE_FIELDS`，  
  `feishu/client.py` 有两道断言，并有单元测试守着（含对**接口响应**的泄漏断言）。
- 「与 N 位伙伴同行」只输出**人数**，不含任何姓名。为此只投影活动表的**姓名一列**，  
  绝不把别人的感想/正文拉进内存，也**不把姓名集合缓存下来长期驻留**。
- 导出卡片上**只出现姓名**，不含院系、年级、学号。
- 社员档案导出件（`docs/*.xlsx`）含姓名/学号/院系，**已被 `.gitignore` 挡住，绝不入库**。
- `docs/平面设计常用素材/`（约 41 MB）仅供本地参考，不入库。
- 中文字体不再随仓库提交（原本 17MB，只被已删除的服务端海报使用）。前端按名引用  
  华文中宋 / Times New Roman，回退到系统自带的宋体族。

---

## 12. 已知限制与待办

**数据侧（需人工在飞书里做，不是代码问题）**

- 活动记录必须都已建立双向关联，否则那条记录对该社员不可见（见 3.1）。  
  当前覆盖率约：25-26 学年 92%、26-27 学年 96%。补完关联即 100%。
- 25-26 主表里有一批历史记录**没有填学号**。这批人拿真学号来查会落到  
  `sid_missing` 归因 → 引导补录。**系统刻意不做姓名兜底匹配**（那会拿同名误判换覆盖率）。

**代码侧（已知、待决定）**

- **同行伙伴的截断没有在界面上说明**：参与过的活动表超过 30 张时，人数是**下界**  
  （`co_partners_truncated = True`），但新设计里没有放这句话的位置。  
  旧 UI 会写「（仅统计了最近若干场活动）」。要不要在导出卡片或身份栏补一句，需用户拍板。
- `confidence` 恒为 `high`；前端 CSV 已撤掉「置信度」列，但 `MemberQueryResult` 上  
  `low_confidence_count` 等历史遗留字段还没删（牵动测试，属产品决定）。
- `ActivityRegistry.errors` 里的失败只会提示「数据可能不完整」，不会自动重试到底 ——  
  限流重试耗尽后仍有极小概率丢表，但**不会无声无息**。
- 活动名清洗还能更好（如「9月20日无障碍部迎新会反馈」尾部「反馈」未剥净，  
  与「2025星空」类命名风格不一致）。
- `search_records` 的 `limit` 在旧版回退路径被忽略（会全量返回），不影响正确性，只影响速度。
- 前端在设计阶段验证过的**打印差分**（三视图各 1 页 A4）用的是独立形态；  
  组件形态下只验证了「确实调用了 `window.print`」，没有栅格化检查打印质量。
- `?degraded=1` 与 `?delay=` 只在**独立形态**有意义（组件形态下 `degraded` 由后端如实给出）。

**未完成**

- **那次「这次没能读到你的档案」没有复现出来**（2026-10）。排查记录：
  · 冷启动 + 表单提交 + 深链，两条路径都走通；
  · 10 个真实社员（两个库各 5 个）逐一走完整路径，**10/10 成功**，服务端日志无异常、无限流；
  · 现场没有留下日志（当时 ERROR 不写日志），所以**根因未知**。
  已按「瞬时失败」把这类故障做成可自愈 + 可诊断（红线 3.12）：自动重试一次、
  失败不入缓存、并把飞书返回的原文写进日志。**若再次出现，请先按 8.4.1 抓那条 WARNING。**
- 线上真实库已经**只读**跑通过（172 张活动表 / 命中 14–29 条记录 / 无敏感字段泄漏），  
  但仍**没有真人从头到尾用过一遍**，也**尚未部署**。

---

## Agent skills

工程类 skill（`to-issues` / `triage` / `to-prd` / `diagnose` / `tdd` /
`improve-codebase-architecture` 等）的仓库配置。三份细则都在 `docs/agents/` 下。

### Issue tracker

任务与 bug 记在 **GitHub Issues**（`kezizizi/loveheart-documents2`），用 `gh` CLI 操作。
⚠️ 本机 `gh` **尚未登录**，首次使用前先跑 `gh auth login`。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范角色用**默认英文标签**（`needs-triage` / `needs-info` / `ready-for-agent` /
`ready-for-human` / `wontfix`），左右两列相同、未改名。见 `docs/agents/triage-labels.md`。

### Domain docs

**单上下文（single-context）**，但领域语言**不放在 `CONTEXT.md`** —— 它就是本文件
第 6 节「领域口径」，架构决策的「为什么」在本文件第 3 节。`docs/adr/` 目前不存在。
见 `docs/agents/domain.md`。

---

## 附：许可

代码供北京大学学生爱心社内部使用。
