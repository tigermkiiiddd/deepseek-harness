# 让 kind:dsh 成员成为"自带人设+模型、私有独立"的完整 ACP agent

## 目标与成功标准

把 `dsh --profile acp` 这个成员进程从一个"只声明 promptCapabilities、不声明 session 配置项"的半套 ACP server，改造成一个**完整声明 model + 人设两个 config option、且完全自包含**的 ACP agent。

成功标准（全部可验证）：
1. **独立性**：`kind:'dsh'` 成员 spawn env **不再含 `DSH_MAIN_HOME`**；成员运行时只读自己的 `DSH_HOME`。启动后成员的 `resolveDshHome()` 等于 `members/<id>`。
2. **创建读**：`member_add` 在成员首次启动前，把主实例的 `settings.yaml` + `.credentials.yaml` 拷贝进 `members/<id>/`（之后脱钩，重启不再覆盖）。
3. **模型可管**：`member_model` 对 `kind:dsh` 成员能 `get`（列出可选 model）和 `set`（切换 model），值来自 `ctx.llm.listModels`。
4. **人设可管**：成员自带标准 preset 人设；有工具可读/改该人设。
5. **不回归**：现有 ACP 消费者（headless、subagent-acp、web GUI、全部 acp 单测）行为不变。

## 修正后的分工（创建读 ≠ 运行读）

| 时机 | 谁 | 读什么 | 读哪 |
|---|---|---|---|
| 创建（`member_add` 那一下） | 主实例 | `settings.yaml` + `.credentials.yaml` | 主实例 home（`resolveDshHome()`） |
| 运行时（acp 跑起来） | 成员 | 只读成员 home | `members/<id>/` |

"读主实例"只发生在 `member_add` 那一下，读出来写进成员 home，之后脱钩。成员 home 自包含，无需 `DSH_MAIN_HOME`。

---

## 改动一：隔离（`packages/team/team`）

**1. `resolve.ts` —— 去掉 `DSH_MAIN_HOME`**
- `resolveMemberSpec` 的 `kind:'dsh'` 分支，`env` 从 `{ DSH_HOME: memberHome, DSH_MAIN_HOME: mainHome }` 改为仅 `{ DSH_HOME: memberHome }`。
- 更新模块文档注释与 `resolveMemberSpec` JSDoc：删除"inheriting the main instance's model settings via DSH_MAIN_HOME"表述，改为"the member is self-contained under its own DSH_HOME; settings/credentials are seeded once at creation (see member-home.ts)"。
- `member.ts` 的 `spawnSpec()` 注释同步更新（那段大注释解释了 DSH_MAIN_HOME 用于读主实例 setting/凭证——现在不成立）。

**2. 新建 `packages/team/team/src/member-home.ts` —— 创建时播种成员 home**
- 导出 `seedMemberHome(member, opts)`：
  - 入参：`member: MemberConfig`、`mainHome: string`（来自主实例 `resolveDshHome()`）、`memberHome: string`（=`join(mainHome, 'members', member.id)`），或让函数内部用 `resolveMemberSpec(member).env.DSH_HOME` 算 memberHome。
  - 行为：若 `<memberHome>` 目录已存在（已播种过）→ 直接返回（幂等，重启不覆盖成员自己改过的 setting/凭证）。否则 `mkdir(memberHome, {recursive, mode:0o700})`，再逐个拷贝：
    - 主实例 `settings.yaml`（或解析到的 `.json`）→ 若存在则拷到成员 home。
    - 主实例 `.credentials.yaml` → 若存在则拷，写 `0600`。
  - 主实例缺哪个文件就跳过哪个，绝不凭空造凭证文件。
  - 拷贝失败（非 ENOENT）→ 抛 Error（让成员启动失败，绝不"无声无凭证运行"）。
- 新增单测 `member-home.spec.ts`：拷贝正确性、幂等（已存在不覆盖）、缺文件跳过、凭证 0600、拷贝失败抛错。

**3. `index.ts` `addMember` —— 在 start 前播种**
- 在 `addConnection(member)` 之前、`connection.start()` 之前，调用 `await seedMemberHome(member)`（用 `resolveMemberSpec(member).env.DSH_HOME` 得 memberHome，`resolveDshHome()` 得 mainHome）。
- 注意：`addMember` 现有 `void connection.start()` 是 fire-and-forget。播种必须 await 在 start 之前，所以把"播种 + start"串成串行：`await seedMemberHome(member); if (autostart) void connection.start()...`。播种失败 → `addMember` 抛错（成员不加入）。
- 范围：仅 `addMember`（运行时添加）。配置声明的 `kind:dsh` 成员（load 时 autostart）暂不播种，作为已知限制记录进 README `Known Limitations`（可后续统一）。

## 改动二：模型（`packages/acp/acp`）

**`index.ts` `makeAgent` —— 声明 model option + 装 model-selection + 装配 preset**

1. **`initialize` 响应**加 `sessionCapabilities`：
   ```
   agentCapabilities: {
     promptCapabilities: { image, audio, embeddedContext },
     sessionCapabilities: { list: { setSessionConfigOption: {} } },
   }
   ```
   - 仅在拿到 `ctx.llm` 时声明 `list`；拿不到则省略（客户端 gated on capability，安全）。

2. **`agents.create` 加 `setup(agentCtx)` 回调**（当前没有）：
   - `ctx.agentPresets.mount(agentCtx, 'standard')` —— 装配标准 preset（人设 + 工具），即"补丁 shipped preset root(standard)"。
   - 建一个 `ModelSelectionRef { current, assembled }`，`current` 初始为 `agentDefaultModel.currentSelection()`（读成员 home setting，因已去 DSH_MAIN_HOME）；`installModelSelection(agentCtx, ref)`。
   - 这些都用 `ctx.get('llm')` / `ctx.get('agentDefaultModel')` / `ctx.get('agentPresets')` 取（可选服务，未就绪则跳过对应步骤，`inject` 仍只保留 `['agents']`）。

3. **新增 `setSessionConfigOption(params)` 方法**（Agent 接口已支持，参考 mock）：
   - 仅处理 `configId === 'model'`：把 `ref.current` 的 `provider/model` 更新为新 model（provider 沿用当前 selection 的 provider）；返回 `{ configOptions: 当前完整 options }`。
   - 非 model 的 configId → 抛 `RequestError.invalidParams`。

4. **`newSession` / `loadSession` 响应加 `configOptions`**：返回当前 model 选项集（`currentValue` = `ref.current.model`，`options` = 从 `listModels` 得来）。

5. **model 选项值来源**：`await ctx.llm.listModels(ref.current.provider)` → `{ value: m.id, name: m.name }`。在 `initialize`/`newSession` 时构建 options 数组。若 provider 未知或 listModels 失败 → options 为空数组（安全降级，不报错）。

6. **`agentOptions` 兼容**：保留 `agentOptions(config)` 作为 seed（provider 来自 acp config），但 model 以 `agentDefaultModel` 为准。headless 已验证 `agentOptions` + `installModelSelection` 可共存。

**回归影响**：`initialize` 多了一个可选的 `sessionCapabilities` 字段，`newSession`/`loadSession` 响应多一个可选 `configOptions`，均为增量、向后兼容。需更新 `packages/acp/acp/tests/*.spec.ts`（bridge.spec 等断言 initialize 响应结构的）。

## 改动三：人设（`packages/acp/acp` + preset）

- 人设通过改动二第 2 步的 `ctx.agentPresets.mount(agentCtx, 'standard')` 获得：标准 preset 自带 `deployment:persona` 段。成员因此"自带人设"。
- **人设作为 config option（开放决策 A）**：最小可行做法是把"已装配 preset 的 id"作为人设 option——`currentValue='standard'`，`options` 为可用 preset id 列表；`setSessionConfigOption` 收到人设变更时调 `ctx.agentPresets.recompose(agent.ctx, newPreset)` 重装配。这比"自由文本人设段"更贴合现有 preset 机制。**待你确认**是否采用此方案，还是要求人设为独立自由文本 option。
- 若 'standard' 根不满足需求（如成员要不同人设），`agentPresets` 的 `roots`/`default` 需在 acp profile 的 cordis.yml 配置——作为已知限制记录。

## 改动四：工具（`packages/team/tool-team`）

- `member_model`：无需改逻辑，acp-app 声明 option 后自动可用（`get`/`set`）。
- **新增 `member_persona` 工具**（镜像 `member_model`）：`action=get` 读当前人设（preset id + 名称），`action=set` 通过 `setSessionConfigOption` 改人设。参数：`member_id`、`session_id`、`action`、`value`。
- `member_add` 描述文案：补一句"成员 home 在创建时从主实例播种 settings/credentials，之后独立运行"。

## 测试与验证

- **单测（vitest）**：
  - `member-home.spec.ts`：改动一第 2 步。
  - acp：新增 `config-option.spec.ts`——`setSessionConfigOption` 切 model 后 `installModelSelection` 生效（`system-prompt/assemble` 的 provider/model 变量、`agent/request` 的 provider/model 被更新值覆盖）；`initialize` 带 `sessionCapabilities`；`newSession` 带 `configOptions`。用 `ctx.plugin` fixture + 一个 mock llm provider（参考 `packages/llm/llm/tests/service.spec.ts` 的 CatalogAdapter 写法）。
  - tool-team：`member_persona` 工具 get/set 行为（可沿用 `tool-team.spec.ts` fixture）。
- **REAL 组合快照/e2e（AGENTS.md 强制：产品可见插件改动）**：新增一个 runnable 示例 `cordis.yml`（acp profile + 一个 kind:dsh 成员），通过 `pnpm run test:snapshot` 实跑：`member_add` → 成员自包含启动 → `member_model get` 列 model → `member_model set` 切换 → 成员用新 model 跑一轮。这是"创建读≠运行读 + 模型可管"的端到端证据，替代任何 mock-only 断言。
- **回归**：跑现有 acp 全测、subagent-acp 全测、team 全测、headless 快照，确认无回归。

## 边界与失败模式

- **重启不覆盖**：`seedMemberHome` 以"成员 home 目录已存在"为幂等闸门，重启只读成员 home（可能含成员 lifetime 期间 member_model 写回的 setting）。
- **主实例无 setting/凭证**：跳过对应文件，成员 home 保持干净，不报错。
- **listModels 失败/无 provider**：model options 为空，`member_model get` 返回"无可选 model"（不抛）。
- **agentPresets 不可用**：`mount` 跳过，成员仍能用（无标准人设），不阻塞。
- **播种失败（主实例 setting 损坏/权限）**：`addMember` 抛错，成员不加入——fail loud，不无声运行。

## 开放决策（需你拍板）

- **A. 人设 option 形态**：采用"preset id option + recompose"（最小，贴合现有机制），还是"自由文本人设段"（需新增 mutable persona section + 每轮重注入 system prompt，工作量大得多）。我推荐前者。
- **B. `member_add` 是否接收显式 `model`/`persona` 入参**：我倾向默认从成员 home（播种来的 setting）初始化，不加新入参；若你要 member_add 显式指定，再加。
- **C. 配置声明的 `kind:dsh` 成员是否也要播种**：本计划只覆盖 `member_add`。配置成员 load 时 autostart，暂未播种（已知限制）。

## 顺序

先改动一（隔离，最底层、无依赖）→ 跑 team 单测 → 改动二（模型）→ 改动三（人设，依赖二）→ 改动四（工具）→ REAL 快照 e2e → 全量回归。
