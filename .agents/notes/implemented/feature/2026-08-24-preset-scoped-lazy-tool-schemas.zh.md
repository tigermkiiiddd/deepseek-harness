# Agent Note: 按 preset scope 延迟加载工具 schema

Status: implemented

[English](2026-08-24-preset-scoped-lazy-tool-schemas.md) | 中文

## Problem

大型原生工具目录会在模型请求前缀中重复携带每个工具的完整输入 schema，即使当前轮次只会使用其中很少一部分。进程级环境变量虽然能减少这项开销，却会强制所有 agent 使用同一种呈现方式，无法让全量会话与渐进披露会话在同一进程共存；它还把 agent 组装选择放进了 Desktop 启动器，而不是现有 preset 体系。

## Decision

`dsh-tools` 将权威工具注册表保留在宿主平面，并新增按 preset scope 生效的呈现配置项。`dsh-agent-tool-presentation` 接受可选的 `lazyLoading` 块，并把它传给 `ctx.tools.presentAs(mode, lazyLoading)`。它只是现有 preset 中一行插件的普通配置。

启用后，模型请求只包含有界的名称／描述目录与三个稳定桥接 schema：`tool_search`、`tool_describe`、`tool_call`。完整的延迟 schema 保留在注册表内。`tool_describe` 仅将一个 schema 作为普通工具结果返回到对话尾部，绝不修改 system prompt 段或下一次请求的原生工具列表。`tool_call` 重新进入常规执行流水线，因此限制、守卫、策略、结果渲染、附加上下文与结束轮次语义仍然具有权威性。

内置 `standard` preset 设置 `lazyLoading.enabled: on`。把这个配置项改为 `off` 即可恢复全量 schema。Desktop 启动器与 Web／Headless bundle patch 不再提供 lazy-loading 环境变量开关。

## Alternatives considered

**Desktop 启动器环境变量。** 这种做法使选择成为进程级状态，绕过 preset 组装，也无法让全量 agent 与延迟 agent 并存，因此予以移除。

**把已经描述的 schema 动态注入前缀。** 这会破坏前缀稳定性，使下一次请求的 schema 列表依赖对话中的操作。将完整 schema 作为普通工具结果返回，可以保持 preset 前缀固定。

**把工具注册表移入每个 preset。** 宿主平面消费者共享该注册表服务，各工具插件也已经向它注册带 scope 的贡献。移动服务只会复制调度与 presenter 状态，而不是从一个权威注册表中选择投影。

## Consequences

- 现有 preset 分别配置不同取值时，延迟会话与全量会话可在同一进程共存。
- preset 固定后，每个会话的前缀保持稳定；压缩可能从对话尾部移除已经描述的 schema，模型届时可再次调用 `tool_describe`。
- 三个桥接名称属于保留的呈现基础设施，不能作为最终能力工具被注册、遮蔽或限制。
- `auto` 会根据固定的 preset 阈值与当前注册表成本在组装时选择全量或延迟；工具注册不变时，`on` 提供最强的前缀稳定保证。
- 延迟披露由 `dsh-agent-tool-presentation` 的 `lazyLoading` 配置项控制。
