# Agent Note: ACP member model and provider configuration

Status: implemented

> **Superseded (2026-08-25):** the refusal/hide-based posture here is replaced by full capability projection — see [ACP full self-encapsulation](2026-08-25-acp-full-self-encapsulation.md). Kept for decision history.

English | [中文](2026-08-23-acp-member-model-and-provider-config.zh.md)

## Problem

The ACP virtual team gives each member its own persona, sessions, and model, but the model-facing `member_sessions` / `member_chat` tools could only list topics and chat — they could not see or change the member's model or provider configuration. The user wanted to configure ACP members (grok-style) through the tools, not by hand-editing config files. The harness holds only the stdio pipes to the member; the member's model and provider routing live in the member process, so the harness has no file it owns — the only seam is the ACP protocol.

## Decision

Model and provider configuration go through the ACP wire, never a hand-edited file. `packages/team/team` gains four `team` service methods that speak ACP to the member: `getConfig` and `setConfig` over session config options, and `listProviders` and `setProvider` over provider configuration. `packages/team/tool-team` exposes `member_model` (`action: "get"` / `"set"`) and `member_provider` (`action: "list"` / `"set"`); `member_sessions` gains a `model` column.

Session config options are cached per session id from the options a member returns with `session/new` and `session/load`, plus any `session/config_option_update` notifications. `getConfig` derives a resolved snapshot (options plus a model shortcut) from that cache; `setConfig` writes one option through `session/set_config_option` and refreshes the cache. The model shortcut picks the option whose UX category or id is `"model"`. There is no ACP capability flag for config options — the only signal is the options returned with the session, so a member that advertises none yields no cache and `getConfig` throws.

Provider configuration is gated on the `providers` capability a member advertises in `initialize` (`AgentCapabilities.providers`). `listProviders` and `setProvider` report "does not support provider configuration" when the capability is absent, unlike config options, which carry no flag. The harness stores no secrets: the agent keeps the provider routing config on its own side, so `setProvider` never persists credentials.

The tools catch and report rather than throw: a member without config options, or without the `providers` capability, returns a one-line "does not support" message, so the model sees a clear signal instead of a crash.

## Alternatives considered

**Hand-edit the member's config file.** Rejected by the user explicitly: the harness holds only the stdio pipes, so there is no file it owns — the member process owns its model and provider routing, and the ACP wire is the only seam.

**A harness-side model/provider registry.** Rejected: the model and provider routing live in the member process, not the harness; a registry the harness controls would diverge from what the member actually serves and would persist credentials the harness is not the right owner of.

## Testing

Real-subprocess combination tests pin both seams through the ACP wire. `member_model get` reads the cached model and its selectable value ids when the member advertises config options, and reports "no session config" when it advertises none; `member_model set` writes a value id and returns the updated snapshot. `member_provider list` returns the advertised providers, and reports "does not support provider configuration" when the capability is absent; `member_provider set` configures one and validates its string headers. Service-level tests pin the same paths on `getConfig` / `setConfig` / `listProviders` / `setProvider`, including the provider capability gate.

## Consequences

The model can now see and change a member's model and provider configuration through the same tools it chats with, without leaving the harness or touching a file. The cost is a per-session option cache keyed by session id and the standing obligation to keep `getConfig`'s cache in step with `session/config_option_update` — a missed update would leave a stale model or option set.

This note extends the [ACP virtual team](2026-08-16-acp-virtual-team.md), which owns the member lifecycle and topic chat. The Web session-domain bridge that reads this seam for model selection is recorded in the [Web member parity integration](2026-08-24-web-member-parity-integration.md).
