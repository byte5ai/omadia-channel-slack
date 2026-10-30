# Changelog

## Unreleased

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
