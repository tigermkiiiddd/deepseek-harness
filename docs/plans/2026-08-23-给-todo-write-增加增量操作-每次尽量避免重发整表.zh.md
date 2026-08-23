# 给 `todo_write` 增加增量操作（每次尽量避免重发整表）

[English](2026-08-23-给-todo-write-增加增量操作-每次尽量避免重发整表.md) | 中文

## 目标与验收标准

让 agent 能**增量地更新 / 修改单条任务**，不必每次都把整个任务清单重发一遍（那样漏掉某条就会悄悄丢失——正是你和 agent 描述的问题），并且在**没有重大方向调整**时主动避免全量重发。

验收标准：

- `todo_write` 新增可选的 `action`（动作）判别字段。不传（或 `action: "replace"`）时行为与**现在逐字节一致**（向后兼容）：整表替换、同样的校验、同样的报错文案、同样的 session 事件、同样的投影。
- 新增动作让 agent 只需发送**增量**：`merge`（按 `content` 向上插入：新增任务 / 更新已存在任务的 `status`）、`remove`（删除列出的任务）、`clear`（清空）。每个增量都合并进"当前持久化清单"。
- **工具描述（模型契约）明确鼓励增量、 discourage 全量、并把 `replace` 留给方向重大调整**（见下"描述增强"）。
- 现存持久化、投影、UI、ACP、session-query 消费方**原封不动继续工作**——`todo/write` 的 `[{ content, status }]` 结构不变。
- `pnpm run test:coverage`（`packages/todo/tool-todo/src` 逐文件 100% 覆盖）通过；`typecheck`、`lint`、`doc-sync`、`build`、`hygiene` 通过。

## 根因

`packages/todo/tool-todo/src/index.ts` 的 `execute()` 无条件地把模型传入的**整表**追加为 `todo/write`；`types.ts` 写明"整值规则"（最后写入胜出）；没有任何动作入口，描述里也禁止"部分更新"。本方案**不改**持久化快照结构，只补动作入口，并把模型引导（描述）改成鼓励增量。

## 模型面向面（已核实，唯一一处）

我搜遍 `packages/`——**唯一**告诉 agent"怎么用任务清单"的模型面向面就是工具自己的 `description`（`describe()` 拼装）。系统提示里没有第二处独立 todo 引导（`plan-mode.spec.ts` 只是注册它、`tool-order.spec.ts` 只是排它、`locales.ts` 的 `更新任务清单` 只是界面标题）。因此"工具描述"和"prompt 描述"是同一处，改它即可；`docs/tool-catalog.md` 由它生成，一并重新生成。

## 改动范围（除注明外都在 `packages/todo/tool-todo` 下）

- `packages/todo/tool-todo/src/index.ts` —— schema（`action` + `todos` 字段描述）、`describe()` 描述、`execute` 分发与合并逻辑。**（唯一功能性改动）**
- `packages/todo/tool-todo/tests/tool-todo.spec.ts` —— 新增覆盖；新增"描述鼓励增量"断言；更新 `presentCall` 断言。
- `packages/todo/tool-todo/tests/integration.spec.ts` —— 补一条端到端 `merge` 全流程用例。
- `packages/todo/tool-todo/README.md` 与 `README.zh.md` —— 说明动作 + "优先增量、非重大调整不全量"的引导；更新 `Known Limitations`。
- `docs/tool-catalog.md` —— 重新生成；`docs/tool-catalog.zh.md` —— 同步更新 `deepseek-aidsh-tool-todo` 片段。
- 不改其它包（已核实：`core/session`、`acp`、`session-query`、`team`、`client/connection`、`session-projection`、`client/runtime` 只读取不变的 `TodoItem[]`）。

## 设计决策（推荐——只标出这一个分叉）

**用 `content` 当定位钥匙。** `content` 已被规范化（去空白、非空、列表内唯一）且用作去重键，是增量操作天然、零新增字段的定位依据。改名字用 `remove`（旧 content）+ `merge`（新 content）组合完成。稳定 `id` **暂缓**（需改 `TodoItem` 结构、`session` 版本号，波及约 9 个包）——列为暂缓项。

回读工具（todo_read）也**先不加**：每次调用返回值已回吐完整 `{ todos, counts }`，模型每轮都能看到当前清单；增量操作已解决痛点。

## 详细实现

**1. schema** —— 加可选 `action`、把 `todos` 改成可选（但各动作运行时都要求它）：

```
action: { type: 'string', enum: ['replace', 'clear', 'merge', 'remove'],
          description: 'replace(默认):整表,即现有行为。merge:按 content 向上插入
          (新增 / 更新已存在任务的 status)。remove:删除列出的 content。clear:清空。
          merge/remove/replace 都在"当前持久化清单"(最近一次 todo/write)上操作。' }
todos: { type: 'array', required: false,
         description: '要改的条目。replace(默认):替换上一次的完整清单。merge:要新增或更新
         status 的增量(按 content 匹配)。remove:要删除的 content(忽略 status)。clear 时不传。',
         items: { content: string, status: enum(pending/in_progress/completed) } }
```

不传 `action` 时默认 `replace`，故既有模型调用与快照/集成输入都不受影响。

**2. 描述增强（本轮重点——在 `describe()` 的 `DESCRIPTION_HEAD`）**。把现有 HEAD 替换为鼓励增量、保留全量给方向调整措辞（注意：不出现 "several at once" 或 "AT MOST ONE"，以免破坏既有锚点测试）：

```
'HEAD = Record and update a structured task list for the current work. '
+ 'UPDATE specific tasks with a delta instead of resending the whole list: '
+ 'use `action` — `merge` upserts each entry by `content` (adds new tasks, updates the '
+ '`status` of tasks that already exist), `remove` deletes the listed tasks, and `clear` '
+ 'empties the list; each delta merges onto the current list. '
+ 'ONLY send the COMPLETE list with `action: replace` when the task direction changes '
+ 'significantly, for example when the plan is restructured. Keep the list current as '
+ 'work progresses. '
```

`DESCRIPTION_PARALLEL` / `DESCRIPTION_SINGLE` / `DESCRIPTION_TAIL` **不动**（`Keep AT MOST ONE ...` / `several at once ...` 段保留），因此 `tool-todo.spec.ts` 与 `loader-composition.spec.ts` 的锚点断言仍然成立。

**3. `execute`** —— 按分发重组。顶部**先保留** `exec.agent` 归属守卫（`clear` 也一样，非 agent 全部拒绝）。

- 把 `toTodoList(raw, allowParallel)` 拆成：
  - `normalize(raw)`：去空白 + 拒绝空 + 拒绝重复 content + 校验 `status` 枚举 → 清洗条目。**不做活跃计数检查**（增量里合法地加一个 `in_progress`，即使已存在另一个）。
  - 公共 `assertSingleActive(list, allowParallel)`：当 `!allowParallel` 且计数 > 1 时抛 `Error: invalid todos: at most one task may be in_progress (got <n>)`，对**每个动作的结果列表**执行，保留确切文案。
- 读一次当前持久化清单：
  ```js
  const last = exec.agent.session.events.findLast(e => e.type === 'todo/write')
  const current = last ? last.data.todos.map(t => ({ content: t.content, status: t.status })) : []
  ```
- 分发：
  - `replace` → `final = normalize(args.todos)`（要求传 `todos`；缺失抛 `Error: todo_write requires a `todos` array for action "replace"`）。
  - `merge` → `final = current.map(t => deltaMap.get(t.content) ?? t)`，再把清洗后、content 不在 current 中的增量追加到末尾（保序、去重）。要求传 `todos`。
  - `remove` → `final = current.filter(t => !removeSet.has(t.content))`（先清洗待删 content）；要求传 `todos`。删除不存在 content 是安全 no-op（幂等，content 可能已改名）。
  - `clear` → `final = []`。
- 分发后执行 `assertSingleActive(final, allowParallel)`。
- 追加**一条**携带 `final` 的 `todo/write`（结构不变），返回 `{ todos: final, counts }`（与现在一致）。

**4. `presentCall`** —— 返回 `rawInput: args`（含 `action`），而非只有 `args.todos`；更新既有 `presentCall` 测试。

## 边界与失败场景（全部用测试覆盖）

- 无前置 `todo/write` → `merge` 视 current 为 `[]`（追加全部增量）；`remove`/`clear` 为 no-op→空。
- `merge` 更新已存在任务时保序、保留其余任务 status 与顺序；新任务按给定顺序追加。
- `merge`/`remove` 在 `allowParallelInProgress=false` 下产生 `>1 个 in_progress` → 对结果列表拒绝。
- 任意增量有重复/空 content → 拒绝（文案与现在一致）。
- 未知 `action` 值或未知条目键 → 由 JSON-schema 边界（registry 参数校验）拒绝，与既有 `doing`/`children` 案例一致。
- `merge`/`remove`/`replace` 缺 `todos` → 新的"requires a `todos` array"报错。
- 非 agent 调用 → 所有动作都拒绝。

## 测试

- `tool-todo.spec.ts`：`clear`（有/无前置）、`merge` 不发整表也能新增任务、`merge` 更新已存在任务且保序保留其余、无前置列表的 `merge`、`remove` 保其余 / 删除未知 content 为 no-op、`allowParallelInProgress:false` 下 merge 结果仍受"至多一个 in_progress"约束、新的"requires a `todos` array"报错。
- **新增描述钉住断言**（模型面向契约，须用测试锁死）：
  ```
  const desc = (await setup(true)).tools.schemas().find(s => s.name === 'todo_write')!.description
  expect(desc).toContain('delta')
  expect(desc).toContain('task direction changes')
  expect(desc).toContain('ONLY')
  ```
  并保留既有 `Keep AT MOST ONE` / `several at once` 锚点断言（不受 HEAD 影响）。
- 更新 `presentCall` 测试以适配新 `rawInput`。
- `integration.spec.ts`：补一条完整 agent 循环下的 `merge` 用例（模型 mock、工具与 session 日志真实）。
- `invariant.ts` / `invariant.spec.ts` **无需改动**——merge 写出的仍是合法的 `todo/write` 快照（结构不变）。

## 文档

- `tool-todo/README.md`：改写 `## What it does` 与 `## Validation`，写明"优先用 `merge`/`remove`/`clear` 增量，除非任务方向发生重大调整才用 `replace` 整表"；更新 `## Known Limitations`（去掉"唯一操作"条，把稳定 id 移到有合理说明的 "Deferred" 行并按 `packages/AGENTS.md` 加 allowlist）。
- `tool-todo/README.zh.md`：镜像 README 改动（中英配对）。
- `docs/tool-catalog.md`：重新生成；`docs/tool-catalog.zh.md`：同步更新 `deepseek-aidsh-tool-todo` 片段。
- 更新两个 README 的 "Model Experience" 报错清单，加入新的"requires a `todos` array"文案。

## 验证（跑覆盖到改动的最小集合）

1. `pnpm test -- packages/todo/tool-todo`（聚焦 vitest，含覆盖——必须保持 100%）。
2. `pnpm run gen-tool-catalog` + 确认 `pnpm run verify-tool-catalog` 通过；刷新中文片段；跑 `pnpm run doc-sync`（覆盖 catalog + 翻译配对 + README model-experience）。
3. `pnpm run typecheck`、`pnpm run lint`、`pnpm run build`、`pnpm run hygiene`。
4. 用 `pnpm dsh --profile <profile> "task"` 从源码冒烟（需 `DEEPSEEK_API_KEY`）。

## 不改什么（及原因）

- 不改 `TodoItem` 结构、`todo/write` 事件、`session-projection` 折叠——持久化快照仍是"整表最后写入胜出"；`merge`/`remove` 只是**算出**一份新的整表再追加。把改动隔离在工具内，避免改数据结构的 ~9 个包波及面。
- 不加新的 session 事件类型——`action` 存在于工具调用参数里（已通过 `tool/call` 记入日志），结果仍是既有的 `todo/write` + `{ todos, counts }`。无 model-visible 输入缺口。

## 上线说明

对 checkout 的源码改动在下一次进程启动时生效（不会在本会话热加载），需重启 / 新会话才能拿到新工具行为。
