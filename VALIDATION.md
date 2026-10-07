# 交付验证

验证日期：2026-10-07。

## 已通过

- Hana 原生 `validateRecipeTemplateDirectory`：五个模板全部通过。
- manifest 声明的 CSS、JavaScript、Hero 资产全部存在。
- 四张 Hero 已转为 JPEG quality=80，保持 1916×821 分辨率；总计由 10,959,118 字节降为 1,007,515 字节（减少90.8%）。模板引用已同步，原始生成图未删除。
- Python unittest：9 项通过。覆盖 Git 工作树、带空格/换行路径、rename、缺失目录、CI 未知/失败/跳过、PR 作用域、卡片准备、JSON 脚本转义及命令退出/超时。
- JavaScript / jsdom：12 组行为检查通过。覆盖 Issue 成功/失败提交、保留批注、8KiB 请求限制；工作树先更新事实、过期回复、错误复位；PR 来源、空态、批注保留、对象重排、审阅 SHA 过期、CI 不被覆盖；命令直接绑定、动态添加不自动执行、后台进程跟进及能力受限状态。
- 实际本地 Git 仓库准备工作树卡成功。
- 实际 gh 只读请求成功，当前查询范围为0个开放 PR；空态准备成功。
- 实际命令包装器执行只读 Git 状态查询，返回退出码0。
- 全包源码/文档未发现个人绝对路径、私人仓库名、会话ID或截图缓存ID。真实快照与机器绑定仅在用户运行准备脚本后写入会话输出目录，不随本配方分发。

## 已知边界

- PR 读写结果协议使用受控宿主 mock 验证；未对真实 PR 发布 review 或评论，也没有为验证创建 PR。
- PR审阅、摘要和动态命令执行需要 Agent 对事件作响应；不能把消息投递成功称为任务完成。
- 初始命令是固定工具绑定，动态新增命令走明确标注的 Agent 执行路径。
- 低权限宿主和离线场景用 jsdom 验证；未做自动化浏览器截图验收。
- `.recipe` 包不包含验证时生成的真实仓库快照、命令输出或缓存。

## 重跑

在提供 jsdom 的 Node 环境中：

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_cards.cjs
node tests/test_pr_runtime.cjs
node tests/test_commands_runtime.cjs
```

GitHub采集需要 gh 登录及目标仓库读取权限。测试本身使用临时Git仓库和mock GitHub数据，不写远端。
