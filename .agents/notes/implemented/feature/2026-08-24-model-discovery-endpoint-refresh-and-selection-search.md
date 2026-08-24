# Agent Note: Model discovery refreshes from the endpoint; selection menu searches

Status: implemented

English | [中文](2026-08-24-model-discovery-endpoint-refresh-and-selection-search.zh.md)

## Problem

Two gaps in the model surfaces. First, pi-ai's installed catalog is a versioned snapshot of each provider's model list, and a route it ships answers discovery from that cache without any network call — so a model the upstream added after the snapshot shipped (opencode-go gained `qwen3.8-max` and `gpt-5.6-luna` between pi-ai 0.82.1 and 0.84.2) is invisible to the settings UI, and a user adopting one must hand-type the id and, on a route spanning several protocols such as opencode-go, guess which wire protocol it speaks. Second, the Web GUI's model-selection menu lists every advertised model with no way to search; as catalogs grow, finding a model means scrolling.

## Decision

Discovery gains `preferEndpoint` on `LlmModelDiscoveryRequest`. For a named route the installed catalog describes, the adapter reads the endpoint's current OpenAI-compatible `GET /models` list and joins it over the cache: installed models keep their cached capacities and protocol in catalog order, upstream additions follow them deduplicated. Without the flag the behavior is unchanged — the catalog answers with no network call, which stays the default because it carries what a listing endpoint would not disclose.

Discovered models may carry an `api`, the wire protocol the answerer speaks for that model; adoption writes it into the profile. Per-entry `api` is now a configuration field on `models` entries and `modelOverrides` values, resolving entry → route → catalog sibling → the protocol all shipped siblings agree on. On a route whose catalog spans several protocols, a model the catalog does not describe needs an entry `api`; its endpoint base is inherited from a shipped sibling speaking that model's protocol (`siblingBaseUrl` in `dsh-llm-pi-ai`), so opencode-go needs no `baseURL` for either of its two endpoint families.

The settings UI sends `preferEndpoint: true` when the fetch button edits a named route, writes an adopted candidate's `api` into the row, and offers a protocol selector on each expanded model row (empty means inherit). The Web GUI's model-selection menu gains a search input in the model pane: it filters by provider name (keeping the whole group), model name, or id; Enter selects the first match; Escape clears the filter first and backs out of the pane only when it is empty.

## Alternatives considered

- **Bumping pi-ai 0.82.1 → 0.84.2 to refresh the snapshot** — loses on freshness: a snapshot is still a point in time, and upstream moves again before the next bump; it also drags in new compat fields (baseten `thinkingFormat`, `supportsFinishReason`, `chatTemplateArgs`, `supportsThinkingTokenBudget`, `supportsAdditionalTools`) that would need drift-gate adaptation. Reading the endpoint is strictly fresher and works for any gateway, not only pi-ai's own providers.
- **Falling back to the cache when the endpoint fails** — loses on honesty: a stale list presented as current misleads adoption into models the endpoint no longer serves; the refusal names the endpoint, and hand-entry remains available.
- **A `source` field per discovered model (catalog vs live)** — loses because no consumer branches on it: adoption treats both identically, and the union order already carries the meaning.
- **Server-side search for the selection menu** — loses a wire round-trip per keystroke for a list of tens of models; component-local state is sufficient and keeps the query transient.

## Consequences

The `discoverModels` wire payload gains optional `preferEndpoint` and the view gains optional `api`; both are additive to the schema. The fetch button on a named route now makes one network call where it previously made none, and its failure surfaces as `DISCOVERY_FAILED` naming the endpoint rather than degrading silently. An entry-level `api` is a deliberate repoint: a wrong protocol fails at serve time like any other, and resolution diagnostics name the model on multi-protocol routes but the route elsewhere. The menu search is transient UI state — reset when the menu closes, never persisted.

## Testing

`dsh-llm-pi-ai` discovery and catalog specs cover the union order, `preferEndpoint` opt-in, draft-route ignore, `installedBaseUrl` selection, entry-`api` resolution and repointing, and same-protocol base inheritance; `ui-settings-models` covers the probe payload, adoption writing `api`, and the row selector; `ui-model-selection` covers filtering, Enter/Escape, and reset-on-close.
