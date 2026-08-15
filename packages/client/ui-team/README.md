# @deepseek-ai/dsh-client-ui-team

English | [中文](README.zh.md)

The Web team view: a sidebar action (`sidebar.footer.action`) that opens the team panel (`shell.overlay`). The panel lists the team members and each member's own conversation topics, shows a topic's replayed history, and chats with a member on the selected topic or a new one.

## Architecture

- **Host half** (`src/index.ts`): an empty apply that keeps the plugin visible to the Loader. The `team` domain is served by the host API-proxy (`team.*` RPC methods, implemented by `@deepseek-ai/dsh-team`).
- **Browser half** (`src/client/index.ts`): the sidebar action and the overlay panel, driven by `api.team.*` through the formal host API (`@deepseek-ai/dsh-client-connection`). Panel visibility lives in one shared `defineStore` handle created in `apply`.

## Data ownership

The panel reads and drives the member processes through the host API; member sessions and their history stay in the member processes. The panel keeps no durable copy of member conversations.

## Known Limitations and Deferred Work

- Styling is minimal inline CSS; a token-based stylesheet pass is future polish.
- Member status is refreshed on panel open; live status updates need a subscription channel.
- Chat returns the full reply when the turn settles (no streaming in the panel yet).
