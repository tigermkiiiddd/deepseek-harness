# Agent Note: 模型自主进入 plan mode

Status: implemented

[English](2026-08-16-model-initiated-plan-mode-entry.md) | 中文

## Problem

plan mode 的进入此前只有人类通道：`/plan` 负责选择，而模型没有进入工具，并且——因为 `plan:policy` 在未激活时不渲染任何内容——连 plan mode 的存在都无法得知。实际表现就是 agent 几乎从不规划：它进不去、没法建议进入，只能读到一个写着"仅在 plan mode 中使用"却无法触及的工具。

[plan 专用协作状态](../simplification/2026-07-22-plan-specific-collaboration-state.zh.md) 记录了"plan 状态的选择与评审归面向人类的组合所有"。该所有权现在被刻意拆分：**评审仍归人类，进入与模型共享。**

## Decision

`dsh-plan-mode` 在 `exit_plan_mode` 之外注册第二个常驻工具 `enter_plan_mode`——工具目录在两个方向的转换中都保持稳定。其 execute 路径：

- 与退出工具一样要求调用方 agent；
- 通过与退出工具相同的 `pendingIntents` 机制排队进入（下一个被接受的轮内 pre-step 追加 `plan/mode` 事件），`narrate: false`，因为工具结果已经说明了这次转换；
- 在 plan mode 已激活或进入已排队时是幂等空操作，返回 `{ entered: true, already: true }`，谨慎的模型不会把日志翻转两次；
- 拒绝被委派的子级 agent（与 user-questions 的调用方守卫一致）：子级无法打开退出评审，让它进入等于把它困死在 plan mode 里；
- 在同一批次内可以覆盖一个已排队的退出——最新的选择生效。

发现性由工具描述承载：`enter_plan_mode` 说明何时适合规划并点名 `exit_plan_mode` 作为经评审的退出方式；退出工具的描述点名进入工具。提示词区段文本零改动，KV cache 侧写不受影响。

## Alternatives considered

**保持进入仅人类通道，加一句静态提示词建议 `/plan`。** 否决：模型仍然无法按自己的判断行动，且建议依赖用户读到并手动敲命令——观察到的行为（agent 从不规划）几乎不会改善。

**让模型直接通过 `ctx.planMode.set()` 进入并带叙述。** 否决：`set()` 的叙述措辞是用户选择（"The user switched this session to plan mode"），会把模型发起的进入错记到用户头上；直接走 `pendingIntents` 排队保持作者归属诚实。

**允许被委派的子级进入。** 否决：退出评审对子级按设计不可用，进入等于困死；子级应在最终结果里报告"需要规划"这件事。

## Consequences

模型可以按自己的判断进入 plan mode，并且始终知道这个模式存在。进入不需要审批，因为退出评审仍是人类闸门：未批准的 plan 永远不会变成改动，`/plan off` 仍是人类的直接覆盖手段。代价：每个请求多一个常驻 schema，以及 2026-07-22 那条所有权表述被部分反转——记录于此。
