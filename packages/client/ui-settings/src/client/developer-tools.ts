/** One accepted preference drives every developer-tool consumer. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DeveloperToolsSettings } from '../developer-tools-settings.ts'
import type { ConfigForm } from './config-form-types.ts'

/** Shared preference; Host-backed features stay disabled until an accepted value arrives. */
export class DeveloperToolsPreference {
  /** Accepted enablement, observable through renderer-bound hooks. */
  readonly enabled: ObservableSnapshot<boolean>
  /** Lazy tool folding toggle. */
  readonly lazyToolFolding: ObservableSnapshot<boolean>
  /** Custom pinned tools string. */
  readonly pinnedTools: ObservableSnapshot<string>

  /**
   * @param scope - settings-owned namespace controller.
   */
  constructor(private readonly scope: ConfigForm<DeveloperToolsSettings>) {
    this.enabled = {
      getSnapshot: () => scope.getSnapshot().value?.enabled ?? false,
      subscribe: (listener) => {
        let previous = this.enabled.getSnapshot()
        return scope.subscribe(() => {
          const next = this.enabled.getSnapshot()
          if (next === previous) return
          previous = next
          listener()
        })
      },
    }

    this.lazyToolFolding = {
      getSnapshot: () => scope.getSnapshot().value?.lazyToolFolding ?? true,
      subscribe: (listener) => {
        let previous = this.lazyToolFolding.getSnapshot()
        return scope.subscribe(() => {
          const next = this.lazyToolFolding.getSnapshot()
          if (next === previous) return
          previous = next
          listener()
        })
      },
    }

    this.pinnedTools = {
      getSnapshot: () => scope.getSnapshot().value?.pinnedTools ?? '',
      subscribe: (listener) => {
        let previous = this.pinnedTools.getSnapshot()
        return scope.subscribe(() => {
          const next = this.pinnedTools.getSnapshot()
          if (next === previous) return
          previous = next
          listener()
        })
      },
    }
  }

  /**
   * Persist the choice on the Host with ordered writes.
   * @param enabled - requested developer-tool mode.
   * @returns settlement after Host acceptance; rejects after a refused write recovers.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (!await this.scope.set('enabled', enabled)) throw new Error('Developer tools preference was not saved')
  }

  async setLazyToolFolding(lazyToolFolding: boolean): Promise<void> {
    if (!await this.scope.set('lazyToolFolding', lazyToolFolding)) throw new Error('Lazy tool folding preference was not saved')
  }

  async setPinnedTools(pinnedTools: string): Promise<void> {
    if (!await this.scope.set('pinnedTools', pinnedTools)) throw new Error('Pinned tools preference was not saved')
  }
}
