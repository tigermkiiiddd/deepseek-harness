# Agent Note: Client boot survives transient bundle-arrival failures and self-heals after host loss

Status: implemented

English | [中文](2026-08-22-client-boot-transient-failure-recovery.zh.md)

## Problem

A Web UI boot fetches every `dsh.client` bundle over HTTP in one burst. Two real-world windows made one bundle request fail while the host itself was fine, and each failure wedged the tab permanently:

1. **Watcher-rewrite race.** `tsdown`/`tsc` rewriting `lib/client.js` makes the registered path briefly unreadable on Windows (`ENOENT` during replace, `EBUSY`/`EPERM` while the writer holds the file). `serveBundle` answered any read error with an immediate 404, and the boot graph points 61 bundles at that handler — whichever file was mid-rewrite failed, so the failing plugin name looked random across incidents (`ui-deliverables`, then `ui-trajectory`, then `ui-workspace` on the same machine, same day).
2. **Host restart window.** A tab whose boot ran while the host died (or died mid-boot) renders the failure report and never recovers: the connection layer resumes its RPC polling, but plugin boot is one-shot and nothing re-runs it, so the tab stays on "Failed to load plugins" until a manual reload — and the manual reload only works if the user hits it while the host is actually up, which they cannot observe from the page.

Both were diagnosed on a Windows dev loop where the host is restarted frequently (dev launcher semantics: closing the launcher window stops the server) and builds rewrite bundles while a browser tab reloads.

## Decision

**Retry transient failures at both ends of the wire; reload the page only after the origin proves healthy, with a budget.**

- Browser `defaultLoadBundle` retries the classic-script load 3× (250 ms apart). A script arrival that fails once during a restart or rewrite window now succeeds on the retry; exhausting the attempts keeps the original loud error unchanged.
- Host `serveBundle` retries `readFile` up to 5× (150 ms apart) for the transient errno set (`ENOENT`, `EBUSY`, `EPERM`, `EACCES`); any other error 404s immediately, and exhausting the window 404s as before. The 404 contract ("loud beats a silent SPA-fallback page") is unchanged — only the transient window is bridged.
- `AppWebEntry.run`'s catch arm schedules recovery: poll `location.href` with `cache: 'no-store'` every 3 s and `location.reload()` after 2 consecutive OK responses. A rolling `sessionStorage` budget (3 reloads per 10 min) stops a persistently failing boot from reloading forever and leaves the failure report visible for diagnosis. Recovery stops on `dispose()`.

Retry bounds are protocol-robustness constants, not deployment-varying tunables, so they are named module constants rather than plugin Config fields.

## Consequences

A dev-loop host restart now costs at most one visible failure report for ~6 seconds per tab; after that every tab reloads itself against the recovered host. Watcher rewrites during a page load no longer fail plugin boot at all. A genuinely missing bundle (build not run) still 404s after the same retries and still fails boot loudly — the retry window only delays that diagnosis by ~600 ms per bundle. The recovery reload is a full page reload, so in-flight composer drafts are lost in exactly the case where the page was already wedged. `BootSeams` gains an optional `reloadPage` seam so jsdom tests can observe the reload without jsdom's non-implemented `location.reload`.

## Alternatives considered

- **Re-running plugin boot in place after reconnect** — boot is owned by the Cordis loader tree with fiber lifecycle and inject semantics; re-running it without a fresh document would need invalidation paths the vendored loader does not expose per-boot. A reload reaches the same end state through the supported path.
- **Retry only on the host side** — covers the rewrite race but not the restart window, where the failure is a browser-side `ERR_CONNECTION_REFUSED` on the script fetch itself.
- **Serving bundles from memory keyed by rev** — would mask stale-content bugs behind the last-read copy and grow the host for a window that bounded retries close.
