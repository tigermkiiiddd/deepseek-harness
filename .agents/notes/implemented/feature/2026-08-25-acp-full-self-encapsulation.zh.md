# Agent Note: ACP 全量自封装——桥投影完整 harness 能力面

状态：已实现

[English](2026-08-25-acp-full-self-encapsulation.md) | 中文

## 问题

ACP 桥只暴露了薄薄一层（prompt、配置项模型选择器），成员能力只能在宿主侧造假或拒绝：历史靠虚拟会话回放合成、图片读取靠准入登记表、rename/fork/queue/rerun 一律「不支持」、模型目录被收窄到单一路由——这就是 Web 界面上成员模型无法选择的根源。

## 决策

桥现在把完整 harness 能力面投影到 ACP 上，宿主只消费协议协商出的能力。差异存在于缝之下（成员进程内），绝不以拒绝或前端分支的形式存在：

- **模型目录**（`27284ccb64`）：全部已注册 llm 路由合成一个选择器，选项 value 用组合串 `provider/model`；解码对枚举条目整串匹配（含斜杠安全）；选中同时改写 provider 与 model——跨 provider 切换可用。广告不再要求预置选择。
- **扩展传输**：原生 ACP `extMethod`，经 `agentCapabilities._meta.dsh.extensions[]` 声明。已实现：`dsh/session/historyPage|rename|queue|state|compact|search|export|rerun` 与 `dsh/attachment/get`。原生面直接使用：`unstable_forkSession`、`listSessions`、`setSessionConfigOption`、providers。
- **重发**（`9f52aabdfd`）：live 代理原位 reseed（`keepSeqs` = 锚点前最后一个完成 turn，延伸到下一 turn/start 或 inbox splice——与宿主规则逐字一致）；冷话题走持久化截断。
- **提问**（`ae69328b5c`、`dbaa644a2b`）：桥注册为成员的 user-questions provider，批次经反向扩展通道 `dsh/user/question` 转发；team 连接层映射到共享的 mux `question/requested|resolved` 帧，现有网页问题面板无需改动即可应答成员提问。未绑定或无订阅者的批次软性谢绝（空答案）。
- **宿主消费**（`5770f13568`、`910950080e`）：rename/fork/queue 走扩展；fork 广播新话题行；缓存热的历史读取直接分页持久日志而非回放；rerun 暂保持「重发即新回合」，直到虚拟 seq 与成员日志索引的对齐完成（唯一延后的映射）。
- **播种**（`cb088226a6`）：按工件幂等——settings/credentials/preset 各自在自身缺失时补种，存量残缺 home 启动即修复且不覆盖成员自有写入。
- **有意保留**：`memberAdmittedImages` 不是重复存储——准入把字节存进**宿主**附件库（内容寻址 id 与成员侧一致），该表是读取授权记录，因为成员话题没有宿主日志可作授权依据。

## 后果

每个会话域操作对成员都有真实实现；客户端动作层面零成员知识。剩余字符串解析（agent 域树分组）属于展示路由，不是行为门禁。其他位置的既有失败（full-fidelity 的协商/排序）顺带修复（`9437eb1f12`）——acp 套件 127/127 全绿。

取代 [ACP 成员模型与 provider 配置](2026-08-23-acp-member-model-and-provider-config.zh.md) 记录的拒绝式姿态与 [Web 成员对等集成](2026-08-24-web-member-parity-integration.zh.md) 记录的隐藏式姿态。
