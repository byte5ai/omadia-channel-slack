<div align="center">

# @omadia/plugin-channel-slack

### Talk to your omadia agents from Slack.

A signed omadia plugin that connects Slack to your agent team. It routes DMs and @mentions to your agents and posts the reply back in the same conversation.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Main repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin hub**](https://hub.omadia.ai) · [**What it does**](#what-it-does) · [**Install**](#install)

🇩🇪 Diese Anleitung gibt es auch [auf Deutsch](./README.de.md).

</div>

---

omadia is a self-hostable agentic OS: compose multi-agent teams from signed plugins, run them on your own machine, and get an auditable trail for every action. This plugin lets people reach those agents straight from Slack. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## What it does

Connects Slack to omadia. DMs and @mentions are routed to your agents, and the reply comes back in the same conversation.

There are two transports:

- **Events API** over a public HTTPS webhook. Recommended for production.
- **Socket Mode** as a fallback when you have no public host.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`, then it receives Slack events over the webhook or the socket, forwards each message to the agent runtime, and posts the response back to Slack. You need an LLM provider assigned to the agent runtime first, otherwise there is nothing to answer with.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI (Store, Upload), or drop the built ZIP in directly.
2. Fill in the setup fields below. There is no API key for this plugin.
3. Assign a model to the agent runtime first, so the chat agent has a model to run on.

## Agents in Slack

**Addressing.** This plugin runs **one Slack app per installation**: one bot token, one bot name and avatar. So the speaker is not shown through the platform, and several agents in the same Slack are reached with the native **`/agent`** command:

- `/agent Mira` selects Mira for you in this conversation, `/agent` clears your selection, `/agents` lists the agents available to you here.
- The plugin only forwards the text (the kernel's resolver hands the turn to a chat agent that carries `/agent`, `/agent Mira` and `/agents` out itself). The omadia kernel stores the selection per user and conversation, checks availability and answers with a short system notice that only you see (an ephemeral message).
- Slack does not allow slash commands inside threads. Write `@YourBot /agent Mira` there, it is handled the same way.
- Create the command in your Slack app (**Slash Commands**): `/agent`, Request URL `<public_base_url>/api/slack/commands` (Events API) or no URL (Socket Mode). See the setup guide.

**Own app per agent.** Slack allows one app per agent with its own name, avatar and `@mention` (`chat:write.customize` only changes name and avatar per message and is no addressable identity, so it is not used). Next to the app in its setup, this plugin runs one app per agent (spec 2042 §5.3). For each agent: create a Slack app from the same app manifest, named like the agent, install it to the workspace, and enter its credentials in omadia under **Operator → Agents → the agent → Channels → Own bots → Slack**: the Bot User OAuth Token and, matching this channel's transport, the Signing Secret (Events API; set the app's Request URL to `<public_base_url>/api/slack/agent-bots/<member id, lowercase>/events`, the member id shows on the agent page after connecting) or an App-Level Token (Socket Mode). omadia hands the credentials to this plugin once; the plugin checks the bot token with `auth.test`, keeps them in its own vault (`agent_app_<member id>`), starts the app and reports the routing key `slack-bot:<member id>`. Then everyone who mentions or DMs that app talks to exactly that agent (`/agent` there says whose app it is), the agent's answers and omadia's posts in its name go out through its app without a name line, and an app omadia does not know as an agent's identity answers only with a short system notice. An agent's app answers when it is mentioned or sent a DM, also with *respond in channels = all* (otherwise every agent app in a channel would answer the same message). If Slack is unreachable when omadia starts, agent apps start in the background as soon as it is. Removing it on the agent page stops it and deletes its credentials. Agents without an app of their own are reached through the shared app with `/agent`.

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

**Proactive messages.** The plugin registers a direct-message and a conversation send provider for the kernel (reminders, approvals, reports). They post through the app omadia names (`asChannelKey`): the agent's own app when it has one, otherwise the shared app, and can @mention Slack members. A poll or question card is refused, so the kernel posts it as a numbered plain-text question itself and remembers it as open (the provider reports the message's Slack `ts`). Answer by typing the number, as a reply in the question's thread or, when it is the only open question and you address the bot, as a message in the channel or DM.

**Reactions.** When an agent moderates a conversation, omadia records a contribution quietly: it sets a thumbs-up (`+1`) on the person's message instead of posting an echo (spec 2043 §5.14). The conversation provider declares `reactions` and calls [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add) with the Slack channel id and the message `ts` the inbound event reported, as exactly the app omadia names (`asChannelKey`): the agent's own app or the shared app, never another one. Add the bot scope `reactions:write` (optional): without it `react` answers `not_permitted` and the caller decides what to do instead (the facilitator can post its confirmation). A message the app already reacted to counts as done. This is no receipt reaction: the bot still reacts to nothing on its own.

**Triggers and routines.** An agent can set a trigger or a routine in a conversation ("remind me tomorrow at 9", a weekly report). Every turn opens omadia's routines scope (`routinesIntegration@1`, only with a database), which is what offers the agent these tools here, and the delivery later goes out through the app the conversation runs through, in the same thread: the agent's own app without a name line, the shared app named like an answer. An app that was removed or given to another agent delivers nothing.

**Message record for the kernel.** For that to work the plugin tells the kernel about every human message in a channel, thread or DM (`created` events through `emitConversationMessage`, feature-detected; the kernel keeps them only for a conversation it moderates and drops the rest): conversation = Slack channel id, `messageId` = `ts`, a thread reply carries the thread root as `replyToMessageId`, a mention of the bot sets `addressedToBot`. Slash commands, DMs switched off and channels outside the allowlist are not emitted. It starts no turn by itself; the mention policy still decides on that. A message that would start a turn is reported first (`reportConversationMessage`, waits at most 1.5 s): if the kernel takes it as the typed answer to an open question, no turn starts, so the agent does not also answer "2". On a timeout or error, or on an older kernel, the turn runs as usual. The kernel knows every app of this installation (the shared app and each agent's app) under the key **`slack-bot:<bot member id, lowercase>`** (for example `slack-bot:u0abc123`): it is the receiving identity of these events, the routing key of an agent's app and the `asChannelKey` its posts go out under.

**Groups.** The bot reads who is in a channel or group chat (`conversations.members`) and gives the kernel an honest roster (complete, partial or unknown). The kernel's audience check needs it: without the roster an agent does not answer in a group. Add the bot scopes `channels:read`, `groups:read`, `im:read` and `mpim:read`. A missing scope shows up as "roster unknown" in the log, not as a guess. A cached read is reused for 30 seconds; a fresh query (`fresh: true`) always asks Slack, and a member joining or leaving drops the cached read at once. A read that fails on any page is `unknown`, never `complete`.

## Facilitation in Slack

A facilitating agent (spec 2043) moderates a Slack channel or group chat through its own Slack app (see *Own app per agent*), so it posts and sends direct messages under its own name and avatar.

- **Every message, per conversation.** While the facilitation holds a message subscription for a conversation, the plugin hands every human message there to the kernel: new messages (also thread replies sent to the channel and messages with a file), edits (`message_changed`), deletions (`message_deleted`) and reactions (`reaction_added` / `reaction_removed`). Deleting a message that has thread replies arrives from Slack as a changed placeholder (`tombstone`) and is reported as a deletion. A reaction or edit by another app or bot is not reported. Events of one conversation reach the kernel in the order Slack sent them, so an edit never arrives before its message. Which of them count in which phase decides the kernel. Elsewhere the mention rules stay: a plain message there is not recorded and starts no turn. Edits, deletions and reactions never start a turn.
- **Members.** `member_joined_channel` and `member_left_channel` go to the kernel as `members_added` / `members_removed`; the app itself being invited is `bot_added`, with the inviter. Members carry their Slack display name. Other apps and bots joining or leaving are not reported: they are never participants. The first human message in a group also tells the kernel the app is present there (`bot_present`), for channels the app joined before omadia ran; it is sent again at most every 12 hours, because the kernel forgets it after 24.
- **Readiness.** For each conversation the plugin tells the kernel whether the agent's app is a member, may read every message and can post. Slack has no per-conversation permission like Teams: a member app with the `*:history` scope of the conversation kind gets every message. Scopes are checked from the bot token and read again after 5 minutes, so a reinstall with new scopes shows up without a reconnect. The channel's own settings count too: with DMs switched off a DM is `unsupported_conversation`, and with an allowlist that does not list the conversation it cannot read every message (`consent_missing`). The check asks Slack once, without retries and with a 5-second timeout; a failure is `graph_error`. Slack has no API that shows an app's event subscriptions, so `message.channels`, `message.groups`, `message.mpim`, `message.im` and the two `member_*` events must be set in the app (setup step 4). If they are missing, the readiness check cannot see it, so every report says `verified: false`.
- **Capabilities.** The plugin tells the kernel what a conversation delivers (`registerMeetingSourceProvider`, spec 2043 §6.1): text and edits, reactions only when the app has `reactions:read`; out: text, mentions and direct messages (a DM: text). Chat only, no live session.
- **Replies to a DM.** When someone answers a DM of the app in its thread (for example a reminder), the turn names the message it answers (`TurnOrigin.replyToMessageId`, the `ts` the plugin reported for its own post; since channel-sdk 0.3.11).
- **Votes through plain text.** Everything works as chat messages: ballots, contributions, status and stop. Slack has no poll API for apps, so a poll or question card is posted as a numbered plain-text ballot and the answers are typed messages. Block Kit buttons are not used: they would need an interactivity endpoint that this plugin does not run. A vote typed without mentioning the bot is recorded in a facilitated conversation.

**What Slack cannot do here.** No native polls (text ballots instead). No live session input: huddles offer bots no audio, transcript or join and leave events, so a Slack conversation is a chat-only session. Edits carry no revision number in Slack: the plugin numbers them from 1 in memory and the kernel assigns the binding revision. The send providers declare no polls or cards; saying in the chat what does not work here is the facilitator's part (kernel).

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