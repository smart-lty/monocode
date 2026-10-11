# 新 session 的 orchestrator prompt

将下面内容复制到已选择 orchestrator 的新 session。先生成任务卡，确认后再执行。

```text
请作为 MonoCode orchestrator，继续实现会话引用、Fork 和 Sidechat。

先阅读 /Users/tianyu/workspace/code/monocode/docs/session-features-handoff.md，按其中的绝对路径读取两份既有调研报告。复用现有结论和原型，不重新做社区调研。当前项目是 /Users/tianyu/workspace/code/monocode，已有未提交修复必须保留，并记录本轮开始时的增量基线。

先调查和规划，生成可审核的任务卡，确认后再执行。不要重复已完成的 orchestrator 和 Markdown 修复，也不要把它们的历史 diff 算作本轮新增。

执行顺序：
1. 确认实际运行的是更新后的 App。首个 worker 先小范围交付，走通执行前检查点、多轮修正及正常 review 集成，再扩大实现。验证普通 session 与编排可并行、停止互不影响。finish 在所有必要任务审查集成后执行，不要为冒烟测试提前结束同一个 run。
2. 把会话选择和上下文注入作为一个完整功能交付：# 当前项目、## 所有项目；最近活动排序、查询相关性、项目图标、模型/时间/标题/轮数、引用卡片及拖拽。跨项目选择不切换项目、不丢草稿。@ 保留文件功能。注入使用摘录＋从已发送 blocks 推导的持久目录＋无损补读/文件导出，覆盖续聊、恢复、compaction 后新 turn、Build 和 harness 切换，不退回旧的三轮截断读取接口。
3. 实现准确分支点的 Fork，区分原生继承和 Handoff/原文重建，验证模型没有继承分支点之后的历史。Sidechat 在现有 Btw 上扩展，默认只读、独立取消、保存讨论，并将选中结论带回可编辑的主输入框草稿，不自动发送。
4. 审查实际增量和用户体验，完成联合验证及可交付构建。Intelligence UI 暂缓；本轮不建设新的摘要服务、引用版本库或第二套侧聊系统。

模型分工：后端与集成优先 codex:gpt-6.1-sol，reasoningEffort=max；UI 与交互审查优先 claude:opus（Opus 5.5），effort=high。以实际可用 catalog 为准，核实设置确实传给 worker，不要只写进 prompt。最多两个 worker 并行，任务数量尽量少；共享文件用依赖串行，仓库级最终验证独占 files=["."]。

确认后使用 MonoCode control CLI 管理任务，先读 --help，不通过其他工具重复创建 worker。worker 不提交、不推送、不切分支、不自行建 worktree、不修改其 checkout 外文件。保留旧 worker checkout 和报告，不伪造 checkpoint 或修改数据库冒充 accepted。

以最小改动和顺滑体验为准，复用既有组件和接口，保留必要的冲突与权限检查。每项完成后审查 diff、要求修正并正常 review 集成。真实 App/provider 与 mock 测试分开报告。常规实现和验收自主推进；遇到真实阻塞准确说明原因，不能反复在 stopped run 上让我找 Resume。最后列出实现效果、本轮 diff、验证结果、未完成项和更新步骤；不要中途自动替换或重启 App。
```
