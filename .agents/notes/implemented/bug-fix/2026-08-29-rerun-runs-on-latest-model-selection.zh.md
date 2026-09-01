# Agent Note：rerun 后重建的会话运行在最新模型选择上

Status: implemented

[English](2026-08-29-rerun-runs-on-latest-model-selection.md) | 中文

## 问题

原地 rerun 从保留的日志前缀重建 live agent，而重建会话的模型选择在下一次读取时从该前缀最后一条 `request/header` 推导。用户在 rerun 之前作的选择只存在于进程本地的选择 ref 中——以旧 agent 对象为键，reseed 必然丢弃——以及已保存的部署默认里，而选择解析只对没有日志 header 的会话才读到这个默认。于是选择悄悄回退到被截断版本的模型。因为同一个模型 id 可以由多条 route 服务（DeepSeek 官方与 opencode-go 网关都提供 `deepseek-v4-flash`），这次回退无感知地跨了 provider：所有界面都只显示模型名，故障以官方端点的配额错误浮现，而不是任何 route 指示。rerun 处理器甚至向 `ctx.agents.reseed` 传了 `agentOptions: agentOptions()`，意图是让当前默认成为种子，但请求组装永远先恢复保留前缀的 header，这个值根本到不了请求——与自己意图矛盾的死代码。

## 决策

rerun 保留用户最新的选择。Web 网关在重建之前捕获该选择——本进程内作过的，否则是已保存的默认——并在 `ctx.agents.reseed` 发布之后、排队的后续轮次组装之前，立即把它安装为重建会话的已选选择。被截断版本的日志模型绝不恢复进选择；下一个请求按最新选择发出，并为它记录一条 `request/header` 变更。`session.rerun` 契约已写入这条语义。ACP member 桥接对 `dsh/session/rerun` 做同样的事：重建的 topic 携带它当前的 `modelRef` 选择，并把公告的选择器重新钉到该复合值上，而不是新解析的初始值。

显示层补上不可见性：composer 触发器和菜单的 Model 行在模型名旁渲染提供方分组名（`提供方 · 模型`），`/model` 弹层的行原本就有。同名的模型挂两条 route，在选择被回显的每一处都能读开。模型窗格还在提供方分组上方固定一个「最近使用」区——最近选过的五个模型，最近优先，每行标注 `提供方 · 模型`——经两个入口共同提交的共享目录漏斗记入浏览器本地存储，会话当前指向哪条 route 一眼可见，不必在分组目录里翻找。

## 已考虑的替代方案

- **像从前一样恢复被截断版本的模型**——输在用户意图：rerun 是显式的重做，刚切过 route 的用户预期重做跑在自己选的 route 上；在他们已转向网关之后悄悄在官方端点重放一轮，花的是他们没有同意的配额。
- **让选择走自然回落层级**（进程内选择，然后日志 header，然后默认）——输在重建必然销毁第一层，而第一层恰恰承载最新选择；这套优先级为读取而设，不为一个会重建 ref 的生命周期而设。
- **rerun 后弹一个 provider 变更警告 toast**——治标：选择被携带、provider 被显示之后，什么都不再回退，没有可警告的东西。

## 后果

会话中途切换模型之后的 rerun，其后续轮次跑在切换后的 route 上；持久日志保留版本历史，被移除的行为（从保留 header 推导）依然可以还原出来供检查。从未切换过选择的会话继续跑在日志模型上，因为它们的最新选择与日志模型一致。网关传给 `reseed` 的 `agentOptions` 保留为无选择时的回落种子，现在与安装的选择一致。冷 rerun（持久但未 live 的会话）仍然只做截断；下次 resume 像从前一样读取保留前缀，因为没有可携带的 live 选择。

## 测试

`dsh-host-apiproxy` 的 rerun 规格覆盖：live rerun 在保留旧 route header 的情况下保住会话中途的选择；无选择时回落到已保存默认而不是保留 header。`dsh-acp` 的 config-option 规格覆盖 member topic 在 `dsh/session/rerun` 后保住切换后的复合 route。`dsh-client-ui-model-selection` 覆盖触发器为双 route 同名模型标注提供方分组，以及「最近使用」区的排序、带提供方后缀的行、五条容量上限、目录已删除记录的裸 id 回退和过滤时让位。
