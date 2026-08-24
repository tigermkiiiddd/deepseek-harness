# Agent Note: Web 成员会话可打开，New Session 路由到成员

Status: implemented

[English](2026-08-24-web-member-session-open-and-new-topic.md) | 中文

## Problem

Web UI 的多 agent 支持有两个用户可见缺陷。点击顶栏成员节点后可能停在空白对话：当该 topic 比本客户端的列表基线更新时，`member:<memberId>:<topicId>` 的 select 抛出 "unknown session"，而团队控制器把这个拒绝吞成一条静默的栏内错误。另外，New Session 按钮永远创建主实例会话——当前正停在成员对话上时，点它会弹回主 agent，而不是和该成员再开一轮对话。

## Decision

两个修复共用一个原语：open 失败时先重拉一次列表再判失败。

- `ISessions` 与 `SessionsPort` 暴露 `refresh()`；具体的 `SessionRuntime.refresh` 早已存在，只是两个面没有发布它。
- `TeamController.openMember` 解析出 topic（最新一个；成员无话题时经 `team.newSession` 新建）后统一走一个助手打开：select 因 id 不在列表基线中而抛错时，先调 `sessions.refresh()` 再重试一次；第二次仍失败才把错误显示到栏内 store。
- `WorkspaceRuntime.startSession` 先做判断：当前会话是成员 topic（host-apiproxy 的纯函数 `memberSessionOwner` 解析）时，经 `team.newSession` 在该成员上创建新 topic，并用同一个 open-with-retry 助手打开；否则走原有 Workspace 目标逻辑、行为不变。两个入口——侧栏按钮与 workspace "+"——在同一处变得成员感知，且无跨包导入：runtime 本来就持有 wire client 与 id 助手。

被吸收的竞态真实存在且有据可查：host 的 `team.newSession` 处理器随 RPC 响应广播该 topic 的列表行（`host/session-added`），两条通道之间没有顺序保证——resolve 之后立即 select 完全可能错过该行。重拉一次之所以仍是确定性的，是因为该处理器在应答前已确认 topic 存在于成员 store。

## Alternatives considered

**只修 open，New Session 保持主实例语义。** 用户否决：那样点完成员再"新建对话"就会悄悄换 agent——正是本次报告的缺陷。

**在顶栏加一个每成员"新话题"按钮，不复用 New Session。** 是合理的形态，但重复了一个现在已正确路由的动作；栏位成熟前入口越少越好。待成员栏长出自己的输入区时再议。

## Testing

- runtime（`workspaces-service.client.spec.ts`）：当前为成员会话时，`startSession` 走 `team.newSession` 并打开新 topic——列表在 `newSession` settle 之后才拿到该 topic，即生产中的帧竞态；RPC 业务错误时保留选择并发出 warn；重拉后列表仍缺该 topic 时 warn。
- ui-team（`team-store.client.spec.ts`）：open 错过比基线新的 topic 时 `openMember` 重拉一次；重试仍错过则显示错误。

纯 Web 行为：不改变任何模型可见 transcript，因此走客户端检查阶梯（`test:gui` 加回放版组装 Web 套件），而非快照 fixture。

## Consequences

New Session 现在是上下文相关的：成员对话中它意味着"和该成员再开一轮"；主实例对话中保持 Workspace 语义。`refresh()` 进入两个公共客户端面——一次有消费者背书的显式加宽，与其他面的加宽规则一致。成员离线期间创建的 topic 仍会在一次重试后响亮失败；没有加自动重建循环。

本 note 扩展 [ACP virtual team](../feature/2026-08-16-acp-virtual-team.zh.md)（成员生命周期与话题聊天）和 [Workspace UI product flow](../feature/2026-07-25-workspace-ui-product-flow.zh.md)（`startSession` slot 动作），本改动经由二者路由。
