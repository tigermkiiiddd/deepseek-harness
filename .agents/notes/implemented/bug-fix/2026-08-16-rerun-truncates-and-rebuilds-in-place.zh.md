# Agent Note: Rerun truncates and rebuilds the session in place

Status: implemented

[English](2026-08-16-rerun-truncates-and-rebuilds-in-place.md) | 中文

## Problem

用户消息的重发/编辑重发此前只是把文本作为普通 prompt 发进同一会话：其后的消息与回复都留在日志和模型上下文里。第一版基于 fork 的修复作为产品行为被否决——每次重跑都会在侧边栏实打实多出一个分支会话，而这正是已有 branch 操作的能力。要求的语义是原地：对话回到该消息之前，后续内容物理消失，会话保持自身标识。

## Decision

Rerun 是跨三层的同 id 截断并重建：

- **持久层**（`dsh-session-persistence` + JSONL/SQLite 后端）：`PersistenceCoordinator.truncate(id, keepSeqs)` 把持久日志重写为恰好 `seq < keepSeqs` 的事件，拒绝 live 会话与异版本格式。JSONL 整体重写构件（zstd 帧边界不允许按字节截断），沿用修复路径的同步临时文件加原子发布纪律；SQLite 在一个事务里删除尾部行并提升 revision。截断到零留下一个仅含头部、仍列出的物化会话。
- **Agent 层**（`dsh-agent` / `dsh-agent-loop`）：`ctx.agents.reseed({ sessionId, keepSeqs, meta?, agentOptions?, setup? })` 捕获 live 日志前缀，dispose 当前 handle（停 loop、注销、展开作用域），截断持久存储，然后以同一 session id 用前缀 seed 重建 agent。头部字段默认承继（meta 可覆盖）；agent options 默认沿用原 agent 的。
- **Wire 与客户端**：`session.rerun { sessionId, atSeq }` 计算切点——锚点之前最后一个 `turn/end`，向前延伸越过带外事件，但在 `agent/inbox/spliced` 前停下，因为后续消息的准入 splice 落在它的 `turn/start` 之前，保留它会把被丢弃的消息重新准入重建后的 inbox。live 会话走 reseed；持久但未 live 的会话直接截断。锚点越界由 `rerun-unavailable` 拒绝。客户端 `rerunUserMessage(seq, text)` 等待 `sessions.rerun`（它对打开的窗口执行 `resync()`，因为所有 seq 游标都已失效），然后把文本作为普通 prompt 排入。该动作服务的原位编辑器见[原位编辑器决策](2026-08-16-reedit-edits-in-place.zh.md)。

## Alternatives considered

**fork 出子会话再 prompt。** 作为产品行为被否决：每次重跑都在侧边栏多一个真实分支会话，与已有 branch 操作重复（[fork 决策](../feature/2026-06-30-session-store-fork-api.zh.md)）；用户要的是对话本身回卷。

**不重建 agent、原地改日志。** 否决：所有插件、投影、遥测游标与客户端窗口都建立在只增、seq 单调的不变量之上（[event-sourced sessions](../architecture/2026-06-11-event-sourced-sessions.zh.md)）；在 live agent 脚下改写会让它们全部悬空。同 id 重建复用了唯一一条已能把前缀重放进全新状态的路径——seed。

**截断前优雅取消运行中的轮次。** 无必要：任何运行中的轮次都在被丢弃区域内，其有序的 `turn/end` 同样会被截掉；dispose 会停掉 loop，重建从干净状态开始。

## Consequences

后续内容在持久日志与重建后 agent 的上下文中物理缺席——模型不可能看到它。队列与所有瞬态轮次状态随旧 agent 消亡。会话保留其 id、标题历史（切点前的事件）、cwd、谱系与 Workspace 挂载，侧边栏不变。发起方客户端在 RPC 后重基线窗口；同一会话的第二个标签页不会被强制 resync，重连前显示陈旧的尾部。rerun 失败则会话保持不动。宿主测试钉住切点（含 splice 回退）、第一轮空前缀、冷会话截断与错误分类；agent-loop 测试钉住 dispose、持久截断与续写；持久层契约测试钉住两个后端。
