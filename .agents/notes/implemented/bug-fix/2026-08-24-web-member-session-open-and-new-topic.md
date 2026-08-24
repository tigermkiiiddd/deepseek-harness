# Agent Note: Web member sessions open, and New Session routes to the member

Status: implemented

English | [中文](2026-08-24-web-member-session-open-and-new-topic.zh.md)

## Problem

The Web UI's multi-agent support had two user-visible defects. Clicking a member node in the top bar could leave an empty conversation: the `member:<memberId>:<topicId>` select threw "unknown session" when the topic was newer than this client's list baseline, and the team controller swallowed that rejection into a silent lane error. And the New Session button always minted a main-instance session — with a member conversation current, clicking it bounced the view back to the main agent instead of starting another conversation with that member.

## Decision

Both fixes share one primitive: an open that re-baselines once before failing.

- `ISessions` and `SessionsPort` expose `refresh()`; the concrete `SessionRuntime.refresh` already existed, the faces simply did not publish it.
- `TeamController.openMember` resolves the topic (the latest one, or a fresh one through `team.newSession` when the member has none) and opens it through one helper: if the select throws because the id is missing from the list baseline, call `sessions.refresh()` once and retry; only a second miss surfaces an error to the lane store.
- `WorkspaceRuntime.startSession` checks first: when the current session is a member topic (the pure `memberSessionOwner` parse from host-apiproxy), it mints a fresh topic on that member through `team.newSession` and opens it with the same open-with-retry helper; otherwise the existing Workspace-targeting behavior runs unchanged. Both entry points — the sidebar button and the workspace "+" — become member-aware in one place, without cross-package imports: the runtime already owns the wire client and the id helpers.

The race this absorbs is real and orderable: the host's `team.newSession` handler broadcasts the topic's list row (`host/session-added`) alongside the RPC response, with no ordering guarantee between the two channels — a select immediately after resolution can legitimately miss the row. Re-baselining once stays deterministic because that handler confirmed the topic exists in the member store before it answered.

## Alternatives considered

**Fix only the open and leave New Session main-instance.** Rejected by the user: with that, clicking a member and then "new conversation" would silently switch agents — exactly the reported defect.

**Add an explicit per-member "new topic" button to the top bar instead of reusing New Session.** A plausible affordance, but it duplicates an action that is now correctly routed; fewer entry points is better while the lane matures. Revisit if the member lane grows its own composer.

## Testing

- runtime (`workspaces-service.client.spec.ts`): `startSession` routes to `team.newSession` and opens the new topic when a member session is current — with the list gaining the topic only after `newSession` settles, i.e. the production frame race; keeps the selection and warns on an RPC business error; warns when the re-baselined list still lacks the topic.
- ui-team (`team-store.client.spec.ts`): `openMember` re-baselines once when the open misses a newer-than-baseline topic, and surfaces the error when the retry still misses.

Web-only behavior: no model-visible transcript changes, so the client check ladder applies (`test:gui`, plus the replayed assembled-web suite) instead of snapshot fixtures.

## Consequences

New Session is now context-dependent: in a member conversation it means "another conversation with that member"; in a main-instance conversation it keeps its Workspace semantics. `refresh()` joins two public client faces — an explicit widening justified by these consumers, under the same rule that governs every other face change. A topic created while the member is offline still fails loud after one retry; no automatic re-creation loop was added.

This note extends the [ACP virtual team](../feature/2026-08-16-acp-virtual-team.md) (member lifecycle and topic chat) and the [Workspace UI product flow](../feature/2026-07-25-workspace-ui-product-flow.md) (the `startSession` slot action), which this change routes through.
