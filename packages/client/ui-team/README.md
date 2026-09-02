# @deepseek-ai/dsh-client-ui-team

English | [中文](README.zh.md)

The Web team view: a **global visualization lane** at the top of the frame (`shell.topbar`) that shows every agent — the main instance plus each member — as nodes with live status and links between them. Member sessions are first-class sessions in the main conversation UI: clicking a member node opens that member's current topic through the regular session-selection path (`ctx.sessions.open`) as a session id of the form `member:<memberId>:<topicId>`. The lane also hosts the member-management controls: a "new member" form (command, args, cwd, env, permission policy, autostart) and per-node remove/start/stop/restart.

## Architecture

- **Host half** (`src/index.ts`): an empty apply that keeps the plugin visible to the Loader. The `team` domain is served by the host API-proxy (`team.*` RPC methods, implemented by `@deepseek-ai/dsh-team`).
- **Browser half** (`src/client/index.ts`): the status push bridge subscribes to forwarded `team/status` remote events and folds them into one `TeamController` store (exposed through the inject `hooks` compartment as `useTeamLive`). The global lane (`TeamTopbar`, an SVG node graph) reads that store and drives `api.team.*` through the formal host API (`@deepseek-ai/dsh-client-connection`). Clicking a member node resolves the member's latest topic (`team.sessions`) and selects the `member:<memberId>:<topicId>` session through `ctx.sessions.open`; if the member has no topics, the controller creates one (`team.newSession`) and then selects it. The topic can be newer than this client's list baseline (created after the page loaded), so a select that misses it re-baselines the session list once (`sessions.refresh`) and retries before surfacing the error. Clicking the main-instance node returns to the main conversation view (`ctx.sessions.clear`). Nothing polls.
- **Frame** (`@deepseek-ai/dsh-client-ui-layout`): declares and renders the `shell.topbar` lane above the three columns.

## Data ownership

The lane reads and drives the member processes through the host API; member conversations now render in the regular conversation UI, which owns the session list and selection. The team package keeps only the roster, status subscription, and member-management verbs.

## Model Experience

None, as the team UI renders the member roster in the browser and routes member conversations to the main conversation surface; nothing here reaches a model request directly.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Member↔member direct messaging is not exposed yet; the lane only connects the main instance to members.
