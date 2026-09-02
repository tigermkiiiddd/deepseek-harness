# dsh-desktop

English | [中文](README.zh.md)

Electron shell for the DeepSeek Harness Web UI (`apps/web`). The window spawns
`dsh web` from a repo checkout and loads it once the server is up; quitting the
window kills the server.

## One-click launcher (Windows)

Double-click `start.bat` (or run `start.ps1`). It packages the exe only when
needed — no exe yet, or `main.js`/`package.json` changed since the last
build — then launches the portable exe. It also exports `DSH_REPO_DIR` so the
packaged exe always finds this repo checkout.

## Development

```bash
pnpm install          # once, from the repo root
pnpm --filter dsh-desktop dev
```

## Package a Windows exe

```bash
pnpm --filter dsh-desktop dist:win
```

Outputs NSIS installer + portable exe under `apps/desktop/release/`.

## Diagnostics log

The packaged app has no reachable renderer console, so renderer warnings and
errors, `render-process-gone` events, and a per-minute memory sample are
mirrored to `<userData>/logs/renderer.log` (rotated to `renderer.old.log` at
4 MB). On Windows the packaged build's userData is
`%APPDATA%\DeepSeek Harness`. When the UI misbehaves, check this file first —
a crashed UI slot logs `slot entry crashed in '<slot key>': <stack>`.

## Notes

- The server always runs from a deepseek-harness repo checkout. Resolution
  order: `$DSH_REPO_DIR` → saved config (userData) → `../../` relative to this
  file (monorepo layout). If none match, the app asks once for the repo folder
  and remembers the choice. The checkout needs `pnpm install` + `pnpm run
  build` done beforehand.
- The server is spawned with the system Node.js (`node` on `PATH`, override
  with `$DSH_NODE`). It must NOT run under Electron's embedded Node: dsh's
  plugin loader detects Electron and swaps in native-only plugins that are
  not installed by the web profile.
