# AGENTS.md

Notes for coding agents working in this repository.

## Rules

- **No version bumps in PRs.** Leave `version` in `package.json` and `manifest.yaml` alone and add your change under `## Unreleased` in `CHANGELOG.md`. The coordinator picks the version and releases.
- Everything the plugin says to Slack goes through the one emitter (`SlackOutbox`, see `src/outbox.ts`); `tests/outbox.test.ts` counts the code paths.
- Proactive sends and reactions go out as exactly the app `asChannelKey` names (`slack-bot:<member id, lowercase>`); an unknown key is `unreachable`, never another app. Providers return unreachability, they never throw.

## Decisions

- **Reactions (spec 2043 §5.14, omadia #2061; kernel ADR 0027, byte5ai/omadia#2151: channel-sdk 0.3.9, plugin-api 1.82.0).** The kernel's `ConversationReaction` `acknowledge` is Slack's `+1` (thumbs-up), set with [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add) (`channel` = the conversation id, `timestamp` = the message `ts`, both as the inbound `created` event reported them; bot scope `reactions:write`, optional). `already_reacted` is success. The only reaction this plugin sets is the one the kernel asks for: there is no receipt reaction on inbound messages.
