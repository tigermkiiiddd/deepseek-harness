# Agent Note: 把区域事实折入压缩摘要

Status: implemented

[English](2026-08-23-region-facts-into-compaction-summaries.md) | 中文

## 问题

压缩摘要要替换一段被遮蔽的历史,并让另一份模型无需任何折损即可续接。摘要是经辅助 `ctx.llm.stream()` 调用、在一个重放的消息前缀上产出的,所以它能知道的一切均来自被重放的 assistant、user、tool 消息。模型没有明确叙述的任何内容都要由模型重新发现:区域里命中了哪些文件、每个文件为什么命中,只能逐条重读该范围的 `tool/call` 才从日志重构,而模型常常复述甚至编造文件上下文;最近呈现过的 plan 也只在模型愿意带上那个 `exit_plan_mode` 参数时才存在。

## 决策

`@deepseek-ai/dsh-compaction-structured` 从日志表层直接计算区域事实,并把它作为权威引导在压缩指令之前注入,让模型只浓缩周围的对话叙述,而不复述或重新推导它们。这个设计建立在压缩能力 seam [`2026-06-18-compaction-capability-seam`](../2026-06-18-compaction-capability-seam.md) 之上,但不改动 `surface` 或 `compaction/*` 事件词汇。

### 区域事实采集

`region.ts` 在 `buildSummarizationInput` 内、对遮蔽的 surface-node seqs 计算 `RegionFacts`,并仅在存在时才把它们展开进 `SummarizationInput.facts`。

- **按首现顺序的文件。** 从区域的第一个到最后一个遮蔽 seq 扫描 `session.events`(`extractRegionFacts` 的第一遍)。每个 `name` 为文件类工具的 `tool/call`——`read`、`write`、`edit`、`write_file`、`append_file`、`open_file`、`create_file`、`append`、`view`——产出一个文件。路径取自解析后参数的 `file_path`、`filePath` 或 `path`。同一文件在区域内只列一次;`seen` 集合按首现去重。
- **邻近解释。** 每个文件条目为 `<path>: <explanation>`。解释是位于该工具调用之前、且最接近的一条 `assistant/message` 的 assistant 文本,截断至 200 字符(`ADJACENT_EXPLANATION_LIMIT`)并以 `…` 标记。首次出现的那条保留它自己的解释。
- **计划,自包含折叠。** 当计划模式在区域末尾处于活动状态时,该区域内最后一条非空的 `exit_plan_mode` `plan` 参数会作为 `RegionFacts.plan` 被纳入。计划模式状态直接从 `plan/mode` 日志事件折叠读取,后到先算——不加载任何 `plan-mode` 服务。

当区域既无文件、也无计划时,`extractRegionFacts` 返回 `undefined`,于是什么都不注入,压缩指令与原 `compaction-basic` 后端逐字一致。

### 注入的指令

仅当 `input.facts` 存在时,`summarizer.ts` 会在 `COMPACTION_INSTRUCTION` 之后依次追加 `COMPACTION_FACTS_GUIDANCE`,再追加 `formatRegionFacts`:

> The following are harness-captured facts about the shadowed region. Treat them as authoritative:
> - Do not restate, verify, or re-derive them.
> - Do not request tools to confirm them.
> Condense only the surrounding conversation narrative.

文件段渲染 `## Files touched in the region (harness-guaranteed)`,每个文件一行 `- <path>: <explanation>`;计划段渲染 `## Active plan (harness-guaranteed)`,承载计划文本。这两段是模型可见的,并在包 README 的 Model Experience 中逐字钉住。

## 影响

- **模型可见行为发生变化。** 压缩指令获得了确定性的、由 harness 保证的段落。检查点里的 `## Files touched` 与 `## Active plan` 段由代码生成,而非模型生成,所以消费方能区分哪一段来自日志、哪一段来自模型。
- **不依赖 plan-mode 服务。** 区域事实自行折叠日志,所以压缩后端不依赖任何 plan-mode 服务;无论 plan mode 是否挂载,该功能都能工作。
- **边界。** 区域内重复的文件按首现去重;仅当计划模式在区域末尾处于活动状态时才纳入计划。解析 `exit_plan_mode` 参数失败(非法 JSON 视为不存在)时,由已有的参数解析器守卫跳过。
- **需验证。** Keyless 单测钉住首现顺序、按首现去重、无事实时的省略、200 字符截断、计划激活时的纳入,以及摘要器的折入。`compaction-basic` 一字未改,新后端实现同一份 `@deepseek-ai/dsh-compaction` 契约。

## 备选考虑

- **让模型自己列出命中文件与计划。** 已否决:摘要调用不带工具钩子,模型会编造文件列表,破坏续接保真度。日志是权威的,harness 直接交付它已经知道的内容。
- **把区域事实新增为会话事件。** 已否决:区域是在已日志化的 surface seqs 上计算的,从日志折叠无需新事件,也不需 bump `SESSION_FORMAT_VERSION`。
- **在消费方重新计算事实。** 已否决:摘要器拥有该指令、必须在模型调用之前注入,后端在 `SummarizationInput` 内部准备这些事实。
