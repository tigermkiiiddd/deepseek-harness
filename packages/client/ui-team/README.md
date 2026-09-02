# @deepseek-ai/dsh-client-ui-team

English | [中文](README.zh.md)

The Web team view: a **global visualization lane** in the sidebar footer (`sidebar.footer.action`) that shows every agent — the main instance plus each member — as nodes with live status and links between them. Member sessions are first-class sessions in the main conversation UI: clicking a member node opens that member's current topic through the regular session-selection path (`ctx.sessions.open`) as a session id of the form `member:<memberId>:<topicId>`. The lane also hosts the member-management controls: a "new member" form (command, args, cwd, env, permission policy, autostart) and per-node remove/start/stop/restart.

## Architecture

- **Host half** (`@deepseek-ai/dsh-team`): owns a generated `team` Remote namespace for roster, lifecycle, and member-topic operations.
- **Browser half** (`src/client/index.ts`): mounts that generated Remote contribution before creating the UI controller, then registers `TeamTopbar` in `sidebar.footer.action`. The controller drives `ctx.remote.team`, selects `member:<memberId>:<topicId>` through `ctx.sessions.open`, and retries once after `sessions.refresh` when a newly created topic is not in the local baseline. Disposal reverses this order so the Remote namespace outlives every UI consumer. Nothing polls.
- **Frame** (`@deepseek-ai/dsh-client-ui-sidebar`): declares and renders the footer action slot.

## Data ownership

The lane reads and drives the member processes through the host API; member conversations now render in the regular conversation UI, which owns the session list and selection. The team package keeps only the roster, status subscription, and member-management verbs.

## Model Experience

None, as the team UI renders the member roster in the browser and routes member conversations to the main conversation surface; nothing here reaches a model request directly.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Member↔member direct messaging is not exposed yet; the lane only connects the main instance to members.
