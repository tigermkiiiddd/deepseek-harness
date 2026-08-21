# Agent Note: Model-initiated plan-mode entry

Status: implemented

English | [中文](2026-08-16-model-initiated-plan-mode-entry.zh.md)

## Problem

Plan-mode entry was human-only: `/plan` selected it, while the model had no entry tool and — because `plan:policy` renders nothing while inactive — no way to even know plan mode existed. In practice the agent almost never planned: it could not enter, could not suggest entering, and read "Use only in plan mode" on a tool it had no path to reach.

[Plan-specific collaboration state](../simplification/2026-07-22-plan-specific-collaboration-state.md) recorded "human-facing compositions own plan selection and review". That ownership is now split deliberately: **review stays human-owned; entry is shared with the model.**

## Decision

`dsh-plan-mode` registers a second always-present tool, `enter_plan_mode`, alongside `exit_plan_mode` — the catalog stays stable across transitions in both directions. Its execute path:

- requires a calling agent, like the exit tool;
- queues the entry through the same `pendingIntents` mechanism the exit tool uses (next accepted in-turn pre-step appends the `plan/mode` event), with `narrate: false` because the tool result already narrates the transition;
- is an idempotent no-op returning `{ entered: true, already: true }` while plan mode is active or entry is pending, so a cautious model never double-flips the log;
- refuses a delegated child agent (mirroring the user-questions caller guard): a child cannot open the exit review, so entering would trap it in plan mode;
- can override a queued exit within the same batch — the latest selection wins.

Discovery rides the tool descriptions: `enter_plan_mode` states when planning is warranted and names `exit_plan_mode` as the reviewed way out; the exit description names the entry tool. No prompt-section text changes, so the KV-cache profile is untouched.

## Alternatives considered

**Keep entry human-only and add a static prompt sentence suggesting `/plan`.** Rejected: the model still cannot act on its own judgment, and the suggestion depends on the user reading and typing a command — the observed behavior (agents never plan) would barely move.

**Let the model enter through `ctx.planMode.set()` directly with narration.** Rejected: `set()` narrates user selections ("The user switched this session to plan mode"), which would falsely attribute a model-initiated entry to the user; the direct `pendingIntents` queue keeps authorship honest.

**Let delegated children enter.** Rejected: the exit review is unavailable to them by design, so entry would strand them; they report the need to plan in their final result instead.

## Consequences

The model can enter plan mode on its own judgment and always knows the mode exists. Entry needs no approval because the exit review remains the human gate: an unapproved plan never turns into changes, and `/plan off` stays the direct human override. Costs: one more always-present schema per request and the partial reversal of the 2026-07-22 ownership sentence, recorded here.
