# Agent Note: `todo_write` 工具——将模型任务列表作为事件溯源的会话状态

Status: implemented

[English](2026-06-29-todo-write-tool.md) | 中文

## 问题

harness 为模型提供了 bash 和 subagent 工具，却没有办法记录结构化的任务列表。todo 列表有两个同等重要的用途：引导模型规划多步骤工作并保持当前活跃工作明确；同时为交互式宿主提供实时进度清单。调研的所有参考编码 agent（智能体），包括 claude-code、opencode、codex、oh-my-pi 和 pi，都提供了某种形式的此类功能；本 harness 此前没有。

## 决策

新增面向模型的 `todo_read` 与 `todo_write` 工具，其整列表状态作为新的 `todo/write` `SessionEventMap` 变体存储在事件溯源的会话日志上。交互式宿主从持久事件渲染：TUI 直接折叠它，web 客户端将其投影进 `ConversationSnapshot.todos`（[web todo 展示](2026-07-23-web-todo-display.zh.md)），而[仅面向自动化的 ACP（Agent Client Protocol）桥接层](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)有意省略 todo 展示。写入使用[按索引寻址的增量](../bug-fix/2026-08-23-todo-index-addressed-deltas.zh.md)；持久事件仍是完整快照。

### 整列表快照，三态 status

每次成功写入都会追加完整结果列表，回放时由最新事件替换先前状态。会话本地的 `add`、`update`、`remove` 和 `clear` 操作会先计算另一份完整快照，再予以追加；`todo_read` 返回带操作索引的该状态且不追加事件。`status` 恰好是 `pending | in_progress | completed`，与 codex `update_plan` 相同的三元组；在 bridge 还把 todo 列表投影为 `plan` 更新时，它也与 ACP `PlanEntryStatus` 1:1 对应，该映射已随[仅面向自动化的 ACP 约定](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)退役。

### 状态在会话日志上，而非服务

列表作为 `todo/write` 事件追加到日志，携带完整的 `{ todos }` 快照。harness 是事件溯源的——LLM（大语言模型）历史、工具调用和轮次结构都在日志上——所以 todo 列表也在那里。这免费获得了持久性、回放和恢复重建：重新打开的会话从「其后没有更晚 `turn/start`」的最近一次 `todo/write` 重新推导当前计划（[计划条生命周期](2026-07-28-todo-plan-clears-on-next-turn.zh.md)），无需独立的持久化后端、无需重新恢复状态的内存服务、无需额外接线。一个内存中的 `ctx.todos` 服务需要重新发明以上所有。（全量 log 消费方直接获得这份重建；web 客户端的分页窗口则从尾页 history 中由宿主计算的投影获得——见 [web todo 展示说明](2026-07-23-web-todo-display.zh.md)。）

### 不是 surface 事件

`todo/write` 被有意排除在 `SurfaceEventType` 之外。surface 是产出 LLM 消息历史（`deriveMessages()`）的投影；todo write 不产生对话消息。因此它不携带 `surfaceOp`，不加入有序 surface，不进入 `deriveMessages()`——它是持久、可回放的 *UI* 状态，与对话并行传输但不属于对话的一部分。（dev-mode 不变式仍要求它位于一个尚未结束的轮次内，而它始终如此：它在工具调用的步骤中途追加。）

### 相比 claude-code V1 舍弃的字段：`activeForm`、id、priority

claude-code V1 的条目是 `{ content, status, activeForm }`；后来（V2）增加了 id、依赖和所有权——但仅为支持 agent *集群*（以磁盘为后端、锁保护、逐项变更）。本工具将条目保持在最小集：`{ content, status }`。不要 `activeForm`（现在进行时标签）——UI 直接展示 `content`；不要 id——单所有者增量按索引寻址当前有序列表，且持久写入仍是完整快照；不要 priority——它只曾是 ACP `PlanEntry` 的协议格式（wire format）要求，在 bridge 边界合成为常量而非建模，并已随该投影一起离开。每舍弃一个字段，模型就少产出一项。

### 单一所有者——无集群机制（YAGNI）

每个列表属于调用它的 agent 会话，非 agent 调用被拒绝。没有共享作用域或 resolver。按索引寻址的增量仅操作该会话的最新完整快照；跨 agent 列表需要稳定的条目标识、并发控制和显式作用域选择，因此留作未来独立设计。

### 校验：低成本的中间路线

schema 强制 type/required/enum。在此之上，`execute` 拒绝为空或重复的 `content`，并在 `allowParallelInProgress` 为 `false` 时拒绝超过一个活跃任务。排序和保持列表最新仍通过工具描述交给模型。被拒绝的写入返回 `isError` 结果，使模型自行修正。必须采用的部署策略，以及持久不变式独立于该策略这一点，均由[并行 in-progress Agent Note](2026-07-26-todo-parallel-in-progress.zh.md)负责。

## 为何没有 cordis-catalog 条目 / 没有 `@mode`

`todo/write` 是 `SessionEventMap` 的成员，不是一等的 cordis `interface Events` 事件。catalog 生成器（`scripts/gen-cordis-catalog.ts`）扫描 `interface Events` 声明；`SessionEventMap` 变体搭载现有的 `session/event` emit，不产生新的 catalog 行。因此它不携带 `@mode` 标签（生成器仅对 `interface Events` 成员要求该标签）——添加一个毫无意义。

## 测试

四个层级：
- **单元测试**——会话事件（append/snapshot-clone/last-write-wins/not-on-surface）；工具（schema 字段、通过真实 `ctx.tools.execute` 的参数校验、值校验、带索引的读写结果、非 agent 拒绝、`presentCall`、HMR（热模块替换）安全性）；以及 TUI 折叠。
- **真实 Loader 路径**——插件通过 `Loader.unwrapExports` 运行，断言命名空间导出形状存活（它有 `inject`，因此一个意外的 default 导出会在加载时崩溃——postmortem/0001）。
- **全循环集成**——一个脚本化的 mock 模型通过真实 agent loop（智能体循环）调用 `todo_write`；`todo/write` 事件落地，索引更新会重命名单个条目且不产生重复。
- **恢复/回放**——持久化的 `todo/write` 折叠回当前任务列表。
- **带密钥 e2e + 快照**——真实提示词诱导 `todo_write`；组装后的快照固定日志事件和交互式渲染。

## 曾考虑的替代方案

- **内存中的 `ctx.todos` 服务**——需要重新发明日志免费提供的持久性、回放和恢复重建。
- **按 content 寻址的逐项增量**——最初未采用，随后曾短暂加入；可编辑的 content 无法承担身份，因为改名后的任务会变成隐式新增。最终采用的单所有者增量按有序索引寻址，并区分 `add` 与 `update`（[决策](../bug-fix/2026-08-23-todo-index-addressed-deltas.zh.md)）。
- **工具放在 `core/` 中**——`todo_write` 是注册在 `ctx.tools` 上的扩展工具，不属于主干；它像其他工具族一样位于自己的 `packages/todo/` 分组中。

## 后果

todo 列表是持久、可回放的会话状态：交互式宿主从最新持久化的 `todo/write` 重新推导它，日志（而非插件内存）是唯一真源。变更动作计算一份完整的 last-write-wins 快照；其索引不会进入事件格式。事件不进入模型 surface，因此 todo 更新永远不会扰动推导出的模型历史——模型只看到自己的工具调用和结果。
