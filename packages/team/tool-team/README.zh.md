# @deepseek-ai/dsh-tool-team

[English](README.md) | 中文

面向 [`team` 服务](../team/README.md) 的模型工具：枚举团队成员与每个成员自己的会话话题、在选定或新话题上与成员对话、变更名册、驱动成员生命周期。这些工具是常驻团队能力：web-app bundle 在 host 面挂载该行，每个会话无需任何 preset 即可看到。

## 工具

- `member_sessions` —— 列出每个成员（或指定 `member_id`）及其状态与能力，外加每个成员自己的话题 id（经 ACP `session/list`）。未运行的成员会报告如何启动它。从这里开始选择要续接的话题。
- `member_chat` —— 向成员发送 `text`。传已有 `topic` id 续接该对话，或 `new_topic: true` 在成员上开新话题。返回成员落定的回复（非 `end_turn`/`max_tokens` 时附带 stop reason）。工具取消信号经 ACP 取消成员的轮次。
- `member_add` —— 在运行时派生成员进程、写入持久名册并加入团队。接受完整成员配置：`command`、`args`、`cwd`、`env`（叠加在完整父环境上）、`permission`（`allow` / `reject` 回落策略）、`autostart`。
- `member_remove` —— 停止成员、移出名册并尝试从持久化删除。删除失败会记录日志，且该记录可能在重启后复现；同时声明在部署配置里的成员会在下次重启时重现。
- `member_start` —— 启动已停止或失败的成员（派生 + 握手）。幂等。
- `member_stop` —— 停止成员并回到 `idle`；其自己的会话留在成员侧。
- `member_restart` —— 先停后启一个成员，例如在它进入 `offline` 之后。

## 模型体验

### 成员对话

#### 模型看到什么

成员名册、话题 id 与 `member_chat` 的落定回复。成员自己的性格、工具与历史留在成员进程内；只有用户文本越过，只有落定的助手文本返回。

#### Token 影响

每次调用增加发送的消息与返回的回复。列出不增加 token。

#### KV Cache 影响

在可复用请求前缀之后仅追加；成员轮次是独立请求。

## 已知限制与暂缓事项

- 无流式中间文本：工具在轮次落定时返回完整回复。
- 话题 id 是成员侧不透明标识符；话题标题是未来的 ACP/session-info 增强。
