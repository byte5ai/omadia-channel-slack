# AGENTS.md

Notes for coding agents working in this repository.

## Rules

- **No version bumps in PRs.** Leave `version` in `package.json` and `manifest.yaml` alone and add your change under `## Unreleased` in `CHANGELOG.md`. The coordinator picks the version and releases.
- Everything the plugin says to Slack goes through the one emitter (`SlackOutbox`, see `src/outbox.ts`); `tests/outbox.test.ts` counts the code paths.
- Proactive sends and reactions go out as exactly the app `asChannelKey` names (`slack-bot:<member id, lowercase>`); an unknown key is `unreachable`, never another app. Providers return unreachability, they never throw.

## Decisions

- **Reactions (spec 2043 §5.14, omadia #2061; kernel ADR 0027, byte5ai/omadia#2151: channel-sdk 0.3.9, plugin-api 1.82.0).** The kernel's `ConversationReaction` `acknowledge` is Slack's `+1` (thumbs-up), set with [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add) (`channel` = the conversation id, `timestamp` = the message `ts`, both as the inbound `created` event reported them; bot scope `reactions:write`, optional). `already_reacted` is success. The only reaction this plugin sets is the one the kernel asks for: there is no receipt reaction on inbound messages.
- **Readiness without event-subscription proof (issue #6, spec 2043 §5.3, kernel #2091).** Context: the kernel refuses a facilitation in a conversation whose channel has no readiness provider, and Teams checks a per-chat permission (RSC). Slack has none: a member app with the `*:history` scope of the conversation kind receives every message, if its event subscriptions include the `message.*` event, and Slack has no API to read an app's event subscriptions. Decision: `check` reports `installed` from `conversations.info`, `canReadAllMessages` from the granted scopes `auth.test` returns, `canPost` from `chat:write` and the archive flag; when Slack reports no scopes the report is `verified: false`. Consequence: a missing event subscription is not caught by the check; the setup guide and README name the required events.
- **Membership from `member_*` events only (issue #6).** Context: Slack reports joins twice, as `member_joined_channel` / `member_left_channel` and as `channel_join` / `channel_leave` message subtypes. Decision: only the `member_*` events are emitted (structured, with the inviter, also for the app itself); the message subtypes are ignored. Consequence: the app must subscribe `member_joined_channel` and `member_left_channel`; without them the kernel learns no membership changes (the roster is still read fresh on demand).
- **Edit revisions are a hint (issue #6).** Context: Slack edits carry no revision number. Decision: the plugin counts edits and deletions per message in memory from 1; the kernel assigns the binding revision (`adapter_revision` is a hint, migration 0068). Consequence: after a restart the hint starts again at 1, which the kernel tolerates.
- **No Block Kit ballots (issue #6, spec 2043 §6.4).** Context: Slack has no poll API for apps; buttons need an interactivity endpoint and signed `block_actions` handling. Decision: polls and question cards stay refused by the send providers, so the kernel posts numbered plain-text ballots and reads typed answers. Consequence: everything works through plain text; buttons would be a separate feature.
