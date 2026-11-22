/**
 * Tool Folding & Token Budget dedicated Settings Section.
 *
 * Provides a comprehensive dashboard for progressive tool disclosure,
 * real-time call frequency monitoring, token budget estimation, and
 * pin/fold toggling for local llama-server KV Cache optimization.
 */
import { useMemo, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LazyToolFoldingRowInjected } from './LazyToolFoldingRow.tsx'
import { clearStoredToolCallStats, getStoredToolCallStats, KNOWN_TOOLS_CATALOG } from './tool-stats.ts'
import css from './ToolFoldingSection.module.css'

type SortField = 'name' | 'desc' | 'category' | 'tokens' | 'calls' | 'status'
type SortDirection = 'asc' | 'desc'

/** The indispensable meta-tools that must always remain active to enable discovery, lookup, and execution. */
const MANDATORY_TOOLS = new Set<string>(['list_tools', 'get_tool_schema', 'call_tool'])

/** Recommended initial default set of pinned tools. */
const DEFAULT_RECOMMENDED_SET = new Set<string>(
  KNOWN_TOOLS_CATALOG.filter(item => item.isPinnedDefault).map(item => item.name),
)

export function ToolFoldingSection({
  useLazyToolFolding,
  usePinnedTools,
  setLazyToolFolding,
  setPinnedTools,
  t,
}: PropsRuntime<'settings.section'> & PropsLocale<'settings'> & InjectFace<LazyToolFoldingRowInjected>) {
  const enabled = useLazyToolFolding(value => value)
  const pinnedRaw = usePinnedTools(value => value) ?? ''

  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [search, setSearch] = useState('')
  const [statsRev, setStatsRev] = useState(0)
  const [sortField, setSortField] = useState<SortField>('calls')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const isCustomized = pinnedRaw.trim().length > 0

  const effectivePinnedSet = useMemo(() => {
    if (!isCustomized) {
      return DEFAULT_RECOMMENDED_SET
    }
    const set = new Set<string>()
    for (const item of pinnedRaw.split(/[\s,]+/)) {
      if (item.trim()) set.add(item.trim())
    }
    for (const m of MANDATORY_TOOLS) {
      set.add(m)
    }
    return set
  }, [pinnedRaw, isCustomized])

  const stats = useMemo(() => getStoredToolCallStats(), [statsRev])

  const { activeTokens, savedTokens, pinnedCount, foldedCount, totalTracked } = useMemo(() => {
    let active = 0
    let saved = 0
    let pCount = 0
    let fCount = 0

    for (const item of KNOWN_TOOLS_CATALOG) {
      const isPinned = !enabled || MANDATORY_TOOLS.has(item.name) || effectivePinnedSet.has(item.name)
      if (isPinned) {
        active += item.estimatedTokens
        pCount++
      } else {
        saved += item.estimatedTokens
        fCount++
      }
    }
    return {
      activeTokens: active,
      savedTokens: saved,
      pinnedCount: pCount,
      foldedCount: fCount,
      totalTracked: KNOWN_TOOLS_CATALOG.length,
    }
  }, [enabled, effectivePinnedSet])

  const savedPercent = activeTokens + savedTokens > 0
    ? Math.round((savedTokens / (activeTokens + savedTokens)) * 100)
    : 0

  const handleTogglePin = async (name: string, shouldPin: boolean): Promise<void> => {
    if (MANDATORY_TOOLS.has(name)) return

    const nextSet = new Set(effectivePinnedSet)
    if (shouldPin) {
      nextSet.add(name)
    } else {
      nextSet.delete(name)
    }
    for (const m of MANDATORY_TOOLS) {
      nextSet.add(m)
    }
    const nextStr = Array.from(nextSet).join(', ')
    setBusy(true)
    try {
      await setPinnedTools(nextStr)
    } finally {
      setBusy(false)
    }
  }

  const handleResetToDefaults = async (): Promise<void> => {
    setBusy(true)
    try {
      await setPinnedTools('')
    } finally {
      setBusy(false)
    }
  }

  const handleResetStats = (): void => {
    clearStoredToolCallStats()
    setStatsRev(r => r + 1)
  }

  const filteredTools = useMemo(() => {
    return KNOWN_TOOLS_CATALOG.filter((item) => {
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return item.name.toLowerCase().includes(q) ||
        item.labelZh.toLowerCase().includes(q) ||
        item.labelEn.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
    })
  }, [search])

  const handleHeaderClick = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDirection(field === 'calls' || field === 'tokens' ? 'desc' : 'asc')
    }
  }

  const sortedTools = useMemo(() => {
    const list = [...filteredTools]
    const dir = sortDirection === 'asc' ? 1 : -1

    list.sort((a, b) => {
      if (sortField === 'calls') {
        const countA = stats[a.name] ?? 0
        const countB = stats[b.name] ?? 0
        if (countA !== countB) return (countA - countB) * dir
      } else if (sortField === 'tokens') {
        if (a.estimatedTokens !== b.estimatedTokens) {
          return (a.estimatedTokens - b.estimatedTokens) * dir
        }
      } else if (sortField === 'name') {
        const cmp = a.name.localeCompare(b.name)
        if (cmp !== 0) return cmp * dir
      } else if (sortField === 'desc') {
        const cmp = a.labelZh.localeCompare(b.labelZh, 'zh-CN')
        if (cmp !== 0) return cmp * dir
      } else if (sortField === 'category') {
        const cmp = a.category.localeCompare(b.category, 'zh-CN')
        if (cmp !== 0) return cmp * dir
      } else if (sortField === 'status') {
        const isPinnedA = !enabled || MANDATORY_TOOLS.has(a.name) || effectivePinnedSet.has(a.name)
        const isPinnedB = !enabled || MANDATORY_TOOLS.has(b.name) || effectivePinnedSet.has(b.name)
        if (isPinnedA !== isPinnedB) {
          return (isPinnedA ? 1 : -1) * dir
        }
      }
      return a.name.localeCompare(b.name)
    })

    return list
  }, [filteredTools, sortField, sortDirection, stats, enabled, effectivePinnedSet])

  const renderSortIndicator = (field: SortField) => {
    if (sortField !== field) {
      return <span className={css.sortIndicatorInactive}>↕</span>
    }
    return (
      <span className={css.sortIndicatorActive}>
        {sortDirection === 'asc' ? '▲' : '▼'}
      </span>
    )
  }

  return (
    <div className={css.section}>
      <div className={css.headerRow}>
        <div>
          <h2 className={css.heading}>{t('toolFolding.title')}</h2>
          <p className={css.intro}>{t('toolFolding.description')}</p>
          {failed && <div className={css.errorAlert} role="alert">{t('developerTools.error')}</div>}
        </div>
        <div className={css.switchBox}>
          <Switch
            checked={enabled}
            disabled={busy}
            label={t('toolFolding.title')}
            onChange={(next) => {
              setFailed(false)
              setBusy(true)
              void setLazyToolFolding(next)
                .catch(() => { setFailed(true) })
                .finally(() => { setBusy(false) })
            }}
          />
        </div>
      </div>

      <div className={css.metricsGrid}>
        <div className={css.metricCard}>
          <div className={css.metricValue}>
            ~{Math.round(activeTokens / 100) / 10}k
            <span className={css.subCount}>({pinnedCount} 个常驻)</span>
          </div>
          <div className={css.metricLabel}>当前活跃 Wire Token</div>
        </div>
        <div className={css.metricCard}>
          <div className={css.metricValue}>
            <span className={css.metricHighlight}>~{Math.round(savedTokens / 100) / 10}k</span>
            <span className={css.subCount}>({foldedCount} 个折叠)</span>
          </div>
          <div className={css.metricLabel}>惰性折叠已节省 Token</div>
        </div>
        <div className={css.metricCard}>
          <div className={css.metricValue}>
            <span className={css.metricHighlight}>{enabled ? `${savedPercent}%` : '未开启'}</span>
          </div>
          <div className={css.metricLabel}>上下文前缀负载降低</div>
        </div>
        <div className={css.metricCard}>
          <div className={css.metricValue}>
            {totalTracked}
          </div>
          <div className={css.metricLabel}>已跟踪工具总数</div>
        </div>
      </div>

      <div className={css.tableHeader}>
        <div className={css.tableControls}>
          <input
            type="text"
            className={css.searchInput}
            placeholder="搜索工具标识、中文名或分类..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {isCustomized && (
            <button
              type="button"
              className={css.resetButton}
              onClick={() => { void handleResetToDefaults() }}
              title="重置为默认推荐的常驻配置"
              disabled={busy}
            >
              恢复推荐配置
            </button>
          )}
          <button
            type="button"
            className={css.resetButton}
            onClick={handleResetStats}
            title="清空调用统计"
          >
            清空调用频次
          </button>
        </div>
      </div>

      <div className={css.toolsTableContainer}>
        <table className={css.toolsTable}>
          <thead>
            <tr>
              <th className={css.sortableTh} onClick={() => handleHeaderClick('name')} title="点击按工具标识排序">
                <div className={css.thContent}>
                  <span>工具名称 (Identifier)</span>
                  {renderSortIndicator('name')}
                </div>
              </th>
              <th className={css.sortableTh} onClick={() => handleHeaderClick('desc')} title="点击按功能描述排序">
                <div className={css.thContent}>
                  <span>功能描述</span>
                  {renderSortIndicator('desc')}
                </div>
              </th>
              <th className={css.sortableTh} onClick={() => handleHeaderClick('category')} title="点击按分类排序">
                <div className={css.thContent}>
                  <span>分类</span>
                  {renderSortIndicator('category')}
                </div>
              </th>
              <th className={css.sortableTh} onClick={() => handleHeaderClick('tokens')} title="点击按预估Token排序">
                <div className={css.thContent}>
                  <span>预估 Token</span>
                  {renderSortIndicator('tokens')}
                </div>
              </th>
              <th className={css.sortableTh} onClick={() => handleHeaderClick('calls')} title="点击按实际调用频次排序">
                <div className={css.thContent}>
                  <span>实际调用</span>
                  {renderSortIndicator('calls')}
                </div>
              </th>
              <th
                className={`${css.sortableTh} ${css.switchTh}`}
                onClick={() => handleHeaderClick('status')}
                title="点击按常驻状态排序"
              >
                <div className={css.thContent}>
                  <span>常驻</span>
                  {renderSortIndicator('status')}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedTools.map((tool) => {
              const isMandatory = MANDATORY_TOOLS.has(tool.name)
              const isPinned = !enabled || isMandatory || effectivePinnedSet.has(tool.name)
              const count = stats[tool.name] ?? 0

              return (
                <tr key={tool.name}>
                  <td>
                    <span className={css.toolNameCode}>{tool.name}</span>
                  </td>
                  <td>
                    <div className={css.toolDescMain}>{tool.labelZh}</div>
                    <div className={css.toolDescSub}>{tool.description}</div>
                  </td>
                  <td>
                    <span className={css.categoryTag}>{tool.category}</span>
                  </td>
                  <td>~{tool.estimatedTokens}</td>
                  <td>
                    <span className={count > 0 ? css.callCountActive : css.callCountMuted}>
                      {count} 次
                    </span>
                  </td>
                  <td>
                    <div className={css.switchWrapper}>
                      <Switch
                        checked={isPinned}
                        disabled={isMandatory || busy || !enabled}
                        label={`${tool.name} 常驻`}
                        title={
                          !enabled
                            ? '需先开启工具折叠总开关'
                            : isMandatory
                              ? '底层调度工具（必须常驻）'
                              : isPinned
                                ? '已常驻（点击切换为折叠）'
                                : '已折叠（点击切换为常驻）'
                        }
                        onChange={(next) => {
                          void handleTogglePin(tool.name, next)
                        }}
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
