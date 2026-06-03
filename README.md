# @omadia/channel-slack

A **Slack channel** for [Omadia](https://omadia.ai). It links a Slack app to
your Omadia orchestrator over **Slack Socket Mode** — a long-lived WebSocket,
so there is **no public webhook host to run**. Every DM to the bot and every
@mention in a channel it has joined is routed through your agents, and the
answer is posted back to Slack.

Built directly on the official [`@slack/socket-mode`](https://www.npmjs.com/package/@slack/socket-mode)
and [`@slack/web-api`](https://www.npmjs.com/package/@slack/web-api) clients —
no third-party bot framework.

---

## How it works

| Concern | Implementation |
|---|---|
| Transport | Long-lived Socket Mode WebSocket (`channel.transport.kind: websocket`). No inbound webhook. |
| Auth | A Slack **Bot token** (`xoxb-…`) + an **App-Level token** (`xapp-…`), stored as plugin secrets (`ctx.secrets`). |
| Admin UI | Connection status + linked workspace + a *Reconnect* button, surfaced through the standard admin-UI iframe (`admin_ui_path`). |
| Inbound | `message` / `app_mention` events → `IncomingTurn` → the orchestrator's `ChatAgent` (`src/inbound.ts`). |
| Outbound | The orchestrator's `SemanticAnswer` is rendered to a Slack `mrkdwn` message; rich elements degrade gracefully (`src/renderer.ts`). |
| Lifecycle | `export async function activate(ctx, core): Promise<ChannelHandle>` — the dynamic channel resolver picks up the bare `activate` export. |

Source map:

```
src/
├── plugin.ts          # activate(ctx, core) — wires everything together
├── slackConnection.ts # Socket Mode lifecycle: auth → connect → reconnect → send + react
├── inbound.ts         # native Slack event → IncomingTurn, mention stripping, session scope
├── renderer.ts        # SemanticAnswer → Slack mrkdwn (graceful degradation)
├── adminRouter.ts     # /api/slack-channel/admin — status + reconnect
├── logger.ts          # Slack (@slack/logger) logger → CoreApi.log
└── state.ts           # shared connection state
assets/admin-ui/index.html # status page (single file)
```

---

## Create the Slack app

1. Create an app at `api.slack.com/apps` (from scratch).
2. **Socket Mode** → enable it, and generate an **App-Level Token** with the
   `connections:write` scope → this is your `xapp-…` token.
3. **OAuth & Permissions** → add the bot scopes, then *Install to Workspace* →
   this gives you the **Bot User OAuth Token** `xoxb-…`:
   - `app_mentions:read`, `chat:write`, `reactions:write`
   - `im:history`, `channels:history`, `groups:history`, `mpim:history`
   - `users:read` (optional, for display names)
4. **Event Subscriptions** → subscribe to the bot events you want:
   - `app_mention` and `message.im` (DMs) are the baseline.
   - add `message.channels` / `message.groups` if you set
     `respond_in_channels: all`.
5. Invite the bot to any channel it should listen in (`/invite @yourbot`).

---

## Build & install

Requires Node ≥ 20 (this repo pins the version in `.nvmrc`).

```bash
nvm use
npm install
npm run typecheck   # tsc gate (see "Typecheck" below)
npm run build       # esbuild-bundles the Slack SDK into dist/plugin.js, then zips
# → out/omadia-channel-slack-0.1.0.zip
```

Install the resulting ZIP into Omadia:

- **Local / smoke:** Admin-UI → *Store → Lokal → Upload* → drop the `.zip`.
- **Hub:** publish to the registry, then *Store → Hub → Jetzt installieren*
  (see the Omadia plugin docs).

After install, enter both tokens in the plugin's setup form, then open the
plugin's admin UI to confirm the connection went green.

### Setup fields

| Field | Default | Purpose |
|---|---|---|
| `bot_token` | _(required)_ | Bot User OAuth Token (`xoxb-…`). |
| `app_token` | _(required)_ | App-Level Token (`xapp-…`, Socket Mode). |
| `respond_in_channels` | `mention` | `mention` = only on @mention; `all` = every message in joined channels. |
| `allow_dms` | `true` | Respond to 1:1 direct messages. |
| `allowlist` | _(empty)_ | Comma-separated channel ids (`C…`) and/or user ids (`U…`) allowed to interact (empty = all). |

---

## Why the Slack SDK is bundled

A plugin's compiled code can only `import` packages that already exist in the
**host's** `node_modules` (the host resolves a plugin's bare specifiers against
its own tree). `@omadia/*` and `express` are host-provided, so they stay
`peerDependencies` and are marked **external**. `@slack/socket-mode`,
`@slack/web-api` and `@slack/logger` are *not* host-provided, so
`scripts/build-zip.mjs` **esbuild-bundles them into `dist/plugin.js`**. (tsc
alone can't do this — hence esbuild.)

### Typecheck

`tsconfig.json` resolves the `@omadia/channel-sdk` / `@omadia/plugin-api` types
via `paths`; point them at wherever you have the Omadia SDK type declarations
built (these packages aren't published to npm). The esbuild build itself doesn't
need them — both are `external` at runtime, provided by the host.

---

## Behaviour

- **ACK reaction.** Every accepted message gets an immediate 👀 reaction so the
  sender sees it was picked up before the answer lands.
- **Who it answers.** DMs (when `allow_dms`), and channel messages — by default
  only when the bot is @mentioned (`respond_in_channels: mention`), or every
  message when set to `all`. The bot's own posts (and other bots) are always
  ignored, so there are no reply loops.
- **Threads.** Replies in a channel are posted in a thread rooted at the user's
  message; DMs reply at the top level. Each channel thread is its own session.
- **De-duplication.** Slack delivers a mention as both an `app_mention` and a
  `message` event — the channel handles each message exactly once.

## Limitations & caveats

- **Text only (v0.1.0).** Outbound rich elements (choice cards, follow-ups,
  attachments) degrade to `mrkdwn` text + links. Block Kit (interactive
  components) is planned for a later version.
- **Socket Mode required.** This channel uses Socket Mode, not the HTTP Events
  API. The `connections:write` app-level token and Socket Mode toggle are
  mandatory.
- **Tokens are sensitive.** The bot + app tokens grant access to your workspace.
  They are stored in the plugin vault and never logged; keep the admin UI behind
  the operator-authenticated web-ui.

## License

MIT © byte5 GmbH
