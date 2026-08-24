# Agent Note: dsh 成员拥有自己的 preset

Status: implemented

[English](2026-08-23-dsh-member-own-preset.md) | 中文

## 问题

每个团队成员都应是独一无二、自带人设的 agent，但 `member_add` 没有任何途径赋予它：`dsh` 成员把同一套安装作为协调器重新拉起，装配自部署的默认 preset。此前两种形态被否决：从公共 preset 名册挑一个 id（该成员会与所有同名 id 的 agent 共享人设），以及经 ACP 会话配置项做运行时 `member_persona` 切换工具（已实现、后被用户砍掉——按会话切换人设并不是「每个成员都是独一无二的人」的意思）。

## 决策

成员的 persona 是创建时写入其自身 home 的数据。`MemberConfig` 增加可选 `preset` 字段——一份 YAML 顶层插件行列表（persona、工具、prompt 段）——`member_add` 将其暴露为参数。只有 `kind: 'dsh'` 成员可以携带；`resolveMemberSpec` 对没有 `kind: 'dsh'` 的 preset 大声失败，因为只有 dsh 成员有承载它的 harness home。

创建时，`seedMemberHome` 把 composition 播种到 `<memberHome>/.agent-presets/<presetId>/agent.cordis.yml`，并把成员的 settings 指向它（`agent-presets.default`），使该成员创建的每个会话都装配自己的 preset 而非部署默认。preset id 由成员 id 派生（小写、非 `[a-z0-9]` 连成 `-`）且须满足 preset-id 文法；未通过加载器形状检查的 composition 让 `addMember` 大声失败——校验只在一处，`compositionTextProblem`，从 `dsh-agent-presets` discovery 中抽出，team 包不重复实现条目列表规则。

播种按 home 幂等：已存在的成员 home 绝不重播种，重启不会覆盖成员对自己 composition 的修改——与 settings 和凭证拷贝已有的保证相同。配置声明与名册恢复的 dsh 成员在加载时播种（失败告警、继续启动）；运行时添加的成员在 `addMember` 中播种（大声失败）。名册记录携带 preset 文本，因此 home 被删掉的成员重启后能从名册恢复自己的 preset。

ACP bridge 从挂载的 preset 名册装配每个创建的 agent（`presets.mount(agentCtx)`）；这是成员自身 persona 生效的唯一途径。没有运行时人设切换工具：`member_persona` 添加与 ACP persona 配置项已删除，模型选择器作为唯一会话配置项保留，支撑已 shipped 的 `member_model`。

## 替代方案

**从公共 preset 名册挑 id。** 被用户否决：preset 是共享目录，成员点名册即与其他所有同名 agent 共享人设。每个成员须独一无二，因此各自拥有自己的 composition。

**`member_persona` 运行时切换（ACP 会话配置项）。** 已实现后被用户否决为错误功能：按会话切换人设与「每个成员都是独一无二的人」矛盾。已从 bridge、工具包及其测试中删除；模型选择器保留，因为它支撑已 shipped 的 `member_model`。

**preset 文本存入名册记录。** 采纳——不是作为主存储（主存储在成员 home），而是作为能扛过 home 删除的持久状态：名册本就负责重新拉起成员，从同一条记录恢复其 persona 是最便宜的恢复方式。

## 测试

`compositionTextProblem` 在 `dsh-agent-presets` 中直接单测（接受 `!!js`、拒绝非列表与坏 YAML）。`seedMemberHome` 测试锁定 preset 路径：composition 落在 `<memberHome>/.agent-presets/<id>/agent.cordis.yml`，settings 指向它且保留其余各节（YAML 与 JSON 文档），派生 id 对未净化的成员 id 做净化，坏 composition 大声拒绝，重播种绝不覆盖成员自己的修改。`resolveMemberSpec` 拒绝没有 `kind: 'dsh'` 的 preset；`member_add` 把 preset 透传给 `addMember`。ACP bridge 测试继续断言仅含模型的会话配置项。

## 后果

dsh 成员的独一无二程度等于为其写入的 composition，无共享名册间接层、无运行时切换。代价：persona 对该 home 终身固定——要改就得编辑成员 home 的 preset 文件，或删除并重新添加该成员——名册记录随每个成员的 composition 体积增长。发布前两者均可接受；日后若要运行时重组功能，那是一个新决策，而非对本注的放宽。

本注延伸自 [ACP 虚拟团队](2026-08-16-acp-virtual-team.zh.md) 与 [ACP 成员的模型与 provider 配置](2026-08-23-acp-member-model-and-provider-config.zh.md)，后者分别拥有成员生命周期、话题对话与模型/provider 配置。
