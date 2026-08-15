# Agent Note: DSH ACP 虚拟团队——成员拥有自己的会话

Status: implemented

[English](2026-08-15-acp-virtual-team.md) | 中文

## 问题

harness 此前无法把一组**持久、独立的 ACP agent 进程**当作一等公民成员运行：`dsh-subagent-acp` 只驱动一次性子级；subagent continuable 子级是父级拥有的镜像会话（被否决的设计，见历史）；也没有任何机制让调用方浏览成员自己的会话话题并选择继续或新开。

## 决策

成员是一个持久的 ACP agent 进程，**拥有自己的会话及其历史**；harness 只通过 Agent Client Protocol 连接并驱动它。新增三个包加一个服务器增强：

1. **`dsh-acp` 服务器会话能力** —— `session/list`（持久化话题，可按 cwd 过滤）与 `session/load`（把持久化会话的事件日志作为 seed 重建 agent 以恢复会话）。`loadSession` 额外把话题历史以 `user_message_chunk` / `agent_message_chunk` 通知**回放**给客户端——这是协议约定的渲染话题的方式，无需第二条读取路径。能力已声明（`loadSession: true`、`sessionCapabilities.list`）。
2. **`@deepseek-ai/dsh-team`** —— `team` 服务为每个已配置成员持有一个进程（`members` 名册：`command`/`args`/`cwd`/`env`/`permission`）。操作：`list`、`listSessions`、`loadSession`、`readHistory`（加载并收集回放历史）、`newSession`、`chat`、`close`、`disposeAll`。成员按需重新 spawn；其持久化话题经成员自己的持久化仍然可列、可加载。`cwd` 在首次使用时绑定（配置优先，否则取第一个调用方会话的工作区）。
3. **`@deepseek-ai/dsh-tool-team`** —— 模型工具 `member_sessions` 与 `member_chat`（继续 `topic` 或 `new_topic`）。
4. **`@deepseek-ai/dsh-client-ui-team`** —— Web 团队视图：侧边栏操作切换覆盖面板（名册 → 话题 → 回放历史 → 输入区），经 `/api/team/*` 的 JSON-RPC 风格 fetch 路由桥接团队服务。

## 备选方案

- **Continuable subagent 镜像会话**（早期实现）——被团队需求否决：成员是一等公民 agent，拥有自己的会话，而不是父级拥有的子级。
- **GUI 侧镜像成员对话**——否决：成员自己的历史才是事实；面板经 `loadSession` 的回放读取它。
- **浏览器桥接用 Remote（typert）方法**——暂缓：`/api/team/*` HTTP 桥更简单，面板是第一版；未来可用 Remote 表面替换，无需改动服务。

## 后果

- 成员 = 独立 ACP 进程（带自己 preset 的 dsh-acp-demo 实例，或任意 ACP 服务器如 Grok CLI）；各自拥有话题与记忆。harness 绝不镜像或保存成员会话。
- 调用方（模型经工具、用户经团队视图）浏览成员话题并选择继续或新开——正是需求所要求的 ACP 原生模型。
- 部署在宿主 `team` 行配置名册（默认 `members: []`），并在 agent preset 中挂载 `tool-team`。
- 测试覆盖（全部 keyless，真实 stdio 上的 scripted mock ACP agent）：acp 会话 list/load/history（7）、team 服务（8）、tool-team（3）。
- 已知限制：一个成员一个进程（无池化）、仅本地工作区、远端工具调用不透明、暂无成员间直接消息、面板样式为最小实现。
