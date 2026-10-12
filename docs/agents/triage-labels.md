# Triage 标签词表

skill 说的是五个**规范角色**；这份文件把角色映射到本仓库 issue tracker 里**实际使用**的标签字符串。

| skill 里的角色 | 本仓库的标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者需要评估这个 issue |
| `needs-info` | `needs-info` | 等报告人补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已写清楚，AFK agent 可独立接手 |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不做 |

**本仓库用默认值**（左右两列相同），没有做任何改名。

当 skill 提到某个角色时（例如"apply the AFK-ready triage label"），
就用上表右列对应的字符串。

> 改词表时改右列即可。左列是 skill 的内部说法，**不要改**。
>
> `kezizizi/loveheart-documents2` 是新建仓库，除 GitHub 自带的
> `bug` / `enhancement` / `documentation` / … 之外没有自定义标签，
> 与上表五个角色**一个都不重合**，所以不会误贴到别人的标签上。
> 首次真正用到某个标签时，GitHub 会在贴标签的同时自动创建它。
