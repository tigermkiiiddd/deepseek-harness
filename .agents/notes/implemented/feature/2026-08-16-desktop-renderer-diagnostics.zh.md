# Agent Note: 桌面端渲染进程诊断日志

Status: implemented

[English](2026-08-16-desktop-renderer-diagnostics.md) | 中文

## Problem

打包后的桌面应用（apps/desktop）对渲染进程故障没有任何持久化手段：槽位边界崩溃只调 `console.error`，OOM 被杀掉的渲染进程什么都不留，而 Electron 外壳只转发服务器进程的 stdout/stderr。像"长时间会话后聊天面板变白、其他部分照常运行"这类现场报告没有任何证据可查，而故障又稀少到没法开着 DevTools 守株待兔。

## Decision

Electron 外壳把渲染进程诊断信息镜像到 `<userData>/logs/renderer.log`，超过 4 MB 时轮转为 `renderer.old.log`（apps/desktop/main.js 的 `wireRendererDiagnostics`）：

- warning/error 级别的渲染进程 `console-message` 事件（包括未捕获异常和被拒绝的 Promise），
- 带原因（`oom`、`crashed` 等）的 `render-process-gone`，以及 `unresponsive` 和 `did-fail-load`，
- 每分钟一次来自 `app.getAppMetrics()` 的渲染进程内存采样，让内存增长的猜想有趋势数据而不是靠猜。

因为控制台转发是纯文本的，packages/client/web-react 的 `SlotErrorBoundary` 现在把捕获的错误——包括堆栈，非 `Error` 的抛出值做字符串化——压平进控制台消息本身，其崩溃面也在 `data-slot-error-detail` 属性中携带同一字符串（视觉上仍为空）。日志写入是故障安全的：日志路径上的文件系统错误被吞掉，诊断绝不能拖垮它所观察的外壳。

## Alternatives considered

- **给所有槽位做可见、可恢复的崩溃面（错误文本 + 重试）。** 暂时否决：它会改变所有槽位的 UI 行为，而哪些故障适合自动重试、哪些该硬失败，正是这份日志要回答的问题。等真实崩溃特征积累后再议。
- **把错误详情经槽位台账（ledger）传导到 outlet 的永久死单元格崩溃面。** 对遮蔽（shadowing）类槽位，退位条目的边界崩溃面会被 outlet 的枯竭单元格面替换，后者拿不到错误。把它接进 `reportEntryError` 是跨包契约变更；控制台通道已携带详情，所以 DOM 属性只覆盖边界自己的崩溃面。
- **Chromium 的 `enable-logging` 开关。** 把 Chromium 内部日志写到 stderr，打包应用同样看不到，而且信号淹没在噪音里。

## Consequences

渲染进程的每条 warning/error 现在都会落盘，由轮转（rotate）约束体积；下一次白屏事故应留下一行 `slot entry crashed in 'conversation.view': <stack>` 和一段能证实或证伪 OOM 假说的内存趋势。代价：userData 里多一个文件，以及每分钟一次的指标唤醒。新增 `crashDetail` 分支的覆盖在 scoped-slots 客户端测试里（非 `Error` 抛出、无堆栈的 `Error`）。
