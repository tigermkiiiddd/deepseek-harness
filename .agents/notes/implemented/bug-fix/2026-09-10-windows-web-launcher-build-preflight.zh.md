# Agent Note: 让 Windows Web 桌面启动器感知构建状态

Status: implemented

[English](2026-09-10-windows-web-launcher-build-preflight.md) | 中文

## Problem

Windows 桌面快捷方式从 TypeScript 源码启动 Web profile，但该 profile 会加载生成的 Host 模块、浏览器包工厂和 Vite 应用。因此，源码更新后，启动器文件可能仍然可执行，但所需产物不存在或属于其他提交。已删除的包目录也可能保留生成物残留，导致 workspace 构建将它们误判为当前包。

## Decision

桌面启动器将仓库客户端构建记录视为版本标识。在替换正在运行的 DSH Web 主进程前，它会比较记录中的 Git 短提交与 `HEAD`，检查 Vite 入口页，并检查每个声明 `dsh.client` 的 workspace 包是否具有 `lib/client.js`。

任一检查失败时，启动器会执行按锁文件的依赖安装、仓库自有的安全清理和完整仓库构建。任一步失败都会阻止服务器启动，并将诊断信息保留 20 秒。`-ForceBuild` 为不改变 `HEAD` 的本地源码编辑提供相同路径。构建当前且完整时，启动器不会重新构建。

根 Host tsdown 默认值将 `index`、`invariant` 和 `startup` 表达为独立的字符类 glob。这保留了每个包的可选入口，并避免 Rolldown 在 Windows 上无法解析的花括号展开。安全清理仅在无清单包目录包含已知生成物残留时删除它们。

## Testing

源码 Web 命令在完整构建前可复现客户端工厂缺失，完成构建后可达到通过鉴权的 HTTP 就绪状态。Windows PowerShell 5.1 启动器覆盖当前构建的快速路径和强制构建路径；两条路径都会启动固定端口服务器，`-Stop` 会释放该服务器。

## Alternatives considered

**不做构建预检就启动。** 拒绝：有效的 TypeScript 启动器文件不能证明它依赖的 Host、浏览器和 Vite 生成物存在。

**只执行 Vite Web 构建。** 拒绝：Vite 会消费浏览器包工厂，而源码启动的 Host 会消费已打包的包入口；完整构建会在 Vite 阶段前生成两者。

**每次启动都执行完整构建。** 拒绝：这会为未变化的 checkout 增加依赖、native、TypeScript、bundle 和 Vite 工作。构建记录与产物检查让重复启动保持快速，同时保留显式重建选项。

## Consequences

更新后的首次启动可能需要几分钟，并且可能需要依赖网络访问。启动器不会从 Git dirty 状态推断同一提交下的本地源码编辑；操作者使用 `-ForceBuild`。启动失败会在启动器改变正在运行的服务器进程前指明构建步骤。
