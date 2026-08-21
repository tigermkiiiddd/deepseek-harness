/**
 * The one home of this application's forwarded-Host-event allowlist. Both
 * compiler faces list this file, so the Host forwarding loop and the consumer
 * `ctx.remote.$on` key face read one declaration instead of two copies that
 * could drift; `./types.ts` derives the type projection from it and stays
 * type-only.
 */

/**
 * Host events this application forwards to consumers verbatim: no projection,
 * no redaction, no renaming. The wire name is the Host cordis event name and
 * the payload is its argument list, so this array is simultaneously the whole
 * control point over what a consumer can receive and the legal key set of
 * `ctx.remote.$on`. Forwarding one more event is an entry here and nothing
 * else.
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  'agent-preset/selected',
  'commands/change',
  'credentials/reference-updated',
  'cordis/request-run',
  'cordis/request-run-resolved',
  'cordis/dynamic-package',
  'cordis/dynamic-retract',
  'cordis/inspect-query',
  'cordis/inspect-query-resolved',
  'llm/adapters-updated',
  'settings/document-updated',
  // Team push: status migrations, lossless member session updates, permission
  // requests, and settled turns ride the same one-way Remote channel, so the
  // GUI renders the member interface from a push stream instead of polling.
  'team/status',
  'team/member-update',
  'team/permission-requested',
  'team/turn-end',
] as const
