# @deepseek-ai/dsh-tool-team

[English](README.md) | 中文

基于 [`team` 服务](../team/README.md) 的模型工具：列出团队成员及每个成员自己的会话话题，并在选定话题或新话题上与成员对话。

## 工具

- `member_sessions` —— 列出每个成员（或指定 `member_id`）及状态，加上每个成员自己的话题 id（来自 ACP `session/list`）。先调用它选择要继续的话题。
- `member_chat` —— 向成员发送 `text`。传已有 `topic` id 继续该对话，或设 `new_topic: true` 在成员上开新话题。返回成员已提交的回复（非 `end_turn`/`max_tokens` 时附带停止原因）。

## 模型体验

### 成员对话

#### 模型看到的内容

成员名册、话题 id 与已提交回复。成员自己的 persona、工具与历史保留在成员进程内；只有用户文本跨进程，只有已提交的 assistant 文本返回。

#### Token 影响

每次调用增加发送的消息与返回的回复。列出操作不消耗 token。

#### KV Cache 影响

可复用请求前缀之后仅追加；成员轮次是独立请求。

## 已知限制与暂缓事项

- 不流式返回中间文本：轮次结束时工具才返回完整回复。
- 话题 id 是成员侧不透明标识；话题标题属于未来的 ACP/session-info 增强。
