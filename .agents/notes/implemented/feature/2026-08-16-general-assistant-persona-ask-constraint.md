# Agent Note: General-assistant persona and ask-only-when-decisive constraint

Status: implemented

English | [中文](2026-08-16-general-assistant-persona-ask-constraint.zh.md)

## Problem

A product session showed the intent-recognition failure this change targets: asked "帮我翻译 <one sentence>" (translate this sentence), the agent fixed on "content must be a missing document", asked for the content twice, globbed the workspace for `*.docx`/`*.pdf` files, and only after repeated user frustration considered that the sentence itself was the payload. Two prompt-level causes compounded: every product persona opened with "You are a coding agent", framing each request as repository work where content lives in files; and the `ask_user_question` description licensed asking for missing information with no counterweight, so asking cost nothing and the first wrong hypothesis was never revised against the user's follow-ups.

## Decision

Personas in the `standard`, `code`, and `cordis` agent presets and in the `web-app` and `headless` bundle patches now open with "You are a general-purpose assistant powered by the {{model}} model — especially strong at coding, but ready to help with any task", and add a second sentence: treat the user's whole message as the request — the text it contains may itself be the content to translate, summarize, or transform, so prefer that reading over assuming the content lives in a file the user never gave.

The `ask_user_question` description gains the missing when-not-to-use half: ask only when the answer would change what the agent does next, do not ask for information already present in the conversation, and first check whether the user's message itself is the content to operate on.

## Alternatives considered

**Add a dedicated "intent recognition" prompt section.** Rejected: intent recognition is not an action a model can be ordered to perform; it emerges from concrete behavioral constraints — infer before asking, re-read the latest user message, assign every token of the request a role. A section reading "understand the user's intent" is unenforceable prose.

**Fix only the web deployment's persona, where the failure was observed.** Rejected: the coding-only frame was identical across every product persona, so the same failure was reachable from each surface; one shared sentence keeps the fix symmetric and single-sourced in wording.

**Also rewrite the `examples/*` "coding assistant" personas.** Rejected for this change: those are demo leaves with recorded replay fixtures, not the product persona; they deliberately demonstrate authoring a persona, and their snapshots embed the recorded text.

## Consequences

Every product surface's system prompt changes by two sentences, and the ask tool's schema description grows — both ride the normal keyless golden updates (`apps/web` fresh-round-trip system prompt, `examples/acp-agent` tool-schemas). The change constrains the prompt, not the model: a model that never considers the self-referential reading can still fail, but the rules now name that reading as the preferred one and turn repeated clarifying questions into a rule violation instead of the default path.
