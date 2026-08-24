# Agent Note: ACP full self-encapsulation — the bridge serves the whole harness capability surface

Status: implemented

English | [中文](2026-08-25-acp-full-self-encapsulation.zh.md)

## Problem

The ACP bridge exposed a thin slice (prompt, config-option model selector), so member capabilities had to be faked or refused on the host: virtual-session replay synthesis for history, an admitted-image registry for reads, blanket "not supported" errors for rename/fork/queue/rerun, and a model catalog narrowed to one provider route — which is why member model selection was impossible from the Web UI.

## Decision

The bridge now projects the FULL harness capability surface over ACP, and the host consumes only negotiated protocol capability. Differences live below the seam (in the member process), never as refusals or frontend branches:

- **Model catalog** (`27284ccb64`): all registered llm routes advertise as one selector with composite `provider/model` values; decode by whole-string match against enumerated entries (slash-safe); selection rewrites both provider and model — cross-provider switching works. Advertisement no longer requires a preset selection.
- **Extension transport**: native ACP `extMethod`, advertised via `agentCapabilities._meta.dsh.extensions[]`. Implemented: `dsh/session/historyPage|rename|queue|state|compact|search|export|rerun` and `dsh/attachment/get`. Native surfaces used directly: `unstable_forkSession`, `listSessions`, `setSessionConfigOption`, providers.
- **Rerun** (`9f52aabdfd`): live agents reseed in place (`keepSeqs` = last completed turn strictly before the anchor, extended to the next turn/start or inbox splice — host rules verbatim); cold topics truncate durably.
- **Questions** (`ae69328b5c`, `dbaa644a2b`): the bridge registers as the member's user-questions provider and forwards batches over the reverse extension channel `dsh/user/question`; the team connection maps them onto the SHARED mux `question/requested|resolved` frames, so the existing web question panel answers member asks unchanged. Unbound or unsubscribed batches decline soft (empty answers).
- **Host consumption** (`5770f13568`, `910950080e`): rename/fork/queue route through the extensions; fork broadcasts the new topic row; warm-cache history reads page the persisted log directly instead of replaying; rerun stays resend-as-new-turn until virtual-seq↔member-log index alignment exists (the only deferred mapping).
- **Seeding** (`cb088226a6`): per-artifact idempotency — each of settings/credentials/preset backfills when its own copy is missing, so legacy partial homes repair at boot without clobbering member writes.
- **Kept intentionally**: `memberAdmittedImages` is not a duplicate store — admission saves bytes into the HOST attachment store (content-addressed ids match the member's), and the map is the authorization record for reads, since member topics have no host log to authorize against.

## Consequences

Every session-domain operation has a real implementation for members; the client needs zero member knowledge for actions. Remaining string parsing (agent-scoped tree grouping) is routing presentation, not behavior gating. Known pre-existing failures elsewhere (`full-fidelity.spec` negotiation/ordering) were fixed in passing (`9437eb1f12`) — the acp suite runs 127/127 green.

Supersedes the refusal-based posture recorded in [ACP member model and provider configuration](2026-08-23-acp-member-model-and-provider-config.md) and the hide-based posture in [Web member parity integration](2026-08-24-web-member-parity-integration.md).
