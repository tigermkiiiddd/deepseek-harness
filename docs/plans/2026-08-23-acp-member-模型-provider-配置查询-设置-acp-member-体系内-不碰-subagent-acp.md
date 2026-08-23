# acp member model + provider config query/set (inside the ACP member system, not touching subagent-acp)

English | [中文](2026-08-23-acp-member-模型-provider-配置查询-设置-acp-member-体系内-不碰-subagent-acp.zh.md)

## Acceptance criteria (core)

- **Never hand-edit any config file** — querying/setting the model config and provider config is done entirely through tools.
- Can query grok's current model; can set grok's model.
- Can query grok's current provider list; can set the provider.
- When the capability is missing (e.g. grok does not declare the `providers` capability), the corresponding tool explicitly returns "not supported", no crash.

## Verified facts

1. `subagent-acp` is an official package (present on deepseek-ai/deepseek-harness master), not a local fork. "Do not touch official" = leave subagent-acp and the ACP SDK alone.
2. `@agentclientprotocol/sdk` 0.25.1 has full capabilities: `ClientSideConnection.setSessionConfigOption`, `unstable_listProviders`, `unstable_setProvider`.
3. The break only lives in `team/MemberConnection`: it does not parse `configOptionUpdate`, never sends `setSessionConfigOption`, and does not probe the `providers` capability.

## ACP mechanism (official convention)

- **Model**: on creating/loading a session or on a model change, the agent sends `session/update` (`sessionUpdate==='configOptionUpdate'`); `configOptions` is the full set of config entries plus their current values; the response of the client call to `setSessionConfigOption` also carries `configOptions`. Take the `currentValue` of `category==='model'` (fallback `id==='model'`).
- **Provider**: `unstable_listProviders()` → `{ providers: ProviderInfo[] }`; `unstable_setProvider({ id, apiType, baseUrl, headers? })` configures the provider; there is also `DisableProvider`. All three require the agent to declare the `providers` capability (if grok does not declare it, the corresponding tool returns "not supported").

## Changes (only `packages/team`; infrastructure is shared; subagent-acp and the SDK are untouched)

### 1. `packages/team/team/src/member.ts` — `MemberConnection`

- `receiveUpdate()`: recognize `configOptionUpdate`, cache `configOptions` per `sessionId`.
- New methods:
  - `getSessionConfig(sessionId)` / `setSessionConfig(sessionId, configId, value)` (calls `conn.setSessionConfigOption`).
  - `listProviders()` → `conn.unstable_listProviders()` (only when `capabilities` includes the `providers` capability).
  - `setProvider(id, apiType, baseUrl, headers?)` / `disableProvider(id)` → `conn.unstable_setProvider(...)` / `conn.disableProvider(...)` (same, gated on capability).
- `newSession`/`loadSession` catch the initial `configOptionUpdate` and the provider info.
- `currentModel(sessionId)` picks the model entry from the cached config.

### 2. `packages/team/team/src/types.ts` + `index.ts` — `TeamService`

- `getConfig(memberId, sessionId?)` / `setConfig(memberId, sessionId, configId, value)`.
- `listProviders(memberId)` / `setProvider(memberId, {id, apiType, baseUrl, headers?})` / `disableProvider(memberId, id)`.
- `MemberSnapshot` carries `model?` (and an optional providers snapshot); the error semantics match the existing `RequestError` branch.

### 3. `packages/team/tool-team/src/index.ts` — model-facing tools

- `member-model`: `{ sessionId?, action: 'get' | 'set', value? }` — query/set the model config.
- `member-provider`: `{ action: 'list' | 'set', id?, apiType?, baseUrl?, headers? }` — query/set the provider.
- The schema contains no ACP/transport vocabulary.

### 4. Supporting

- Real composition/snapshot tests: `configOptionUpdate` parsing, `setSessionConfigOption`, the provider capability-probe guard, empty config/providers fallback, snapshot model fields.
- README + JSDoc, the package `./invariant`, one Agent Note.

## Out of scope

- Leave `subagent-acp` alone, leave `@agentclientprotocol/sdk` alone, do not work on the subagent delegation chain.
- The provider parts are experimental (`unstable_*`) and take effect only when the agent declares the `providers` capability.
