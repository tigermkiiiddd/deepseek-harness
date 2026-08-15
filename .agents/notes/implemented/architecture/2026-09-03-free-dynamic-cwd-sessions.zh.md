# Agent Note：自由（动态 cwd）会话——没有固定目录时的相对路径解析

状态：已实现

English | [中文](2026-09-03-free-dynamic-cwd-sessions.zh.md)

## 问题

`SessionHeader.cwd` 一直是可选的，因此会话核心本来就能支持没有工作目录的会话。但每个把相对路径解析到会话工作区的模型工具都写着 `header.cwd ?? process.cwd()`：没有不可变 cwd 的会话，其相对路径会静默解析到服务器的启动目录。这是一个隐式、不可恢复的工作目录——这类会话里的相对路径可能落在部署进程 cwd 内的任何位置，与模型意图无关，而且模型没有办法在运行时选择目录。

不可变的 `SessionHeader.cwd` 在创建时就被冻结（`deepFreeze`，作为存储元数据持久化）。它不能在会话中途修改；对于本应是自由的（不绑定任何目录）会话，它根本不会被设置。

## 决策

引入**自由（动态 cwd）会话**概念：`SessionHeader.cwd` 缺失的会话。其有效工作目录是模型可以用新 `set_cwd` 工具切换的运行时值，并作为持久化的 `session/cwd` 事件保存，使其在恢复与回放后仍然存在。工具的相对路径解析遵循单一、权威的链路，绝不回退到 `process.cwd()`：

1. 显式的绝对路径——原样使用（所有会话都可用）；
2. 否则使用会话的有效 cwd：固定会话用不可变 `header.cwd`，自由会话用最近一条 `session/cwd` 事件；
3. 否则——还没有目录的自由会话收到相对路径——以 `no session working directory: pass an absolute path, or set one with the set_cwd tool` 拒绝。

固定会话（头部有 cwd 的会话）行为不变：它忽略任何 `session/cwd` 事件，`set_cwd` 也会拒绝它。

### 各部分的落点

- `packages/core/session/src/current-cwd.ts` —— `currentSessionCwd(session)`：唯一权威解析器。固定会话返回 `header.cwd`；自由会话返回最近一条 `session/cwd` 事件，否则返回 `undefined`。所有消费者（fs 工具、搜索、bash、pwsh、沙箱策略、系统提示 `{{cwd}}`）都使用它，因此动态目录在各处行为一致。
- `SessionEventMap['session/cwd']` —— 持久的、仅日志、整值快照事件（`{ cwd: string }`）。追加它即持久化当前目录；回放把它折叠回来。它不是 `SurfaceEventType`，因此本身不会产生模型消息。生成器（`gen-persistence-catalog`）已把它纳入 `KNOWN_SESSION_EVENT_TYPES`。
- `packages/fs/tool-fs/src/set-cwd.ts` —— `set_cwd` 模型工具。校验绝对路径且会话为自由会话后，追加 `session/cwd`。
- `packages/fs/tool-fs/src/session-cwd.ts` —— `sessionCwd`/`sessionResolveOptions` 现在经由 `currentSessionCwd`；自由会话的相对路径且无目录时抛出拒绝。
- `packages/fs/tool-fs-search/src/search-core.ts` —— `runRipgrep` 通过 `currentSessionCwd` 派生 spawn `workdir`；没有目录的自由会话以 `SEARCH_NO_CWD` 拒绝，而不是从 `process.cwd()` 启动。
- `packages/shell/tool-bash`、`packages/shell/tool-pwsh` —— `resolveWorkdir` 返回有效 cwd；没有目录的自由会话收到相对/省略的 `workdir` 时拒绝。
- `packages/sandbox/sandbox-policy` —— `workspace-write` 根经由 `currentSessionCwd` 解析（仍回退到配置的部署根，保证 workspace-write 边界始终有具体根目录）。
- `packages/core/agent-loop` —— `{{cwd}}` 提示变量经由 `currentSessionCwd` 解析。
- Web GUI —— 工作区选择器流程新增**自由会话**入口，调用新的 `ctx.workspaces.startFreeSession()`（`session.create({})`，不带工作区）。自由会话已经落入未分组桶：工作区实体拒绝把头部无 cwd 的会话挂到目录工作区，客户端把这类会话归到 `group.ungrouped`。

## 备选方案

### 把动态 cwd 存进 header

`header.cwd` 不可变，且作为存储元数据留在对话日志之外。把它放宽为可变字段会：(a) 需要持久化 schema 变更，(b) 混淆「会话创建时的目录」与「会话当前使用的目录」，(c) 违反仓库「模型可见输入必须可由日志重建」的不变量。`session/cwd` 事件把两个关注点分开，并让自由会话满足「Model-visible ⟺ logged」。

### 保留 `process.cwd()` 作为无 cwd 回退

这正是被移除的行为。问题就在于自由会话会因此静默指向服务器工作目录，既让模型困惑又不可恢复。以明确的 `set_cwd` 修复指引来拒绝，才是用户选择的诚实做法。

## 后果

- 自由会话的工具调用作用于单一、已记录、可切换的目录；模型可以用 `set_cwd` 在目录之间移动，且变更在恢复后仍然存在。
- 固定会话行为逐字节不变；它永远不会看到 `session/cwd` 事件，`set_cwd` 也会拒绝它。
- 自由会话在没有目录时收到相对路径，会大声失败，而不是静默落在 `process.cwd()`。
- 因为目录是持久事件，回放/历史重建看到的就是恢复后的会话所使用的同一目录。
- 对 `process.cwd()` 的默认回退仅保留给真正无 agent（非会话）的工具调用，以及沙箱策略的配置部署根，绝不会用于模型驱动的会话。
- 在 `workspace-write` 沙箱策略下，自由会话的可写边界就是它当前的 `set_cwd` 目录，随每次切换迁移（2026-08-15 决策接受：漫游正是自由会话的意义；`workspace-write` 约束的是此刻的写入位置，而不是终身可达范围）。该语义已在模型可见处写明：`set_cwd` 工具描述、`tool:set-cwd` 提示词小节、`sandbox:policy` 上下文渲染。

## 不变量

`currentSessionCwd` 先检查 `header.cwd` 并始终为固定会话返回它，因此 `session/cwd` 事件永远不能覆盖不可变的固定目录。`set_cwd` 还会在源头拒绝固定会话。
