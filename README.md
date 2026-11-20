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

## Agents in Slack

**Addressing.** This plugin runs **one Slack app per installation**: one bot token, one bot name and avatar. So the speaker is not shown through the platform, and several agents in the same Slack are reached with the native **`/agent`** command:

- `/agent Mira` selects Mira for you in this conversation, `/agent` clears your selection, `/agents` lists the agents available to you here.
- The plugin only forwards the text (the kernel's resolver hands the turn to a chat agent that carries `/agent`, `/agent Mira` and `/agents` out itself). The omadia kernel stores the selection per user and conversation, checks availability and answers with a short system notice that only you see (an ephemeral message).
- Slack does not allow slash commands inside threads. Write `@YourBot /agent Mira` there, it is handled the same way.
- Create the command in your Slack app (**Slash Commands**): `/agent`, Request URL `<public_base_url>/api/slack/commands` (Events API) or no URL (Socket Mode). See the setup guide.

**Own identity per agent: not supported by this plugin.** Slack itself allows it: one Slack app per agent gives each its own name, avatar and `@mention`. `chat:write.customize` only changes name and avatar per message and is no addressable identity, so it is not used. A plugin installation holds exactly one token set (bot token, signing secret or app-level token), so per-agent apps would need one installation per app, and the kernel has no channel key for a Slack bot identity yet to bind such a bot to its agent. What it would cost you per agent: create and maintain a Slack app, its scopes, its request URL or app-level token, install it in the workspace and invite it to channels. Until then, use `/agent`.

**How answers look.** Like a colleague's message: no status line, chip, footer, button or follow-up list.

- One agent in a conversation: no name line. Several agents: a plain `Name:` line where the speaker would otherwise be unclear. The speaker history is kept in memory, so after a restart a conversation is recognised as a multi-agent one again from its second speaker on.
- What a consulted colleague contributed appears as plain text (`Mira: ...`).
- Messages from the system (for example "this agent is not available to you") are plain text of their own, never under an agent's name.
- Choices become a numbered list in the text.
- The AI disclosure line is part of the answer text and follows the operator's frequency setting.
- There is **no receipt reaction** any more (the former eyes emoji) and no typing indicator: Slack offers none to a bot outside its AI-assistant surface. For long work the agent acknowledges once ("on it", under its own name, as announced by the kernel) after 8 seconds, then answers. A slash command that outlives its 30-minute `response_url` is answered as an ephemeral follow-up.

**Who is asking.** The kernel is told who sends a message as a principal in the one form every channel uses (`channelUserPrincipal` of the SDK): `user:<e-mail>` when Slack gives the member's e-mail (`users.info`, bot scope `users:read.email`; Slack confirms workspace addresses), else `user:slack-user:<member id, lowercase>`. Selections and availability are keyed by it, and the Conductor people picker writes the same form, so an await finds the person's turn. The same `users.info` call gives the person's language: `de` or `en` go to the kernel so its notices and the "on it" acknowledgement speak it (other languages: German). Without `users:read.email` the id form is used; a lookup that fails never blocks a message.

**Where your selection lives.** `/agent` is stored for you and the **channel** (or DM) you typed it in, never for the whole workspace. A workspace-wide binding still answers ordinary messages in every channel; `/agent` is handed to the channel's own entry so your choice stays in that channel. Slack has no per-thread selection: it is per channel.

**Refusals.** If no agent answers a turn (disabled, deleted, not available to you, nothing addressed), you get the kernel's `system` notice, never an answer from another agent. `/agent` still works then, so you can pick an agent. An answer without a speaker is withheld and replaced by a short system notice (fail-closed).

**Proactive messages.** The plugin registers a direct-message and a conversation send provider for the kernel (reminders, approvals, reports). They deliver `system` messages through the same single outbox, can @mention Slack members and cannot post "as" a given agent (one Slack app is one identity). A poll or question card is refused so the sender falls back to a plain-text ballot: a numbered question you answer by typing the number.

**Groups.** The bot reads who is in a channel or group chat (`conversations.members`) and gives the kernel an honest roster (complete, partial or unknown). The kernel's audience check needs it: without the roster an agent does not answer in a group. Add the bot scopes `channels:read`, `groups:read`, `im:read` and `mpim:read`. A missing scope shows up as "roster unknown" in the log, not as a guess.

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
npm test        # node:test via esbuild; needs the built channel SDK of an omadia checkout
```

Tests bundle `@omadia/channel-sdk` and `@omadia/plugin-api` from `../middleware/packages/*/dist` (override with `OMADIA_CHANNEL_SDK_DIST` and `OMADIA_PLUGIN_API_DIST`). `@omadia/plugin-api` is provided by the omadia host at runtime (optional peer dep). Link it from a local omadia checkout to build. See [byte5ai/omadia](https://github.com/byte5ai/omadia) for the layout.

## License

[MIT](LICENSE), byte5 GmbH