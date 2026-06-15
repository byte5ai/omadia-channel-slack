<div align="center">

# @omadia/plugin-channel-slack

### Talk to your omadia agents from Slack.

A signed omadia plugin that connects Slack to your agent team. It routes DMs and @mentions into the orchestrator and posts the reply back in the same conversation.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Main repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin hub**](https://hub.omadia.ai) · [**What it does**](#what-it-does) · [**Install**](#install)

🇩🇪 Diese Anleitung gibt es auch [auf Deutsch](./README.de.md).

</div>

---

omadia is a self-hostable agentic OS: compose multi-agent teams from signed plugins, run them on your own machine, and get an auditable trail for every action. This plugin lets people reach those agents straight from Slack. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## What it does

Connects Slack to omadia. DMs and @mentions are routed into the omadia orchestrator, and the reply comes back in the same conversation.

There are two transports:

- **Events API** over a public HTTPS webhook. Recommended for production.
- **Socket Mode** as a fallback when you have no public host.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`, then it receives Slack events over the webhook or the socket, forwards each message to the orchestrator chat agent, and posts the response back to Slack. You need an LLM provider assigned to the orchestrator first, otherwise there is nothing to answer with.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI (Store, Upload), or drop the built ZIP in directly.
2. Fill in the setup fields below. There is no API key for this plugin.
3. Assign an LLM provider to the orchestrator first, so the chat agent has a model to run on.

## Configuration

| Field | Notes |
| --- | --- |
| Bot User OAuth Token (`xoxb-...`) | Required. |
| Public HTTPS Base-URL | For the Events API transport. |
| Signing Secret | For the Events API transport. |
| App-Level Token (`xapp-...`) | Only for Socket Mode. |
| Channel behaviour | How the bot reacts in channels. |
| Allow DMs | Let the bot answer direct messages. |
| Allowlist | Optional. |

Use the Events API transport for production. Socket Mode works without a public host.

## Build from source

```bash
npm install
npm run build   # tsc, emits dist/
npm test        # validates manifest.yaml against core's invariants
```

`@omadia/plugin-api` is provided by the omadia host at runtime (optional peer dep). Link it from a local omadia checkout to build. See [byte5ai/omadia](https://github.com/byte5ai/omadia) for the layout.

## License

[MIT](LICENSE), byte5 GmbH