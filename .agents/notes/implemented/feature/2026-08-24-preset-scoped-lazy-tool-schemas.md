# Agent Note: Preset-scoped lazy tool schemas

Status: implemented

English | [中文](2026-08-24-preset-scoped-lazy-tool-schemas.zh.md)

## Problem

A large native tool catalog repeats every exact input schema in the model request prefix even when one turn uses only a small subset. A process-wide environment switch can reduce that cost, but it gives every agent the same presentation and prevents an eager session from running beside a progressively disclosed one. It also puts an agent-composition choice in the Desktop launcher instead of the existing preset system.

## Decision

`dsh-tools` keeps the authoritative tool registry on the host plane and adds a preset-scoped presentation option. `dsh-agent-tool-presentation` accepts an optional `lazyLoading` block and passes it to `ctx.tools.presentAs(mode, lazyLoading)`. This is an ordinary row configuration inside an existing preset.

When active, the model request contains a bounded name-and-description catalog and three stable bridge schemas: `tool_search`, `tool_describe`, and `tool_call`. Exact deferred schemas remain in the registry. `tool_describe` returns one schema as an ordinary tool result at the conversation tail and never mutates system-prompt sections or the next request's native tool list. `tool_call` re-enters the normal execution pipeline, so restrictions, guards, policy, result rendering, additional contexts, and turn conclusion remain authoritative.

The shipped `standard` preset sets `lazyLoading.enabled: on`. Changing that item to `off` restores eager schemas. The Desktop launcher and Web/Headless bundle patches carry no lazy-loading environment switch.

## Alternatives considered

**Desktop launcher environment variable.** This makes the choice process-wide, bypasses preset composition, and cannot support eager and lazy agents concurrently, so it was removed.

**Dynamically inject described schemas into the prefix.** This invalidates the stable prefix and makes the next request's schema list depend on conversation actions. Returning the exact schema as a normal tool result preserves a fixed preset prefix.

**Move the tool registry into each preset.** Host-plane consumers share the registry service, and tool plugins already register scoped contributions into it. Moving the service would duplicate scheduling and presenter state rather than selecting a projection of one authoritative registry.

## Consequences

- Lazy and eager sessions can coexist when their existing preset configurations select different values.
- Each session's prefix remains stable after its preset is fixed; compaction may remove a described schema from the conversation tail, after which the model can call `tool_describe` again.
- The bridge names are reserved presentation infrastructure and cannot be registered, shadowed, or restricted as end-capability tools.
- `auto` may choose eager or lazy at assembly from the fixed preset threshold and current registry cost; `on` gives the strongest prefix-stability guarantee when tool registrations are unchanged.
- Lazy disclosure is configured by the `lazyLoading` option on `dsh-agent-tool-presentation`.
