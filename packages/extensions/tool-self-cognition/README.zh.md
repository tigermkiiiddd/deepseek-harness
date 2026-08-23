# @deepseek-ai/dsh-tool-self-cognition

[English](README.md) | 中文

自我认知入口:一段告诉 agent「可以通过编辑自身源码 checkout 来迭代自己」的系统提示,外加一个报告活体组成的只读 `self_cognition` 工具。由 `cordis` agent preset 挂载。

## 功能

在 agent 平面上贡献两样东西:

- 一个 `harness:self-cognition` 提示段,order 为 `-97`,位于 `harness:source` 与 persona 之间。探测到源码 checkout 时,它给出绝对根路径和工作流入口;探测不到时如实说明,而不是宣传一条此部署不存在的路径。
- 一个挂在 `ctx.tools` 上的工具 `self_cognition()`。每次调用都重新读取活体状态——没有任何缓存:源码 checkout 根、本会话的 agent preset 及其扁平化插件条目(`agentPresets.readEntries`)、以及每个非 group 的 Loader 条目及其启用状态和 fiber 相位。

## 源码 checkout 探测

挂载时,本包从自己的模块 URL 逐级向上,找到第一个同时带有 `pnpm-workspace.yaml`、`AGENTS.md` 和 `packages/` 的目录。找不到意味着该部署不附带源码 checkout——这是安装版 profile 的正常状态,报告为 `sourceCheckout.available: false`,不是错误。

## 路由:源码 vs 动态

永久能力走源码编辑并经 preset 的 `cordis.yml` 挂载(`cordis` preset 里的 `self-development` skill 承载这套工作流);临时、会话级或试验性扩展走动态 Cordis 插件(`cordis-plugin-development` skill)。提示段文本和两份 skill 双向写明这条分界,让 agent 选择已有路径而不是即兴发明第三条。

## 配置

无。

## 渲染

规范结果渲染为缩进 JSON 文本。工具不声明 presenter,各界面回退到 `generic` 卡片。

## 导出形态

函数/命名空间插件:命名导出 `name` / `inject` / `apply`,无默认导出([docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md))。注入 `loader`、`systemPrompt`、`tools`;preset roster 是可选能力,经 `ctx.get('agentPresets')` 读取。

## Model Experience

### System prompt

#### What the model sees

一个名为 `harness:self-cognition` 的提示段。可用变体在挂载时插入探测到的 checkout 绝对根路径;不可用变体把源码编辑指引替换为「此部署不附带 checkout」的如实陈述。

##### Self-cognition section(有源码 checkout)

```markdown
You are running on DeepSeek Harness from its source checkout at <absolute checkout root>. You can evolve yourself permanently by editing that checkout: read `AGENTS.md` and `docs/architecture.md` first, then load the `self-development` skill for the full workflow. Source changes take effect on the next process start; they never hot-reload into this session.

The `self_cognition` tool reports your live composition: mounted plugins, the agent preset this session was composed from, and its plugin entries.

Temporary, session-scoped, or experimental extensions belong to dynamic Cordis plugins instead — load the `cordis-plugin-development` skill for those, and do not edit the checkout for one-off needs.
```

##### Self-cognition section(无源码 checkout)

```markdown
You are running on DeepSeek Harness. The `self_cognition` tool reports your live composition: mounted plugins and the agent preset this session was composed from. This deployment does not carry the harness source checkout, so source-level self-development is unavailable here; temporary or session-scoped extensions can still be built as dynamic Cordis plugins — load the `cordis-plugin-development` skill for those.
```

#### Token effect

插件在作用域内的每个请求都有小额固定输入成本;变体在挂载时选定一次。

#### KV Cache effect

插件及其探测到的 checkout 根不变时前缀稳定。挂载或卸载插件会使此段之后的缓存复用失效。

### Tool schema

#### What the model sees

模型看到的是生成的 [`self_cognition` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-self-cognition)。

#### Token effect

工具可见的每个请求都有固定 schema 成本。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期变化可能使此 schema 之后的复用失效。

### Tool-call history and result

#### What the model sees

调用无参数。成功返回一个 JSON 对象:`sourceCheckout`(探测到时为 `available` 加 `root`)、`preset`(会话 preset 的 `id` 及其扁平化 `entries`(形如 `{ id, name, disabled }`),或 `unavailable: true` 加 `reason`)、`plugins`(每个已挂载非 group 插件一行:`id`、`name`、`enabled`、`fiberPhase`,已销毁或从未启动的条目为 `null`)。preset id 无法解析的会话会以 roster 的工具错误响亮失败。

#### Token effect

结果随已挂载插件数和 preset 条目数增长,并随调用历史保留直到压缩。

#### KV Cache effect

只追加;结果跟在可复用的请求前缀之后,不会使现有 KV 缓存失效。

## 已知限制与延后工作

- **挂载时探测根路径**——checkout 根在插件挂载时解析一次;移动 checkout 与任何源码改动一样,下次进程启动才生效。
- **preset 条目依赖 roster**——没有 `agentPresets` 的组合(例如 headless)报告 `preset.unavailable` 并附原因;工具绝不猜测组合来源。
- **设计上只读**——自我修改经源码编辑加进程重启完成;本包刻意不注册任何写路径。
