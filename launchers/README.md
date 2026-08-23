# DSH Web UI launcher

English | [中文](README.zh.md)

Starts (or directly opens) the DeepSeek Harness Web UI (browser mode).

## Files

- `dsh-web.ps1` — the launcher script (this directory; the desktop holds only a shortcut)
- The desktop shortcut "DeepSeek Harness Web UI" points to this script

## Usage

Double-click the desktop shortcut:

- **When a leftover main process exists (the window that started it has exited)**: stop the leftover process first, then start fresh. The leftover process holds the port and the task-board ledger lock, so if it is not cleared the new instance fails to start (`ledger is already owned by process ...`).
- **When the server is not running** → an interactive console window pops up showing server logs in real time; once ready it opens the browser automatically. **Press Ctrl+C or close the window to stop the server.**
- **When the server is already running (the host window is alive)** → open the browser; the window stays and refreshes a status line every 10 seconds (PID / stopped), and the user closes the window themselves to quit, with no automatic close.

Cleanup scope convention: **main process only** (`bin.ts web` main server). Subprocesses such as ACP agents are not in scope; they usually exit on their own when disconnected from the main server, and even if they survive they are unaffected by this launcher.

Command-line mode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1                  # start / cleanup leftovers and restart / open
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Status          # view status
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Stop            # stop main process (no tree-kill of children)
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Port 63848      # override preferred port
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -NoOpen          # ready without auto-opening browser
```

## Details

- Port: `63848` (default, overridable with `-Port`)
- Startup command: `node --import tsx/esm G:\projects\deepseek-harness\apps\cli\src\bin.ts web --port 63848`
- If the server is already running on the default port 3080 (started manually without `--port`), the launcher opens it directly
- Server output shows directly in the launcher window and is tee-d to `%USERPROFILE%\.dsh\launcher-web.log`
- When the port is taken by a non-DSH program, interactive options are offered: change port / open directly / quit
