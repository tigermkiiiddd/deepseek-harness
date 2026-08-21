# @deepseek-ai/dsh-team

[English](README.md) | 中文

DSH ACP 虚拟团队的成员连接。**成员**是持久 ACP agent 进程，**拥有自己的会话（话题）**——会话历史存在成员进程与其持久化里，绝不在本 harness 中。成员可以是一等 `dsh` 对等体（harness 把当前安装作为 ACP 服务器重新拉起），也可以是任意自定义 ACP 服务器（如 `dsh-acp-demo`）。`team` 服务是 ACP 客户端接缝：派生成员进程、完成 `initialize` 握手、保留成员能力，并通过 Agent Client Protocol 驱动轮次。

## 服务

`ctx.team`（插件 `@deepseek-ai/dsh-team`，配置 `members`）：

| 成员 | 含义 |
|---|---|
| `list()` | 每个成员及其对外状态、能力与最后错误。`idle` = 进程已就绪、无进行中的提示轮次；`running` = 有提示轮次进行中；`offline` = 进程未运行；`failed` = 最近一次启动失败。连接中为内部过渡态：启动期间成员保持此前的对外状态（初始为 `offline`）。 |
| `start(id)` / `stop(id)` / `restart(id)` | 显式生命周期；`autostart`（默认）在加载时派生成员。对已停止成员的操作大声失败。 |
| `listSessions(id, cwd?)` | 成员自己的会话话题（经 ACP `session/list`）。成员在线时实时刷新缓存；成员离线时返回上一次缓存的列表，从未缓存则大声失败。 |
| `loadSession(id, sessionId)` | 在成员上恢复一个话题（经 ACP `session/load`）。 |
| `readHistory(id, sessionId)` | 加载一个话题并收集回放的会话历史（成员自己的记录）。成员离线时从持久缓存读取。 |
| `readHistoryEvents(id, sessionId)` | 加载一个话题并返回全保真转译后的 harness 事件序列（`turn/start`、`user/message`、`assistant/message`、`assistant/chunk`、`tool/call`、`tool/result` 等），用于在主会话 UI 中渲染。成员离线时从持久缓存读取。 |
| `isTurnInFlight(id, sessionId)` | 成员是否对某个话题仍有进行中的提示轮次。 |
| `newSession(id)` | 在成员上开新话题（经 ACP `session/new`）。 |
| `prompt(id, sessionId, text)` | 受理一轮并立即返回 prompt id；块以 `team/member-update` 事件流式到达，结算以 `team/turn-end` 到达。 |
| `cancel(id, sessionId)` | 取消一个会话的在途轮次。 |
| `permission(id, requestId, outcome)` | 应答一个已上浮的 `session/request_permission` 提示。 |
| `chat(id, sessionId, text, signal?)` | 面向模型工具的阻塞便捷方法：prompt 加落定回复（文本 + stop reason）。 |
| `addMember(config)` / `removeMember(id)` | 运行时名册变更。`addMember` 立即写入持久名册；`removeMember` 尝试删除并记录失败，因此删除失败时该成员可能在重启后复现。 |
| `onPermissionRequest(handler)` | 订阅权限处理器；有订阅者时提示上浮（事件 + `team.permission`），否则按 `permission: allow | reject` 自动应答。 |
| `disposeAll()` | 停止所有成员进程；服务卸载时执行 dispose-all 效果。 |

每次状态迁移发出 `team/status` 事件；成员输出以无损 `team/member-update` 事件到达。从不轮询。

## 成员配置

```yaml
- id: team
  name: '@deepseek-ai/dsh-team'
  config:
    members:
      - id: architect
        title: 架构师
        description: system design
        command: node
        args: ['--import', 'tsx', './packages/examples/acp-demo/src/bin.ts', '--config', './members/architect/cordis.yml']
        cwd: /path/to/workspace
        env:
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
        autostart: true
```

每个成员是一个进程。成员是可信对等体：子进程继承**完整父环境**（含凭证），**但排除 harness 自有的 `DSH_*` 命名空间**——这些键配置的是本 harness 实例，绝不泄漏给成员——`env` 叠加其上。`cwd` 是成员的工作目录与会话工作区——未配置时为主进程启动目录；绝不让调用方会话工作区绑定到成员。`permission: allow | reject` 是无 GUI 订阅者应答时 `session/request_permission` 的回落策略。

### 一等 `dsh` 成员

设置 `kind: 'dsh'` 即可让 harness 把当前安装作为成员进程重新拉起。此模式下省略 `command` 与 `args`：成员以 `dsh --profile acp` 运行，拥有独立的 harness home，并通过 `DSH_MAIN_HOME` 指回协调器 home，从而继承用户的设置与凭证，同时保持会话隔离。

```yaml
- id: team
  name: '@deepseek-ai/dsh-team'
  config:
    members:
      - id: helper
        title: Helper
        description: a first-class dsh peer
        kind: dsh
        autostart: true
```

`kind` 为可选；省略时必须有 `command`，成员运行你指定的任意 ACP 服务器。

### 持久名册与离线缓存

名册（团队里有谁、怎么拉起）是 harness 侧唯一持久化的团队状态。`addMember` 立即写入 `team` 存储域；`removeMember` 尝试删除并记录失败，因此删除失败时该成员可能在重启后复现。重启时把持久名册与 `Config.members` 合并（config 对重复 id 保持权威）并重新拉起 autostart 成员。没有存储域的部署保持仅内存名册。

同一个 `team` 存储域还保存每个成员的离线缓存（`cache` 表）：

- **`listSessions` 成功** 时刷新缓存话题列表。每个缓存话题保留 `sessionId`、`cwd` 以及可选的透传字段 `title` 和 `updatedAt`。
- **实时 `session/update` 通知** 会追加到该话题的缓存更新流。
- **`readHistoryEvents`/`readHistory` 成功** 后，用完整的 `loadSession` 回放替换该话题的缓存更新（回放为权威），之后继续追加实时更新。
- **离线读取** 使用缓存：`listSessions` 返回缓存列表，`readHistoryEvents` 把缓存更新流经转译器折叠。未知话题大声失败，不会静默返回空。

不缓存秘密：缓存的更新是成员已经向 harness 展示的会话内容。

## 事件

| 事件 | 载荷 |
|---|---|
| `team/status` | `(memberId, status, error?)`——每次状态迁移。 |
| `team/member-update` | `(memberId, sessionId, update)`——一条无损 ACP `session/update`（文本/思考块、工具调用、计划、用量）。 |
| `team/permission-requested` | `(request)`——一条已上浮的 `session/request_permission` 提示，可经 `team.permission` 应答。 |
| `team/turn-end` | `(memberId, sessionId, promptId, stopReason)`——一轮已结算的 prompt。 |

四条全部进入允许列表，经 host SSE 流逐字转发（`@deepseek-ai/dsh-api-remotes`）。

## 全保真历史渲染

`readHistoryEvents` 把成员回放的 ACP `session/update` 流经 `@deepseek-ai/dsh-team/fidelity-reverse`（`AcpUpdateTranslator`）转译为 harness `SessionEvent` 载荷，host bridge 可将其追加到本地会话以渲染。该转译器按（成员，会话）保持状态：把用户块累积为一条 `user/message`，在首个 agent 输出处打开 `step/start` 与内容块，将 `tool_call` / `tool_call_update` 配对为 `tool/call` + `tool/result`，在 step 关闭时发出一条提交的 `assistant/message` 使客户端将该 step 标记为已落定，并丢弃没有干净逆映射的更新（`usage_update`、模式/命令/会话信息公告等）。轮次边界由实时 `session/prompt` 结算关闭（对流式轮次）或在回放末尾由转译器尾部冲洗关闭。

在实时路径上，host bridge 通过 `startTurn(text)` 铸造 `user/message`；若 agent 以 `user_message_chunk` 更新回显相同的用户文本，转译器会抑制这条重复消息，使该轮只显示一个用户气泡。

## 进程边界

成员经 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 接缝派生。ACP wire 是序列化边界。协作式关闭终止进程；意外进程死亡使成员进入 `offline`。

## 模型体验

### 成员请求

#### 模型看到什么

经 `dsh-tool-team`（`member_sessions` / `member_chat` / `member_*`），调用 agent 看到成员名册、每个成员的话题 id 与成员落定的回复。成员自己的系统提示、工具与历史留在成员进程内；只有用户文本越过，只有落定的助手文本返回。

#### Token 影响

每轮对话发送一条用户消息并返回一条回复。历史读取（`readHistory`）是 UI 侧操作，不消耗调用方模型 token。

#### KV Cache 影响

调用方请求前缀不受影响；成员轮次是独立请求。

## 已知限制与暂缓事项

- **每成员一个进程**——无池化或热备；重启是显式的。
- **诚实边界**——harness 持有 stdio 管道，因此 harness 派生的成员随 harness 终止；成员会话存在成员自己的持久化里，经 `loadSession` 恢复。
- **仅本地工作区**——成员进程运行在同一台机器上；远程 ACP agent 需要自己的工作区映射。
- **远程工具调用不透明**——成员在自己进程内执行自己的工具；harness 只能看到协议流。
- **成员↔成员直发尚未开放**——通信经协调 agent（或用户经团队视图）。
