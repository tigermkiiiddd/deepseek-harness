# Agent Note: Self-cognition entry and source-level self-development

Status: implemented

[English](2026-08-15-self-cognition-entry.md) | 中文

## Problem

harness 只教给 agent 一条自我扩展路径:动态 Cordis 工具集(`@deepseek-ai/dsh-tool-cordis` 加 `cordis-plugin-development` skill),而其定义性特征就是一切产物都是进程内的、重启即失。提示词声称动态插件只是「可用机制之一」,但另一套机制——编辑 harness 自己的源码 checkout——从未在模型可见的任何地方被文档化:没有提示段、没有 skill、没有工具。`harness:source` 段也只在 Web bundle 的 `surfaceContext` 下给出一个路径,不含任何工作流。

可预期的失败已经在实践中出现:一个 agent 被要求自我认知时,即兴拼出了一个孤儿包(`tool-selfops`),硬编码部署值、没有挂载点、没有测试、没有 README——不是模型粗心,而是没有任何指引告诉它「正确」长什么样。与此同时,想要永久能力的用户拿到的是临时插件,想要快速试验的用户却可能去改源码,因为没有任何东西在两条路之间做路由。

## Decision

`cordis` agent preset——本来就是「开发 harness 自身」的组合——获得一个源码级自开发入口,由三部分组成。

**自我认知插件**([`@deepseek-ai/dsh-tool-self-cognition`](../../../../packages/extensions/tool-self-cognition/README.zh.md))。`harness:self-cognition` 提示段(order `-97`)告诉 agent 它运行在一个源码 checkout 上(插入绝对路径),可以通过编辑它迭代自身,改动在下次进程启动时生效——绝不热加载。探测不到 checkout 时(安装版 profile),提示段如实说明,而不是宣传一条不存在的路径。只读工具 `self_cognition` 每次调用重新读取活体状态:checkout 根(从模块 URL 逐级向上找第一个同时含 `pnpm-workspace.yaml` + `AGENTS.md` + `packages/` 的目录)、会话的 preset id 及其经 `agentPresets.readEntries` 扁平化的插件条目、以及每个非 group Loader 条目的启用状态和 fiber 相位。不硬编码任何部署值,一切来自活体服务。

**`self-development` skill**(`apps/cli/config/agent-presets/cordis/skills/self-development/SKILL.md`)。源码编辑工作流:先用 `self_cognition` 确认 checkout,读 `AGENTS.md` 与 `docs/architecture.md`,按文档化扩展点设计插件,按 `docs/cookbook/adding-a-package.md` / `adding-a-tool.md` 实现,经 preset 的 `cordis.yml` 和解析 manifest 挂载,用最小检查集验证,最后补齐双语 README 和 Agent Note。它明确写出:源码改动在下次进程启动生效,绝不允许声称改动在当前会话已生效。

**显式两路径路由。** `tool-cordis` 的系统提示现在写明动态插件不是永久能力的归宿,并在会话报告有 checkout 时指向 `self-development`;`cordis-plugin-development` 开头加了按生命周期路由的表;新的提示段和 skill 携带反向规则(一次性需求不得动 checkout)。每条路径都指明另一条,agent 做选择而不是即兴发挥。

即兴产生的 `tool-selfops` 包在同一变更中删除;它从未被 git 跟踪、从未被挂载,而它硬编码的 `expectedConfigNote` 正是这个入口要防止的失败模式。

## Alternatives considered

- **运行时热加载自开发**——让 agent 在活体进程里替换自己的包。否决:它把自我修改绑死在运行时最脆弱的生命周期机制上,收益甚微;重启很便宜,且动态工具集已覆盖进程内场景。「改源码、重启、验证」的对外契约也正是仓库所有检查(typecheck、build、snapshot)既有的假设。
- **挂在 `standard`(或每个)preset**——否决:不在开发 harness 的 agent 要为一个永远不该用的能力承担常驻提示和工具成本,而且告诉每个写代码的 agent 它可以重写自己的运行时是在邀请范围蔓延。`cordis` preset 本就是这类工作的 opt-in 组合。
- **新建专门的 `self-dev` preset**——因重复而否决:`cordis` preset 已经携带动态工具集和开发 skill,分叉会漂移。
- **修复 `tool-selfops` 而不是替换**——否决:它的设计是带编造值的 settings/配置读取器,不是组成报告器;没有任何值得保留的东西,且从未被挂载或跟踪。
- **只做提示段、不做工具**——否决:静态提示段回答不了「我现在由什么组成」(preset 条目、fiber 状态),而把活体事实烤进提示词会以过期的方式违背 model-visible ⟺ logged 规则的精神。

## Consequences

`cordis` preset 里的 agent 现在有了一条文档化、带验证的路径,从「给自己加能力」走到一个挂载好、测过的包——以及一条何时不该用它的显式规则。代价是仅在该 preset 里常驻一段提示和一个工具 schema,以及提示段文本或路由指引每次变化时的快照波动(模型可见文本)。源码 checkout 探测信任文件系统标记(`pnpm-workspace.yaml` + `AGENTS.md` + `packages/`);一个刻意模仿全部三件的外部目录树会被误读为 harness checkout,这被接受为同机信任假设。路由编辑触及 `tool-cordis` 的模型可见提示,因此动态插件指引和源码路径必须随任一方演化保持一致。
