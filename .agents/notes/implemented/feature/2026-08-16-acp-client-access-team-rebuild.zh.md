# Agent Note: ACP 客户端接入团队重建

Status: implemented

[English](2026-08-16-acp-client-access-team-rebuild.md) | 中文

## 问题

ACP 虚拟团队的第一版实现（[原 Agent Note](2026-08-16-acp-virtual-team.md)）只让 harness 位于协议的 agent 侧：`dsh-acp` 应答外部客户端，但 harness 自身没有 ACP *客户端*接缝来驱动其他 agent 进程。临时的 `packages/team/team` 实现表现得像一个部分手工搓制的客户端：惰性拉起成员、清洗掉环境凭证、轮询存活状态、把成员输出降级为纯文本、不保留能力、名册只写在内存里。这违反了定义团队成员是什么的核心设计约束 C1–C7：团队成员应是 harness 作为客户端连接的独立 ACP agent 进程，具备显式生命周期、完整协议保真度和持久名册。

## 决策

团队子系统围绕真正的 ACP 客户端接入层重建。harness 通过 stdio JSON-RPC 作为 ACP 客户端连接成员进程；成员是拥有自己的会话与持久化的独立 agent。实现遵循设计计划中的 C1–C7 约束。

### C1 —— 客户端角色，非所有权

harness 持有 stdio 管道与 UI 聚合权，但不拥有成员的模型循环、系统提示、工具或会话数据。成员会话存在于成员进程内，并由成员自己的存储持久化。harness 只通过 ACP 协议列出、加载并驱动轮次。

### C2 —— 协议面说话

`MemberConnection` 完成 ACP `initialize` 握手并保存返回的 `agentCapabilities`。界面按能力真实渲染：没有 `sessionCapabilities.list` 的成员没有历史入口，没有 `loadSession` 的成员只显示新轮次。每条 `session/update` 通知都以 `team/member-update` 事件无损转发，承载文本块、思考块、工具调用、计划与用量。`session/request_permission` 上浮为 `team/permission-requested` 事件，并通过 `team.permission` 应答；没有订阅者时，成员配置的 `permission` 策略自动应答。

### C3 —— GUI 是聚合器，成员视图是投影

Web GUI 增加全局可视化栏（`shell.topbar`），每个 agent 一个节点——主实例加每个成员——并用连线展示星型拓扑。节点颜色反映 host 推送的实时成员状态。选中成员后，主视图替换为 `MemberView`（ui-team，注册进 `shell.overlay`），投影成员自己的话题、所选话题的 ACP 流式对话、工具卡片、计划与权限弹窗。该视图由协议流驱动，而非重新解释 harness 的 `SessionEvent` 语义。

### C4 —— 团队是部署形态，不是模式

只要加载了 `team` 插件，团队能力就始终存在。profile 的 `cordis.patch.yml` 在 `team.config.members` 下声明成员；模型工具（`member_add`、`member_remove`、`member_start`、`member_stop`、`member_restart`、`member_sessions`、`member_chat`）由 web-app bundle 永久挂载在 host 面。不存在「团队模式」preset，也不需要按会话选择加入。

### C5 —— 显式生命周期，显式环境，状态推送

`start`、`stop`、`restart` 是一等服务方法与模型工具。`autostart: true`（默认）的成员在服务加载、名册合并完成后启动；对已停止成员的操作大声失败，而不是惰性派生。派生的进程继承**完整父环境**（含凭证），`config.env` 叠加其上。对外状态词汇严格为 `idle` / `running` / `offline` / `failed`：`idle` 表示已连接且没有在途轮次，`running` 表示有 prompt 轮次在飞，`offline` 表示进程未运行，`failed` 表示启动失败。`connecting` 是内部过渡态：启动期间成员读作 `offline`。每次迁移发出 `team/status` 事件；GUI 与工具接收推送，从不轮询。

### C6 —— 名册是部署数据，必须持久化

名册（团队里有谁、怎么拉起）是 harness 侧唯一持久化的团队状态。运行时添加的成员立即写入 `team` 存储域；`removeMember` 尝试删除并在失败时记录日志而不崩溃。重启时，持久名册与 `Config.members` 合并，config 对重复 id 保持权威，然后重新拉起所有 autostart 成员。

### C7 —— 诚实边界

stdio ACP 下 client 持有管道：harness 派生的成员进程随 harness 终止。声明 `loadSession` 的成员通过自身持久化在重启后恢复自己的会话历史，而非通过 harness。

## 曾考虑的替代方案

### 在惰性、轮询、纯文本的实现上打补丁

这会留下错误的基础：一个不是真正 ACP 客户端的成员会继续发明与协议矛盾的语义（清洗环境、轮询、降级输出、内存名册）。否决，改为在真实 ACP 客户端契约上重建接入层。

### 保留「团队模式」preset

只对选定会话挂载工具行的 preset 在第一版中用过，具有吸引力。否决，因为团队是部署级能力：一旦声明了 agent servers，每个会话都应能添加并驱动成员；把它藏在会话模式 preset 后面会任意地对模型隐藏能力。

## 后果

- harness 现在可以作为 ACP 客户端接入任何具备 ACP 能力的 agent 进程，使每个 dsh 实例都成为潜在的网状节点：它既能被外部客户端作为 agent 驱动（`dsh-acp`），也能作为客户端驱动其他 agent（`dsh-team`）。
- 成员输出以流式方式按完整协议保真度渲染；GUI 是投影，而非手搓摘要。
- 名册在重启后保留，因此运行时添加的成员会自动重新拉起（除非 `autostart: false`）。
- 成员是可信对等体，继承父环境；运维者必须像对待 harness 进程本身一样谨慎对待成员命令与凭证。
- `connecting` 被刻意不暴露为可观测状态；消费者在启动期间看到 `offline`，并通过 `team/status` 推送等待迁移。
