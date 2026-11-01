/**
 * LocalStorage tool statistics and token estimation store.
 */

export interface ToolStatItem {
  name: string
  labelZh: string
  labelEn: string
  category: 'file' | 'search' | 'shell' | 'subagent' | 'web' | 'skill' | 'plan' | 'domain' | 'meta'
  estimatedTokens: number
  description: string
  isPinnedDefault: boolean
}

export const KNOWN_TOOLS_CATALOG: readonly ToolStatItem[] = [
  // Core Pinned Tools
  { name: 'read', labelZh: '读取文件', labelEn: 'Read File', category: 'file', estimatedTokens: 380, description: '读取指定路径文件内容', isPinnedDefault: true },
  { name: 'read_image', labelZh: '读取图片', labelEn: 'Read Image', category: 'file', estimatedTokens: 400, description: '读取并在上下文渲染图片附件', isPinnedDefault: true },
  { name: 'write', labelZh: '写入文件', labelEn: 'Write File', category: 'file', estimatedTokens: 420, description: '全量写入文件内容', isPinnedDefault: true },
  { name: 'edit', labelZh: '编辑文件', labelEn: 'Edit File', category: 'file', estimatedTokens: 450, description: '局部替换文件指定文本块', isPinnedDefault: true },
  { name: 'str_replace_editor', labelZh: '精确文本替换', labelEn: 'String Replace', category: 'file', estimatedTokens: 410, description: '精确匹配并替换内容', isPinnedDefault: true },
  { name: 'find_by_name', labelZh: '文件名搜索', labelEn: 'Find by Name', category: 'search', estimatedTokens: 320, description: '按名称或模式查找文件', isPinnedDefault: true },
  { name: 'grep_search', labelZh: '正则/文本搜索', labelEn: 'Grep Search', category: 'search', estimatedTokens: 390, description: '在工作区多文件快速搜索文本', isPinnedDefault: true },
  { name: 'glob', labelZh: 'Glob 通配符查找', labelEn: 'Glob Search', category: 'search', estimatedTokens: 310, description: '按通配符模式展开匹配路径', isPinnedDefault: true },
  { name: 'bash', labelZh: 'Bash 命令行', labelEn: 'Bash Shell', category: 'shell', estimatedTokens: 520, description: '在终端执行 Bash 脚本命令', isPinnedDefault: true },
  { name: 'pwsh', labelZh: 'PowerShell 命令行', labelEn: 'PowerShell', category: 'shell', estimatedTokens: 520, description: '在终端执行 PowerShell 命令', isPinnedDefault: true },
  { name: 'subagent', labelZh: '子代理派发', labelEn: 'Spawn Subagent', category: 'subagent', estimatedTokens: 680, description: '派发独立会话的子代理协作执行', isPinnedDefault: true },
  { name: 'subagent_list_agents', labelZh: '查询活跃子代理', labelEn: 'List Subagents', category: 'subagent', estimatedTokens: 280, description: '获取当前活跃的子代理状态列表', isPinnedDefault: true },
  { name: 'web_search', labelZh: '网页搜索', labelEn: 'Web Search', category: 'web', estimatedTokens: 410, description: '调用搜索引擎检索外部互联网资讯', isPinnedDefault: true },
  { name: 'web_fetch', labelZh: '网页内容抓取', labelEn: 'Web Fetch', category: 'web', estimatedTokens: 460, description: '抓取并解析网页为纯文本或 Markdown', isPinnedDefault: true },
  { name: 'skill', labelZh: '专业技能调用', labelEn: 'Run Skill', category: 'skill', estimatedTokens: 490, description: '激活并调用内置或外部专业技能', isPinnedDefault: true },
  { name: 'ask_user_question', labelZh: '询问用户选择', labelEn: 'Ask Question', category: 'plan', estimatedTokens: 360, description: '向用户提出单选/多选确认选项', isPinnedDefault: true },
  { name: 'todo_write', labelZh: '任务清单管理', labelEn: 'Update Todos', category: 'plan', estimatedTokens: 780, description: '更新多步骤任务清单与执行进度', isPinnedDefault: true },
  { name: 'list_tools', labelZh: '检索与列出可用工具', labelEn: 'List / Search Tools', category: 'meta', estimatedTokens: 190, description: '按关键词模糊检索或列出所有已折叠的专业工具', isPinnedDefault: true },
  { name: 'get_tool_schema', labelZh: '查询工具完整 Schema', labelEn: 'Get Tool Schema', category: 'meta', estimatedTokens: 180, description: '按需查询被折叠工具的完整参数和用法', isPinnedDefault: true },
  { name: 'call_tool', labelZh: '万能折叠工具代理', labelEn: 'Call Tool (Proxy)', category: 'meta', estimatedTokens: 210, description: '代理执行任何被折叠的工具', isPinnedDefault: true },

  // Folded / Heavy Domain Tools
  { name: 'workflow', labelZh: '复杂工作流编排', labelEn: 'Workflow Engine', category: 'domain', estimatedTokens: 4800, description: '多阶段 DAG 异步子任务调度与流程引擎', isPinnedDefault: false },
  { name: 'tool_team', labelZh: '多智能体团队协作', labelEn: 'Agent Team', category: 'domain', estimatedTokens: 6200, description: '多角色代理协同、会话中继与角色分配', isPinnedDefault: false },
  { name: 'tool_jobs', labelZh: '后台长作业管理', labelEn: 'Background Jobs', category: 'domain', estimatedTokens: 1800, description: '启动、监控与终止异步常驻后台进程', isPinnedDefault: false },
  { name: 'tool_schedule', labelZh: '定时与周期调度', labelEn: 'Scheduler', category: 'domain', estimatedTokens: 1900, description: '配置 Cron 表达式或倒计时定时触发器', isPinnedDefault: false },
  { name: 'tool_lsp', labelZh: '语言服务器 (LSP)', labelEn: 'LSP Diagnostics', category: 'domain', estimatedTokens: 3100, description: '代码定义跳转、类型检查与语义重构', isPinnedDefault: false },
  { name: 'tool_session_query', labelZh: '历史会话向量查询', labelEn: 'Session Query', category: 'domain', estimatedTokens: 1500, description: '多轮对话历史记忆与相似度检索', isPinnedDefault: false },
  { name: 'tool_goal', labelZh: '自主长任务目标追踪', labelEn: 'Goal Tracking', category: 'domain', estimatedTokens: 2200, description: '长时间全自主执行直到达成目标', isPinnedDefault: false },
  { name: 'tool_plugin_manager', labelZh: '插件安装与包管理', labelEn: 'Plugin Manager', category: 'domain', estimatedTokens: 1800, description: '安装、配置、卸载 Cordis 插件与运行时包', isPinnedDefault: false },
  { name: 'tool_plugin_market', labelZh: '插件市场检索', labelEn: 'Plugin Market', category: 'domain', estimatedTokens: 1600, description: '检索与发现社区插件库', isPinnedDefault: false },
]

const STATS_STORAGE_KEY = 'dsh.tool_call_stats'

export function getStoredToolCallStats(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STATS_STORAGE_KEY)
    return raw ? JSON.parse(raw) as Record<string, number> : {}
  } catch {
    return {}
  }
}

export function clearStoredToolCallStats(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(STATS_STORAGE_KEY)
  } catch {}
}
