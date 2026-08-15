/**
 * The Exa web-search provider's card: its endpoint, retrieval mode, result
 * defaults, and the key — which is written through the credentials domain,
 * never into the settings section, so the literal never rides a response.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { WebSearchExaCardFace } from './web-search-exa-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Exa web-search card. */
export type WebSearchExaCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchExaCardFace>

/**
 * Render the Exa web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchExaCard(props: WebSearchExaCardProps) {
  const { t } = props
  const state = props.useWebSearchExaCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="webSearchExaTitle"
      descriptionKey="webSearchExaDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SecretField
        id="plugin-config-web-search-exa-key"
        label={t('webSearchExaApiKey')}
        hint={t('webSearchExaApiKeyHint')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        // Its own writability is what disables this control — a key sourced
        // from the process environment cannot be written from here.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('webSearchExaApiKeySet') : t('webSearchExaApiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      <ValueField
        id="plugin-config-web-search-exa-endpoint"
        label={t('webSearchExaBaseUrl')}
        hint={t('webSearchExaBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <ValueField
        id="plugin-config-web-search-exa-search-type"
        label={t('webSearchExaSearchType')}
        hint={t('webSearchExaSearchTypeHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.searchType}
        onEdit={(text) => { props.edit('searchType', text) }}
        onReset={() => { props.resetField('searchType') }}
      />
      <ValueField
        id="plugin-config-web-search-exa-num-results"
        label={t('webSearchExaNumResults')}
        hint={t('webSearchExaNumResultsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.numResults}
        onEdit={(text) => { props.edit('numResults', text) }}
        onReset={() => { props.resetField('numResults') }}
      />
      <ValueField
        id="plugin-config-web-search-exa-highlights"
        label={t('webSearchExaHighlightsPerResult')}
        hint={t('webSearchExaHighlightsPerResultHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.highlightsPerResult}
        onEdit={(text) => { props.edit('highlightsPerResult', text) }}
        onReset={() => { props.resetField('highlightsPerResult') }}
      />
    </PluginCard>
  )
}
