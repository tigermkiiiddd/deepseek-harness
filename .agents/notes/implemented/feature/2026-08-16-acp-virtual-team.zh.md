# Agent Note: ACP virtual team — peer ACP agent processes as persistent team members

Status: implemented

[English](2026-08-16-acp-virtual-team.md) | 中文

## Problem

用户希望有一个虚拟 AI 团队：成员长期存活，各自拥有性格、模型与持久化的多话题会话，可平级通信（主实例 ↔ 成员、成员 ↔ 成员），并在 GUI 中以成员名册和按话题聊天历史的形式呈现。现有委派路径无法提供这一点：subagent 是短生命周期、发起者拥有的子进程，其会话归属于父会话并随父会话消亡；continuable 镜像也只是调用方的单会话扩展。成员必须是独立 agent 进程，拥有自己的会话并独立于主实例存活。

## Decision

团队成员是**独立的 ACP agent 进程**（基于 stdio 的 JSON-RPC），团队即主实例与这些进程之间的平级连接。选择 ACP 作为传输接缝，因为它就是本 harness 的自动化专用 agent 协议：成员可以是任何具备 ACP 能力的 agent，声明自己的会话能力，并拥有自己的会话。

- `packages/acp/acp` —— dsh-acp 服务器现在声明 `loadSession: true` 与 `sessionCapabilities.list`，并实现 `session/list`（`listSessions`）与 `session/load`（`loadSession`）。`loadSession` 幂等：种子化会话事件流，并把持久化历史以 `user_message_chunk` / `agent_message_chunk` 通知流式回放；未知会话 id 以请求错误拒绝。这使调用方（主实例）能够决定继续哪个已有话题，或用 `session/new` 新建一个。
- `packages/team/team`（`@deepseek-ai/dsh-team`）—— 宿主团队服务。`Config.members[]` 声明成员（id/title/description/command/args/cwd/env/permission）。`MemberConnection` 在首次使用时 spawn 并初始化进程，然后提供 `listSessions`、`loadSession`、`readHistory`（回放加载流）、`newSession` 与 `chat`（prompt 并等待轮次落定）。协作式关闭会终止进程；服务卸载时执行 dispose-all 效果。
- `packages/team/tool-team`（`@deepseek-ai/dsh-tool-team`）—— 模型工具 `member_sessions`（列出成员话题）与 `member_chat`（在选定或新话题上对话），使主 agent 自身也能与成员协作。
- `packages/host/apiproxy` —— 新增 `team` API 域（`team.list` / `team.sessions` / `team.history` / `team.newSession` / `team.chat`），经标准 RPC 载体提供，委托给 `ctx.team`；团队服务缺失时报告该域不可用。
- `packages/client/ui-team`（`@deepseek-ai/dsh-client-ui-team`）—— Web 团队视图：`sidebar.footer.action` 入口切换一个 `shell.overlay` 面板，面板列出成员名册、成员的各个话题、话题回放历史，以及针对所选话题的输入框。所有数据经正式宿主 API（connection 的 `IApiClient`）的 `api.team.*` 传输，绝不使用手写 fetch 桥接。
- 「ACP 团队模式」agent preset（`~/.dsh/.agent-presets/team/`）为需要模型侧成员工具的会话挂载 tool-team 行。

成员会话及其历史**保存在成员进程内**；主实例只负责列出、加载与驱动。成员既不是 subagent 也不是镜像——委派栈不参与其中。

## Alternatives considered

### Subagent / continuable 镜像委派

本 harness 自己的委派方式：发起者拥有的子进程、归属父会话的历史、生命周期随调用方。被用户明确否决——成员必须拥有自己的会话并比主会话活得更久；该路径也无法赋予成员独立的多话题生命或平级通信。

### 单一模型「grok 式」集成

用户提及外部 agent（hermes、grok）只是作为 agent 的*示例*，而非主题。单一提供商的定制集成因范围与命名被否决：真正的概念是 agent 协议本身，因此团队建立在 ACP 之上，可对接任何具备 ACP 能力的成员进程。

## Consequences

- 成员是完全独立的进程：即使主实例消失，它们仍继续运行并保留会话；主实例通过 `session/load` 重连并继续某个话题。
- GUI 显示每个成员自己的话题与按话题的历史；切换话题是对成员的一次 `loadSession`，而非本地视图。
- 每个成员都消耗真实资源（进程、API 额度），且可能代表其执行真实命令；名册由部署配置（`Config.members`）决定，未配置的部署显示空名册。
- 团队面只读/驱动：面板不保存成员对话的持久副本，聊天返回轮次落定后的完整回复（面板暂不支持流式）。
