# DSH Web UI launcher

English | [中文](README.zh.md)

Builds when required, then starts the DeepSeek Harness Web UI in browser mode.

## Files

- `dsh-web.ps1` — the launcher script (this directory; the desktop holds only a shortcut)
- The desktop shortcut "DeepSeek Harness Web UI" points to this script

## Usage

Double-click the desktop shortcut:

- **When the current commit has no complete build record, the record names another commit, or a Web/client artifact is missing**: install the locked dependencies, remove repository-owned generated output, and run the complete build before replacing a running server. A build failure does not start or replace the server and keeps its diagnostic visible for 20 seconds.
- **When the build is current**: skip the build. Stop the DSH Web main process already listening on the selected port, clear orphaned DSH Web main processes, and start a fresh instance.
- The interactive window shows the server log. Once the authenticated readiness probe succeeds, the launcher opens the browser. **Press Ctrl+C or close the window to stop the server.**

Cleanup scope convention: **main process only** (`bin.ts web` main server). Subprocesses such as ACP agents are not in scope; they usually exit on their own when disconnected from the main server, and even if they survive they are unaffected by this launcher.

Command-line mode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1                  # start / cleanup leftovers and restart / open
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Status          # view status
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Stop            # stop main process (no tree-kill of children)
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Port 63848      # override preferred port
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -NoOpen          # ready without auto-opening browser
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -ForceBuild       # rebuild before starting
```

## Details

- Port: `63848` (default, overridable with `-Port`)
- Build preparation: `pnpm install --frozen-lockfile`, `pnpm run clean`, then `pnpm run build`
- Build identity: the current short Git commit must match `.dsh-build/client-build-environment.json`; `apps/web/dist/index.html` and every workspace package that declares `dsh.client` must also have their emitted files
- Startup command: `node --import tsx/esm G:\projects\deepseek-harness\apps\cli\src\bin.ts web --port 63848`
- Server output shows directly in the launcher window and is tee-d to `%USERPROFILE%\.dsh\launcher-web.log`
- When the port is taken by a non-DSH program, the launcher stops and asks the user to release it or select another port
