# `@deepseek-ai/dsh-acp-app`

English | [中文](README.zh.md)

The dsh ACP server bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it mounts the automation-only [`dsh-acp`](../../acp/acp/README.md) plugin, redirects the `settings-file` and `credentials-local` documents to the **main instance's harness home** (`DSH_MAIN_HOME`), and disables HMR so stdout stays reserved for ACP JSON-RPC. It provides no Host, HTTP server, Web runtime, or browser plugin.

This bundle is the profile used by first-class `dsh` team members: a member process booted with `dsh --profile acp` runs the same harness installation as the coordinator, reads the same `settings.yaml` and `.credentials.yaml`, but keeps its own `DSH_HOME` so its session store and attachments are isolated from the main instance's.

## Model Experience

None, as the bundle only exposes the ACP bridge; the member's model, tools, and prompts belong to the base composition and any profile/user overlays.

#### KV Cache effect

None; the bundle adds nothing to request prefixes.

## Known Limitations and Deferred Work

- **Automation-only** — no human-facing surface; the member is driven entirely through the ACP wire.
- **Inherited model settings** — the member uses the main instance's saved model selection and credentials; it does not carry its own defaults.
