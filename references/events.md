# 事件与返回协议

模板通过 emit 唤醒 Agent；emit.ok 只说明已投递。Agent 用 update_card_data 回写，卡片检查当前请求 ID 后接受并复位。不要用 state 写入接口冒充 Agent 结果，不要用 track 唤醒 Agent。

所有响应都写到事件来源 cardEntityId。事件来源的 cardInstanceId 用于 ui_inspect；两种 ID 不可混用。

## 工作树简介

事件：`hana-corder.enrich-worktrees`，参数 `{repoPath,refreshId,instruction}`。读取来源 `state.model.rows`，不要求事件携带整个快照。

成功：
```json
{"kind":"worktree-enrich","refreshId":"本轮ID","phase":"done","summaries":{"完整工作树id":"一句话用途"}}
```

失败：
```json
{"kind":"worktree-enrich","refreshId":"本轮ID","phase":"error","error":"具体原因"}
```

## PR 简介

事件：`hana-corder.enrich-prs`，参数 `{repoPath,remote,host,refreshId,instruction}`。完整事实在 `state.model.prs`。

成功：
```json
{"kind":"pr-enrich","refreshId":"本轮ID","phase":"done","summaries":{"host/owner/repo#42":{"summary":"一句话目的与范围","attention":"必要关注点，可省略"}}}
```

失败：
```json
{"kind":"pr-enrich","refreshId":"本轮ID","phase":"error","error":"具体原因"}
```

简介应覆盖本轮对象；遗漏不能被当作 Agent 已经补齐。Agent 不回写或覆盖 CI、冲突和 GitHub review 状态。

## PR 审阅

事件：`hana-corder.review-pr`，参数 `{reviewId,prId,headSha,note,instruction}`。其他事实从精确卡片读取。

成功：
```json
{
  "kind":"pr-review",
  "reviewId":"本轮ID",
  "prId":"host/owner/repo#42",
  "reviewedHeadSha":"实际审阅的完整SHA",
  "phase":"done",
  "review":{
    "conclusion":"未发现阻断问题",
    "summary":"主要结论",
    "findings":[],
    "validation":"实际验证及结果；或未运行的原因",
    "limitations":"覆盖限制",
    "completedAt":"ISO时间",
    "latestHeadSha":"结束时核对的SHA"
  }
}
```

每条 finding：`severity, path, lines, trigger, impact, evidence, suggestion, sourceUrl?`。sourceUrl 只用已核实来源。conclusion 可以是“未发现阻断问题”“发现问题”“信息不足”，不是 GitHub approval。

失败：
```json
{"kind":"pr-review","reviewId":"本轮ID","prId":"host/owner/repo#42","reviewedHeadSha":"目标SHA","phase":"error","error":"具体原因"}
```

旧 reviewId 不处理。结果版本与当前 PR 不符时保留其 reviewedHeadSha 并标过期，不把结果显示为当前版本通过。

## Issue 提交

保留已有事件名，便于既有卡片继续工作：

- `issue-swarm-gate`：含 repo、rangeLabel、allConfirmed、逐组 notes。精确分组和验收仍从来源 state.groups 读取。确认是当前范围的确认，不是 push/merge 的授权。
- `issue-swarm-notes`：逐组批注和来源范围。按注释分别解释、重查或按明确授权修复，不能把纯疑问当作改代码要求。

模板内 instruction 描述本次任务；Agent 仍要按 issues.md 检查计划成熟度和用户授权。示例卡上的点击不能被解释为真实 Issue 派工。

## 错误与恢复

- 读取、命令、emit 或 data 写入失败分别说明，不伪称动作完成。
- 对于已开始的请求，失败响应保留匹配 ID 并标 error，按钮应恢复可用。
- 单张 PR 卡每次只进行一轮刷新或审阅，避免多个返回文档互相覆盖。卡片之间互不借用状态。
- 已关闭实例不替换成其他同名卡；无法更新时回到正文报告。
- 长内容留在 state 或结果文档中，emit payload 控制在宿主 8KiB 上限内。
- 命令事件及结果以 commands.md 为准；不将新增命令等同于执行授权。
