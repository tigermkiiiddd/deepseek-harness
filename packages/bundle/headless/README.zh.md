# `@deepseek-ai/dsh-headless`

[English](README.md) | 中文

dsh 一次性任务组合包。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.zh.md) 之上：提供编码 persona 和工具模式、禁用 HMR（热模块替换）、将 Code Mode 的 worker 作为核心执行能力挂载，并插入本包的 `headless-runner` 插件（配置为 `{task}`，从注入的 `headlessStartup` 提供方解析）。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

Loader 结算后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.zh.md)，通过 `ctx.agents` 创建一个全新的持久化 Agent（智能体），将任务作为普通用户消息提交，并等待完全停稳。它对 Session 执行 flush 后再汇总自身持有的持久化事件区间，将最后一条非空 assistant 文本写入 stdout，再经启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)）请求退出（最终 `turn/end` 完成 → 0，否则为 1）。最终结束原因为 `error` 时，还会将 code 与 message 写入 stderr；成功运行时 stderr 保持为空。进程不会打开监听端口。任务文本就是这个应用的命令行：普通 `headless-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)），读取 `dsh --profile headless "task"` 的位置参数、打印应用自己的 `--help`，并提供 `headlessStartup`；runner 注入该服务，再从惰性配置中读取任务。缺失或只有空白的任务会在 runner 激活前被拒绝。

## 模型体验

### 部署 persona

#### 模型看到的内容

Headless 组合包的 `deployment:persona` 默认让所有面向用户的沟通使用简体中文。只有用户明确要求其他语言时才会切换，技术内容、生成内容、subagent 消息和助手先前的文本不参与语言判断；代码和交付物仍保留所需语言。

#### Token 影响

这项固定策略属于每次 headless 请求既有的 persona。

#### KV Cache 影响

该策略跨轮次保持稳定，因此首次请求后不会使提示词前缀失效。Runner 不再向该前缀添加其他内容。

## 已知限制与暂缓事项

- **只提交一个任务**：runner 没有用于交互式后续输入的 surface；它会等待 Agent 在返回 idle 前完成的所有工作，并打印该区间内最后一条非空 assistant 消息。
- **`ctx.appExit` 由启动器持有**：在 `dsh` 启动器之外启动 headless profile 会在激活时明确报错，直到宿主提供该退出请求。
