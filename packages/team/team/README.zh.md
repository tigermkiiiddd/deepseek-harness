# @deepseek-ai/dsh-team

[English](README.md) | 中文

DSH ACP 虚拟团队的成员连接层。**成员**是一个持久的 ACP agent 进程（带自己 `cordis.yml` 的 `dsh-acp-demo`，或任意 ACP 服务器），**拥有自己的会话（话题）**——它的对话历史保存在成员进程及其持久化中，绝不保存在本 harness 里。`team` 服务只负责 spawn 进程、通过 Agent Client Protocol 列出/加载/创建话题，以及驱动对话轮次。

## 服务

`ctx.team`（插件 `@deepseek-ai/dsh-team`，配置 `members`）：

| 成员方法 | 含义 |
|---|---|
| `list()` | 每个已配置成员及其连接状态（`connecting` / `connected` / `failed` / `closed`）。 |
| `listSessions(memberId, cwd?)` | 成员自己的会话话题（经 ACP `session/list`）。 |
| `loadSession(memberId, sessionId)` | 在成员上恢复一个话题（经 ACP `session/load`）。 |
| `readHistory(memberId, sessionId)` | 加载话题并收集回放的对话历史（成员自己的记录）。 |
| `newSession(memberId)` | 在成员上开新话题（经 ACP `session/new`）。 |
| `chat(memberId, sessionId, text, signal?)` | 驱动一轮并返回已提交文本与停止原因。 |
| `close(memberId)` | 拆除成员进程（其持久化话题保留）。 |
| `disposeAll()` | 拆除全部成员进程。 |

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
```

每个成员一个进程。`cwd` 在首次使用时绑定进程（及其话题的工作区）：配置值优先，否则取第一个调用方会话的工作区。进程死亡后按需重新 spawn；其持久化话题仍然可列、可加载（成员自己的持久化）。

## 进程边界

成员经 [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam spawn（凭据清洗 + 显式 `env`）。权限提示按 `permission: allow | reject` 自动应答。ACP 线协议是序列化边界。

## 模型体验

### 成员请求

#### 模型看到的内容

经 `dsh-tool-team`（`member_sessions` / `member_chat`），调用 agent 看到成员名册、每个成员的话题 id，以及成员已提交的回复。成员自己的系统提示词、工具与历史保留在成员进程内；只有用户文本跨进程，只有已提交的 assistant 文本返回。

#### Token 影响

每轮对话发送一条用户消息并返回一条回复。历史读取（`readHistory`）在 UI 侧，不消耗调用方模型 token。

#### KV Cache 影响

调用方的请求前缀不变；成员轮次是独立请求。

## 已知限制与暂缓事项

- **一个成员一个进程**——无池化或热备；下一次操作时按需重新 spawn。
- **仅本地工作区**——成员进程运行在同一台机器上；远程 ACP agent 需要自己的工作区映射。
- **远端工具调用不透明**——成员在自己的进程内执行自己的工具；只有已提交的 assistant 文本跨回。
- **暂无成员间直接消息**——通信经协调 agent（或用户经团队视图）。
