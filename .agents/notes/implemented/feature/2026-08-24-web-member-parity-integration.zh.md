# Agent Note: Web 成员对等接入 —— ACP 成员作为会话域的一等会话

Status: implemented

[English](2026-08-24-web-member-parity-integration.md) | 中文

## 问题

成员主题在 Web UI 中已是一等会话（`member:<memberId>:<topicId>`），但围绕它的会话域面大多是断裂或误导性的：模型选择没有成员路径，图片 prompt 被死胡同式拒绝，重发点击必失败，分叉和重命名提供必然失败的对话框，队列更新返回错误的 `queue-item-not-found`，搜索/导出的限制没有记录。用户对成员的标准是对等 agent：每个会话域面要么对成员可用、要么可见地缺席——绝不允许"按钮存在但点了必失败"。

## 决策

先在 host wire 层强制对等，再由客户端隐藏无对应物的入口。不扩展公共 wire schema；全部走既有方法加一个 team 服务内部 seam。

- **模型选择（W1）**：成员 id 的 `session.models` 从成员自己的 `session/setSessionConfigOption` 目录合成一个 routable 目录（`current` = 缓存的选项值，一组以成员标题命名）；无选项时返回 `model-unavailable`。`session.selectModel` 先对照该目录校验——未提供的模型在跨线前被拒绝——再委托 `team.setConfig`，成员自己的选择始终是唯一权威。
- **图片 prompt（W2）**：`packages/team/team` 新增 `promptContent(sessionId, content: MemberPromptBlock[])`（ACP wire blocks；`prompt(text)` 改为委托它）。host 的 `session.prompt` 成员分支让图片 part 走与主路径相同的 `admitEncodedImages` 准入——超限批次在任何字节离开前被拒——然后按协议各建一份 block 列表：给成员进程 ACP 形态 `{type:'image', data, mimeType}`，给铸造的 `user/message` core 形态 `{type:'image', attachment: ref}`，Web 转录因此能渲染已准入的图片。成员主题没有 host 日志可供读取鉴权，所以准入本身即授权：铸造的引用按虚拟会话记录于本进程生命周期内，成员 id 的 `session.attachment` 只服务这些已准入图片（未准入 id 返回 `attachment-error` / `ATTACHMENT_NOT_ADMITTED`）。反向翻译器铸造带附件引用的 user message，且仅当回显消息不带图片时才去重。
- **重发（W3）**：成员主题无法截断自己的日志，所以 `session.rerun` 无操作接受：客户端在重发被接受后本就会补一条 prompt（其既有流程），这条 prompt 在同一主题上开新轮次——这就是重发。分叉在 dsh ACP bridge 中没有对应物，保持拒绝；客户端在成员会话隐藏分支动作（`TurnTailNodeView` 省略 `onBranch`，会话行菜单去掉重命名/分叉、保留只动本地 registry 的归档）。
- **队列/steer（W4）**：成员 id 的 `session.updateQueue` 以明确的"不支持"错误拒绝，不再冒充 `queue-item-not-found`；成员没有本地 agent inbox，队列面保持为空，Enter-steer 由 prompt 分支以自己的清晰消息拒绝。
- **已知限制（W6/W7）**：apiproxy README 记录成员会话不进入 `session.search`（查询服务索引 host 日志，成员没有）且导出返回 400；team README 记录成员无法发起自由问答——ACP 没有 question 原语，`requestPermission`（以审批呈现）是其唯一交互通道。

## 备选方案

**扩展公共 wire API 增加成员专用方法。** 拒绝：上述每个面都能映射到既有方法的成员分支；新增 `member.*` 会话域方法会复制客户端已在说的契约，并分裂 host 对模型、prompt、动作的唯一事实源。

**纯客户端检测（只做 UI 门控）。** 作为主要强制手段被拒绝：客户端检查可被绕过，且 wire 仍会以误导性错误应答。host 分支才是决策点；UI 隐藏是其上的体验层。

**通过 ACP 截断重建实现重发。** 拒绝：dsh ACP bridge 不实现日志截断或上下文重写原语，为此发明一个会让 harness 拥有它并不存储的成员历史。同主题新轮次是诚实的语义。

## 测试

- `packages/team/team`：`promptContent` 让图片 block 跨真实 ACP wire（mock agent 回显收到的 block 类型）并拒绝纯空白文本；反向翻译器铸造带附件引用的 user message，且保留带回显图片的 user message 不去重。
- `packages/host/apiproxy`（`api-proxy-team.spec.ts`，真实子进程 mock agent）：成员模型目录合成、选择后重读、未提供模型的拒绝；带已准入图片的成员 prompt 转发到 agent（回显 block 类型）并把附件引用铸进 user message；超限图片批次在持久化前被拒；分叉仍拒绝而重发接受；队列更新明确拒绝。
- `packages/client`：成员会话上分支动作缺席（chat view），重命名/分叉离开会话行菜单而归档保留（workspace 行）；两个套件都以真实 props 渲染并断言用户可见行为。

## 后果

成员会话现在像对等 agent 一样工作：文本和图片进出、从成员自己的目录选模型、重发即新轮次、权限请求走审批流应答——每个没有 ACP 对应物的面（分叉、重命名、队列编辑、搜索、导出、自由问答）要么被隐藏，要么以说明原因的拒绝消息应答。代价是 team 服务多一个 seam（`promptContent`），以及保持合成模型目录与成员 `session/config_option_update` 通知同步的持续义务——过期目录会宣告成员已不再提供的模型。

本 note 扩展 [ACP 虚拟团队](2026-08-16-acp-virtual-team.zh.md)（成员生命周期与主题聊天；其「面板尚无流式」后果针对 ui-team 名册面板，不覆盖本会话域桥——后者经反向翻译器流式）与本 note 模型桥所读取的[成员模型与 provider 配置](2026-08-23-acp-member-model-and-provider-config.zh.md) seam。
