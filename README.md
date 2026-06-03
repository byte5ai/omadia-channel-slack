# @omadia/channel-slack

A **Slack channel** for [Omadia](https://omadia.ai). It links a Slack app to
your Omadia orchestrator and routes every DM to the bot and every @mention in a
channel it has joined through your agents, posting the answer back to Slack.

It supports **two transports**, chosen automatically from config:

- **Events API (webhook)** — when you set a public base URL. Slack POSTs signed
  events to `<public_base_url>/api/slack/events`. This is Slack's recommended
  transport for production reliability and the only one eligible for the Slack
  Marketplace.
- **Socket Mode** — when no public base URL is set. A long-lived WebSocket, no
  public endpoint required: ideal for local dev and behind-firewall installs.

Built directly on the official [`@slack/web-api`](https://www.npmjs.com/package/@slack/web-api)
and [`@slack/socket-mode`](https://www.npmjs.com/package/@slack/socket-mode)
clients — no third-party bot framework. Signature verification is done in-house
with `node:crypto`.

---

## How it works

| Concern | Implementation |
|---|---|
| Transport | Events API webhook (`public_base_url` set) **or** Socket Mode (unset). Selected at `activate()`. |
| Auth | Bot token (`xoxb-…`) always; **Events API** adds a Signing Secret; **Socket Mode** adds an App-Level token (`xapp-…`). All stored as plugin secrets (`ctx.secrets`). |
| Signature | Webhook requests verified via `X-Slack-Signature` HMAC-SHA256 over the raw body, with a ±5-min replay window (`src/eventsApiTransport.ts`). |
| Admin UI | Connection status, transport mode, the Request URL to paste (webhook), URL-verified state, last-event timestamp, and a *Reconnect* button. |
| Inbound | `message` / `app_mention` → `IncomingTurn` → the orchestrator's `ChatAgent`. Both transports funnel through one `SlackChannel.ingest` (shared dedup, policy, loop-guard). |
| Outbound | The orchestrator's `SemanticAnswer` is rendered to a Slack `mrkdwn` message; rich elements degrade gracefully (`src/renderer.ts`). |
| Lifecycle | `export async function activate(ctx, core): Promise<ChannelHandle>` — the dynamic channel resolver picks up the bare `activate` export. |

Source map:

```
src/
├── plugin.ts              # activate(ctx, core) — picks transport, wires everything
├── slackChannel.ts        # transport-agnostic core: WebClient, identity, dedup, ingest, send
├── socketModeTransport.ts # Socket Mode WebSocket lifecycle → channel.ingest
├── eventsApiTransport.ts  # Events API webhook router: signature verify + url_verification → channel.ingest
├── inbound.ts             # native Slack event → IncomingTurn, mention stripping, session scope
├── renderer.ts            # SemanticAnswer → Slack mrkdwn (graceful degradation)
├── adminRouter.ts         # /api/slack-channel/admin — status + reconnect
├── logger.ts              # Slack (@slack/logger) logger → CoreApi.log
└── state.ts               # shared connection state
assets/admin-ui/index.html # status page (single file)
```

---

## Create the Slack app

Create an app at `api.slack.com/apps`, then under **OAuth & Permissions** add the
bot scopes and *Install to Workspace* to get the **Bot User OAuth Token**
(`xoxb-…`):

- `app_mentions:read`, `chat:write`, `reactions:write`
- `im:history`, `channels:history`, `groups:history`, `mpim:history`
- `users:read` (optional, for display names)

Then pick a transport:

**Events API (production):**
1. Set `public_base_url` in the plugin setup → the admin UI shows your Request URL.
2. **Basic Information → App Credentials** → copy the **Signing Secret** into the plugin setup.
3. **Event Subscriptions** → enable, paste `<public_base_url>/api/slack/events` as
   the Request URL (Slack verifies it live), and subscribe to the bot events:
   `app_mention`, `message.im` (add `message.channels` / `message.groups` if you
   set `respond_in_channels: all`).

**Socket Mode (local dev / behind firewall):**
1. Leave `public_base_url` empty.
2. **Socket Mode** → enable, generate an **App-Level Token** with
   `connections:write` (`xapp-…`) and put it in the plugin setup.
3. **Event Subscriptions** → subscribe to the same bot events as above.

Finally, invite the bot to any channel it should listen in (`/invite @yourbot`).

---

## Build & install

Requires Node ≥ 20 (this repo pins the version in `.nvmrc`).

```bash
nvm use
npm install
npm run typecheck   # tsc gate (see "Typecheck" below)
npm run build       # esbuild-bundles the Slack SDK into dist/plugin.js, then zips
# → out/omadia-channel-slack-0.2.0.zip
```

Install the resulting ZIP into Omadia:

- **Local / smoke:** Admin-UI → *Store → Lokal → Upload* → drop the `.zip`.
- **Hub:** publish to the registry, then *Store → Hub → Jetzt installieren*
  (see the Omadia plugin docs).

After install, fill in the setup fields, then open the plugin's admin UI to
confirm the connection went green (and — in Events API mode — that Slack
verified the Request URL).

### Setup fields

| Field | Default | Purpose |
|---|---|---|
| `bot_token` | _(required)_ | Bot User OAuth Token (`xoxb-…`). |
| `public_base_url` | _(empty)_ | Public HTTPS origin → **Events API**; empty → **Socket Mode**. |
| `signing_secret` | _(empty)_ | Slack app Signing Secret. Required in Events API mode. |
| `app_token` | _(empty)_ | App-Level Token (`xapp-…`). Required in Socket Mode. |
| `respond_in_channels` | `mention` | `mention` = only on @mention; `all` = every message in joined channels. |
| `allow_dms` | `true` | Respond to 1:1 direct messages. |
| `allowlist` | _(empty)_ | Comma-separated channel ids (`C…`) and/or user ids (`U…`) allowed to interact (empty = all). |

---

## Why the Slack SDK is bundled

A plugin's compiled code can only `import` packages that already exist in the
**host's** `node_modules` (the host resolves a plugin's bare specifiers against
its own tree). `@omadia/*` and `express` are host-provided, so they stay
`peerDependencies` and are marked **external**. `@slack/web-api`,
`@slack/socket-mode` and `@slack/logger` are *not* host-provided, so
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
  `message` event — and the Events API may retry — so the channel handles each
  message exactly once (`channel:ts` dedup, shared across both transports).

## Limitations & caveats

- **Text only (v0.x).** Outbound rich elements (choice cards, follow-ups,
  attachments) degrade to `mrkdwn` text + links. Block Kit (interactive
  components) is planned for a later version.
- **Tokens are sensitive.** The bot/app tokens and signing secret grant access
  to your workspace. They are stored in the plugin vault and never logged; keep
  the admin UI behind the operator-authenticated web-ui.

## License

MIT © byte5 GmbH
