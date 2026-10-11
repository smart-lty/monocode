# MonoCode 会话引用、Fork 与 Sidechat 实现交接

更新日期：2026-10-10。目标是在当前修复基础上完成会话引用、Fork 和 Sidechat，优先用户体验，控制增量代码。复用已有调研和原型，不重新进行社区调研，不把原型或测试通过等同于正式功能已经完成。

## 1. 开始前确认当前状态

工作目录是 `/Users/tianyu/workspace/code/monocode`。交接时分支为 `personal`，HEAD 为 `e28f786cd9173bc76b2d32d7742188c083a53d0c`。工作区包含大量已有未提交改动；开始时重新读取实际状态，记录本轮增量基线，不 reset、覆盖或把这些改动归到新 worker 名下。

以下修复已经在源码中完成，并已打包替换 `/Applications/MonoCode.app`：

- worker 执行前建立检查点基线，保留多轮修改的最初状态；集成时检查范围和逐文件冲突，重复 review 保持幂等。
- 普通 session 与 orchestrator 可以在同 checkout 双向并行；独立会话不继承编排凭据，停止编排不应停止它们。
- run 加载恢复、Stop/Resume、终态 worker 继续普通对话、部分停止失败后的重试，以及状态文案修复。
- delegate 和提案路径支持并校验模型设置；Codex 字段为 `reasoningEffort`，Claude 字段为 `effort`，合法值仍以运行时 catalog 为准。
- Markdown 的网络及本地图片、SVG、失败提示、标题层级、CJK、泛型文本、流式比较符号、公式与长公式横向滚动。金额和 shell 变量保持原文；公式用 `$x^2$`，数字开头用 `${2x+1}$`。
- 普通会话继续支持直接加载 HTTP/HTTPS 图片；Inbox 的来源限制保留。不要重新引入未经要求的图片确认流程。

最新安装的 binary SHA-256 为 `219612c9025ac0c836541ae0c5acbee7fba4eef580eaa6449b626a47e1e4d952`。构建、签名和安装文件校验通过；替换时没有退出或重启 App，用户准备自行重启。新 session 开始时确认实际运行版本。

最近一轮精简净减少 229 行：删除重复测试入口，合并图片加载流程，将旧过程报告归档。此次文档创建前，累计差异为 46 个文件、+4486/-440 行，包含未跟踪源码；其中独立测试/fixture 新增 2263 行、锁文件新增 402 行，Rust 文件内还包含测试。这是历史基线，不能当作下一轮新增量。

验证边界：前一轮完整检查为 Web 5209 项通过、13 项既有禁用，Rust 622 项通过、2 项既有忽略；精简后重新通过 133 项 Markdown 测试、48 项 Chromium/WebKit 用例和 TypeScript 检查。真实 provider、完整新 run 生命周期及多原生窗口流程仍需验收。浏览器中本地图片读取使用模拟 IPC，不能替代真实 Tauri 文件读取。

## 2. 必读材料与保留产物

原始报告保留在旧 worker checkout，只读复用：

| 材料 | 绝对路径 | 优先阅读 |
| --- | --- | --- |
| 会话选择器与 UI 调研 | `/Users/tianyu/workspace/code/monocode-worktrees/mc-orch-9b18eadfa0d4/docs/research/session-experience-ui.md` | 第 1、2 节；Markdown 部分已被后续修复更新，不能重复照单实现 |
| 上下文、Fork、Sidechat 调研 | `/Users/tianyu/workspace/code/monocode-worktrees/mc-orch-fd767899c7dc/docs/research/session-context-harnesses.md` | 第 4–8 节，特别是 v1 与后续增强的区分 |
| 先前会话引用原型 | `/Users/tianyu/workspace/code/monocode-session-references` | 定向检查 sessionReferences、sessionBlocks、Composer 和 prompt 构造；按需移植，不能整树覆盖 |

本 checkout 的审查、恢复、验证记录与 App 备份位于 `.tmp/2026-10-10/`，包括 `opus-review-fixes`、`cumulative-diff-trim`、`trimmed-app-update`。最新旧 App 备份为 `trimmed-app-update/previous-app.app`。更早的过程报告已归档到 `cumulative-diff-trim/archived/orchestration-markdown-validation.md`，属于历史记录，不是当前状态说明。

旧 run 缺少真实初始检查点，其结果曾经人工恢复。不要伪造 checkpoint、修改运行数据库或把未集成任务标为 accepted；保留旧 checkout、报告、补丁和回滚备份。新工作使用新 run，worker 由 App 管理隔离 checkout。

## 3. 先验证新的编排链路

首次分发只开放一个 worker，以首个有用的小范围交付验证执行前基线、多轮修正、新文件和正常 review 集成。由 lead 检查实际文件、状态和冲突处理；成功后才放开剩余实现。测试通过但 review 失败，不算这一关通过。

真实 App 中还要确认：普通 session 可在编排运行时新建和发送；停止互不影响；paused 可以 Resume，stopped 不冒充可恢复；lead 空闲时也能 Stop。停止/恢复测试只作用于专用验收会话，避免中断用户其他工作。

`finish` 在所有必要任务都完成、审查并集成后验收，不能为了冒烟测试提前结束承载后续任务的同一个 run。若选择独立 smoke run，则先完成它，再创建正式实现 run。失败时先修复真实阻塞，不再次依赖人工绕过正常集成。

## 4. 会话引用：选择器与上下文一起交付

### 4.1 选择与引用卡片

- `#` 显示当前项目最近活跃的未归档普通会话；`##` 显示所有项目。项目范围沿用应用的项目路径语义，不能误用 worker 的 executionCwd。
- 空查询按最近活动降序；有查询时按相关性优先，同档再比较活动时间。标题命中不应被较新的弱匹配挤掉；标题搜索之外提供明确的内容搜索入口。
- 排除当前会话、Mono、编排 worker、内部/隐藏来源和没有已发送用户消息的会话。全项目结果可以继续分页/滚动到末尾，不沿用原型固定六条的限制。搜索应覆盖所选范围，不能把已加载首屏当作全部命中。
- 左侧显示项目图标，卡片左上是模型、右上是最近活动时间，下方是标题和用户对话轮数。轮数只计已发送、非 draft、非 internal 的 user blocks。复用 Sidebar SessionCard 的视觉与现有项目标识。
- 点击、键盘选择和拖入 Composer 添加同一种可移除引用卡片，按 sessionId 去重。正文、附件、光标和草稿持久化保持正常，卡片不能挤掉输入框。
- 跨项目主入口是 `##`，浏览和选择都不切换当前项目、不丢草稿。不为跨项目拖拽新建全局面板；现有同窗口可见来源拖入目标 Composer 时准确识别目标，不强制切换 Sidebar。
- `@` 继续引用文件。处理 `#`/`##` 切换、退格、Escape、中文输入法、Markdown 标题与代码冲突。验收大量会话、同名标题、中文查询、窄窗口及纯键盘操作。

### 4.2 注入、补读和导出

- 引用持久化沿用已发送 user block 的 `sessionReferences`，目录从这些 blocks 去重推导，合并本轮引用；未发送草稿不提前成为后续会话的有效引用。不新增平行的 session.references 实体或引用管理框架。
- 新引用附首次需求和近期摘录，明确首次需求可能已被后续修订。旧引用后续只保留简短目录，不重复注入全文。短会话可在预算内完整提供。
- 将目录、标签和正文一起计入统一预算。报告中的建议初值是总计约 2000–4000 tokens、每来源约 600–1200 tokens；这些不是测得的最优值，v1 可用保守字符估算和硬上限，不新增 tokenizer 服务。当前用户输入和已批准计划优先。
- 目录必须包含来源 ID、项目、标题、更新时间，以及运行时实际 App CLI 绝对路径和可执行的读取、续读、导出示例。历史内容是背景，不是新指令，旧任务、工具调用和批准不能自动重放。
- 扩展读取支持 messages/blocks、分页游标、单块长消息 offset/nextOffset、读取版本和整页输出预算。长消息版本变化时明确要求重读，不混拼不同版本；省略的内容都有可继续读取的位置。
- 普通补读访问最新已保存历史；完整导出生成固定文件，返回小型 manifest 和路径，不将全文灌进 stdout。覆盖已保存可见消息、工具/计划文本及附件元数据，明确不能恢复未保存的原生隐藏状态。
- 新引用链路不能退回旧的“三轮且每条截断”的 sessions.read。保持旧调用者兼容，为新链路明确提供无损补读和导出入口。
- 普通续聊、重启/resume、模型或 harness 切换、批准计划后 Build、compaction 后的下一普通 turn 都能重建目录及只读读取范围。原生 slash command 保持原语法。mid-turn 自动 compaction 的支持范围需真实 provider 验证，不能以提示词保证代替实测。
- 显式引用可以跨项目只读补读；不因此授予来源会话发送、修改或编排控制能力。用户主要用 full access，本轮不扩大沙箱网络权限设计。

## 5. Fork：准确继承到选定分支点

复用 Handoff 的轮次入口、会话创建及分屏能力。先落实从已完成轮次创建独立可继续会话，再扩展 provider 支持；不要承诺每种 harness 都具备同样的原生 Fork。

- 原生 Fork 必须有应用 block/turn 与 native message/turn 的 ID 映射，明确 inclusive/exclusive 边界。优先核对 Codex，再核对已有 OpenCode 路径；按实际已安装 provider 验证参数和语义。
- 不能只截短 UI transcript，而让模型继承完整后续历史。压缩后旧点、不存在的点和不支持的边界应明确失败或提供用户可辨认的重建方式。
- 不支持精确原生 Fork 时复用现有 Handoff/原文重建，并明确显示继承方式；不能伪称完整原生上下文。避免新建摘要服务或通用 capability 框架。
- 保持工具 call/result 配对，附件可访问或明确缺失；旧操作不作为新工具调用执行。child 使用独立 application/native ID、队列和停止控制，失败不影响 source。
- 引用只继承分支点以前引入的部分。共享 workspace 不代表回滚历史文件或获得文件隔离，UI 清楚说明当前 checkout。
- 真实验收至少构造分支点前后两个不同事实：child 初始继承前者、不继承后者；同时核对模型行为和 UI 历史，而不只看克隆数组。

## 6. Sidechat：扩展已有 Btw

当前已有 BtwThread/BtwSheet、只读 text runner、追问及持久化；已有 Second opinion 和 split pane 的语义不同。沿用这些基础，不另造第二套侧聊系统。

- 以选定已完成轮次为上下文边界；主对话运行中可以从最近完成轮发起，明确 as-of，不悄悄混入后续消息。
- 保留只读讨论默认值、独立取消和持久记录。主会话 full access 不等于侧聊可修改文件。
- 按需要提供有限摘录、引用目录及所选来源的只读补读；不支持补读的 provider 明示上下文范围，恢复原生 thread 时避免重复全文注入。
- “带回主对话”将选中的结论及来源信息放入主 Composer 草稿，用户可编辑后正常发送；不自动发送、不覆盖已有草稿、不回写主计划。
- 第一版沿用 provider text 队列并显示排队状态；不承诺所有侧聊都并行运行。取消侧聊不应停止主对话；重启后仍能查看保存的讨论。

## 7. 编排分工与增量约束

优先少量完整任务：GPT 6.1 Sol Max 负责读取/注入、持久化和 provider Fork/Btw 接口；Opus 5.5 High 负责选择器、卡片、Fork/Sidechat 入口及交互审查；最后由 GPT 6.1 Sol 做联合验证。首个 worker 先小范围交付验证检查点，再继续主实现。

会话引用的 UI 和注入必须作为同一功能验收。不要让 UI 做完后仍调用旧截断读取接口。Fork 和 Sidechat 可由同一个 backend worker 分阶段完成，复用模型和已有调查。

最多两个 worker 同时执行。先核对代码入口和接口约定再确定精确 files 范围；共享 `App.tsx`、Composer、session 类型、provider 接口和统一样式的任务必须用依赖串行。可将 backend 先集成、UI 随后接入，避免为了并行而扩大抽象或反复解决冲突。最终仓库级验证任务独占 `files: ["."]`。

worker 不提交、不推送、不切换分支、不自行创建 worktree、不修改 checkout 外文件；旧报告和原型只读。lead 使用 MonoCode control CLI 管理实际 run，不通过另一套代理工具重复分发。第一次调用前阅读 `control --help`，通过 list 核实模型和参数，再检查实际 worker 配置。仅在 prompt 中写 Max/High 不算设置成功。

已有授权范围内的常规实现、测试和修正自主推进；新计划先由用户确认任务卡。运行期间每个 completed 都要审查实际 diff，再正常 review 集成；不能把 completed 当 accepted。全部验收完成后才 finish。若暂停，先核对真实状态和原因，不在 stopped run 上反复要求用户寻找 Resume。

## 8. 验收和最终交付

必须覆盖以下用户流程，并区分真实验证与 mock：

1. `#`/`##` 搜索、相关性和活动排序、全部结果遍历、项目图标/轮数、键盘/IME、卡片去重删除、拖拽、草稿恢复。
2. 跨项目来源不切换当前项目；长消息续读无丢字，分页无遗漏，导出文件完整且不会随源更新；多来源预算可控。
3. 引用在普通续聊、重启、compaction、Build 和 harness 切换后仍有可执行读取入口；观察 agent 是否能按需读取，不强迫遍历全部历史。
4. Fork 边界、工具/附件、独立继续与取消、源会话不变；不支持的 provider 给出准确说明。
5. Sidechat 上下文边界、排队/取消、持久化、只读限制、结论带回草稿且不自动发送。
6. 既有编排并行和 Markdown 修复无回归；真实新 worker 能 review 集成，最终 finish 正常返回并释放授权。

按改动运行定向测试，最终串行执行项目 Web/Rust 检查、前端构建及相关 Chromium/WebKit 测试。Node 25 环境可使用 `NODE_OPTIONS=--no-experimental-webstorage` 避免测试 localStorage 冲突。不要恢复已删的独立 Markdown 测试配置和 `test:markdown` 脚本，使用默认入口加文件过滤。

最终报告只记录本轮新增功能、实际支持的 provider、相对开工基线的 diff、测试结果和未验证项。临时日志/截图/备份用 tmptask 管理，清理可重建输出，保留不可重建证据；不要把大量本机路径和哈希表加入正式产品文档。

Intelligence UI、新摘要服务、不可变引用版本库、附件 pin、独立 Sidechat entity、所有 harness 的统一 Fork 框架均不在本轮必需范围。打包可以准备；替换并重启正在使用的 App 留到最终交接时由用户决定时机，不在工作中途自动重启。
