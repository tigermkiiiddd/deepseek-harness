# @deepseek-ai/dsh-tool-todo

[English](README.md) | 中文

面向模型的 `todo_read` 与 `todo_write` 工具，用于维护 agent（智能体）的有序任务列表。

## 功能

向 `ctx.tools` 注册 `todo_read()` 和 `todo_write({ action, todos, updates, indices })`。`todo_read` 返回带有从零开始操作索引的完整当前列表。当前列表取当前 `turn/start` 之后最新的 `todo/write`；新轮次从空列表开始，与当前有效计划投影一致。`todo_write` 必须指定 action：`add` 追加 `todos`，`update` 通过 `updates[].index` 修改现有条目，`remove` 删除 `indices`，`clear` 清空列表；协议不支持整表替换。每个索引都指向调用前的当前有序列表；无效索引会失败，不会新增或猜测目标。每次成功写入都会向调用 agent 的会话日志追加一条携带完整结果列表的 `todo/write` 事件；同一轮次内的回放仍采用后写覆盖先写。

`status` 是 `pending`、`in_progress` 或 `completed` 之一。

## 单一所有者

该列表属于调用工具的唯一 agent 会话。不存在 subagent／共享／swarm scope：非 agent 调用方（没有 `exec.agent`）无处写入列表，因此会被拒绝。这是有意设置的 scope 限制，详见 Agent Note。

## 配置

`allowParallelInProgress` 是必填项：每个组合都必须选择是否允许多个 todo 同时处于 `in_progress`。这是部署层的选择而非固定规则：并发的活跃任务是否合理，取决于工具无法观测的运行时并发情况。可能并行展开工作的 agent 使用 `true`，`false` 则强制执行单活跃项纪律。

该开关会同时改变面向模型的指令与接受的输入——`true` 要求模型标记每个正在推进的任务并接受任意数量；`false` 要求恰好一个，并以 `Error: invalid todos: at most one task may be in_progress (got <n>)` 拒绝标记更多的调用。持久日志不变式**不**跟随它：在允许并行时写下的日志，在部署收紧策略之后仍必须可回放，因此不变式对活跃数量保持沉默。

## 验证

除 schema 的类型与枚举检查外，`execute` 还会拒绝空或在结果列表中重复的 `content`。`add` 要求 `todos`；`update` 要求非空 `updates`，其中每项必须带有唯一且有效的索引，并至少提供 `content` 或 `status`；`remove` 要求唯一且有效的非空 `indices`；`clear` 不需要集合。活跃数量规则（见「配置」）作用于每次写入产生的完整结果列表，因此增量无法绕过单活跃组合。

## 渲染

两个工具都返回 `{ todos, counts: { pending, inProgress, completed } }`。Native 渲染器会展示每个条目及其从零开始的索引；写入结果会在列表前附加状态计数。`todo_write` 还会记录完整的 `todo/write` 会话事件。UI 订阅事件流，并自行渲染该持久化列表：[web 客户端](../../client/ui-conversation)基于当前有效计划（其后没有更晚 `turn/start` 的最近一次 `todo/write`）显示计划条和专属工具行（[展示](../../../.agents/notes/implemented/feature/2026-07-23-web-todo-display.zh.md)、[生命周期](../../../.agents/notes/implemented/feature/2026-07-28-todo-plan-clears-on-next-turn.zh.md)）。

## 会话投影

当组合挂载了 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.zh.md)）时，本包在一个注入的子插件中注册 `todos` 投影单元：`init` = `null`（尚无写入）、`apply` = 从每个 `todo/write` 取整表，并在每个 `turn/start` 清为 `null`（当前有效计划；`turn/end` 保留刚完成的清单；其余事件都返回同一个状态引用）、`view` = 恒等、`stateVersion` = 2。该键在本包中合并进 `SessionProjectionMap`（经 Service Definition 包的 `/types` 出口）；框架驱动该单元，载体通过历史尾页与 `session/projection` 推送帧提供该值。未挂载注册表的组合不受影响。生命周期理由见 [在下一轮次清空 todo 计划](../../../.agents/notes/implemented/feature/2026-07-28-todo-plan-clears-on-next-turn.zh.md)。

## 导出形状

函数／命名空间插件：导出 `name`/`inject`/`apply`，不提供默认导出。意外的 `export default` 会被 Loader 的 `unwrapExports` 折叠为默认导出，并导致 `inject` 丢失（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`todo_read` 与 `todo_write` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-todo)。

#### Token 影响

工具可见的每个请求都有固定的 schema token 开销。

#### KV Cache 影响

只要定义和可见性不变，前缀就保持稳定。插件生命周期或 scope 限制可能会使从此 schema 起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

每个 assistant 写入调用只在参数中保留对应动作的数据：`add` 的新增条目、`update` 的按索引变更，或 `remove` 的索引。每次成功读取和写入都会以 `<index> [<status>] <JSON content>` 行返回完整当前列表，使下一次变更能够寻址可见索引。稳定失败会指明缺失的动作集合、空内容、结果内容重复、索引重复或越界、既无 `content` 也无 `status` 的更新、缺失所有者，或违反已配置的活跃数量规则。完整 `todo/write` 事件仍是 UI 与回放状态，而非第二条模型消息。

#### Token 影响

写入调用的 token 用量随提交的增量增长。为保证正确性，结果包含完整索引列表，因此其 token 成本随当前任务数量增长；仅当模型需要重新同步时，`todo_read` 才会产生这项成本。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **仅单一所有者 scope**：列表属于唯一调用 agent 会话；subagent／共享／swarm scope 是有意设置的限制（参见「单一所有者」一节），非 agent 调用方会被拒绝。
- **索引跟随列表顺序**：`add` 和 `remove` 可能改变后续索引。每次 `update` 和 `remove` 都必须寻址最新的有序列表；经过压缩（compaction）或无法看到该列表时，模型必须调用 `todo_read`。越界索引会失败，不会修改其他位置或追加条目。
