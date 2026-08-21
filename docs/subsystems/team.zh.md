# Team

[English](team.md) | 中文

团队子系统通过 [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) 把独立 agent 进程接入主实例：每个成员都是**完整的 agent**——自己的 preset、模型与持久化的多话题会话——主实例作为 ACP 客户端连接成员。Web GUI 在框架顶部提供全局可视化栏，并把框架切换到用户选中的那个 agent 的界面。团队不是 [subagent 接缝](subagent.md)：成员是持有自己进程与会话的可信对等体，委派栈不参与其中。

Sources: [`packages/team/team`](../../packages/team/team)、[`packages/team/tool-team`](../../packages/team/tool-team)、[`packages/acp/acp`](../../packages/acp/acp) 中的会话能力、[`packages/host/apiproxy`](../../packages/host/apiproxy) 中的 `team` API 域、[`packages/client/ui-team`](../../packages/client/ui-team) 中的浏览器半边。框架栏由 [`packages/client/ui-layout`](../../packages/client/ui-layout)（`shell.topbar`）声明。决策记录见 [ACP 虚拟团队 Agent Note](../../.agents/notes/implemented/feature/2026-08-16-acp-virtual-team.md)。

## 角色模型

ACP 定义两个角色；同一协议在不同部署中角色分配不同：

- **Agent**——被驱动方：持有并持久化会话、执行工具。团队中每个**成员进程**都是 Agent。
- **Client**——驱动方：列出、加载并提示会话。**主实例**（本 GUI 背后的 dsh 进程）对成员是 Client。

主实例具有双重身份：对成员是 Client；对外部工具自己又是 Agent（`dsh-acp` 服务器）。角色由连接方向决定，从不意味着从属：成员不是 subagent，主实例不能决定成员的会话去留。

## 会话能力（dsh-acp）

`dsh-acp` 服务器在 `initialize` 中声明 `loadSession: true` 与 `sessionCapabilities.list`，并实现 `session/list`（`listSessions`）与 `session/load`（`loadSession`）。`loadSession` 幂等：种子化会话事件流，并把持久化历史以 `user_message_chunk` / `agent_message_chunk` 通知流式回放；未知会话 id 以请求错误拒绝。这使调用方能够决定继续哪个已有话题，或用 `session/new` 新建。会话保存在成员进程内；调用方只是借用。

## 团队服务（dsh-team）

`Config.members[]` 声明成员——`id`、`title`、`description`、`kind`、`command`、`args`、`cwd`、`env`、`permission`、`autostart`。该服务是 ACP 客户端接缝：`MemberConnection` 派生成员进程、完成 `initialize` 握手，并把成员的 `agentCapabilities` 保留给界面使用。

成员生命周期是显式的——`start` / `stop` / `restart` 是一等动词，带 `autostart`（默认）的成员在服务加载时派生。对已停止成员执行会话操作会大声失败，而不是惰性派生。对外状态词汇是 `idle` / `running` / `offline` / `failed`（`idle` 表示已连接且没有在途轮次，`running` 表示有 prompt 轮次在飞，`offline` 表示进程未运行，`failed` 表示启动失败）；`connecting` 仅为内部过渡态，启动期间成员读作 `offline`。每次迁移都发出 `team/status` 事件——从不轮询。

成员是可信对等体：派生的进程继承**完整父环境**（含凭证），**但排除 harness 自有的 `DSH_*` 命名空间**——这些键配置的是本 harness 实例，绝不泄漏给成员——`config.env` 叠加其上。成员工作目录是 `config.cwd`，未配置时为主进程启动目录——绝不让调用方会话工作区绑定到成员。

服务提供：

- `list()`——每个成员及其状态、能力与最后错误。
- `start` / `stop` / `restart`——显式生命周期。
- `listSessions()` / `loadSession()` / `readHistory()` / `newSession()`——成员自己的话题（ACP `session/list`、`session/load`、`session/new`）。
- `prompt()`——受理一轮并立即返回 prompt id；该轮的块以 `team/member-update` 事件流式到达，结算以 `team/turn-end` 事件到达。
- `cancel()`——取消一个会话的在途轮次。
- `permission()`——应答一个已上浮的 `session/request_permission` 提示。
- `chat()`——面向模型工具的阻塞便捷方法：prompt 加落定回复。
- `addMember()` / `removeMember()`——运行时名册变更（见下）。
- `onPermissionRequest()`——订阅权限处理器；只要存在至少一个订阅者，权限提示就上浮（`team/permission-requested` 事件 + `team.permission` 应答），否则按成员的 `permission: allow | reject` 策略自动应答。
- `disposeAll()`——停止所有成员；服务卸载时执行 dispose-all 效果。

成员的 `session/update` 流以 `team/member-update` 事件无损转发：文本与思考块、工具调用、计划、用量——GUI 是协议流的投影，不是手搓摘要。`readHistory` 收集的回放在这里消费，不重复转发。

### 一等 `dsh` 成员

设置 `kind: 'dsh'` 的成员会让 harness 重新拉起当前安装（`dsh --profile acp`），而不是运行自定义命令。harness 通过 `resolveMemberSpec()` 把派生规格解析为当前 Node 可执行文件与脚本，并剥离 Node debug/inspect 标志以避免成员与父进程调试端口冲突，同时设置：

- `DSH_HOME` 为主 harness home 下的 per-member 目录（`<main-home>/members/<member-id>`），让成员的会话与附件相互隔离。
- `DSH_MAIN_HOME` 指向主 harness home，让成员读取协调器的 `settings.yaml`、`.credentials.yaml` 及其他 home 本地文件。

`kind: 'dsh'` 时不能设置 `command` 与 `args`；省略 `kind` 则必须提供自定义 `command`。实现位于 `@deepseek-ai/dsh-team` 的 `resolveMemberSpec()`，由 `MemberConnection.spawnSpec()` 消费。profile 模板是 `@deepseek-ai/dsh-acp-app`（见 [`packages/bundle/acp-app`](../../packages/bundle/acp-app/README.md)）。

### 持久名册

名册（团队里有谁、怎么拉起）是 harness 侧唯一持久化的团队状态。运行时添加的成员落入 `team` 存储域（`member_add` 即写；`removeMember` 尝试删除并记录失败，因此删除失败时该成员可能在重启后复现）。重启时把持久名册与 `Config.members` 合并——config 对重复 id 保持权威——并重新拉起所有 autostart 成员。没有存储域的部署保持仅内存名册。

## 模型工具（tool-team）

`member_sessions` 列出成员与话题，`member_chat` 在选定或新话题上对话，`member_add` / `member_remove` 变更名册（含 `kind` / `command` / `args` / `cwd` / `env` / `permission` / `autostart` 字段），`member_start` / `member_stop` / `member_restart` 驱动生命周期——主 agent 可以在对话内组建并驱动团队。这些工具是常驻团队能力：web-app bundle 在 host 面挂载该行，每个会话都可见；不涉及 preset。

## API 域（host API-proxy）

`team.list` / `team.start` / `team.stop` / `team.restart` / `team.sessions` / `team.history` / `team.newSession` / `team.prompt` / `team.cancel` / `team.permission` / `team.addMember` / `team.removeMember` 经标准 RPC 载体提供给浏览器，委托给 `ctx.team`；团队服务缺失时报告该域不可用。成员实时输出不走 RPC 载体：`team/status`、`team/member-update`、`team/permission-requested`、`team/turn-end` 是允许列表中的 host 事件，经 `events.host` SSE 流逐字转发（允许列表位于 [`dsh-api-remotes`](../../packages/api/remotes/README.md)）。

## GUI 设计

Web GUI 是一个**多 agent 工作台**：一个框架，顶部一条全局可视化栏，下方是所选 agent 自己的界面。

```
┌───────────────────────────────────────────────────────────┐
│ ●主实例 ──●成员A ● ──●成员B ⚠        全局可视化栏 (shell.topbar) │
├───────────┬───────────────────────────────────────────────┤
│ 会话列表    │  聊天窗（当前 agent 的会话）                    │
│ (当前      │  历史消息（该 agent 进程里真实持久化的）          │
│  agent     │  [给当前 agent 发消息………………]  [发送]          │
│  的会话)   │                                               │
└───────────┴───────────────────────────────────────────────┘
```

- **全局可视化栏**（`shell.topbar`，由 ui-layout 声明为三列之上的固定顶行）：每个 agent 一个 SVG 节点——主实例在最前，然后是每个成员——节点间带连线。节点颜色承载 host 推送的实时状态（`team/status` 事件折叠进共享视图 store；从不轮询）。点击节点切换当前 agent；栏上还有新建成员表单（完整成员配置）与逐节点移除。
- **栏下方**：当前 agent 自己的界面。主实例显示常规三列（本对话界面）。成员显示 `MemberView`（ui-team，注册进 `shell.overlay`，覆盖栏下方列区域）：成员自己的话题（左侧，按 `sessionCapabilities.list` 能力门控）、所选话题从 ACP 流投影出的对话（右侧）——流式文本、思考、工具卡片、计划、图片、用量说明——经 `team.prompt` 发送、`team.cancel` 取消的输入栏、面向 `session/request_permission` 提示的权限弹窗（逐选项批准 / 拒绝）、以及带成员实时状态、生命周期控件（启动 / 停止 / 重启）与「返回主实例」控件的顶栏。不支持 `loadSession` 的成员没有历史入口：其话题只读可浏览。
- 选择主实例节点会隐藏 `MemberView` 并恢复三列。框架变为顶栏 + 主行堆叠；拖拽把手与覆盖层锚定在主行上。

## 数据流

视图通过 `api.team.*` → `ctx.team` → ACP → 成员进程读取并驱动成员，并通过转发的 `team/*` 远程事件接收成员实时输出。成员会话及其历史是成员进程内的唯一事实源；视图不保存持久副本。主实例自己的会话保持本地（常规会话栈）。

## 配置

名册由部署在 profile 的 `cordis.patch.yml` 中配置（`team` 行，`members: []`）。未配置的部署只渲染含主实例节点的栏。成员也可从栏上的「新建成员」表单或 `member_add` 运行时添加；这些成员落入持久名册，重启后重新拉起（除非 `autostart: false`）。

## 已知限制与暂缓事项

- **诚实边界**：stdio ACP 下 client 持有管道，因此 harness 派生的成员随 harness 终止；支持 `loadSession` 的成员重启后恢复历史，是因为会话存在成员自己的持久化里，而不是这里。
- 成员↔成员直发尚未开放；全局栏目前只连接主实例与成员。
- 远程工具调用对 harness 不透明：成员在自己的进程里执行自己的工具，harness 只能看到协议流（工具调用、计划、输出）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxteam--teamservice"></a>

### `ctx.team` — `TeamService`

The team service the plugin provides under `ctx.team`.

```ts cordis-catalog
/**
 * Every member with its live connection status, capabilities, and last error.
 * @returns the list of member snapshots.
 */
list(): MemberSnapshot[]

/**
 * Start one member's process and complete the ACP handshake.
 * @param memberId - the member to start.
 */
start(memberId: string): Promise<void>

/**
 * Stop one member's process and return it to `offline`.
 * @param memberId - the member to stop.
 */
stop(memberId: string): Promise<void>

/**
 * Stop then start one member.
 * @param memberId - the member to restart.
 */
restart(memberId: string): Promise<void>

/**
 * One member's own conversation topics (persisted in the member process).
 * @param memberId - the member whose topics are listed.
 * @param cwd - workspace filter passed to the member; defaults to the member's configured cwd.
 * @returns the member's topic list for that workspace.
 */
listSessions(memberId: string, cwd?: string): Promise<MemberSession[]>

/**
 * Resume one of the member's topics so chat continues its history.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic to load.
 */
loadSession(memberId: string, sessionId: string): Promise<void>

/**
 * Load one topic and collect its replayed conversation history.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic whose history is replayed.
 * @returns the replayed conversation entries.
 */
readHistory(memberId: string, sessionId: string): Promise<MemberHistoryEntry[]>

/**
 * Load one topic and collect its full-fidelity translated session events.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic whose history is replayed.
 * @returns the translated harness event sequence.
 */
readHistoryEvents(memberId: string, sessionId: string): Promise<TranslatedSessionEvent[]>

/**
 * Whether a member currently has a prompt turn in flight for a topic.
 * @param memberId - the member to query.
 * @param sessionId - the member topic to query.
 * @returns true when a turn is in flight.
 */
isTurnInFlight(memberId: string, sessionId: string): boolean

/**
 * Open a new topic on the member and return its id.
 * @param memberId - the member to create a topic on.
 * @returns the new topic id.
 */
newSession(memberId: string): Promise<string>

/**
 * Accept one prompt turn and return immediately; chunks stream as
 * `team/member-update` events and settlement as `team/turn-end`.
 * @param memberId - the member to prompt.
 * @param sessionId - the member topic to prompt in.
 * @param text - the user text for this turn.
 * @returns the prompt id assigned to this turn.
 */
prompt(memberId: string, sessionId: string, text: string): Promise<{ promptId: string }>

/**
 * Cancel the in-flight prompt turn of one session.
 * @param memberId - the member whose turn is in flight.
 * @param sessionId - the member topic whose turn is cancelled.
 */
cancel(memberId: string, sessionId: string): Promise<void>

/**
 * Answer one unanswered `session/request_permission` prompt.
 * @param memberId - the member that raised the request.
 * @param requestId - the locally minted request id.
 * @param outcome - the selected option or cancellation.
 */
permission(memberId: string, requestId: string, outcome: TeamPermissionOutcome): Promise<void>

/**
 * Drive one chat turn to completion (blocking convenience for model tools).
 * @param memberId - the member to chat with.
 * @param sessionId - the member topic to chat in.
 * @param text - the user text for this turn.
 * @param signal - optional cancellation signal.
 * @returns the member's committed reply and stop reason.
 */
chat(memberId: string, sessionId: string, text: string, signal?: AbortSignal): Promise<ChatResult>

/**
 * Spawn a new member process at runtime, persist it in the roster, and join it.
 * Omitted `args`/`env` default to empty at this funnel, so every caller —
 * host API, model tool, future seams — is safe.
 * @param config - the member configuration; collection fields optional.
 * @returns the snapshot of the newly added member.
 */
addMember(config: MemberConfigInput): Promise<MemberSnapshot>

/**
 * Stop one member, drop it from the roster, and attempt to delete it from
 * persistence. A failed delete is logged and the record may reappear on restart.
 * @param memberId - the member to remove.
 */
removeMember(memberId: string): Promise<void>

/**
 * Register a permission-request subscriber. While at least one subscriber
 * exists, `session/request_permission` prompts are surfaced (event +
 * `team.permission` answers); with none, the member's `permission` policy
 * auto-answers.
 * @param handler - the subscriber that receives each request.
 * @returns the disposer removing this handler.
 */
onPermissionRequest(handler: TeamPermissionHandler): () => void

/** Stop every member process. Idempotent. */
disposeAll(): Promise<void>
```

Source: [`packages/team/team/src/index.ts:63`](../../packages/team/team/src/index.ts)

<a id="team-events"></a>

### `team/*` events

<a id="teammember-update--emit"></a>

#### `team/member-update` — emit

One typed `session/update` notification from a member, forwarded losslessly: text/thought chunks, tool calls, plans, usage — the member interface is a projection of this stream. Replays collected by a `readHistory` call are consumed there and not re-forwarded.

```ts cordis-catalog
/**
 * One typed `session/update` notification from a member, forwarded
 * losslessly: text/thought chunks, tool calls, plans, usage — the member
 * interface is a projection of this stream. Replays collected by a
 * `readHistory` call are consumed there and not re-forwarded.
 * @mode emit
 * @param memberId - the member that sent the update.
 * @param sessionId - the member's session the update belongs to.
 * @param update - one lossless ACP session update.
 */
'team/member-update'(memberId: string, sessionId: string, update: SessionUpdate): void
```

Source: [`packages/team/team/src/types.ts:178`](../../packages/team/team/src/types.ts)

<a id="teampermission-requested--emit"></a>

#### `team/permission-requested` — emit

A member raised `session/request_permission`. The GUI answers through `team.permission`; with no subscriber the deployment policy answers.

```ts cordis-catalog
/**
 * A member raised `session/request_permission`. The GUI answers through
 * `team.permission`; with no subscriber the deployment policy answers.
 * @mode emit
 * @param request - the surfaced permission request.
 */
'team/permission-requested'(request: TeamPermissionRequest): void
```

Source: [`packages/team/team/src/types.ts:185`](../../packages/team/team/src/types.ts)

<a id="teamstatus--emit"></a>

#### `team/status` — emit

A member's status migrated. Every transition emits exactly one public event (`idle` / `running` / `offline` / `failed`). `connecting` is an internal transition: during startup a member reads as `offline` until the handshake completes. Consumers never poll. `error` carries the failure message on `failed`.

```ts cordis-catalog
/**
 * A member's status migrated. Every transition emits exactly one public
 * event (`idle` / `running` / `offline` / `failed`). `connecting` is an
 * internal transition: during startup a member reads as `offline` until the
 * handshake completes. Consumers never poll. `error` carries the failure
 * message on `failed`.
 * @mode emit
 * @param memberId - the member whose status moved.
 * @param status - the new public status.
 * @param error - the failure message, on `failed`.
 */
'team/status'(memberId: string, status: MemberStatus, error?: string): void
```

Source: [`packages/team/team/src/types.ts:167`](../../packages/team/team/src/types.ts)

<a id="teamturn-end--emit"></a>

#### `team/turn-end` — emit

A prompt turn settled: the member answered `session/prompt` (or the connection died and the turn was settled `cancelled` locally). A turn the member rejected with a protocol error carries `error`; consumers must branch on `error` first and treat `stopReason` as a placeholder.

```ts cordis-catalog
/**
 * A prompt turn settled: the member answered `session/prompt` (or the
 * connection died and the turn was settled `cancelled` locally). A turn
 * the member rejected with a protocol error carries `error`; consumers
 * must branch on `error` first and treat `stopReason` as a placeholder.
 * @mode emit
 * @param memberId - the member whose turn settled.
 * @param sessionId - the member's session the turn belonged to.
 * @param promptId - the prompt id minted when the turn was accepted.
 * @param stopReason - the ACP stop reason the member returned.
 * @param error - the failure message when the member rejected the prompt.
 */
'team/turn-end'(memberId: string, sessionId: string, promptId: string, stopReason: StopReason, error?: string): void
```

Source: [`packages/team/team/src/types.ts:198`](../../packages/team/team/src/types.ts)
<!-- END GENERATED cordis-surface -->
