# Agent Note: 模型发现从端点刷新；选择菜单支持搜索

Status: implemented

[English](2026-08-24-model-discovery-endpoint-refresh-and-selection-search.md) | 中文

## Problem

模型界面上的两个缺口。其一，pi-ai 安装的 catalog 是各提供方模型列表的版本化快照，它随附的路由在回答发现请求时直接取自这份缓存、不发生任何网络调用——于是上游在快照发布之后新增的模型（opencode-go 在 pi-ai 0.82.1 与 0.84.2 之间新增了 `qwen3.8-max` 和 `gpt-5.6-luna`）对设置界面不可见，用户要采纳其中一个只能手敲 id，而在 opencode-go 这种横跨多种协议的路由上还得猜它说的是哪条线路协议。其二，Web GUI 的模型选择菜单平铺列出所有已公布模型、没有任何搜索手段；目录越大，找一个模型越靠滚动。

## Decision

发现请求在 `LlmModelDiscoveryRequest` 上新增 `preferEndpoint`。对安装 catalog 有描述的已命名路由，适配器读取端点当前的 OpenAI 兼容 `GET /models` 列表并与缓存合并：已装模型按 catalog 顺序保留其缓存的容量与协议，上游新增的模型去重后追加在后。不带该标志时行为不变——catalog 无网络作答仍是默认，因为它携带着列表端点不会披露的信息。

发现的模型可携带 `api`（应答方为该模型使用的线路协议）；采纳时会把它写入 profile。条目级 `api` 成为 `models` 条目与 `modelOverrides` 值的配置字段，解析顺序为条目 → 路由 → catalog 同 id 兄弟 → 全体已装兄弟一致的协议。在 catalog 横跨多种协议的路由上，catalog 未描述的模型必须有条目 `api`；它的端点基址从说该协议的已装兄弟处继承（`dsh-llm-pi-ai` 的 `siblingBaseUrl`），因此 opencode-go 的两个端点族都不需要 `baseURL`。

设置界面在编辑已命名路由时由 fetch 按钮发送 `preferEndpoint: true`，把采纳候选的 `api` 写入该行，并在每个展开的模型行上提供协议选择器（空值表示继承）。Web GUI 的模型选择菜单在模型页新增搜索框：按提供方名（整组保留）、模型名或 id 过滤；Enter 选中第一个匹配项；Escape 先清空过滤词、为空时才退出该页。

## Alternatives considered

- **升级 pi-ai 0.82.1 → 0.84.2 以刷新快照**——时效性上落败：快照终究是某个时间点，上游还会再动；而且会带入新的 compat 字段（baseten `thinkingFormat`、`supportsFinishReason`、`chatTemplateArgs`、`supportsThinkingTokenBudget`、`supportsAdditionalTools`），需要适配漂移门。读取端点严格更新鲜，且对任何网关都有效，不限于 pi-ai 自家提供方。
- **端点失败时回退缓存**——诚实性上落败：把过期列表冒充当前会误导采纳到端点已不服务的模型；拒绝时会点名端点，手动录入仍然可用。
- **每个发现模型带 `source` 字段（catalog 还是 live）**——没有消费方按它分支：采纳对两者一视同仁，合并顺序本身已承载该含义。
- **选择菜单做服务端搜索**——为一个几十条模型的列表付出每次击键一次网络往返；组件本地状态足够，且查询保持瞬时。

## Consequences

`discoverModels` 协议载荷新增可选 `preferEndpoint`，视图新增可选 `api`；两者对 schema 均为增量。编辑已命名路由的 fetch 按钮现在会发起一次网络调用（此前为零），失败以点名端点的 `DISCOVERY_FAILED` 呈现，而非静默降级。条目级 `api` 是刻意的改指：错误的协议会在服务时像其他错误协议一样失败；解析诊断在多协议路由上点名模型，在别处点名录由。菜单搜索是瞬时 UI 状态——菜单关闭即重置，绝不持久化。

## Testing

`dsh-llm-pi-ai` 的 discovery 与 catalog 规格覆盖合并顺序、`preferEndpoint` 显式开启、draft 路由忽略该标志、`installedBaseUrl` 选择、条目 `api` 解析与改指、同协议基址继承；`ui-settings-models` 覆盖探测载荷、采纳写入 `api`、行内协议选择器；`ui-model-selection` 覆盖过滤、Enter/Escape、关闭即重置。
