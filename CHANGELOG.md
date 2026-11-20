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
  principal, direct/group, channel id, message id) and
  `IncomingTurn.conversationType`. `channelResolver@1.resolve` gets
  `{ principal, locale }`. **Behaviour change:** a `reject` from the resolver
  is now answered with the kernel's `system` notice (or a short "no agent set
  up" text) and never by the default agent (INV-7, #1598).
- **S1 resolver contract** (kernel `135a14dbe`, needs core `>=1.76.0`):
  `compat.core` is `>=1.76.0 <2.0` (placeholder; the parent session sets the
  final range at landing). The resolver result is `bound | reject`, `chatAgent`
  always set (the old `fallback` decision is gone). On `reject` the text still
  reaches that ChatAgent (it carries out `/agent`, `/agents`) and only a
  `system` answer is posted, else the resolver `notice`. **The principal is
  built only with the SDK's `turnPrincipal` / `channelUserPrincipal`**:
  `user:slack-user:<id>` lowercase (was `user:<id>`). The pace
  acknowledgement goes out under the speaker the resolver announces
  (`ChannelResolveResult.speaker`), no longer as `system`; without a speaker
  it is skipped, and an answer without a speaker is withheld and replaced by a
  `system` notice (fail-closed).
- **No singleton fallback**: the turn path uses the SDK's `resolveChannelRoute`
  and always the `chatAgent` of its result (also on `reject`). A throwing
  resolver is an error of the turn (system notice), no longer a reason to ask
  `chatAgent@1`, which since S1 only serves a host without a resolver.
- **Selection key**: the agent selection lives at the narrowest conversation
  key, the Slack channel, never the workspace. A binding on the workspace key
  still answers ordinary turns; `/agent` goes to the ChatAgent of the channel
  key (the SDK's `parseAgentCommand` only chooses the target, the text is
  untouched).
- **Sender profile** (`users.info`, cached, 1.5 s timeout, never blocks a
  turn): the e-mail makes the principal `user:<e-mail>` (bot scope
  `users:read.email`, optional), the language (`de` / `en`) goes to the
  resolver as `locale` and to the pace acknowledgement.
- **People directory** builds `principalRef` with `channelUserPrincipal`
  (`slack-user:<id>` or the e-mail, was the bare member id), the form of the
  turn principal. **Kernel follow-up:** `bindingKeyForTurn` still keys a Slack
  binding by the bare member id.
- **Typed answers to polls and cards** (kernel c510bf5c4): `created` message
  events through `core.emitConversationMessage` (feature-detected;
  `conversationDelivery` `none` skips). Conversation = channel id,
  `messageId` = `ts`, `replyToMessageId` = thread root of a thread reply,
  `addressedToBot` on a mention, `receivedByChannelKey` = `slack-bot:<bot member id>`
  (no binding key per bot in the contract yet). Not emitted for slash
  commands, disabled DMs, channels outside the allowlist. The conversation
  send provider returns the Slack `ts` as `messageId`.
- **No double turn for a typed answer** (kernel 28da9b54a): a message that
  would start a turn goes through `core.reportConversationMessage` first
  (feature-detected, 1.5 s timeout, errors logged); `answeredCard: true` means
  no turn (no acknowledgement, no agent answer). Timeout, error or an older
  kernel: emit and turn as before.
- **Send providers**: `TargetedSendProvider` (DM by member id,
  `user:slack-user:<id>` or e-mail via `users.lookupByEmail`, scope
  `users:read.email`) and `ConversationSendProvider`, registered when the
  kernel offers them. `system` messages through the outbox; `mentions`
  declared; `asChannelKey`, polls and cards are not (the sender falls back to
  a plain-text ballot, `renderCardAsText` / `parseCardReply`, criterion 30).
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
