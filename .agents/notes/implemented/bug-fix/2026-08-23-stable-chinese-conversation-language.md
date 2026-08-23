# Agent Note: Keep the default conversation language stable

Status: implemented

English | [中文](2026-08-23-stable-chinese-conversation-language.zh.md)

## Problem

The shipped personas told the model to follow the user's language and switch when the user switched, but did not define which messages counted as evidence. English system sections, tool descriptions and results, code, logs, subagent reports, and prior assistant replies could therefore outweigh the user's Chinese messages as a conversation grew. The `minimal` preset had no language policy at all. Compaction amplified the same ambiguity because its English checkpoint landed as a synthesized user message in the durable conversation prefix.

## Decision

The `standard`, `code`, and `cordis` agent personas, the `minimal` complete persona, and the Web and headless deployment personas default all user-facing communication to Simplified Chinese. Only an explicit language request authored by the user changes that default. System or developer text, generated summaries and checkpoints, tool output, code, logs, file or quoted content, subagent messages, prior assistant replies, and short confirmations do not change it. Code, identifiers, paths, commands, error literals, proper nouns, and explicitly requested artifact languages retain the language their task requires.

The rule remains inside each existing persona. The composition adds no separate late prompt section or repeated runtime-context reminder. A scoped persona still shadows the deployment persona, while `minimal` embeds the rule in its `complete: true` text because complete prompts suppress every companion section.

Both shipped compaction summarizers follow the active system prompt's conversation-language policy plus any explicit user preference and record the resulting language under `Critical Context`. Only when neither establishes a language do they fall back to the user's latest substantive natural-language request. They preserve exact technical literals and the existing English Markdown headings. The trailing instruction remains the only new input after the byte-identical routed-request prefix, so provider prefix-cache reuse is unchanged.

## Alternatives considered

- **Continue following the apparent language of the conversation** — rejected because generated and technical English dominates many long coding sessions without representing a user choice.
- **Append a separate language-policy section late in every assembled prompt** — rejected because it repeats policy as a distinct prompt contribution, adds noise, and cannot survive a `complete: true` persona without another exception.
- **Keep every compaction checkpoint in English** — rejected despite its consistent engineering register because the checkpoint is delivered as a synthesized user message and can pull later user-facing replies into English. Exact technical literals remain protected without normalizing the narrative language.
- **Validate and regenerate non-Chinese assistant output** — rejected because another model call adds latency and cost, and an output-language detector can reject valid code, quoted text, or requested foreign-language artifacts.

## Consequences

- Long conversations, tool-heavy turns, compaction, resume, and model changes retain Simplified Chinese unless the user explicitly asks otherwise.
- Checkpoints may carry non-English narrative into an otherwise English technical prefix when the user selected that language; this preserves conversation intent at the cost of a single normalized engineering register.
- The fixed policy adds text to the existing persona but creates no new prompt section or dynamic context event, so its rendered prefix is stable after the first request.
- The real Web `minimal` snapshot pins the complete persona, shipped-composition coverage pins all scoped personas, and compaction unit plus real-loop coverage pins the final summarization instruction. The direct summarization call still emits no `assistant/chunk` event, so no transcript snapshot can observe its instruction.
