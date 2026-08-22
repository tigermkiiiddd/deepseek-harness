# acp member 模型 + provider 配置查询/设置(ACP member 体系内,不碰 subagent-acp)

## 验收标准(核心)
- **不手改任何配置文件**——查/改模型配置、provider 配置全部通过 tools 完成。
- 能查 grok 当前模型;能设 grok 模型。
- 能查 grok 当前 provider 列表;能设 provider。
- 缺能力(如 grok 未声明 `providers` capability)时,对应工具显式返回"不支持",不崩溃。

## 已核实事实
1. `subagent-acp` 是官方包(deepseek-ai/deepseek-harness master 存在),非本地 fork。"不动官方"= 不碰 subagent-acp 和 ACP SDK。
2. `@agentclientprotocol/sdk` 0.25.1 能力齐全:`ClientSideConnection.setSessionConfigOption`、`unstable_listProviders`、`unstable_setProvider`。
3. 断裂只在 `team/MemberConnection`:不解析 `configOptionUpdate`、从不发 `setSessionConfigOption`、不探 `providers` 能力。

## ACP 机制(官方约定)
- **模型**:agent 在创建/加载会话或模型变化时发 `session/update`(`sessionUpdate==='configOptionUpdate'`),`configOptions` 即全部配置项+当前值;客户端调 `setSessionConfigOption` 的响应也回传 `configOptions`。取 `category==='model'`(兜底 `id==='model'`)的 `currentValue`。
- **Provider**:`unstable_listProviders()` → `{ providers: ProviderInfo[] }`;`unstable_setProvider({ id, apiType, baseUrl, headers? })` 配置 provider;还有 `DisableProvider`。三者都要求 agent 声明 `providers` capability(grok 未声明则相应工具返回不支持)。

## 改动(仅 `packages/team`;基础设施共用;subagent-acp、SDK 不动)

### 1. `packages/team/team/src/member.ts` — `MemberConnection`
- `receiveUpdate()`:识别 `configOptionUpdate`,按 `sessionId` 缓存 `configOptions`。
- 新增方法:
  - `getSessionConfig(sessionId)` / `setSessionConfig(sessionId, configId, value)`(调 `conn.setSessionConfigOption`)。
  - `listProviders()` → `conn.unstable_listProviders()`(仅当 `capabilities` 含 `providers` capability)。
  - `setProvider(id, apiType, baseUrl, headers?)` / `disableProvider(id)` → `conn.unstable_setProvider(...)` / `conn.disableProvider(...)`(同上, gated on capability)。
- `newSession`/`loadSession` 抓到初始 `configOptionUpdate` 与 provider 信息。
- `currentModel(sessionId)` 从缓存 config 挑 model 项。

### 2. `packages/team/team/src/types.ts` + `index.ts` — `TeamService`
- `getConfig(memberId, sessionId?)` / `setConfig(memberId, sessionId, configId, value)`。
- `listProviders(memberId)` / `setProvider(memberId, {id, apiType, baseUrl, headers?})` / `disableProvider(memberId, id)`。
- `MemberSnapshot` 带 `model?`(及可选 providers 快照);错误语义与现有 `RequestError` 分支一致。

### 3. `packages/team/tool-team/src/index.ts` — 模型-facing 工具
- `member-model`:`{ sessionId?, action: 'get' | 'set', value? }` —— 查/设模型配置。
- `member-provider`:`{ action: 'list' | 'set', id?, apiType?, baseUrl?, headers? }` —— 查/设 provider。
- schema 不含 ACP/transport 词汇。

### 4. 配套
- 真·组合/快照测试:`configOptionUpdate` 解析、`setSessionConfigOption`、provider 探能力门禁、空 config/providers 兜底、snapshot 模型字段。
- README + JSDoc、package `./invariant`、一条 Agent Note。

## 非目标
- 不动 `subagent-acp`、不动 `@agentclientprotocol/sdk`、不在 subagent 委派链上做。
- provider 部分为实验性(`unstable_*`),仅在 agent 声明 `providers` capability 时生效。
