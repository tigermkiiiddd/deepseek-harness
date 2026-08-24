# Agent Note: vLLM 思考 token 预算

Status: implemented

[English](2026-08-23-vllm-thinking-token-budget.md) | 中文

## 问题

部分兼容 OpenAI 协议的 vLLM 推理模型会把整份响应额度都耗在思考块内。Harness 已提供总输出上限与提供方推理档位，但 pi-ai 的通用流选项没有公开 vLLM 独立的 `thinking_token_budget` 请求字段。因此，部署无法在适配器内为思考设硬上限，只能在外部修改请求。

## 决策

`@deepseek-ai/dsh-llm-pi-ai` 在模型条目或模型覆盖上接受 `thinkingTokenBudget`，前提是该模型解析后的 API 为 `openai-completions`。协议请求构造完成后，适配器通过 pi-ai 的 payload 钩子把它以 `thinking_token_budget` 注入请求。

配置值必须是正的安全整数，并独立于模型的 `maxTokens`。Harness 把 `thinkingTokenBudget` 视为思考额度，把 `maxTokens` 视为可见正文额度，因此两者可以相等。payload 转换会把两份额度相加后写入 pi-ai 的 `max_completion_tokens` 或 `max_tokens` 总上限，同时单独发送 `thinking_token_budget`。该预算继续与 `thinkingBudgets` 分离；后者为原生协议已经用 token 预算表示思考的提供方映射推理档位。

## 影响

- vLLM 部署可以限制思考，同时单独配置最终答案的可见正文额度。
- 该扩展刻意不适用于其他 API；若 profile 在其他 API 上声明它，会在配置解析时失败，而不是静默丢弃字段。
- 预算适用于该模型的每次请求，包括内部压缩调用，但不会占用或约束其可见正文额度。
- 单元测试钉住配置校验、准确的协议字段名、加入协议总 completion 上限的换算、正常的可见正文默认值，以及同一请求中相等的思考与正文额度。

## 备选考虑

- **把 `thinkingBudgets` 当作 vLLM 上限。** 已否决：该字段把具名推理档位映射到 pi-ai 的提供方原生选项，而 vLLM 需要一个独立的顶层请求字段。
- **把字段放在提供方 profile 上。** 已否决：一条路由可以承载思考行为与输出容量不同的多个模型，因此校验和归属应落在确切模型上。
- **修改 pi-ai 或直接发送 HTTP。** 已否决：pi-ai 已提供受支持的 payload 转换钩子，可以继续由同一适配器负责协议构造与流处理，无需维护依赖分叉。
