# dsh-desktop

[English](README.md) | 中文

DeepSeek Harness Web UI（`apps/web`）的 Electron 外壳。窗口会从仓库检出目录启动 `dsh web`，并在服务器就绪后加载页面；关闭窗口即终止服务器。

## 一键启动（Windows）

双击 `start.bat`（或运行 `start.ps1`）。脚本仅在需要时打包 exe（尚无 exe，或自上次构建以来 `main.js`/`package.json` 已变更），随后启动便携版 exe。脚本还会导出 `DSH_REPO_DIR`，让打包后的 exe 始终能找到本仓库检出目录。

## 开发

```bash
pnpm install          # once, from the repo root
pnpm --filter dsh-desktop dev
```

## 打包 Windows exe

```bash
pnpm --filter dsh-desktop dist:win
```

产物输出到 `apps/desktop/release/`：NSIS 安装包 + 便携版 exe。

## 诊断日志

打包后的应用没有可访问的渲染进程控制台，因此渲染进程的 warning/error、`render-process-gone` 事件和每分钟一次的内存采样会写入 `<userData>/logs/renderer.log`（超过 4 MB 时轮转（rotate）为 `renderer.old.log`）。Windows 上打包版本的 userData 是 `%APPDATA%\DeepSeek Harness`。界面异常时先查这个文件——UI 槽位崩溃会记录 `slot entry crashed in '<slot key>': <stack>`。

## 备注

- 服务器始终从 deepseek-harness 仓库检出目录运行。解析顺序：`$DSH_REPO_DIR` → 已保存配置（userData）→ 相对本文件的 `../../`（monorepo 布局）。均不匹配时应用会询问一次仓库目录并记住选择。检出目录需先完成 `pnpm install` 与 `pnpm run build`。
- 服务器使用系统 Node.js 启动（`PATH` 上的 `node`，可用 `$DSH_NODE` 覆盖）。它绝不能运行在 Electron 内置 Node 下：dsh 的插件加载器检测到 Electron 时会替换为 web profile 未安装的原生插件。
