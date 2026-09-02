# Agent Note: 通过生成式 Remote 生命周期挂载原生 Team Web UI

Status: implemented

[English](2026-09-02-team-web-remote-lifecycle.md) | 中文

## Problem

原生 Team Web 插件依赖已移除的 API-proxy 与 client-runtime 界面。上游 Client 装配变化后，其浏览器入口可能因模块未物化而加载失败，也可能从 Web profile 消失；原样恢复源码仍会引用已不存在的包名与槽位。Host Team 服务也没有浏览器安全的生成式 Remote 贡献，因此只恢复 UI bundle 配置无法得到可加载的完整功能。

## Decision

`@deepseek-ai/dsh-team` 拥有生成式 `team` Remote 命名空间，公开浏览器安全的名册与话题行。`@deepseek-ai/dsh-client-ui-team` 先挂载该贡献，只在 `remote.team`、sessions 与 slots 可用后创建控制器，并把全局栏注册进 `sidebar.footer.action`。销毁时先释放控制器与槽位，再卸载 Remote 贡献。Web bundle 同时包含 Team 服务、Team 工具与 Team UI。

桌面启动器以源码启动 Web profile 打印的鉴权 URL 作为就绪信号，并在固定端口上干净替换已有 DSH Web 主进程。浏览器 bundle 依赖已物化的包工厂，不使用动态 workspace require。

## Testing

Team UI 的 facade、控制器与组件测试覆盖 Remote 失败解包、成员会话选择、名册管理和渲染。生产 Web 构建与经桌面启动路径执行的 Chrome smoke 验证页面含 Team 控件，且没有插件加载错误或控制台错误。

## Alternatives considered

**恢复已移除的 API-proxy 方法与 client-runtime 聚合包。** 拒绝：这些包已不是当前上游接口的所有者；原生代码可直接使用现有 Remote 与 Session Controller 服务，无需围绕旧接口建立兼容层。

**把 Team 加入全局 API Remote 装配。** 拒绝：Team 是由 Web bundle 选择的原生可选功能。其 UI 自行挂载生成式贡献，使基础 Client 装配不依赖 Team。

## Consequences

原生 Team 功能保持可选，但以完整 Host/Browser 切片加载。浏览器数据显式可序列化，UI 创建不会与 Remote 命名空间竞态，销毁也不会让 UI 消费者继续连接已卸载的命名空间。Web 打包前，Team 包构建必须产出生成式 Typert host 与 remote-client 产物。
