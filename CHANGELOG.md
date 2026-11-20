# Changelog

## 0.3.0

Agents as colleagues in Slack (omadia#2042, issue #5). Needs kernel
omadia#2045 / #2086 / #2087 (S6 branch): do not publish before the kernel is live.

- **Plain-text output through the SDK renderer** (`renderer.ts`, `outbox.ts`):
  one emitter for everything this channel says. A name line only where INV-4
  wants it (several agents, or a speaker change), colleagues' contributions as
  `Mira: ...`, `system` notices as their own text, choices as a numbered list.
  Gone: follow-up list, disclaimer line, verifier badge, consulted footer and
  the receipt reaction. The AI disclosure line stays part of the answer text
  (operator setting `ai_disclosure_frequency`). Our own failure text is now a
  `system` notice without emoji.
- **No receipt reaction** (the eyes emoji, undeclared decoration, spec §5.14).
  The `reactions:write` scope is no longer needed. Slack has no typing
  indicator for a bot; instead the SDK pace: one acknowledgement after 8 s of
  work, and an ephemeral follow-up when a slash command outlives its
  `response_url`.
- **`/agent` slash command**: Events API route `/api/slack/commands` (signed,
  form-encoded) and Socket Mode `slash_commands` envelopes. The text reaches
  the kernel unchanged (`/agent Mira`); the plugin has no parser. The answer is
  ephemeral through `response_url`. DM policy and allowlist still apply.
  Create the command in the Slack app (setup guide step 5).
- **Turn origin and routing context**: `ChatTurnInput.origin` (channel type,
  principal `user:<member id>`, direct/group, channel id, message id) and
  `IncomingTurn.conversationType`. `channelResolver@1.resolve` gets the
  principal as optional third argument. **Behaviour change:** a `reject` from
  the resolver is now answered with the kernel's `system` notice (or a short
  "no agent set up" text) and never by the default agent (INV-7, #1598).
- **Conversation roster**: `ConversationRosterProvider` via
  `conversations.members` with honest `complete` / `partial` / `unknown`. New
  bot scopes `channels:read`, `groups:read`, `im:read`, `mpim:read`; without
  them a group has no roster and the kernel's audience check stays closed.
- **Per-agent identity is not supported** (one installation = one token set);
  the README states why and what it would cost. Selection runs through `/agent`.
- **Fix:** Socket Mode read the envelope kind from the payload
  (`body.type === 'events_api'`), which is `event_callback` there, so no event
  was ever dispatched; the envelope `type` is used now.
- **Tests:** `npm test` (`node:test` through esbuild, no new dependency):
  criteria 5, 29, 30, 31 and the pace behaviour.
- Version `0.3.0` in `package.json` and `manifest.yaml` (Hub latest was `0.2.3`).
- **People directory** (`slackPeopleDirectory.ts`): registers the kernel's
  `PeopleDirectoryProvider` for `slack` (feature-detected —
  `core.registerPeopleDirectoryProvider?.`), so Conductor human steps can
  resolve a person named in prose to a routable ref. Walks `users.list` into a
  5-minute cache (≤2000 members, `truncated` beyond) and matches handle / real
  name / display name / email; `principalRef` = Slack member id (the channel
  binding key). Needs the **`users:read`** bot scope (+ `users:read.email` for
  addresses); `missing_scope` → `not_configured`, never a crash.

## 0.2.3

- Declare the capabilities this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-slack` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` under
  `requires:` (provided by `@omadia/orchestrator`); `channelResolver@1`
  under `optional_requires:` (kernel-published, absence survivable).
