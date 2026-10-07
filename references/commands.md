# 命令面板：添加、执行、结果

## 生成

```sh
python3 "$RECIPE_DIR/scripts/prepare.py" commands --repo "$REPO" --out "$OUT"
```

默认放 Git 状态、最近提交、diff 统计、工作树列表四条只读命令。需要项目测试/构建时先读取真实 package scripts 或构建配置，写 JSON 文件并加 `--commands 文件`，不要猜 `npm test`。

命令描述符：
```json
[{"id":"test-unit","name":"单元测试","argv":["npm","run","test:unit"],"cwd":"已核实绝对目录"}]
```

id 是唯一小写标识符。argv 是参数数组，不是未审查的 shell 字符串；cwd 显式。示例命令并不表示任何仓库一定存在该脚本。

准备脚本将每条初始命令冻结为静态工具绑定：调用本包 run_command.py，运行明确 argv/cwd，返回真实退出码和有限输出。卡片运行时无 cmd、cwd 或任意工具名槽位。生成后工具仍需要宿主授权，拒绝不是执行成功。

## 两类执行

- **初始绑定命令**：点击播放按钮直接调用其固定工具，通常无需 Agent 介入。
- **动态新增命令**：卡片明确标注由 Agent 执行；点击通过事件请求 Agent 运行对应 descriptor，然后把结果写回同一卡片。不把自然语言输入偷偷变成任意 shell 权限。

静态绑定无法因卡片数据更新而改变，因此不是静默 fallback。这一差别在卡片按钮提示和底栏可见。新增命令不等于立即执行；必须另点它的播放按钮。

同一卡片一次执行一条，避免重入；各条保留自己的结果。命令目录、输出与错误都按命令 id 归属，不借用其他卡片。

## 添加事件

`hana-corder.add-command` 携带 requestId、repoPath、request、模板内 instruction。

Agent 执行：
1. ui_inspect 精确事件来源，确认 `state.panel.requestId` 匹配且 pending。
2. 读取用户实际需求及仓库配置，确定最小命令、argv、cwd。不能为了满足需求顺手安装依赖或修改配置。
3. 原命令不改、不删；新增唯一 id 和简短名称，不编造可用脚本。
4. 写回完整命令列表，保留原条目字段。卡片将新条目标成 agent 模式。
5. 只添加不运行。不可完成则写回错误，保留输入并恢复添加按钮。

成功：
```json
{"kind":"command-add","requestId":"本轮ID","phase":"done","commands":[{"id":"existing","name":"原命令","argv":["git","status"],"cwd":"原目录"},{"id":"new","name":"新命令","argv":["工具","参数"],"cwd":"目标目录"}]}
```

实际列表必须包含来源卡片全部原条目，而不是复制上面的占位符。

失败：`{kind:"command-add",requestId,phase:"error",error:"具体原因"}`。

## 执行事件

`hana-corder.run-command` 携带 commandId、runId 和动作指令。读取 `state.panel.commands` 和 `activeRun` 核对，不执行事件中另塞的任意命令。

- 用户点击授权当前描述符所表达的普通本地操作，不自动授权发布、push、merge、破坏性操作或付费。那些仍按真实授权处理；需要确认时先说明，不能先执行。
- 不把 command 展示字符串交给 shell；使用已核实 argv/cwd。
- 可运行 `scripts/run_command.py --cwd 目录 --argv-json JSON`；它返回 `HANA_COMMAND_RESULT`。严格按真实结果判断，不把工具成功调用等同于命令退出0。
- 运行测试/构建前核对仓库来源与脚本，不执行未知 PR 附带的任意安装脚本。
- 不修改卡片 HTML，不新建替代卡片。结果写回原卡。

响应：
```json
{"kind":"command-run","runId":"本轮ID","commandId":"所选命令id","phase":"done","exitCode":0,"output":"真实输出","outputTruncated":false,"finishedAt":"ISO时间"}
```

失败用 phase:error、真实非零或null exitCode 和 error。输出最多约12KiB；截断必须标 outputTruncated，不伪称完整日志。

## 后台执行

初始直接绑定超过工具前台等待预算时，卡片保留 processId 并发送 `hana-corder.command-followup`。Agent 只跟进这个已有进程，绝不能再执行原命令。

需要结果现在返回时使用 write_stdin 空输入带预算等待；稍后用任务完成事件/wait_for_tasks。不要轮询。读取完整 `HANA_COMMAND_RESULT` 后按上面 command-run 响应回写。用户可点“请 Agent 跟进”，仍只跟进原任务。

没有 processId 的 Agent 请求卡住时，先核实原事件是否还在执行，不能凭等待时间推断失败，也不能盲目重跑。确认已失败或无法恢复后，回写明确错误复位。

## 不能做的事

不自动修复命令造成的失败、不默认安装依赖、不把一条命令扩展成部署流水线；用户要求解释结果时再分析卡点和建议。独立浏览器仅显示快照，不执行任何命令。
