# Agent Note: vLLM thinking-token budgets

Status: implemented

English | [中文](2026-08-23-vllm-thinking-token-budget.zh.md)

## Problem

Some OpenAI-compatible vLLM reasoning models can spend their entire response allowance inside a reasoning block. Harness exposed total output caps and provider reasoning levels, but pi-ai's common stream options did not expose vLLM's separate `thinking_token_budget` request field. A deployment therefore could not place a hard ceiling on reasoning without patching requests outside the adapter.

## Decision

`@deepseek-ai/dsh-llm-pi-ai` accepts `thinkingTokenBudget` on a model entry or model override whose resolved API is `openai-completions`. The adapter injects it as `thinking_token_budget` through pi-ai's payload hook after the protocol request is constructed.

The configured value is a positive safe integer independent of the model's `maxTokens`. Harness treats `thinkingTokenBudget` as the reasoning allowance and `maxTokens` as the visible-output allowance, so the values may be equal. The payload transform adds both allowances into pi-ai's `max_completion_tokens` or `max_tokens` total and also sends `thinking_token_budget` separately. The budget remains separate from `thinkingBudgets`, which maps reasoning levels for providers whose native protocol already represents thinking as token budgets.

## Consequences

- vLLM deployments can bound reasoning while configuring the final answer's visible-output allowance separately.
- The extension is deliberately unavailable to other APIs; a profile naming it there fails at configuration resolution instead of silently dropping the field.
- The budget applies to every request for that model, including auxiliary compaction calls, without consuming or constraining their visible-output allowance.
- Unit tests pin configuration validation, exact wire spelling, addition into the protocol's total completion cap, the normal visible-output default, and equal reasoning/output allowances on one request.

## Alternatives considered

- **Treat `thinkingBudgets` as the vLLM cap.** Rejected: that field maps named reasoning levels into pi-ai's provider-native option, while vLLM expects one independent top-level request field.
- **Add the field to the provider profile.** Rejected: one route can serve models with different reasoning behavior and output capacities, so validation and ownership belong to the exact model.
- **Patch pi-ai or send HTTP directly.** Rejected: pi-ai already offers a supported payload transformation hook, which keeps protocol construction and stream handling in one adapter without vendoring a dependency.
