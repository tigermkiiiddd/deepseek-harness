/**
 * Team view, node half. The empty apply exists so the plugin appears in the
 * host cordis.yml / Loader; the browser half owns the panel through
 * exports["./client"]. The host `team` domain is served by the API-proxy
 * (`team.*` RPC methods, implemented by @deepseek-ai/dsh-team), so this
 * package registers no host-side routes.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
