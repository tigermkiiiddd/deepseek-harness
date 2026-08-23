# 改造压缩策略：独立新包 `compaction-structured`（整包复制 compaction-basic，改摘要层）+ plan-mode 落盘

[English](2026-08-23-改造压缩策略-独立新包-compaction-structured-整包复制-compaction-basic-改摘要层-plan-mode-落盘.md) | 中文

## 关键修正（采纳你两点）

- **不动 `compaction-basic`**（原压缩机制一字不改）。
- 新建**独立包** `@deepseek-ai/dsh-compaction-structured`，把 `compaction-basic` **整包复制**出来，只在摘要层改动。
- profile 一行替换：`compaction-basic` → `compaction-structured`，老的停掉、新的选中；回滚=把那行切回去，原始永远在。
- plan-mode 落盘是单独的小改，不属于压缩新包。

## 目标与验收标准

压缩输出由三块拼成一个 checkpoint，并分块标明来源：

1. **代码块① 文件清单**：被压缩区域里所有被 `read` 过、被 `write`/`edit` 过的文件，各带一段邻近解释。
2. **代码块② 当前 plan**：只要 plan 模式 active，checkpoint 里必然含当前 plan 完整内容（不依赖模型自愿）。
3. **LLM 块**：对话正文/推理/细节的压缩叙述。

验收（keyless 可断言，除"LLM 调用"本身）：

- 文件清单覆盖 read/write/edit，带邻近文本，去重、顺序稳定、非法 JSON 跳过。
- plan active 时 checkpoint 必含 `<plan>` 块且为完整内容。
- 输出为一条 `user/message`，内部固定标签分块，可区分"代码出的"与"LLM 出的"。
- `compaction-basic` 源码 diff 为空。
- plan-mode 每次呈现/修订都写盘（不只是批准）。

## 改动 1：新独立包 `compaction-structured`（复制 + 改摘要）

在 `packages/compaction/compaction-structured/` 下新建，**复制** `compaction-basic` 全部源：

- `index.ts`：引擎（`static inject=['llm','tokenMeter','sessions']`）、`compactIfNeeded`/`compactRegion`/`compactNow`、`_registerAutomaticCompaction` 压力监听、溢出恢复、`regionDependencies`——原样复制，行为与现在一致。
- `region.ts`：`selectCompactableRange`、`compactSurfaceRegion` 事务/锁/稳定校验、`commitCompactionBody`、`frameSummary` 外层——原样复制；**仅 `buildSummarizationInput` 附加 `facts`**。
- `summarizer.ts`：原 `summarizeWithLlm`、`COMPACTION_INSTRUCTION`、`frameSummary` 整包复制；**仅改写摘要组装**为"代码块 + LLM 正文 + plan 注入"。
- `config.ts` / `types.ts` / `invariant.ts`：整包复制。

新包实现 `@deepseek-ai/dsh-compaction` 的抽象 `CompactionEngine`，提供 `ctx.compaction`，与 `command-compact`、optional `toolResultPruner` 的对接方式和原包一致。

### 1.1 文件清单提取（新包 region.ts）

`buildSummarizationInput(session, shadowedSeqs)` 新增计算 `facts`：

- **区间**：定位 `session.events` 中 `shadowedSeqs[0]` 与 `shadowedSeqs[last]` 的日志下标，扫描其间。
- **文件**：命中 `tool/call` 且 `name ∈ {read, write, edit, append_file, open_file}`；`path` 取自 `JSON.parse(arguments).path`（缺省 `.filePath`/`.filename`）；按首现去重。
- **邻近解释**：每个文件取该 `tool/call` 之前最近一条 `assistant/message` 文本，截约 2 句/240 字符。
- 产物 `RegionFacts = { files:{path,explanation}[]; plan?:string }`（`types.ts` 加 `SummarizationInput.facts`）。

### 1.2 当前 plan 注入（新包，自包含）

- 扫描整个 `session.events` 取**最新** `tool/call`（`name==='exit_plan_mode'`），`plan = JSON.parse(arguments).plan`。
- active 判定自包含：读最近 `plan/mode` 事件（`foldPlanMode` 等价逻辑，不依赖 `plan-mode` 服务）。
- 仅 `active && plan` 时产出 `<plan>` 块。

### 1.3 摘要改写（新包 summarizer.ts）

`summarizeWithLlm` 改三段：

1. 输入：若 `facts` 有 `files`/`plan`，作为"harness 已捕获、以它为准、勿复述"放 `messages` 前部；压缩指令改为"只压缩对话叙述，文件清单与 plan 由 harness 保证"。
2. `ctx.llm.stream(messages)` 产出正文 `prose`。
3. 拼装 `summary = [ <plan>…</plan> | <files>\n- {path}: {说明}\n…\n</files> | {prose} ]`。

`commitCompactionBody`、`region.ts:374` 收缩校验不动（对拼装后整体生效）。

## 改动 2：plan-mode 落盘（独立小改，`plan-mode/src/index.ts`）

- `EXIT_PLAN_MODE` 的 `execute`：把"写文件"从"仅批准时"改为"每次调用即写"（与是否批准解耦），文件名沿用 `docs/plans/<date>-<slug>.md`，最新写入者为当前 plan。
- 保留批准分支的 `path` 回传（render 要显示）。
- 无 fs 能力仍跳过（与现在一致）。

## 装配 / 切换

- profile（如 `packages/bundle/base/cordis.patch.yml`、各 agent preset 的 `agent.cordis.yml`）：把 `compaction-basic` 那一行换成 `compaction-structured`。
- `command-compact`、`tool-result-pruner` 行不动（后端无关，跟随 `ctx.compaction`）。
- 保留 `compaction-basic` 供回滚：profile 切回该行即可。

## 边界与异常

- 无 `<plan>`（plan 未呈现）/ 无 `<files>`（无文件操作）→ 不出对应块。
- `JSON.parse` 非法 → 该次跳过，不阻断压缩。
- 注入 plan/代码块若使摘要不比被阴影内容小 → 由收缩校验拦截，回退到无注入行为，不丢压缩。

## 测试

- `compaction-structured`（keyless）：`extractRegionFacts`（read/write/edit 命中+邻近文本+去重+非法跳过）；拼装四种组合；active 门控。
- `plan-mode`（keyless）：每次呈现都写盘；多次修订取最新落盘。
- snapshot（需 key）：`examples/headless-agent/compaction.cordis.snapshot.yml` 摘要结构已变，需重录；补一条 plan 注入端到端复现。

## 影响面与代价

- `compaction-basic`、`surface.ts`、token-meter、SDK 事件面、`SESSION_FORMAT_VERSION` 均不改。
- 代价：整包复制引入约 1200 行重复，新包需与原包在行为上保持同步（用独立测试钉住，避免漂移）。
- 新包与 plan-mode **无服务耦合**（plan 从日志自包含读取）。

## 备选（一行，不展开提问）

若整包重复不可接受，可让新包只继承 `BasicCompactionEngine` 并重写 `summarize()`（共享原 region/事务逻辑，改动面小很多，原始仍一字不动）；代价是随原包演进耦合。当前按你"复制出来"的字面要求走整包复制；要更轻再改。

## 推荐执行顺序

1. 新包整包复制骨架（index/region/summarizer/config/types/invariant）+ 最小测试证明能跑通原行为。
2. plan-mode 落盘 + 其 keyless 测试。
3. 新包 region 附 facts（文件清单 + plan 注入）。
4. 新包 summarizer 改代码/LLM 拼装。
5. compaction keyless 单元（四种组合）+ snapshot 重录 + plan 注入端到端。
6. 同步新包 README；profile 切换并回归。
