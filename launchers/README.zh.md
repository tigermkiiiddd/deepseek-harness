# DSH Web UI 启动器

[English](README.md) | 中文

启动（或直接打开）DeepSeek Harness 的 Web UI（浏览器模式）。

## 文件

- `dsh-web.ps1` — 启动器脚本（本目录；桌面只放快捷方式）
- 桌面快捷方式「DeepSeek Harness Web UI」指向此脚本

## 用法

双击桌面快捷方式：

- **有残留主进程时（启动它的窗口已退出）**：自动停止残留主进程，然后全新启动。残留主进程占着端口和 task-board 账本锁，不清掉新实例会启动失败（`ledger is already owned by process ...`）。
- 服务器未运行时 → 弹出互动命令行窗口，实时显示服务器日志；就绪后自动打开浏览器。**Ctrl+C 或关闭窗口即停止服务器。**
- 服务器已在运行（宿主窗口存活）时 → 打开浏览器，窗口常驻并每 10 秒刷新一条运行状态（PID / 已停止），**由用户自行关闭窗口退出，不自动关闭。**

清理范围约定：**只处理主进程**（`bin.ts web` 主服务器）。ACP agent 等子进程不在清理范围；它们通常随主服务器断连自行退出，即使脱离存活也不受本启动器影响。

命令行方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1                  # start / cleanup leftovers and restart / open
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Status          # view status
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Stop            # stop main process (no tree-kill of children)
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Port 63848      # override preferred port
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -NoOpen          # ready without auto-opening browser
```

## 细节

- 端口：`63848`（默认，可用 `-Port` 覆盖）
- 启动命令：`node --import tsx/esm G:\projects\deepseek-harness\apps\cli\src\bin.ts web --port 63848`
- 若服务器正运行在默认端口 3080（未加 `--port` 手动启动），启动器会直接打开它
- 服务器输出直接显示在启动窗口并 tee 到 `%USERPROFILE%\.dsh\launcher-web.log`
- 端口被非 DSH 程序占用时提供互动选择：换端口 / 直接打开 / 退出
