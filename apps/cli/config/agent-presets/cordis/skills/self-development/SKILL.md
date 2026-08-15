---
name: self-development
description: Develop a permanent new capability for DeepSeek Harness itself — a plugin package, tool, or preset change — by editing the source checkout. Use this Skill when the user asks you to modify, fix, or extend the harness's own behavior in a way that must survive restarts and land in version control. Temporary or session-scoped extensions belong to the cordis-plugin-development Skill instead.
---

# Develop DeepSeek Harness from source

You are working on the harness's own source checkout. Source changes never hot-reload: they take effect on the next process start, so the current session keeps running the old code. Plan for that — tell the user a restart or new session is needed to pick up the change, and never claim an edit is already live.

## Choose source vs dynamic first

| Intended lifetime | Path |
| --- | --- |
| Permanent capability, must survive restart, belongs in version control | This Skill: edit the checkout |
| Experiment, temporary UI, session-scoped behavior, one-off need | `cordis-plugin-development` Skill (dynamic Cordis Plugin) |

Do not edit the checkout for one-off needs, and do not define a dynamic Plugin for a capability the user expects to keep.

## Standard workflow

1. **Confirm the checkout.** Call `self_cognition`. If `sourceCheckout.available` is false, this deployment carries no source — stop and say so; only the dynamic path remains. Read the `plugins` and `preset` fields to see what you are currently made of.
2. **Understand before designing.** Read `AGENTS.md` (repository conventions), `docs/architecture.md` (the plugin architecture), and the README of every package you will touch. Follow links, not guesses.
3. **Design as a plugin.** New behavior goes on documented extension points — a capability seam (Service Definition / Provider / Consumer), a tool, a prompt contribution, or a preset row. Do not change `agent-loop` for a feature; if a loop change is truly required, `docs/architecture.md` must change with it. Registrations are effects: every contribution goes through `ctx.effect()`/`ctx.on()` or a registry whose `register()` returns a disposer.
4. **Implement.** For a new package follow `docs/cookbook/adding-a-package.md` (package.json, tsconfig references, invariant companion, README); for a model-facing tool follow `docs/cookbook/adding-a-tool.md` (schema, `output` contract, render intent up front). Match the surrounding package's conventions exactly: ESM, `@deepseek-ai/dsh-<name>` naming, `.ts` in relative imports, strict TypeScript with no unexplained `any`.
5. **Mount.** Add the plugin row to the target preset's `agent.cordis.yml`, and add the package to that resolver manifest's `dependencies` (for the shipped presets, `apps/cli/package.json`) — `verify-cordis-config` rejects a bare plugin missing from the manifest. Register the package in `tsconfig.host.json` (host plane) or `tsconfig.client.json` (client plane).
6. **Verify.** Run the smallest checks that cover the change: the package's focused vitest (new packages need an explained invariant companion at `src/invariant.ts`), `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, `pnpm run build`, `pnpm run hygiene`. Model- or user-visible behavior changes need keyless snapshot coverage through a real runnable example — see `docs/testing.md`. Smoke the result from source with `pnpm dsh --profile <profile> "task"`.
7. **Finish the paperwork.** Every package carries `README.md` + `README.zh.md` kept consistent via `pnpm run verify-translation-pairing --write <path>`, a Model Experience section when it registers anything model-facing, and an Agent Note under `.agents/notes/` for non-trivial changes. Update `AGENTS.md` files when you change what they document.

## Hard rules

- Never commit credentials; real-API tests read `DEEPSEEK_API_KEY` from the environment, never from source.
- Do not edit `vendor/` directly — vendored Cordis is updated through the sync procedure in `vendor/README.md`.
- Everything model-visible must be reconstructable from the session log; a new model-visible input requires a session event.
- Misconfiguration fails loud at load; never silently skip a missing referent or hardcode a deployment-specific value (paths, models, presets) into plugin code.
- Keep the change minimal and scoped; run only the checks that cover it, not the full suite by default.
