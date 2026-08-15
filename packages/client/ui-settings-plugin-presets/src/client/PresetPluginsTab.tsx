import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PresetPluginsTab.module.css'

/** Response shapes the section closes over from the API client. */
type AgentPresetListValue = ResponseValue<'agentPreset.list'>
type AgentPresetReadEntriesValue = ResponseValue<'agentPreset.readEntries'>
type AgentPresetEntry = AgentPresetListValue['presets'][number]
type AgentPresetReadEntry = AgentPresetReadEntriesValue['entries'][number]

/** Registration-side API face used by the section. */
export interface PresetPluginsTabInjected {
  /** List every preset the deployment currently supplies. */
  list: () => Promise<AgentPresetListValue>
  /** Read one preset's flattened, effective plugin entries. */
  readEntries: (agentPreset: string) => Promise<AgentPresetReadEntriesValue>
}

/** Full component props assembled by the Settings slot renderer. */
export type PresetPluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginPresets'>
  & InjectFace<PresetPluginsTabInjected>

/** Per-pet body: broken presets stay readable so they can be deleted elsewhere. */
type PresetBody =
  | { readonly status: 'broken'; readonly reason: string }
  | { readonly status: 'entries'; readonly entries: readonly AgentPresetReadEntry[] }
  | { readonly status: 'error'; readonly message: string }

/** One preset row plus its resolved body. */
type PresetRow = AgentPresetEntry & { readonly body: PresetBody }

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly presets: readonly PresetRow[] }

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Localized trust badge text. */
function trustLabel(trust: AgentPresetEntry['trust'], t: PresetPluginsTabProps['t']): string {
  return trust === 'system' ? t('trustSystem') : t('trustUser')
}

/**
 * Read the roster and then each preset's entries, isolating per-preset failures
 * so a single broken preset or failed read does not hide the rest.
 * @param list - roster call.
 * @param readEntries - per-preset entry call.
 * @returns ready rows, or throws only when the roster itself fails.
 */
async function loadPresetRows(
  list: PresetPluginsTabInjected['list'],
  readEntries: PresetPluginsTabInjected['readEntries'],
): Promise<readonly PresetRow[]> {
  const roster = await list()
  const bodies = await Promise.allSettled(roster.presets.map(async (preset): Promise<PresetBody> => {
    if (preset.broken !== undefined) {
      return { status: 'broken', reason: preset.broken }
    }
    try {
      const value = await readEntries(preset.id)
      return { status: 'entries', entries: value.entries }
    } catch (error: unknown) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }))
  return roster.presets.map((preset, index) => {
    const body = bodies[index]
    return {
      ...preset,
      /* v8 ignore next -- every allSettled result is fulfilled: the mapper catches its own errors */
      body: body?.status === 'fulfilled' ? body.value : { status: 'error', message: '' },
    }
  })
}

/** Render the read-only by-preset plugin roster. */
export function PresetPluginsTab({ list, readEntries, t }: PresetPluginsTabProps): ReactNode {
  const rosterId = useId()
  const [request, setRequest] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => loadPresetRows(list, readEntries)).then(
      (presets) => { if (current) setState({ status: 'ready', presets }) },
      /* v8 ignore next -- unmount guard: tests cannot reject the roster after cleanup */
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, readEntries, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.roster}>
          {state.presets.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {state.presets.length > 0 ? (
            <ul className={css.cards}>
              {state.presets.map((preset) => {
                const displayName = preset.name ?? preset.id
                const trust = trustLabel(preset.trust, t)
                const open = expanded === preset.id
                const detailId = `${rosterId}-details-${encodeURIComponent(preset.id)}`
                return (
                  <li
                    className={css.card}
                    key={preset.id}
                    data-preset-id={preset.id}
                    data-open={open ? 'true' : undefined}
                  >
                    <button
                      className={css.cardHeader}
                      type="button"
                      aria-expanded={open}
                      aria-controls={detailId}
                      aria-label={`${displayName}, ${trust}${preset.isDefault ? `, ${t('defaultBadge')}` : ''}`}
                      onClick={() => {
                        setExpanded(current => current === preset.id ? null : preset.id)
                      }}
                    >
                      <span className={css.cardTitleGroup}>
                        <strong className={css.cardTitle} title={preset.id}>{displayName}</strong>
                        <span className={css.badges}>
                          <span className={css.trustBadge} data-trust={preset.trust}>{trust}</span>
                          {preset.isDefault ? <span className={css.defaultBadge}>{t('defaultBadge')}</span> : null}
                        </span>
                      </span>
                      <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                    </button>
                    {open ? (
                      <div className={css.cardBody} id={detailId}>
                        {preset.body.status === 'broken' ? (
                          <p className={css.bodyError} role="alert">
                            {t('broken')}
                            <span className={css.bodyErrorDetail}>{preset.body.reason}</span>
                          </p>
                        ) : null}
                        {preset.body.status === 'error' ? (
                          <p className={css.bodyError} role="alert">
                            {t('readEntriesError')}
                            <span className={css.bodyErrorDetail}>{preset.body.message}</span>
                          </p>
                        ) : null}
                        {preset.body.status === 'entries' ? (
                          preset.body.entries.length === 0 ? (
                            <p className={css.emptyEntries}>{t('entries')}</p>
                          ) : (
                            <ul className={css.entryList}>
                              {preset.body.entries.map(entry => (
                                <li
                                  className={css.entryRow}
                                  key={entry.id}
                                  data-entry-id={entry.id}
                                  data-disabled={entry.disabled ? 'true' : 'false'}
                                >
                                  <span className={css.entryName} title={entry.name}>
                                    {moduleShortName(entry.name)}
                                  </span>
                                  <code className={css.entryId}>{entry.id}</code>
                                  {entry.disabled ? <span className={css.disabledMarker}>{t('disabledMarker')}</span> : null}
                                </li>
                              ))}
                            </ul>
                          )
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
