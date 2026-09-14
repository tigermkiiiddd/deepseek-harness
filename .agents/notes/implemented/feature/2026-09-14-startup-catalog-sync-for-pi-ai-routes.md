# Agent Note: Startup catalog sync for pi-ai catalog routes

Status: implemented

English | [中文](2026-09-14-startup-catalog-sync-for-pi-ai-routes.zh.md)

## Problem

The model list an installed pi-ai catalog route serves is a snapshot compiled into the `@earendil-works/pi-ai` npm package. A provider that ships a new model keeps serving the old list until pi-ai publishes a release: the OpenCode Go gateway advertised `deepseek-v4.1-flash` on its listing endpoint while the pinned pi-ai 0.85.1 snapshot still carried only the V4 family, and no configuration surface could show the addition. Discovery cannot help either: a catalog route is answered from the installed registry with no network call by design, and a settings `models` list would replace the catalog wholesale and put the deployment's hand-written answer in `settings.yaml`.

## Decision

The adapter gains an opt-in startup sync. With `catalogSyncEnabled: true` in the `llm-pi-ai` section, each catalog route that appears is asked once per process at its own listing endpoints — at mount, or when a settings section names it. The merged reply (union across the route's listable protocols, first listing winning per model, tagged with the listing's protocol, capacities adopted when disclosed) is written atomically to `<catalogCacheDir>/<provider>.json` and resolution serves it in place of the frozen snapshot from then on. A model the snapshot also describes keeps that entry's metadata with the synced name and capacities on top, so a listing that discloses only ids still yields a fully described model. A route with its own `models` list or `modelOverrides` is never synced; a failed, refusing, or empty endpoint leaves the previous catalog serving; a missing or corrupt cache file answers absence and the snapshot serves — the route keeps working offline either way. The route stays an installed provider throughout: nothing reaches `settings.yaml`.

The sync is fire-and-forget and never fails a mount. The Models surface's fetch action also refreshes the route's cache on demand, so an addition can be picked up mid-session.

Coverage: cache file format, fingerprint, atomic write, mtime-keyed serve memo, and corrupt/missing fallback in `catalog-cache.spec.ts`; listing union, protocol dedup, first-wins tagging, per-endpoint failure tolerance, and abort in `discovery.spec.ts`; cache-over-snapshot resolution and `resolveProfiles`-with-directory semantics in `catalog.spec.ts`; and a real composition test that registers a catalog route from settings, syncs it at mount from a local endpoint, and serves the synced listing while another pins the snapshot when sync is off.

## Alternatives considered

- **A TTL-based background refresh.** The original fork feature (removed when the package aligned to upstream's architecture) refreshed a cache every seven days or on pi-ai fingerprint change. Rejected for the restore: the deployment asked for a forced check at every startup, and an automatic background fetch on a schedule is harder to reason about than one synchronous check per route per process.
- **Defaulting the sync on.** Rejected: every configured catalog route would phone its provider at every mount, which changes behavior for every existing deployment and would reach real third-party endpoints from the test suite. The switch defaults to `false` and is one line in the settings section.
- **Letting discovery interrogate catalog routes over the wire.** The surface action exists, but the answer it returns is draft metadata; persisting it would need the same cache layer anyway, and a per-fetch miss would not keep a route current between actions.

## Consequences

- A deployment that wants upstream-fresh model lists turns the sync on and gets them at the next launch: `catalogSyncEnabled: true` in the `llm-pi-ai` section, optionally `catalogCacheDir` (defaults to `$DSH_HOME/llm-pi-ai/catalog-cache`).
- Cache serve is gated by the same flag: with sync off, no provider endpoint is reached and no cache file is read, so behavior is byte-identical to before.
- A synced listing only discloses ids, names, and sometimes capacities; reasoning levels, cost, and compatibility quirks still come from the pi-ai snapshot, so a brand-new model appears serviceable with route-default capacities until pi-ai catches up (a later fingerprint mismatch retires the cache cut against the older snapshot).
- The synchronization endpoint is the route's effective endpoint (configured `baseURL`/`api` when the profile overrides them), not the frozen catalog's address, so a proxy or self-hosted replica is asked rather than the vendor endpoint.