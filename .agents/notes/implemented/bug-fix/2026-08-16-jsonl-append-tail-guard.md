# Agent Note: JSONL append tail guard against concurrent external writers

Status: implemented

English | [中文](2026-08-16-jsonl-append-tail-guard.zh.md)

## Problem

Two dsh host processes sharing one `DSH_HOME` could hold the same session live at once — for example a leftover `dsh web` server and a freshly started one resuming the same conversation. The coordinator's resume exclusivity is per-process, and the JSONL backend appended with no cross-process check, so both processes kept their own sequence counters and interleaved frames into one file. The result was a log whose seq values regress mid-file; the reader's contiguity invariant then refused the whole log and the Web UI showed "history unavailable" for that session.

## Decision

`dsh-session-persistence-jsonl` now tracks the byte offset where this process last left each log (`expectedTails`, keyed by path), recorded on read (`readPrefix`), `materialize`, `repair`, and every successful append. `appendLines` stats the file before writing — which it already did for rollback — and refuses loudly when the on-disk size disagrees: a concurrent external writer changed the log, and appending would interleave two generations of sequence numbers. After a refusal, re-observing the log (a fresh load) re-arms the appender. A path the backend instance never observed keeps the historical unchecked first append; the coordinator always loads before writing, so a live writer holds a fresh entry.

The check is optimistic, not a lock: the stat and the append are separate operations. It deterministically stops writers seconds apart — the observed failure shape — while the residual microsecond race between stat and write remains.

## Alternatives considered

**OS-level file locking (LockFileEx / flock) held for the session's lifetime.** Rejected for now: it changes teardown semantics on every platform (a killed process must not wedge the session for others) and the koffi-based native surface would grow for a case the optimistic check already covers deterministically.

**A host-level single-instance lock on `DSH_HOME`.** Rejected because distinct profiles (CLI, headless, web) legitimately share one home; the corruption requires the same session live in two processes, which the per-log tail check addresses precisely.

**Let the stale writer keep writing and repair on read.** Rejected: interleaved streams are alternative histories of the same turn and cannot be merged mechanically; refusing the write keeps every log readable.

## Consequences

A second process that resumes a session still succeeds; the abandoned first process now fails its next flush with a descriptive error instead of silently corrupting the file, and the write-behind layer retains and retries the batch (which keeps failing until the session is reloaded there). Reads and single-writer appends are unchanged. Unit coverage pins the cross-instance refusal, the log's continued validity after a refusal, re-arming through a fresh load, and the unchecked first append for an unobserved log.
