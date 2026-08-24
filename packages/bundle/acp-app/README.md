# `@deepseek-ai/dsh-acp-app`

English | [中文](README.zh.md)

The dsh ACP server bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it mounts the automation-only [`dsh-acp`](../../acp/acp/README.md) plugin plus the preset roster, and disables HMR so stdout stays reserved for ACP JSON-RPC. It provides no Host, HTTP server, Web runtime, or browser plugin.

This bundle is the profile used by first-class `dsh` team members: a member process booted with `dsh --profile acp` runs the same harness installation as the coordinator but with its own self-contained `DSH_HOME` — the member's settings, credentials, and optional own preset are seeded once into that home by the main instance (per-artifact idempotent; see `@deepseek-ai/dsh-team/member-home`), so sessions stay isolated and the member inherits nothing at runtime.

## Model Experience

None, as the bundle only exposes the ACP bridge; the member's model, tools, and prompts belong to the base composition and any profile/user overlays.

#### KV Cache effect

None; the bundle adds nothing to request prefixes.

## Known Limitations and Deferred Work

- **Automation-only** — no human-facing surface; the member is driven entirely through the ACP wire.
- **Seeded settings** — the member's model defaults and credentials come from the seeded copy of the main instance's documents; after seeding it manages its own values independently.
