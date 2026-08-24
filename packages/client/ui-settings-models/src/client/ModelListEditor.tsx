/**
 * The model list of one pi-ai provider profile, plus the action that refreshes
 * what the route serves.
 *
 * The list is the profile's `models` array as the card holds it: an empty list
 * means "serve this route's built-in catalog", and any entry replaces that
 * catalog, so a row is only ever added deliberately. Refreshing asks the
 * adapter to re-sync the route's catalog from its own endpoints — the reply is
 * applied directly, never staged as candidates: a route that inherits its
 * catalog keeps inheriting it (the adapter's local cache now serves the
 * current listing), and a route whose list the user already owns has that list
 * replaced by the upstream one. A provider in draft gets its rows filled from
 * the endpoint's listing, so adding a provider is one pass instead of
 * save-then-return.
 *
 * A provider that cannot be interrogated (an unreachable endpoint, a protocol
 * with no readable listing) is not a dead end: the failure is shown next to the
 * rows the user can still fill in by hand.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { DiscoveredModelView, IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { formatCapacity, parseCapacity } from './DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * One configured model row. Structurally open, exactly like the DeepSeek
 * catalog editor's rows: a profile field this card does not edit — one a future
 * schema adds, or one hand-written in `settings.yaml` — has to survive being
 * edited here rather than being dropped by a rebuild.
 */
export type ModelDraft = DeepSeekModelDraft

/** A row's text field, or the empty string when unset or not a string. */
function textOf(model: ModelDraft, key: string): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model: ModelDraft, key: string): number | undefined {
  const value = model[key]
  return typeof value === 'number' ? value : undefined
}

/** What an interrogation needs, taken from the live form. */
export interface ProbeTarget {
  /** Settings namespace whose adapter family answers. */
  settingsNs: string
  /**
   * Route being edited, when the card edits one. An adapter that already
   * describes it answers from its own registry, so such a card can ask without
   * an endpoint at all.
   */
  provider?: string
  /** Endpoint as the form currently shows it. */
  baseURL?: string
  /** Wire protocol the form names, when it names one. */
  api?: string
  /** Key typed into the form and not yet stored, when there is one. */
  apiKey?: string
}

/** Props of {@link ModelListEditor}. */
export interface ModelListEditorProps {
  /** The rows as currently drafted. */
  models: readonly ModelDraft[]
  /** Whether the user layer currently owns the whole array; absent on a create. */
  overridden?: boolean
  /** Replace the drafted rows. */
  onChange: (models: ModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance; absent on a create. */
  onReset?: () => void
  /** Endpoint facts for the fetch action. */
  probe: ProbeTarget
  /**
   * Copy key naming why the fetch action is unavailable, or `undefined` when
   * it is. The card owns this because the key it would send is judged there:
   * asking with a key the form has already refused spends a round trip to be
   * told what the field already says.
   */
  probeBlocked?: keyof typeof en | undefined
  /**
   * Wire protocols a row may name, in adapter-reported order; absent when the
   * owning card cannot read them and no per-row protocol choice is offered.
   */
  protocols?: readonly string[]
  /** Wire face the fetch action calls. */
  api: Pick<IApiClient, 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
}

/** Disclosure chevron; rotates to point down while its row is open. */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Removal glyph for one model row. */
function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

/**
 * What an empty capacity field is worth, shown as its placeholder so a row left
 * blank does not read as a model with no capacity at all.
 *
 * The magnitudes are the adapter's own route-level fallbacks (`llm-pi-ai`'s
 * `defaultContextWindow` and `defaultMaxTokens`), spelled the way a person
 * would say them. They are a hint, not a mirror: this page counts `K` as 1000,
 * so typing `256K` stores 256000 while leaving the field blank keeps the
 * adapter's 262144. A deployment that overrides those defaults is not
 * reflected here — nothing on this page can read them.
 */
const CAPACITY_HINT: Readonly<Record<CapacityField, string>> = {
  contextWindow: '256K',
  maxTokens: '32K',
}

/**
 * Spell a stored count for a field that may be unset. The spelling itself is
 * {@link formatCapacity}, shared with the DeepSeek catalog editor so both
 * surfaces read and write one K/M vocabulary.
 * @param value - stored capacity, or `undefined` for an unset field.
 * @returns the field text, empty when unset.
 */
function capacitySpelling(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/** One listing row as a drafted model, keeping whatever the answerer disclosed. */
function draftOf(entry: DiscoveredModelView): ModelDraft {
  return {
    id: entry.id,
    // A protocol the answerer knew joins the row: on a route spanning several,
    // it is the one field nothing else can supply for a model the installed
    // catalog does not describe.
    ...entry.api === undefined ? {} : { api: entry.api },
    ...entry.name === undefined ? {} : { name: entry.name },
    ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
    ...entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens },
  }
}

/**
 * Render the model list with its fetch action.
 * @param props - the drafted rows, probe target, wire face, and copy.
 * @returns the model-list editor.
 */
export function ModelListEditor(props: ModelListEditorProps): ReactNode {
  const { models, onChange, probe, api, t, disabled } = props
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // The last successful refresh: what the status line reports. Absent until a
  // refresh has answered; a later failure leaves it in place so the user still
  // sees when the route last synced.
  const [refreshed, setRefreshed] = useState<{ count: number; at: string } | undefined>(undefined)
  // Rows carry an id and a name; capacities are the exception, so they stay
  // folded until asked for rather than crowding every row with four inputs.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // Capacities are edited as text, so a field's keystrokes are held here rather
  // than re-derived from the parsed count on every change — that would rewrite
  // `1000` to `1K` mid-word. Unreadable text is kept past blur so the refusal
  // names a row the user can still see, which is why this is one entry PER
  // FIELD: a single buffer would be displaced by editing any other field, and
  // the abandoned one would render its stored NaN as the literal `NaN`.
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map())

  /** Buffer key for one capacity field; the row half moves when rows do. */
  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    setEditing(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCapacity(text) })
  }

  /** What a capacity field shows: the buffer while typing, else the stored count. */
  const capacityText = (model: ModelDraft, index: number, field: CapacityField): string =>
    editing.get(bufferKey(index, field)) ?? capacitySpelling(numberOf(model, field))

  /** Drop one row's entries and shift the rows after it down, in one pass. */
  const reindexOnRemove = (
    current: ReadonlyMap<string, string>,
    index: number,
  ): Map<string, string> => {
    const next = new Map<string, string>()
    for (const [key, value] of current) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      // Only the row number moves; the field half of the key is untouched.
      next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    return next
  }

  const toggleExpanded = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const patch = (index: number, next: Record<string, string | number | undefined>): void => {
    onChange(models.map((model, at) => {
      if (at !== index) return model
      // Rebuilt rather than spread over: an emptied optional field has to leave
      // the profile, not be stored as a value its schema would reject.
      // Spread first so a field this card does not edit survives; an emptied
      // optional field is then dropped rather than stored as a value its
      // schema would reject.
      const cleared = new Set(
        Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key),
      )
      return Object.fromEntries(
        Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)),
      )
    }))
  }

  const refreshModels = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await api.llm.discoverModels({
        settingsNs: probe.settingsNs,
        ...probe.provider === undefined ? {} : { provider: probe.provider },
        // A named route's installed catalog is a version cache; the flag asks
        // the adapter to re-sync it from the route's own endpoints. A route in
        // draft has no catalog to sync, so it omits the flag and gets a plain
        // endpoint interrogation instead.
        ...probe.provider === undefined ? {} : { preferEndpoint: true },
        ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
        ...probe.api === undefined ? {} : { api: probe.api },
        ...probe.apiKey === undefined ? {} : { apiKey: probe.apiKey },
      })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        return
      }
      const found = response.result.value.models
      if (found.length === 0) {
        setFailure(t('refreshEmpty'))
        return
      }
      // The reply applies directly: a route that inherits its catalog keeps
      // inheriting it — the adapter's local cache now serves the current
      // listing, and writing rows here would demote the route to a customized
      // one. A route whose list the user already owns (or a draft being
      // created) has that list replaced by the upstream one.
      const inheritsCatalog = probe.provider !== undefined && models.length === 0
      if (!inheritsCatalog) onChange(found.map(draftOf))
      setRefreshed({ count: found.length, at: new Date().toLocaleTimeString() })
    } catch (error) {
      // The transport rejected rather than answering; without this the button
      // would stay busy with nothing shown.
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  // A route the adapter already describes answers without an endpoint; only a
  // draft with neither has nothing to ask about.
  const askable = probe.provider !== undefined || (probe.baseURL !== undefined && probe.baseURL.length > 0)
  return (
    <section className={styles['modelCatalog']} aria-label={t('models')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{t('models')}</span>
          {props.overridden === undefined
            ? null
            : (
              <span className={styles['modelCatalogMeta']}>
                {props.overridden ? t('modelsCustomized') : t('modelsInherited')}
              </span>
            )}
        </div>
        {props.overridden === true && props.onReset !== undefined
          ? (
            <button
              type="button"
              className={styles['linkButton']}
              disabled={disabled}
              onClick={props.onReset}
            >
              {t('resetModels')}
            </button>
          )
          : null}
        <button
          type="button"
          className={styles['linkButton']}
          disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
          title={props.probeBlocked !== undefined
            ? t(props.probeBlocked)
            : askable ? undefined : t('refreshNeedsBaseUrl')}
          onClick={() => { void refreshModels() }}
        >
          {busy ? t('refreshing') : t('refreshModels')}
        </button>
      </div>
      {refreshed !== undefined
        ? (
          <p className={styles['refreshed']}>
            {t('refreshedStatus').replace('{count}', String(refreshed.count)).replace('{at}', refreshed.at)}
          </p>
        )
        : null}
      {models.length === 0 ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      {models.map((model, index) => (
        <div key={index} className={styles['modelEntry']}>
          <div className={styles['modelRow']}>
            <input
              className={styles['input']}
              type="text"
              value={textOf(model, 'id')}
              placeholder={t('modelId')}
              aria-label={`${t('modelId')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { id: event.target.value }) }}
            />
            <input
              className={styles['input']}
              type="text"
              value={textOf(model, 'name')}
              placeholder={t('modelName')}
              aria-label={`${t('modelName')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { name: event.target.value === '' ? undefined : event.target.value }) }}
            />
            <button
              type="button"
              className={styles['iconButton']}
              aria-label={`${t('modelAdvanced')} ${index + 1}`}
              aria-expanded={expanded.has(index)}
              title={t('modelAdvanced')}
              onClick={() => { toggleExpanded(index) }}
            >
              <IconChevron open={expanded.has(index)} />
            </button>
            <button
              type="button"
              className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
              aria-label={`${t('removeModel')} ${index + 1}`}
              title={t('removeModel')}
              disabled={disabled}
              onClick={() => {
                onChange(models.filter((_model, at) => at !== index))
                // Both stores are keyed by position, so every row after this
                // one shifts down and would otherwise inherit its neighbour's
                // state — a different row's capacities popping open, or its
                // half-typed text appearing in another row's field.
                setExpanded((current) => {
                  const next = new Set<number>()
                  for (const at of current) {
                    if (at < index) next.add(at)
                    else if (at > index) next.add(at - 1)
                  }
                  return next
                })
                setEditing(current => reindexOnRemove(current, index))
              }}
            >
              <IconTrash />
            </button>
          </div>
          {expanded.has(index)
            ? (
              <div className={styles['modelAdvanced']}>
                {/* The row's protocol wins over the route default for this one
                    model — the field that lets a route spanning several
                    protocols adopt a model its installed catalog does not yet
                    describe. The empty choice means "inherit", which is what a
                    catalog model already does. */}
                {props.protocols !== undefined && props.protocols.length > 0
                  ? (
                    <label className={styles['modelField']}>
                      <span className={styles['modelFieldLabel']}>{t('modelApi')}</span>
                      <select
                        className={`${styles['input']} ${styles['selectInput']}`}
                        value={textOf(model, 'api')}
                        aria-label={`${t('modelApi')} ${index + 1}`}
                        disabled={disabled}
                        onChange={(event) => { patch(index, { api: event.target.value === '' ? undefined : event.target.value }) }}
                      >
                        <option value="">{t('modelApiUnset')}</option>
                        {props.protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                      </select>
                    </label>
                  )
                  : null}
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelContextWindow')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'contextWindow')}
                    placeholder={CAPACITY_HINT.contextWindow}
                    aria-label={`${t('modelContextWindow')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'contextWindow', event.target.value) }}
                  />
                </label>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelMaxTokens')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'maxTokens')}
                    placeholder={CAPACITY_HINT.maxTokens}
                    aria-label={`${t('modelMaxTokens')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'maxTokens', event.target.value) }}
                  />
                </label>
              </div>
            )
            : null}
        </div>
      ))}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={disabled}
        onClick={() => { onChange([...models, { id: '' }]) }}
      >
        {t('addModel')}
      </button>
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
    </section>
  )
}
