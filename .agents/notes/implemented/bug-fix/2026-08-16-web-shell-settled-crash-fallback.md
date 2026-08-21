# Agent Note: Web shell survives post-settle render failures instead of blanking

Status: implemented

English | [中文](2026-08-16-web-shell-settled-crash-fallback.zh.md)

## Problem

The GUI white-screened with `web boot: appShell service missing after settled` thrown out of `AppRoot`'s settled branch. The boot kernel's sweep (`assertEntriesActive`) proves every entry ACTIVE before `settled.set(true)` flips, so the appShell service existed at settle time; the error fired at render time. The settled signal is one-way, so a post-settle service withdrawal cannot re-close the gate — `renderApp()` threw inside React's render phase, React unmounted the whole tree, and the page went blank with no recovery path short of a reload.

The withdrawal is a real, reachable event, not a hypothetical: a `dsh web` connection loss or an in-flight bundle rebuild (hot reload under a live page) disposes the connection → client-runtime → sessions chain, which takes the app-shell entry's inject set with it. The same window shows up as `syncInspectManifest has no active Connection` / `inventory is not a function` in the console — the remote namespace services are torn down or recreated empty while dependents still run.

## Decision

`AppRoot` wraps the settled branch in a class error boundary (`SettledBoundary`). A caught failure renders the same fail-loud card the loading page owns (wordmark, `Failed to render the UI`, the error message, a retry note) instead of an unmounted tree. Recovery is automatic: AppRoot derives a retry key from its kernel-store snapshots, and any change — in practice a fiber-state projection update while the withdrawn service graph comes back — clears the boundary's failure and re-attempts the real UI. The boundary itself never remounts on unrelated store changes, so a healthy UI tree is untouched.

Two mechanics matter for correctness:

- The boot closure runs in a child component (`SettledContent`), because a React error boundary cannot catch a throw from its own render.
- The retry is bounded by store updates: each fiber-state change is one re-attempt, so a persisting withdrawal produces one card re-render per status change, never a hot loop.

The `appShell service missing` throw in `boot.tsx` stays — its message is now the card's failure text, keeping the withdrawal diagnosable.

## Alternatives considered

**Re-close the boot gate when a service withdraws.** Rejected: the kernel would need a service-lifecycle watcher plus a re-run of entry creation, duplicating the boot chain for an event the boundary already survives; `settled` keeping its one-way meaning also keeps the sweep's guarantee readable (ACTIVE at settle).

**Teach consumers to tolerate a missing assembly.** Rejected: the crash is in the shell's own render path, and "blank page, console error" is exactly the failure the shell self-sufficiency rule exists to prevent.

## Consequences

A post-settle teardown now shows the fail-loud card and self-heals when services return — no reload, and in the packaged Electron shell (no DevTools) the card is the only visible diagnosis. During the withdrawal window the real UI is absent by design (the assembly it renders is gone); recovery rebuilds it through the app-shell entry's own once-per-fiber render closure. Tests pin the fallback, the store-change recovery, and the persisting-withdrawal behavior (`app-root.client.spec.tsx`).
