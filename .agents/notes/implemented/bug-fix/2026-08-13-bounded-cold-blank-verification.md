# Agent Note: Bound cold blank-session verification

Status: implemented

English | [中文](2026-08-13-bounded-cold-blank-verification.zh.md)

## Problem

The Web session tree hides blank Sessions and reuses the selected blank entry as New Session. Attached Sessions can derive blankness from their in-memory event log, but `session.list` normally avoids loading every cold log. Treating every materialized cold Session as non-blank exposes empty Sessions left by older versions. Treating a projection-cache `blank: true` as current can instead hide a real conversation after the log advances and the fail-soft cache remains stale.

The same cold list used the JSONL artifact mtime for `updatedAt`. Opening a Session appends `session/end-seed`, so a pickup with no human prompt refreshed mtime and promoted that Session above recently used conversations.

## Decision

`dsh-host-apiproxy` registers `sessionListMetadata`, a projection containing `blank` and `lastPromptAt`. The attached summary folds the same functions directly over the live log. `blank` changes only from true to false on `turn/start`; `lastPromptAt` changes only on a `user/message` whose source kind is `user`.

A cold summary takes one of three rungs. A durable row that already confirms non-blank — and, when the title capability is mounted, carries a settled title (a missing key means a discarded or never-written row) — is served with zero I/O. Otherwise the gateway reads through the projection cache's `coldSnapshot` ladder: cached rows plus the stored-log tail, refolded by every registered unit (`sessionListMetadata` and the log-backed `title`) and written back fail-soft, so the next list takes the zero-I/O rung; one read per cold Session lifetime bounds the cost. Cached `blank: true` and a cache miss never prove the current log is blank, and an unavailable heal read degrades to `blank: false`, keeping the Session visible — only an authoritative read may hide it.

`updatedAt` is the later of `createdAt` and `lastPromptAt`. The heal read supplies exact `lastPromptAt`; cache misses or stale checkpoints that are not read order the Session too old rather than promoting it from an unrelated file write. After each asynchronous cold read, the gateway checks the live store again and replaces the cold result with an attached summary when another request resumed that Session meanwhile.

## Alternatives considered

**Trust cached `blank: true`.** Rejected because the projection cache deliberately permits a persisted log to advance beyond its checkpoint. A crash or fail-soft write failure after the first `turn/start` would hide a real conversation and could make the client reuse it as New Session.

**Read every cold log on every list.** Rejected because list latency and I/O would scale with total stored conversation bytes per listing. The heal rung reads only rows that are not yet settled, and its write-back makes the read one-shot per Session lifetime; a `stateVersion` bump (which discards rows) re-heals once.

**Store blankness and recency in an authoritative persistence index.** Deferred because JSONL has an immutable first line and would require a second durable artifact with ordered updates, while SQLite would require a schema field. The broader exact-index design remains in the [last-activity proposal](../../proposed/architecture/2026-07-29-durable-last-activity-index.md).

**Continue ordering JSONL by mtime.** Rejected because mtime records every artifact write, including pickup boundaries, rather than the latest human prompt. Its error direction promotes untouched Sessions to the front.

## Consequences

Cold blank Sessions are hidden after one heal read without depending on projection-cache availability, and a stale cache cannot hide a stored `turn/start`. Cold rows born elsewhere (no durable row yet) — exactly the ungrouped free-Session case with no cwd basename to fall back on — carry their log-folded title instead of a bare session id.

Unavailable heal reads and missing recency entries degrade toward visibility and older ordering: the UI may show an extra empty row or order a Session too low, but it does not hide a conversation or promote one because it was merely opened.

The gateway-owned projection is an effect of the gateway fiber; unloading the gateway removes the key. Unit coverage pins settled-row zero-I/O serving, heal-read title and recency folds, stale-true rejection, unavailable-read degradation, no-cache-seam visibility, live-attachment races, human-prompt recency, and fiber disposal. A keyless Web snapshot boots the shipped compressed JSONL composition, seeds a cold blank artifact without a cache row, and verifies that the sidebar omits it.
