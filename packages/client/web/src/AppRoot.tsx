/**
 * Shell root: boot loading page → (boot settled) → real UI in one switch.
 * Pure kernel component with zero plugin dependencies — before settled it may
 * only rely on itself (the fail-loud presentation must not depend on the
 * system whose failure it reports; the status/signal stores are kernel-own,
 * shell self-sufficiency rule); the real UI is produced by the app-shell
 * entry once every entry is active. A failed boot keeps the loading page,
 * lists the per-entry fiber states and the sweep report (fail loud, no
 * partial UI). A render failure AFTER settle (a service withdrawal tore the
 * assembly out from under the UI — connection loss, hot reload) is caught by
 * {@link SettledBoundary}: the shell falls back to the same fail-loud card
 * and re-attempts the real UI whenever a kernel store changes, so a
 * recovered service graph restores the UI without a page reload.
 */
import { Component, useSyncExternalStore } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { KernelSignal, LoaderStatus } from './loader-status.ts'
import css from './AppRoot.module.css'

/** AppRoot props: settled signal, fiber-state projection feed, boot failure report, deferred real-UI factory. */
export interface AppRootProps {
  /** True once the boot chain settled (loader quiesced + all entries ACTIVE); the boot closure flips it. */
  settled: KernelSignal<boolean>
  /** Per-entry fiber-state projection store (drives loading/failed rendering). */
  status: KernelSignal<LoaderStatus>
  /** Boot failure report (the settle rejection message); undefined while loading or after success. */
  error: KernelSignal<string | undefined>
  /** Builds the real UI; called only after settled. */
  renderApp: () => ReactNode
}

/** Boot gate: loading page until the boot settles; failures stay here. */
export function AppRoot(props: AppRootProps) {
  const settled = useSyncExternalStore(props.settled.subscribe, props.settled.getSnapshot)
  const status = useSyncExternalStore(props.status.subscribe, props.status.getSnapshot)
  const error = useSyncExternalStore(props.error.subscribe, props.error.getSnapshot)
  const failed = Object.entries(status).filter(([, s]) => s === 'failed')

  if (settled) {
    // The retry key re-arms the boundary after a crash: fiber-state rows
    // change while a withdrawn service graph recovers, and each change is one
    // bounded re-attempt (never a remount — the boundary keeps its identity,
    // so a healthy UI tree survives unrelated status updates untouched).
    const retryKey = `${String(error)}|${Object.entries(status).map(([id, s]) => `${id}:${s}`).join(',')}`
    return <SettledBoundary renderApp={props.renderApp} retryKey={retryKey} />
  }

  const loud = error !== undefined || failed.length > 0

  return (
    <div className={css.boot}>
      <div className={css.card}>
        <div className={css.wordmark}>HARNESS</div>
        {!loud
          ? (
            <>
              <div className={css.spinner} />
              <div className={css.hint}>Loading plugins…</div>
            </>
          )
          : (
            <div className={css.failed}>
              <div className={css.failedTitle}>Failed to load plugins</div>
              {failed.map(([id]) => <div key={id} className={css.failedItem}>{id}</div>)}
              {error !== undefined && <div className={css.failedItem}>{error}</div>}
            </div>
          )}
      </div>
    </div>
  )
}

/** Props for the post-settle crash boundary. */
interface SettledBoundaryProps {
  /** Builds the real UI; the boot closure throws when the assembly is gone. */
  readonly renderApp: () => ReactNode
  /** Changes whenever a kernel store changes; re-arms the retry after a crash. */
  readonly retryKey: string
}

/** State of the post-settle crash boundary: the caught render failure. */
interface SettledBoundaryState {
  readonly failure: Error | undefined
}

/**
 * Error boundary around the settled UI. The settled signal is one-way, so a
 * service withdrawal after settle cannot re-close the boot gate — without
 * this boundary the thrown render unmounts the whole React tree (a blank
 * page). The failure card is the same fail-loud presentation the loading
 * page owns; a retryKey change clears the failure and re-attempts the UI.
 */
class SettledBoundary extends Component<SettledBoundaryProps, SettledBoundaryState> {
  override state: SettledBoundaryState = { failure: undefined }

  static getDerivedStateFromError(failure: Error): SettledBoundaryState {
    return { failure }
  }

  override componentDidCatch(failure: Error, info: ErrorInfo): void {
    console.error('web shell: rendering the settled UI failed:', failure, info.componentStack)
  }

  override componentDidUpdate(prev: SettledBoundaryProps): void {
    if (this.state.failure !== undefined && prev.retryKey !== this.props.retryKey) {
      this.setState({ failure: undefined })
    }
  }

  override render(): ReactNode {
    const { failure } = this.state
    if (failure === undefined) return <SettledContent renderApp={this.props.renderApp} />
    return (
      <div className={css.boot}>
        <div className={css.card}>
          <div className={css.wordmark}>HARNESS</div>
          <div className={css.failed}>
            <div className={css.failedTitle}>Failed to render the UI</div>
            <div className={css.failedItem}>{failure.message}</div>
            <div className={css.failedItem}>Retrying when plugin states change…</div>
          </div>
        </div>
      </div>
    )
  }
}

/**
 * Renders the real UI as the boundary's child: an error boundary cannot catch
 * a throw from its own render, so the boot closure must run one level down
 * for the boundary to intercept it.
 * @param props - carries the boot closure.
 * @returns the assembled UI tree.
 */
function SettledContent(props: { readonly renderApp: () => ReactNode }): ReactNode {
  return props.renderApp()
}
