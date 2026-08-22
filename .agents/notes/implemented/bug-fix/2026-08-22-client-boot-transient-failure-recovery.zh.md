# Agent Note: 客户端 boot 穿透瞬态 bundle 加载失败,并在 host 恢复后自愈

Status: implemented

[English](2026-08-22-client-boot-transient-failure-recovery.md) | 中文

## 问题

Web UI 的一次 boot 会通过 HTTP 突发拉取全部 `dsh.client` bundle。两个真实窗口会让其中某一个请求失败而 host 本身完好,而每次失败都会把标签页永久卡死:

1. **watcher 重写竞态。** `tsdown`/`tsc` 重写 `lib/client.js` 时,已注册路径在 Windows 上短暂不可读(替换期间的 `ENOENT`、写者持锁时的 `EBUSY`/`EPERM`)。`serveBundle` 对任何读错误立即回 404,而 boot 图把 61 个 bundle 都指向这个 handler —— 碰巧在重写的那个文件失败,所以每次事故里失败的插件名看起来是随机的(同一台机器同一天先 `ui-deliverables`、再 `ui-trajectory`、再 `ui-workspace`)。
2. **host 重启窗口。** boot 期间 host 死掉(或中途死掉)的标签页渲染出失败报告后永远不自愈:连接层会恢复 RPC 轮询,但插件 boot 是一次性的,没有任何东西重跑它,标签页停留在 "Failed to load plugins" 直到手动刷新 —— 而手动刷新只有在 host 真正活着时按下去才有用,用户从页面上根本观察不到这一点。

两者都是在 Windows dev loop 上诊断出来的:host 频繁重启(dev 启动器语义:关启动器窗口即停止服务器),而浏览器标签页刷新时构建恰好重写 bundle。

## 决策

**在链路两端重试瞬态失败;只在源站证明健康后整页刷新,并带预算。**

- 浏览器 `defaultLoadBundle` 对 classic-script 加载重试 3 次(间隔 250 ms)。重启或重写窗口内失败一次的脚本到达现在会在重试中成功;耗尽尝试后仍保持原有的响亮报错不变。
- host `serveBundle` 对 `readFile` 以瞬态 errno 集合(`ENOENT`、`EBUSY`、`EPERM`、`EACCES`)重试至多 5 次(间隔 150 ms);其他错误立即 404,耗尽窗口也照旧 404。404 契约("响亮胜过静默的 SPA 回退页")不变 —— 只桥接瞬态窗口。
- `AppWebEntry.run` 的 catch 分支调度恢复:每 3 s 以 `cache: 'no-store'` 轮询 `location.href`,连续 2 次 OK 后 `location.reload()`。滚动 `sessionStorage` 预算(每 10 分钟 3 次)阻止持续失败的 boot 永无限刷新,把失败报告留在页面上供诊断。`dispose()` 会停止恢复。

重试边界是协议健壮性常量,不是随部署变化的可调项,因此是具名模块常量而非插件 Config 字段。

## 后果

dev loop 的 host 重启对每个标签页最多代价一次约 6 秒的失败报告;之后所有标签页对着恢复的 host 自行刷新。页面加载期间的 watcher 重写不再导致插件 boot 失败。真正缺失的 bundle(未跑 build)在同样的重试后仍然 404、仍然响亮地失败 —— 重试窗口只把诊断推迟约 600 ms。恢复刷新是整页刷新,输入框草稿在页面本已卡死的情形下丢失。`BootSeams` 增加可选 `reloadPage` seam,让 jsdom 测试无需 jsdom 未实现的 `location.reload` 即可观察刷新。

## 备选方案

- **重连后原位重跑插件 boot** —— boot 由 Cordis loader 树持有 fiber 生命周期与 inject 语义;不刷新文档而重跑需要 vendored loader 未暴露的按-boot 失效路径。整页刷新经被支持的路径到达同一终态。
- **只在 host 侧重试** —— 覆盖重写竞态,但覆盖不了重启窗口,那里的失败是浏览器侧脚本拉取自身的 `ERR_CONNECTION_REFUSED`。
- **按 rev 从内存服务 bundle** —— 会用最后读到的副本掩盖内容过期 bug,并为一个有界重试就能关闭的窗口扩张 host。
