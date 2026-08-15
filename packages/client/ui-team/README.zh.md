# @deepseek-ai/dsh-client-ui-team

[English](README.md) | 中文

Web 团队视图：侧边栏操作（`sidebar.footer.action`）打开团队面板（`shell.overlay`）。面板列出团队成员及每个成员自己的会话话题，显示话题回放的历史，并在选定话题或新话题上与成员对话。

## 架构

- **Host 半边**（`src/index.ts`）：空 apply，仅让插件对 Loader 可见。`team` 域由宿主 API 代理提供（`team.*` RPC 方法，由 `@deepseek-ai/dsh-team` 实现）。
- **浏览器半边**（`src/client/index.ts`）：侧边栏操作与覆盖面板，经正式宿主 API（`@deepseek-ai/dsh-client-connection`）的 `api.team.*` 驱动。面板可见性存于 `apply` 中创建的共享 `defineStore` 句柄。

## 数据归属

面板通过宿主 API 读取并驱动成员进程；成员会话及其历史保留在成员进程内。面板不保存成员对话的持久副本。

## 已知限制与暂缓事项

- 样式为最小内联 CSS；基于 token 的样式整理属于后续打磨。
- 成员状态在面板打开时刷新；实时状态更新需要订阅通道。
- 对话在轮次结束时返回完整回复（面板暂不支持流式）。
