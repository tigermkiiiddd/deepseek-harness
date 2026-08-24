# Agent Note: Web member parity — ACP members as first-class sessions in the session domain

Status: implemented

> **Superseded (2026-08-25):** the hide/refuse-based member gating here is replaced by full capability projection with real implementations for every surface — see [ACP full self-encapsulation](2026-08-25-acp-full-self-encapsulation.md). Kept for decision history.

English | [中文](2026-08-24-web-member-parity-integration.zh.md)

## Problem

Member topics surface in the Web UI as first-class sessions (`member:<memberId>:<topicId>`), but most of the session-domain surface around them was broken or misleading: the model selector had no member path, image prompts were refused with a dead-end error, re-run failed on click, fork and rename offered dialogs that always failed, queue updates answered with a wrong `queue-item-not-found`, and search/export failures were undocumented. The user's standard for members is a peer agent: every session-domain surface either works for a member or is visibly absent — never a button that exists but must fail when clicked.

## Decision

Parity is enforced at the host wire first, then the client hides what has no inverse. No public wire schema changed; everything rides existing methods and one internal team-service seam.

- **Model selection (W1).** `session.models` for a member id synthesizes a routable directory from the member's own `session/setSessionConfigOption` catalog (`current` = the cached option value, one group named after the member title); no options answers `model-unavailable`. `session.selectModel` validates the requested value against that catalog — an unoffered model is refused before it crosses the wire — then delegates to `team.setConfig`, so the member's own selection remains authoritative.
- **Image prompts (W2).** `packages/team/team` gains `promptContent(sessionId, content: MemberPromptBlock[])` (ACP wire blocks; `prompt(text)` now delegates to it). The host `session.prompt` member branch admits image parts through the same `admitEncodedImages` gate as the main path — an over-limit batch is refused before any bytes leave — then builds one block list per protocol: ACP `{type:'image', data, mimeType}` for the member process and core `{type:'image', attachment: ref}` for the minted `user/message`, so the Web transcript renders the admitted image. Because a member topic has no host log to authorize reads against, the admission itself is the authorization: the minted reference is recorded per virtual session for the process lifetime, and `session.attachment` for a member id serves exactly those admitted images (an unadmitted id answers `attachment-error` with `ATTACHMENT_NOT_ADMITTED`). The reverse translator mints user messages carrying attachment references and only deduplicates an echoed user message when it carries no images.
- **Re-run (W3).** A member topic cannot truncate its own log, so `session.rerun` accepts as a no-op: the client's follow-up prompt (its standing flow after an accepted rerun) opens a new turn on the same topic — that is the re-run. Fork has no ACP inverse in the dsh bridge and stays rejected; the client hides the branch action on member sessions (`TurnTailNodeView` omits `onBranch`, session row menus drop rename/fork and keep archive, which only touches the local registry).
- **Queue/steer (W4).** `session.updateQueue` for a member id refuses with an explicit "not supported" error instead of masquerading as `queue-item-not-found`; members have no local agent inbox, so the queue surface stays empty and steer-by-Enter is refused by the prompt branch with its own clear message.
- **Known limits (W6/W7).** The apiproxy README now records that member sessions stay out of `session.search` (the query service indexes host logs, which members do not have) and that export answers 400; the team README records that members cannot ask free-form questions — ACP has no question primitive, and `requestPermission` (served as an approval) is their only interactive channel.

## Alternatives considered

**Extend the public wire API with member-specific methods.** Rejected: every surface above maps onto an existing method's member branch; adding `member.*` session-domain methods would duplicate the contract clients already speak and split the host's single source of truth for models, prompts, and actions.

**Client-side member detection everywhere (UI-only gating).** Rejected as the primary enforcement: a client check is bypassable and leaves the wire answering with misleading errors. The host branches are the decision; the UI hiding is the affordance layer on top.

**Truncate-and-rebuild re-run through ACP.** Rejected: the dsh ACP bridge implements no log-truncation or context-rewrite primitive, and inventing one would make the harness own member history it does not store. A new turn on the same topic is the honest semantic.

## Testing

- `packages/team/team`: `promptContent` carries image blocks across the real ACP wire (mock agent echoes the received block types) and rejects blank text; the reverse translator mints user messages with attachment references and keeps an echoed image-bearing user message.
- `packages/host/apiproxy` (`api-proxy-team.spec.ts`, real subprocess mock agent): member model directory synthesis, select-and-reread, unoffered-model refusal; a member prompt with an admitted image forwards to the agent (echoed block types) and mints the attachment reference into the user message; an over-limit image batch is refused before persistence; the admitted image is served back through `session.attachment` while an unadmitted id is refused; fork still rejected while rerun accepts; queue updates refuse loud.
- `packages/client`: the branch action is absent on member sessions (chat view), rename/fork leave the session row menu while archive stays (workspace rows); both suites feed realistic props and assert user-visible behavior.

## Consequences

A member conversation now behaves like a peer agent's: text and images in, model choice from the member's own catalog, re-send as a new turn, permission prompts answered through the approval flow — and every surface without an ACP inverse (fork, rename, queue edits, search, export, free-form questions) is either hidden or refused with a message that says why. The cost is one more team-service seam (`promptContent`) and the standing obligation to keep the synthesized model directory in step with the member's `session/config_option_update` notifications — a stale catalog would advertise models the member no longer serves.

This note extends the [ACP virtual team](2026-08-16-acp-virtual-team.md) (member lifecycle and topic chat; its "no streaming in the panel yet" consequence covers the ui-team roster panel, not this session-domain bridge, which streams through the reverse translator) and the [member model and provider configuration](2026-08-23-acp-member-model-and-provider-config.md) seam this note's model bridge reads from.
