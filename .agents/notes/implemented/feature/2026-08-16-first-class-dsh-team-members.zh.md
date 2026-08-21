# Agent Note：一等 `dsh` 团队成员

Status: implemented

[English](2026-08-16-first-class-dsh-team-members.md) | 中文

## 问题

ACP 虚拟团队允许用户添加长期运行的成员，但每个成员都必须手动配置 `command` 与 `args`。没有内置方式让成员成为“另一个 dsh”——一个与协调器运行同一安装、读取用户已保存设置与凭证、并保持自身会话隔离的对等 harness 进程。想要一等 dsh 队友的用户必须手写命令行并自行管理 home 目录隔离。

## 决策

新增 `kind: 'dsh'` 作为一等成员类型。当成员在配置中（或运行时）设置为 `kind: 'dsh'` 时，harness 自行解析派生规格：

- 禁止设置 `command` 与 `args`；成员以 `dsh --profile acp` 启动。
- 复用当前 Node 可执行文件与脚本，但剥离 Node debug/inspect 标志，避免子进程与父进程调试端口冲突。
- `DSH_HOME` 设为主 harness home 下的 per-member 目录（`<main-home>/members/<member-id>`），会话与附件相互隔离。
- `DSH_MAIN_HOME` 指回协调器 home，成员因此读取同一份 `settings.yaml`、`.credentials.yaml` 及其他 home 本地文件。

实现分布在整个能力接缝：

- `packages/team/team/src/resolve.ts` —— `resolveMemberSpec()` 将 `kind: 'dsh'` 展开为 `ResolvedMemberSpawnSpec`，并校验与 `command`/`args` 的互斥。
- `packages/team/team/src/member.ts` —— `MemberConnection.spawnSpec()` 消费解析后的规格；`inheritedMemberEnv()` 在 `config.env` 之后叠加 `DSH_HOME` / `DSH_MAIN_HOME`，显式的 per-member 环境项仍可覆盖。
- `packages/team/team/src/index.ts` —— 名册记录存储 `kind`，重建路径把它展开回 `MemberConfig`；`apply()` 现在会等待持久名册加载完成再 autostart，因此 `ctx.plugin(team)` 结束时完整名册已可见。
- `packages/team/team/src/spec.ts` / `types.ts` —— 持久名册形状与运行时类型携带 `kind?: 'dsh'`，`command`/`args` 变为可选。
- `packages/team/tool-team/src/index.ts` —— `member_add` 接受 `kind: 'dsh'`，并在选择该 kind 时从 schema 中省略 `command`/`args`。
- `packages/host/apiproxy/src/api/team.ts` 与 `team.schema.ts` —— wire view 包含 `kind`，并允许省略 `command`。
- `packages/boot/app-boot/src/profile.ts` —— 新增 `acp` profile 模板：`['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']`。
- `packages/bundle/acp-app` —— 把 `dsh-base` 变成自动化专用 ACP 服务器的组合补丁层：挂载 `dsh-acp`，把 `settings-file` 与 `credentials-local` 重定向到 `DSH_MAIN_HOME`，禁用 HMR，将 stdout 留给 ACP JSON-RPC。

测试覆盖 `resolveMemberSpec()`（argv、env、inspect 标志剥离、校验）、`kind` 经持久名册的往返，以及 `app-boot` 中 `acp` profile 的自动初始化。

## 备选方案

### 仅在 tool schema 中硬编码 `dsh --profile acp`

已否决：派生解析属于 team 服务，而非 tool。同一个 `kind: 'dsh'` 成员必须能从配置、模型工具、host API 及未来接缝中添加，因此展开逻辑集中在 `resolveMemberSpec()`。

### 让成员复用主 `DSH_HOME`

已否决：成员会话与附件会与协调器冲突。在主 home 下建立 per-member home 既能保持隔离，又能锚定同一安装与设置。

### 把设置文件复制到成员 home 以继承设置

已否决：复制存在竞态，且需要 team 服务了解 settings 与 credentials 的内部布局。`DSH_MAIN_HOME` 让现有 settings/credentials provider 原生读取协调器 home。

## 影响

- `kind: 'dsh'` 成员是启动对等 dsh agent 的最简方式：无需自定义命令、无需手动 home 接线，成员开箱即用协调器的模型设置。
- 成员进程仍是可信对等体：继承完整父环境（排除 `DSH_*` 命名空间），并叠加 per-member `env`。
- 持久名册存储 `kind`，因此持久化的 `dsh` 成员在重启后能被正确重新拉起。
- `acp` profile 仅用于自动化场景；它不包含 Host、HTTP server、Web runtime 或浏览器插件。
- 自定义命令成员保持原行为不变；`kind` 为可选，省略 `kind` 时仍需 `command`。
