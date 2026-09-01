# Agent Note: Rerun runs the rebuilt session on the latest model selection

Status: implemented

English | [中文](2026-08-29-rerun-runs-on-latest-model-selection.zh.md)

## Problem

In-place rerun rebuilt the live agent from the kept log prefix, and the rebuilt session's model selection was derived on the next read from that prefix's last logged `request/header`. A selection the user had made before the rerun lived only in the process-local selection ref — keyed by the old agent object, so the reseed dropped it — and in the saved deployment default, which the selection resolution only reaches for a session with no logged header. The user's pick therefore silently reverted to the cut version's model. Because one model id can be served by several routes (official DeepSeek and the opencode-go gateway both serve `deepseek-v4-flash`), the revert crossed providers invisibly: every surface displayed the model name only, and the failure surfaced as the official endpoint's quota error rather than any route indication. The rerun handler even passed `agentOptions: agentOptions()` into `ctx.agents.reseed` intending to seed the current default, but request assembly always restores the kept prefix's header first, so that value could never reach a request — dead code contradicting its own intent.

## Decision

Rerun keeps the user's latest selection. The Web gateway captures the selection before the rebuild — the one made in this process, else the saved default — and installs it as the rebuilt session's picked selection immediately after `ctx.agents.reseed` publishes, before the queued follow-up turn assembles. The cut version's logged model is never restored into the selection; the next request goes out under the latest pick and logs a `request/header` change for it. The `session.rerun` contract documents this. The ACP member bridge does the same for `dsh/session/rerun`: the rebuilt topic carries its current `modelRef` selection and re-pins the advertised selector to that composite value instead of the freshly resolved initial one.

Display closes the invisibility: the composer trigger and the menu's Model cell render the provider group name beside the model name (`Provider · Model`), and the `/model` popup rows already did. A same-named model on two routes now reads apart everywhere the selection is echoed. The model pane additionally pins a `Recent` section above the provider groups — the five most recently selected models, most recent first, each labeled `Provider · Model` — recorded browser-locally through the shared directory funnel both entries submit through, so the route a session serves is one glance away instead of a scroll through grouped catalogs.

## Alternatives considered

- **Restoring the cut version's model, as before** — loses on user intent: rerun is an explicit redo, and the user who switched routes expects the redo to run on the route they chose; silently replaying a turn on the official endpoint after they moved to a gateway spends quota they did not agree to.
- **Leaving the selection to the natural fallback tiers** (process pick, then logged header, then default) — loses because the rebuild always destroys the first tier, which is exactly the tier that carries the latest choice; the precedence exists for reads, not for a lifecycle that recreates the ref.
- **A provider-only warning toast after rerun** — treats the symptom: with the selection carried and the provider displayed, nothing reverts, so there is nothing to warn about.

## Consequences

A rerun after a mid-session model switch runs the follow-up turn on the switched route; the durable log keeps the version history, so the removed behavior (deriving from the kept header) remains reconstructable for inspection. Sessions whose selection was never switched keep running on their logged model, because their latest pick and the logged model agree. The gateway's `agentOptions` passed to `reseed` remains as the no-pick fallback seed and is now consistent with the installed selection. Cold reruns (persisted-but-not-live sessions) still truncate only; their next resume reads the kept prefix as before, since no live selection exists to carry.

## Testing

`dsh-host-apiproxy` rerun specs cover the live rerun keeping a mid-session pick over a kept old-route header, and the no-pick rerun falling back to the saved default rather than the kept header; `dsh-acp` config-option specs cover the member topic keeping its switched composite route across `dsh/session/rerun`; `dsh-client-ui-model-selection` covers the trigger labeling a two-route same-named model with its provider group, and the recency section's ordering, provider-suffixed rows, five-entry cap, raw-id fallback for dropped picks, and filter yielding.
