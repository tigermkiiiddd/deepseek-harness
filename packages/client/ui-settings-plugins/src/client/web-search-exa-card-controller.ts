/**
 * The Exa web-search card's staged form over the `web-search-exa` settings
 * namespace.
 *
 * Same contract as the DeepSeek card: the key is the one control that does
 * not live in the section — its literal never rides a response, so the card
 * learns only whether one is configured and writes it through the credentials
 * domain, addressed by the reference the section names.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, numberField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'
import { CredentialControl } from './credential-control.ts'

/**
 * Namespace of the Exa search provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const WEB_SEARCH_EXA_NS = 'web-search-exa'

/** Credential reference the provider resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'EXA_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** The search-provider fields this card edits. */
export interface WebSearchExaSettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Provider endpoint; blank inherits the provider default. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`; blank inherits the provider default. */
  searchType?: string
  /** Default result count when a request carries no `maxResults`; blank sends none. */
  numResults?: number
  /** Highlight sentences requested per result. */
  highlightsPerResult?: number
}

/** What the Exa web-search card renders. */
export interface WebSearchExaCardState extends CardShell {
  /** Provider endpoint. */
  baseURL: CardFieldState
  /** Retrieval mode sent as Exa's `type`. */
  searchType: CardFieldState
  /** Default result count for requests without `maxResults`. */
  numResults: CardFieldState
  /** Highlight sentences requested per result. */
  highlightsPerResult: CardFieldState
  /** The staged credential, which starts blank on every load. */
  apiKey: CardFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
}

/** The registration-side face the Exa web-search card's slot entry injects. */
export interface WebSearchExaCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchExaCard. */
    webSearchExaCard: SnapshotStore<WebSearchExaCardState>
  }
}

/** Bridges the `web-search-exa` scope and the credentials domain onto the card. */
export class WebSearchExaCardController {
  private readonly form: CardForm<WebSearchExaSettings>
  private readonly store: SnapshotStore<WebSearchExaCardState>
  private readonly credential: CredentialControl

  /**
   * @param scope - the bound settings scope for the `web-search-exa` namespace.
   * @param api - wire face used for the credential the section references.
   */
  constructor(
    private readonly scope: SettingsScope<WebSearchExaSettings>,
    api: Pick<IApiClient, 'credentials'>,
  ) {
    this.form = new CardForm(
      scope,
      [textField('baseURL'), textField('searchType'), numberField('numResults'), numberField('highlightsPerResult')],
      [{ field: API_KEY_FIELD, write: text => this.credential.write(text) }],
    )
    this.credential = new CredentialControl(
      api,
      () => refOf(this.scope.getSnapshot()),
      () => { this.store.set(this.projection()) },
    )
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.credential.read() })
    void this.credential.read()
  }

  private projection(): WebSearchExaCardState {
    return {
      ...this.form.shell(),
      baseURL: this.form.field('baseURL'),
      searchType: this.form.field('searchType'),
      numResults: this.form.field('numResults'),
      highlightsPerResult: this.form.field('highlightsPerResult'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  /**
   * Re-read after the Host reports a change to the reference this card watches.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    this.credential.refresh(ref)
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): WebSearchExaCardFace {
    return { hooks: { webSearchExaCard: this.store }, ...this.form.actions() }
  }
}

/**
 * The credential reference the section names, or the provider's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: SettingsScopeSnapshot<WebSearchExaSettings>): string {
  const declared = snapshot.value?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}
