# DSH Web UI 启动器

[English](README.md) | 中文

必要时先构建项目，再以浏览器模式启动 DeepSeek Harness Web UI。

## 文件

- `dsh-web.ps1` — 启动器脚本（本目录；桌面只放快捷方式）
- 桌面快捷方式「DeepSeek Harness Web UI」指向此脚本

## 用法

双击桌面快捷方式：

- **当前提交没有完整构建记录、记录属于其他提交，或 Web／客户端产物缺失时**：按锁文件同步依赖，删除仓库自有的生成物，执行完整构建，再替换正在运行的服务器。构建失败时不启动或替换服务器，并保留诊断信息 20 秒。
- **构建与当前版本一致时**：跳过构建。停止正在选定端口监听的 DSH Web 主进程，清理孤立的 DSH Web 主进程，再启动新实例。
- 互动窗口会显示服务器日志。通过带鉴权的就绪探测后，启动器自动打开浏览器。**Ctrl+C 或关闭窗口即停止服务器。**

清理范围约定：**只处理主进程**（`bin.ts web` 主服务器）。ACP agent 等子进程不在清理范围；它们通常随主服务器断连自行退出，即使脱离存活也不受本启动器影响。

命令行方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1                  # start / cleanup leftovers and restart / open
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Status          # view status
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Stop            # stop main process (no tree-kill of children)
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -Port 63848      # override preferred port
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -NoOpen          # ready without auto-opening browser
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-web.ps1 -ForceBuild       # rebuild before starting
```

## 细节

- 端口：`63848`（默认，可用 `-Port` 覆盖）
- 构建准备：`pnpm install --frozen-lockfile`、`pnpm run clean`，再执行 `pnpm run build`
- 构建标识：当前 Git 短提交必须与 `.dsh-build/client-build-environment.json` 一致；`apps/web/dist/index.html` 和每个声明 `dsh.client` 的 workspace 包也必须具有已生成文件
- 启动命令：`node --import tsx/esm G:\projects\deepseek-harness\apps\cli\src\bin.ts web --port 63848`
- 服务器输出直接显示在启动窗口并 tee 到 `%USERPROFILE%\.dsh\launcher-web.log`
- 端口被非 DSH 程序占用时，启动器停止并提示用户释放端口或选择其他端口
