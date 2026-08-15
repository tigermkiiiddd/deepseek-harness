# @deepseek-ai/dsh-team

English | [中文](README.zh.md)

Team-member connections for the DSH ACP virtual team. A **member** is a persistent ACP agent process (`dsh-acp-demo` with its own `cordis.yml`, or any ACP server) that **owns its own sessions (topics)** — its conversation history lives in the member's process and persistence, never in this harness. The `team` service only spawns the process, lists/loads/creates topics through the Agent Client Protocol, and drives chat turns.

## Service

`ctx.team` (plugin `@deepseek-ai/dsh-team`, config `members`):

| Member | Meaning |
|---|---|
| `list()` | Every configured member with its connection status (`connecting` / `connected` / `failed` / `closed`). |
| `listSessions(memberId, cwd?)` | The member's own conversation topics (via ACP `session/list`). |
| `loadSession(memberId, sessionId)` | Resume one topic on the member (via ACP `session/load`). |
| `readHistory(memberId, sessionId)` | Load a topic and collect its replayed conversation history (the member's own record). |
| `newSession(memberId)` | Open a new topic on the member (via ACP `session/new`). |
| `chat(memberId, sessionId, text, signal?)` | Drive one turn and return the committed text + stop reason. |
| `close(memberId)` | Tear down the member process (its persisted topics remain). |
| `disposeAll()` | Tear down every member process. |

## Member configuration

```yaml
- id: team
  name: '@deepseek-ai/dsh-team'
  config:
    members:
      - id: architect
        title: 架构师
        description: system design
        command: node
        args: ['--import', 'tsx', './packages/examples/acp-demo/src/bin.ts', '--config', './members/architect/cordis.yml']
        cwd: /path/to/workspace
        env:
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

Each member is one process. `cwd` binds the process (and its topics' workspace) at first use: the configured value wins, else the first caller session's workspace. A dead process is respawned on demand; its persisted topics remain listable and loadable (the member's own persistence).

## Process boundary

Members spawn through the [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam (credential scrub + explicit `env`). Permission prompts are auto-answered by `permission: allow | reject`. The ACP wire is the serialization boundary.

## Model Experience

### Member request

#### What the model sees

Through `dsh-tool-team` (`member_sessions` / `member_chat`), the calling agent sees the member roster, each member's topic ids, and the member's committed replies. The member's own system prompt, tools, and history stay in the member process; only user text crosses, and only committed assistant text returns.

#### Token effect

Each chat turn sends one user message and returns one reply. History reads (`readHistory`) are UI-side and cost no model tokens in the caller.

#### KV Cache effect

The caller's request prefix is untouched; member turns are independent requests.

## Known Limitations and Deferred Work

- **One process per member** — no pooling or hot standby; respawn happens on demand at the next operation.
- **Local workspaces only** — the member process runs on the same machine; remote ACP agents would need their own workspace mapping.
- **Remote tool calls are opaque** — the member executes its own tools inside its process; only committed assistant text crosses back.
- **No member-to-member direct messaging yet** — communication goes through the coordinating agent (or the user via the team view).
