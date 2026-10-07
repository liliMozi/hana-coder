# Issue：从分诊到修复汇报

## 1. 收集

通过 gh 获取用户指定范围的 Issue 全文、标签及相关讨论，确认仓库身份。范围可为编号、最近N天、标签或milestone。先读取再分组，不只靠标题猜根因。

超过15项可建议分批，但不能擅自丢弃其余项。分页或数量限制必须说明。用户只要整理时到分组卡为止，不自动修复。

## 2. 分组

默认一项一组。只有同一根因、改同一批代码或因果依赖，才合并为一个执行单元并说明理由。不相关问题不得为了少开工作树而绑在一起。

信息不足、缺复现、需要产品决策的条目进入 `status: clarify` 待澄清组。卡片上用琥珀黄，列出缺什么和下一步，不当作修复失败。

主代理先亲读关键代码、理解上下游和归属，收敛关键设计。任务书写清目标、非目标、基准提交、文件/符号、契约、修改步骤、错误处理、验证命令和停止条件；不把核心设计调查交给执行者。

## 3. 分组确认卡

模板：`hana-coder/assets/issue-gate.card.html`。

完整 state：
- uiLanguage、title、repo（host/owner/repo）、rangeLabel、hero:true。
- groups：label、modules、issues、mergeReason；待澄清组额外 status:clarify。
- 每个 issue：number、title、实际url、problem、acceptance、body、detail；待澄清项用 missing。
- notes:{}、submittedAt:null、page:0。

字段写法：problem是具体症状，不先编根因；acceptance来自用户目标和既有契约，不凭偏好加门槛；detail区分已证实根因和待验证假设。body保留有用原文和复现，不复制无关讨论。

模板内提交指令应说明：

> 读取本卡的真实分组、范围、验收和逐组批注。无批注表示确认当前方案，有批注则先按批注调整；重大范围变化重新确认。先确保关键设计和任务书完备，再按明确授权派工。待澄清组不派工。本次提交不授权 push、开 PR、合并、关闭 Issue 或删除工作树。若本卡标明示例，不执行真实任务。

## 4. 执行与审阅

遵守目标仓库工作树位置和基准分支规范，不写死 `.worktrees/`，不默认 fetch 后丢弃用户当前基准。

长且边界清楚的任务交运行环境中可用的执行代理；代理选择、思考等级和权限服从当前宿主与仓库规范。每组只能改自己的工作树。任务书自足，带完整事实和验收。通过完成事件/wait等待，不轮询。

主代理亲读真实 diff，对照验收核实测试、接口契约和回归影响；不只相信汇报。需要返工给出具体位置和理由，续接原实例。多轮未收敛就解释争议交用户裁定，不无限循环。

“修不了”是有效结果。记录实际卡点，不硬凑完成。验证失败区分产品、夹具和环境；不改弱断言冒充通过。

## 5. 修复汇报卡

模板：`hana-coder/assets/issue-report.card.html`。

完整 state：uiLanguage、title、repo、rangeLabel、hero:true、groups、notes:{}、notesSubmittedAt:null、page:0。

每组：label、branch、status（approved / rounds / failed / clarify）、rounds、issues、mergeReason、filesChanged、tests（passed / failed / none）、testsNote、failReason。

- 每个 issue：number、title、真实url、problem、solution、body、detail；待澄清项为 missing。
- solution用“根因：…处理：…”，只写已验证的实际修复。
- testsNote写实际命令及结果；none不写“通过”。
- failReason写卡点及建议，不写含糊的“遇到问题”。
- 文件数、分支和提交来自实际改动；示例结果不得替代真实证据。

模板内批注指令应说明：

> 读取来源卡片的分组及批注，先判断是疑问、重查、返工还是明确后续操作。只处理点名范围；返工续接原工作树与执行实例，修后重新审阅。纯疑问先回答。远端写入或破坏性动作遵守单独授权，不因批注提交自动执行。保留原批注与可核验的修复证据。

## 6. 善后

修复完成不等于允许合并、push或清理。用户明确点名后才处理；本配方默认最多完成授权的本地提交。已有仓库规范可能要求本地提交、版本或验证，按该仓库执行，配方本身不新增全仓CI门槛。
