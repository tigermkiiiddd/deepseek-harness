# Agent Note: Web 外壳在 settle 后渲染失败时自保，不再白屏

Status: implemented

[English](2026-08-16-web-shell-settled-crash-fallback.md) | 中文

## 问题

GUI 白屏，`web boot: appShell service missing after settled` 从 `AppRoot` 的 settled 分支抛出。boot 内核的扫描（`assertEntriesActive`）在 `settled.set(true)` 翻转前证明所有 entry ACTIVE，因此 settle 时刻 appShell 服务确实存在；报错发生在渲染时刻。settled 信号是单向的，settle 之后的服务撤走无法重新关闭闸门——`renderApp()` 在 React 渲染阶段抛错，React 卸载整棵树，页面空白，除刷新外无任何恢复路径。

服务撤走是真实可达的事件，不是假设：`dsh web` 断连或构建期间在活页面脚下替换 bundle（热重载）都会拆除 connection → client-runtime → sessions 依赖链，连带 app-shell entry 的 inject 集合。同一窗口在 console 里表现为 `syncInspectManifest has no active Connection` / `inventory is not a function`——remote 命名空间服务被拆掉或重建为空，而依赖方仍在运行。

## 决策

`AppRoot` 在 settled 分支外包了一层类组件错误边界（`SettledBoundary`）。被接住的失败渲染为加载页同款的醒目报告卡（wordmark、`Failed to render the UI`、错误消息、重试说明），而不是卸载成空白树。恢复是自动的：AppRoot 从内核 store 快照派生 retry key，任何变化——实践中即被撤走的服务图恢复期间的 fiber 状态投影更新——都会清掉边界的失败态并重试真实 UI。边界自身不会因无关 store 变化而重挂载，健康的 UI 树不受影响。

两个对正确性关键的机制：

- boot 闭包在子组件（`SettledContent`）里运行，因为 React 错误边界接不住自己 render 里的抛错。
- 重试以 store 更新为界：每次 fiber 状态变化对应一次重试，持续撤走只产生每次状态变化一次的卡片重渲染，绝不形成热循环。

`boot.tsx` 里的 `appShell service missing` 抛错保留——它的消息现在是卡片上的失败文本，让撤走原因可诊断。

## 备选方案

**服务撤走时重新关闭 boot 闸门。** 否决：内核需要服务生命周期监听加上 entry 重建的再运行，为边界已经能扛住的事件复制整条 boot 链；`settled` 保持单向语义也让扫描的保证（settle 时 ACTIVE）可读。

**让消费方容忍组装缺失。** 否决：崩溃发生在外壳自己的渲染路径上，而"整页空白、只留 console 错误"正是外壳自足规则要防止的失败形态。

## 后果

settle 后的拆除现在显示醒目报告卡，并在服务回来时自愈——无需刷新；打包的 Electron 壳（无 DevTools）里这张卡是唯一可见的诊断。撤走窗口期间真实 UI 按设计缺席（它渲染的组装已不存在）；恢复经 app-shell entry 自身的每 fiber 一次渲染闭包重建。测试钉住回落、store 变化恢复与持续撤走行为（`app-root.client.spec.tsx`）。
