# Agent Note: Desktop renderer diagnostics log

Status: implemented

English | [中文](2026-08-16-desktop-renderer-diagnostics.zh.md)

## Problem

The packaged desktop app (apps/desktop) gave renderer failures no persistence: a crashed slot boundary only called `console.error`, an OOM-killed renderer left nothing behind, and the Electron shell forwarded only the server process's stdout/stderr. Field reports like "the chat pane went blank after a long session while everything else kept running" arrived with zero evidence, and the failures are too rare to reproduce under a watching DevTools.

## Decision

The Electron shell mirrors renderer diagnostics to `<userData>/logs/renderer.log`, rotated to `renderer.old.log` at 4 MB (`wireRendererDiagnostics` in apps/desktop/main.js):

- renderer `console-message` events at warning/error level (which include uncaught exceptions and rejected promises),
- `render-process-gone` with its reason (`oom`, `crashed`, …), `unresponsive`, and `did-fail-load`,
- a per-minute renderer memory sample from `app.getAppMetrics()`, so memory-growth hypotheses get trend data instead of guesses.

Because console forwarding is text-only, `SlotErrorBoundary` in packages/client/web-react now flattens caught errors — stack included, non-`Error` throws stringified — into the console message itself, and its crash face carries the same string in `data-slot-error-detail` (the face stays visually empty). Logging is fail-safe: filesystem errors in the log path are swallowed so diagnostics can never take down the shell.

## Alternatives considered

- **A visible, recoverable crash face (error text + retry) for every slot.** Rejected for now: it changes UI behavior across all slots, and which failures deserve auto-retry vs. a hard face is exactly what the log is meant to teach us. Revisit once real crash signatures accumulate.
- **Plumbing the error detail through the slot ledger to the outlet's permanent dead-cell face.** For shadowing kinds the abdicated entry's boundary face is replaced by the outlet's dry-cell face, which has no access to the error. Wiring that through `reportEntryError` is a cross-package contract change; the console channel already carries the detail, so the DOM attribute covers only the boundary's own face.
- **Chromium's `enable-logging` switch.** Writes Chromium internals to stderr, which the packaged app does not surface either, and buries the signal in noise.

## Consequences

Every renderer warning/error now persists to disk, bounded by rotation; the next blank-pane incident should leave a `slot entry crashed in 'conversation.view': <stack>` line and a memory trend that confirms or refutes the OOM hypothesis. Costs: one more on-disk file in userData and a per-minute metrics wakeup. Coverage of the new `crashDetail` branches lives in the scoped-slots client spec (non-`Error` throw, stackless `Error`).
