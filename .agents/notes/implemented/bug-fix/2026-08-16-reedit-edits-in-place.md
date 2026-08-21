# Agent Note: Re-edit edits the user bubble in place

Status: implemented

English | [中文](2026-08-16-reedit-edits-in-place.zh.md)

## Problem

Clicking re-edit on a settled user message opened the editor as a second panel appended below the message's actions row, leaving the original bubble above it. The screen then showed two stacked copies of the same text, which read as an unexpected extra input box rather than an edit mode of the message, and on long messages the edit target and the editing surface sat far apart.

## Decision

Re-edit is now view state on `UserMessageNodeView`: a non-null draft seed swaps the user bubble for `UserReeditEditor` at the bubble's own position, replacing the actions row while open. Send routes through the `rerunUserMessage` verb (which truncates and rebuilds the session in place at the completed turn before the message — see [the in-place rerun decision](2026-08-16-rerun-truncates-and-rebuilds-in-place.md)) and closes the editor; cancel closes without sending and restores the bubble. `UserRerunActions` is a pure actions row again that raises `onReedit`, and the editor component and its styles stay beside it in `UserRerunActions.tsx` / `UserRerunActions.module.css`.

## Alternatives considered

**Keep the editor below the actions row but hide the bubble while open.** Rejected: the editor would still live outside the bubble's geometry, so its width and alignment could drift from the message being edited, and the open/close layout jump remains.

**Load the text into the main composer for editing.** Rejected: it loses which message is being revised, collides with an in-progress draft, and the composer's queue/steering semantics differ from re-sending a settled message.

## Consequences

The edit target and the editing surface are the same element, and only one copy of the text is ever on screen. The open/closed state is per message node and dies with the view — nothing is persisted. Unit coverage pins verbatim re-run, the in-place swap inside the message's own row, prefill, revised send, empty-payload disable, and cancel-restores-bubble.
