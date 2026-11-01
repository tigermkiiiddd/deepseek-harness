/** General Settings control for dynamic tool lazy folding. */
import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DeveloperToolsRow.module.css'

/** Accepted setting and ordered mutation supplied by the settings owner. */
export interface LazyToolFoldingRowInjected {
  hooks: {
    lazyToolFolding: ObservableSnapshot<boolean>
    pinnedTools: ObservableSnapshot<string>
  }
  setLazyToolFolding(enabled: boolean): Promise<void>
  setPinnedTools(pinned: string): Promise<void>
}

/**
 * Render the lazy-tool-folding single switch row in General Settings.
 */
export function LazyToolFoldingRow({
  useLazyToolFolding,
  setLazyToolFolding,
  t,
}: PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<LazyToolFoldingRowInjected>) {
  const enabled = useLazyToolFolding(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  return (
    <div className={css.row}>
      <div>
        <div className={css.title}>{t('lazyToolFolding.title')}</div>
        <div className={css.description}>{t('lazyToolFolding.description')}</div>
        {failed && <div role="alert">{t('developerTools.error')}</div>}
      </div>
      <Switch
        checked={enabled}
        disabled={busy}
        label={t('lazyToolFolding.title')}
        onChange={(next) => {
          setFailed(false)
          setBusy(true)
          void setLazyToolFolding(next)
            .catch(() => { setFailed(true) })
            .finally(() => { setBusy(false) })
        }}
      />
    </div>
  )
}
