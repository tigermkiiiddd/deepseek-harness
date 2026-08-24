# `@deepseek-ai/dsh-acp-app`

[English](README.md) | 中文

dsh ACP 服务器组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.zh.md) 之上：挂载自动化专用的 [`dsh-acp`](../../acp/acp/README.zh.md) 插件与预设名册，并禁用 HMR（热模块替换）以让 stdout 专用于 ACP JSON-RPC。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

该组合包是一等 `dsh` 团队成员使用的 profile：以 `dsh --profile acp` 启动的成员进程与协调器运行同一 harness 安装，但拥有自包含的独立 `DSH_HOME`——成员的 settings、凭证与可选自有预设由主实例在创建时一次性播种进该 home（按文件幂等；见 `@deepseek-ai/dsh-team/member-home`），因此会话相互隔离，且成员在运行时不继承主实例的任何状态。

## 模型体验

无影响，因为本组合包仅暴露 ACP 桥；成员的模型、工具与提示词由 base 组合及任何 profile/用户覆盖层决定。

#### KV Cache 影响

无；本组合包不向请求前缀添加任何内容。

## 已知限制与暂缓事项

- **仅自动化**——无人 facing 的 surface；成员完全通过 ACP wire 被驱动。
- **播种式设置**——成员的模型默认值与凭证来自主实例文档的播种副本；播种完成后成员独立管理自己的取值。
