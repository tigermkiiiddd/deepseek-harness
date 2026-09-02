# @deepseek-ai/dsh-client-ui-team

[English](README.md) | 中文

Web 团队视图：侧栏底部一条**全局可视化栏**（`sidebar.footer.action`），把每个 agent——主实例加每个成员——渲染为带实时状态与连线的节点。成员会话是主对话 UI 中的普通一等会话：点击成员节点会通过常规会话选择路径（`ctx.sessions.open`）打开该成员当前话题，会话 id 格式为 `member:<memberId>:<topicId>`。全局栏还承载成员管理控件：一个“新建成员”表单（命令、参数、工作目录、环境变量、权限策略、自启动）以及每个节点的移除/启动/停止/重启。

## 架构

- **Host 半边**（`@deepseek-ai/dsh-team`）：拥有生成式 `team` Remote 命名空间，提供名册、生命周期和成员话题操作。
- **浏览器半边**（`src/client/index.ts`）：先挂载该 Remote 贡献，再创建 UI 控制器，随后把 `TeamTopbar` 注册进 `sidebar.footer.action`。控制器驱动 `ctx.remote.team`，通过 `ctx.sessions.open` 选择 `member:<memberId>:<topicId>`；新建话题尚未进入本地基线时，经 `sessions.refresh` 重拉一次再重试。销毁按反序进行，使 Remote 命名空间始终比所有 UI 消费者活得更久。从不轮询。
- **框架**（`@deepseek-ai/dsh-client-ui-sidebar`）：声明并渲染侧栏底部动作槽位。

## 数据归属

全局栏经 host API 读取并驱动成员进程；成员对话现在渲染在常规对话 UI 中，由后者拥有会话列表与选择状态。本包只保留花名册、状态订阅与成员管理动词。

## 模型体验

无。团队视图只在浏览器中渲染成员花名册，并把成员对话路由到主对话界面；这里没有任何内容直接进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 成员↔成员直发尚未开放；全局栏目前只连接主实例与成员。
