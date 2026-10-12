# Issue tracker：GitHub

本仓库的任务/bug 记录在 **GitHub Issues** 里。所有操作走 `gh` CLI。

仓库：`kezizizi/loveheart-documents2`（在克隆目录内跑 `gh` 会自动识别，不必每次写 `-R`）。

> ⚠️ **前置条件**：这台机器上的 `gh` **尚未登录**。首次使用前跑一次
> ```
> gh auth login
> ```
> （或设 `GH_TOKEN` 环境变量）。没登录时 `gh issue create` 会直接失败，
> 而 skill 会把它当成"发布失败"，所以先做这一步。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --comments`；需要标签时一并取。
- **列 issue**：
  ```
  gh issue list --state open --json number,title,body,labels,comments \
    --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'
  ```
  按需加 `--label` / `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`
- **贴/摘标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

## 当 skill 说「publish to the issue tracker」

建一个 GitHub issue。

## 当 skill 说「fetch the relevant ticket」

跑 `gh issue view <number> --comments`。

## 写 issue 时的两条本仓库口径

1. **正文用中文**（与仓库其余文档一致）。
2. **不要在 issue 里贴真实社员数据**（姓名 / 学号 / 感想 / 导出件内容）。
   复现步骤用演示账号代替（见 `CLAUDE.md` 8.2），必要时脱敏成 `高＊＊`。
