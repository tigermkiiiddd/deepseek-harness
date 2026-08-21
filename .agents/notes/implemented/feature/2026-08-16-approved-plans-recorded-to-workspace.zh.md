# Agent Note: 经批准的 plan 记录到工作区

Status: implemented

[English](2026-08-16-approved-plans-recorded-to-workspace.md) | 中文

## Problem

`exit_plan_mode` 此前只把 plan 保存为记进日志的工具参数：批准时可评审、可从会话日志恢复，但在项目本身不可见。用户想重读已批准的 plan——或追溯代码为何这样改——得去翻会话日志并回放。工作在 workspace 里不留痕迹。

几个显而易见的替代方案各自破坏了契约。由模型先写 plan 文件（exit 之前一次 `write` 调用）会把被拒绝的草稿留在磁盘上；把参数改成 `path` 取代 plan 全文会掏空 transcript 卡片，因为 `presentCall` 必须是 args 的纯函数、不许读文件系统（adding-a-tool cookbook）。

## Decision

exit 工具的 `plan` 参数保持不变——记进日志的参数仍是权威的、可重放的记录（见 [plan 专用协作状态](../simplification/2026-07-22-plan-specific-collaboration-state.md)）。批准时由 `exit_plan_mode` 自己把 plan markdown 写入相对会话工作目录（`currentSessionCwd`）解析的 `<plansDir>/yyyy-mm-dd-<slug>.md`，其中：

- `plansDir` 是经过校验的 config 字段，默认 `docs/plans`；
- slug 取自 plan 的第一个标题（转小写、非字母/数字串折叠为连字符、Unicode 字母保留）；纯标点标题回退为 `plan`；
- 写入走 `ctx.fs` 并携带会话解析出的沙箱策略，有限制性后端时与模型发起的写入受同样的围栏约束；未组合文件系统能力的组合跳过记录，结果中直接没有 `path`；
- 只有经批准的 plan 落文件——被拒绝的草稿只留在会话日志里；
- 会话没有工作目录、或写入失败时，调用失败且 plan mode 保持激活，批准可重试。

输出 schema 增加 `path?: string`，确认文本会点名它。同日同名覆盖；草稿迭代留在会话日志里，不产生版本化文件。

## Alternatives considered

**模型自己写文件并传路径。** 否决：草稿必须先落盘才能送审，被拒绝的工作会弄脏 workspace；且 transcript 卡片失去 plan 全文（展示纯度禁止在 `presentCall` 里读文件）。

**记录每次提交（含被拒绝的）。** 否决：草稿的持久归宿是会话日志；每个草稿一份文件会把 `docs/plans` 变成用户没有要求的只增垃圾堆。

**记录到 harness 会话状态目录而不是 workspace。** 就本特性而言否决：重点是工作留痕要留在用户工作的地方——仓库里——正如 Agent Notes 是入库的过程记录。存到会话状态目录会把留痕藏在内部簿记旁边。

## Consequences

经批准的 plan 出现在项目的 `docs/plans/`（是否提交由用户决定）；exit 的结果与确认文本点名路径。代价：一个 config 字段、对 `fs`/`sandboxPolicy` 的可选消费，以及在只读沙箱下写入可能让 exit 调用失败。KV cache 与工具目录稳定性不受影响——schema 变更只是新增一个可选字段，提示词文本未动。
