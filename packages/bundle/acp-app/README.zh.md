# `@deepseek-ai/dsh-acp-app`

[English](README.md) | 中文

dsh ACP 服务器组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：挂载自动化专用的 [`dsh-acp`](../../acp/acp/README.md) 插件，把 `settings-file` 与 `credentials-local` 的文档路径重定向到**主实例的 harness home**（`DSH_MAIN_HOME`），并禁用 HMR（热模块替换）以让 stdout 专用于 ACP JSON-RPC。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

该组合包是一等 `dsh` 团队成员使用的 profile：以 `dsh --profile acp` 启动的成员进程与协调器运行同一 harness 安装，读取同一份 `settings.yaml` 与 `.credentials.yaml`，但拥有独立的 `DSH_HOME`，从而让其会话存储与附件与主实例隔离。

## 模型体验

无影响，因为本组合包仅暴露 ACP 桥；成员的模型、工具与提示词由 base 组合及任何 profile/用户覆盖层决定。

#### KV Cache 影响

无；本组合包不向请求前缀添加任何内容。

## 已知限制与暂缓事项

- **仅自动化**——无人 facing 的 surface；成员完全通过 ACP wire 被驱动。
- **继承模型设置**——成员使用主实例保存的模型选择与凭证，不自带默认值。
