# @omadia/channel-slack

Connects Slack to omadia, so people can talk to their agents from Slack. It routes direct messages and `@mentions` into the omadia orchestrator and returns the reply in the same conversation.

omadia is a self-hostable agentic OS: you build, run, and audit multi-agent AI teams from signed plugins. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia). A channel is how a messaging platform reaches those agents.

## What it does

- Bridges Slack to the omadia orchestrator.
- Two transports: the Events API over a public HTTPS webhook (recommended for production), or Socket Mode as a fallback when you have no public host.
- Handles DMs and `@mentions`, with channel behaviour and an optional allowlist.

## How it works in omadia

This is a channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`; the plugin receives Slack events (webhook or socket), forwards each message to the orchestrator's chat agent, and posts the agent's response back. It needs an LLM provider assigned to the orchestrator first, otherwise there is no agent to answer.

## Install

Install from the omadia hub at [hub.omadia.ai](https://hub.omadia.ai) (omadia admin, plugins, install), or upload the built ZIP directly. Then open the plugin's setup page and fill in the fields below.

## Configuration

| Setup field | Notes |
|-------------|-------|
| Bot User OAuth Token (`xoxb-…`) | Required. |
| Public HTTPS Base-URL | For the Events API transport. |
| Signing Secret | For the Events API transport. |
| App-Level Token (`xapp-…`) | Only for Socket Mode. |
| Channel behaviour | How the bot reacts in channels. |
| Allow DMs | Answer direct messages. |
| Allowlist | Optional. |

Use the Events API transport (token + public URL + signing secret) for production. Socket Mode (token + app-level token) works without a public host.

## Build from source

```bash
npm install
npm run build   # tsc, emits dist/
```

The plugin compiles against the omadia workspace packages it declares as peer deps. Link them from a local omadia checkout before building. See [byte5ai/omadia](https://github.com/byte5ai/omadia).

## License

MIT, byte5 GmbH
