# Agent Note: 有界验证冷空白会话

Status: implemented

[English](2026-08-13-bounded-cold-blank-verification.md) | 中文

## Problem

Web 会话树会隐藏空白 Session，并把当前选中的空白项复用为 New Session。已附加 Session 可以从内存事件日志派生空白状态，但 `session.list` 通常不会加载每一份冷日志。把所有已物化的冷 Session 都视为非空，会暴露旧版本留下的空 Session；反过来，把 projection cache 中的 `blank: true` 当成当前事实，则可能在日志已经前进而 fail-soft cache 仍然陈旧时隐藏真实对话。

同一份冷列表还曾用 JSONL 工件的 mtime 作为 `updatedAt`。打开 Session 会追加 `session/end-seed`，因此即使没有真人 prompt，单纯拾起也会刷新 mtime，并把该 Session 提升到最近使用的对话之前。

## Decision

`dsh-host-apiproxy` 注册 `sessionListMetadata` 投影，其中包含 `blank` 与 `lastPromptAt`。已附加摘要直接用同一组函数折叠实时日志。`blank` 只在 `turn/start` 时从 true 单调变为 false；`lastPromptAt` 只在来源 kind 为 `user` 的 `user/message` 上更新。

冷摘要分三档。已确认为非空的持久行——且当 title 能力挂载时携带已定稿的标题（键缺失意味着该行被丢弃或从未写入）——以零 I/O 直接返回。否则网关经由 projection cache 的 `coldSnapshot` 阶梯读取：缓存行加上存储日志尾部，由每个已注册单元（`sessionListMetadata` 与基于日志的 `title`）重新折叠并 fail-soft 写回，下一次列表即取零 I/O 档；每个冷 Session 一生只读一次，成本有界。缓存的 `blank: true` 和 cache miss 永远不能证明当前日志为空，heal 读取不可用时降级为 `blank: false`，让 Session 保持可见——只有权威读取才能隐藏它。

`updatedAt` 取 `createdAt` 与 `lastPromptAt` 中较晚者。heal 读取提供精确 `lastPromptAt`；未被读取的 cache miss 或陈旧 checkpoint 只会让 Session 排得偏旧，而不会因无关的文件写入被提升。每次异步冷读取后，网关都会再次检查实时 store；若另一请求期间已恢复该 Session，则用已附加摘要替换冷结果。

## Alternatives considered

**信任缓存的 `blank: true`。** 拒绝，因为 projection cache 有意允许持久日志前进到 checkpoint 之后。首个 `turn/start` 之后若发生崩溃或 fail-soft 写入失败，真实对话就会被隐藏，客户端还可能把它复用为 New Session。

**每次列表都读取每一份冷日志。** 拒绝，因为列表延迟与 I/O 会随每次列表的已存对话总字节数增长。heal 档只读取尚未定稿的行，且其写回使该读取对每个 Session 一生只发生一次；`stateVersion` 升版（丢弃行）之后只会再 heal 一次。

**把空白状态与最近时间存入权威 persistence index。** 暂缓，因为 JSONL 的首行不可变，需要增加带有顺序写入要求的第二份持久工件；SQLite 则需要 schema 字段。更广泛的精确索引设计仍由[最后活动提案](../../proposed/architecture/2026-07-29-durable-last-activity-index.zh.md)负责。

**继续按 mtime 排序 JSONL。** 拒绝，因为 mtime 记录包括拾起边界在内的每一次工件写入，而非最近真人 prompt；其错误方向会把未经操作的 Session 提升到列表开头。

## Consequences

冷空白 Session 经一次 heal 读取后即可被隐藏且不依赖 projection cache 是否存在，陈旧 cache 也无法隐藏已存的 `turn/start`。在他处诞生（尚无持久行）的冷行——正是没有 cwd basename 可回退的 ungrouped free-Session 情形——携带日志折叠出的标题，而不是裸 session id。

heal 读取不可用与最近时间缺失都向“保持可见、排序偏旧”降级：UI 可能多显示一条空记录，或把 Session 排得偏低，但不会隐藏真实对话，也不会因为单纯打开而把会话提升到前面。

网关自有投影是网关 fiber 的 effect；卸载网关会移除该 key。单元覆盖固定了定稿行零 I/O 返回、heal 读取的标题与最近时间折叠、拒绝陈旧 true、不可用读取降级、无 cache seam 时的可见性、实时附加竞态、真人 prompt 最近时间和 fiber 销毁。无密钥 Web snapshot 会启动发行版的压缩 JSONL 组合，在没有 cache row 的情况下播种一份冷空白工件，并验证侧栏不展示它。
