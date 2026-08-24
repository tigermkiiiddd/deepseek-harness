# Agent Note: ACP 成员的模型与 provider 配置

Status: implemented

[English](2026-08-23-acp-member-model-and-provider-config.md) | 中文

## 问题

ACP 虚拟团队让每个成员拥有自己的性格、会话和模型，但面向模型的工具 `member_sessions` / `member_chat` 只能列出话题、进行对话——无法查看或修改成员的模型或 provider 配置。用户希望通过工具配置 ACP 成员（grok 式），而不是手改配置文件。harness 只持有与成员之间的 stdio 管道，成员的模型与 provider 路由都在成员进程内，所以 harness 没有可编辑的文件——唯一的接缝是 ACP 协议。

## 决策

模型与 provider 配置都经 ACP 协议线，绝不手改文件。`packages/team/team` 新增四个 `team` 服务方法，分别经 ACP 与成员通信：`getConfig` 与 `setConfig` 处理会话配置项，`listProviders` 与 `setProvider` 处理 provider 配置。`packages/team/tool-team` 暴露 `member_model`（`action: "get"` / `"set"`）与 `member_provider`（`action: "list"` / `"set"`）；`member_sessions` 增加 `model` 列。

会话配置项按会话 id 缓存：来源是成员在 `session/new` 与 `session/load` 带回的项，以及任何 `session/config_option_update` 通知。`getConfig` 从该缓存派生解析后的快照（配置项加模型快捷方式）；`setConfig` 经 `session/set_config_option` 写入一个项并刷新缓存。模型快捷方式挑选 UX 类别或 id 为 `"model"` 的项。ACP 没有配置项的能力标志——唯一信号是会话带回的项，因此不声明任何项的成员不会产生缓存，`getConfig` 会抛出。

provider 配置受成员在 `initialize` 中声明的 `providers` 能力（`AgentCapabilities.providers`）门控。与不带能力标志的配置项不同，`listProviders` 与 `setProvider` 在能力缺失时报告「does not support provider configuration」。不缓存秘密：agent 在其自身侧保存 provider 路由配置，所以 `setProvider` 绝不持久化凭证。

工具采用捕获并报告而非抛出：没有配置项、或缺乏 `providers` 能力的成员，返回一行「does not support」消息，使模型看到清晰信号而非崩溃。

## 替代方案

**手改成员的配置文件。** 被用户明确否决：harness 只持有 stdio 管道，没有可编辑的文件——成员进程拥有自己的模型与 provider 路由，ACP 线是唯一接缝。

**harness 侧的模型/provider 注册表。** 否决：模型与 provider 路由存在于成员进程而非 harness；harness 控制的注册表会与成员实际提供的服务脱节，并持久化 harness 并非合适所有者的凭证。

## 测试

真实子进程的组合测试经 ACP 线锁定两条接缝。`member_model get` 在成员声明配置项时读取缓存的模型及其可选 value id，在成员不声明时报告「no session config」；`member_model set` 写入一个 value id 并返回更新后的快照。`member_provider list` 返回声明的 provider，在能力缺失时报告「does not support provider configuration」；`member_provider set` 配置一个成员并校验其字符串 header。服务层测试在 `getConfig` / `setConfig` / `listProviders` / `setProvider` 上锁定相同路径，包括 provider 能力门控。

## 后果

模型现在能与对话相同的工具里查看并修改成员的模型与 provider 配置，无需离开 harness，也无需触碰文件。代价是按会话 id 索引的每会话项缓存，以及让 `getConfig` 的缓存与 `session/config_option_update` 保持一致的持续义务——漏掉一次更新会留下陈旧的模型或选项集。

本注延伸自 [ACP 虚拟团队](2026-08-16-acp-virtual-team.zh.md)，后者拥有成员生命周期与话题对话。读取本 seam 做 Web 会话域模型选择桥的决策记录在 [Web 成员对等接入](2026-08-24-web-member-parity-integration.zh.md)。
