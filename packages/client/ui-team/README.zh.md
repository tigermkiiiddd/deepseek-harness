# @deepseek-ai/dsh-client-ui-team

[English](README.md) | 中文

Web 团队视图：框架顶部一条**全局可视化栏**（`shell.topbar`），把每个 agent——主实例加每个成员——渲染为带实时状态与连线的节点。成员会话现在已是主对话 UI 中的普通一等会话：点击成员节点会通过常规会话选择路径（`ctx.sessions.open`）打开该成员当前话题，会话 id 格式为 `member:<memberId>:<topicId>`。全局栏还承载成员管理控件：一个“新建成员”表单（命令、参数、工作目录、环境变量、权限策略、自启动）以及每个节点的移除/启动/停止/重启。

## 架构

- **Host 半边**（`src/index.ts`）：空 apply，让插件对 Loader 可见。`team` 域由 host API-proxy 提供（`team.*` RPC 方法，由 `@deepseek-ai/dsh-team` 实现）。
- **浏览器半边**（`src/client/index.ts`）：状态推送桥订阅转发的 `team/status` 远程事件，折叠进一个 `TeamController` store（经 inject `hooks` 舱以 `useTeamLive` 暴露）；全局栏（`TeamTopbar`，SVG 节点图）读取该 store，并经正式 host API（`@deepseek-ai/dsh-client-connection`）驱动 `api.team.*`。点击成员节点会解析该成员最新话题（`team.sessions`）并通过 `ctx.sessions.open` 选择 `member:<memberId>:<topicId>` 会话；若成员尚无话题，控制器会先新建一个（`team.newSession`）再选择。点击主实例节点则返回主对话视图（`ctx.sessions.clear`）。从不轮询。
- **框架**（`@deepseek-ai/dsh-client-ui-layout`）：在三列之上声明并渲染 `shell.topbar` 栏。

## 数据归属

全局栏经 host API 读取并驱动成员进程；成员对话现在渲染在常规对话 UI 中，由后者拥有会话列表与选择状态。本包只保留花名册、状态订阅与成员管理动词。

## 模型体验

无。团队视图只在浏览器中渲染成员花名册，并把成员对话路由到主对话界面；这里没有任何内容直接进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 成员↔成员直发尚未开放；全局栏目前只连接主实例与成员。
