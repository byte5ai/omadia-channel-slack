import {
  channelUserPrincipal,
  type PeopleDirectoryEntry,
  PeopleDirectoryLookup,
  PeopleDirectoryProvider,
} from '@omadia/channel-sdk';

/** The slice of a Slack `users.list` member this directory needs. */
export interface SlackDirectoryUser {
  readonly id: string;
  readonly name?: string;
  readonly realName?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly title?: string;
}

/** `SlackChannel.searchUsers` — matched workspace members, bounded by `limit`. */
export interface SlackUserSearch {
  searchUsers(query: string, limit: number): Promise<{ users: SlackDirectoryUser[]; truncated: boolean }>;
}

/**
 * Slack people directory — the kernel's `PeopleDirectoryProvider` for
 * `channelType: 'slack'` (Conductor human-step principal resolution).
 *
 * `principalRef` is built with the SDK's `channelUserPrincipal` — the same
 * principal an inbound turn of the person carries (`user:<e-mail>` with a
 * verified e-mail, else `user:slack-user:<id>`) — so awaits and reminders
 * written into `human.principal.ref` meet the turn. Needs the `users:read` bot scope (+ `users:read.email` to show
 * addresses); a missing scope answers `unavailable/not_configured`, never a
 * crash — the kernel then shows a *partial* result and the operator keeps the
 * free-text field.
 */
export function createSlackPeopleDirectoryProvider(opts: {
  readonly channel: SlackUserSearch;
  readonly log: (msg: string) => void;
}): PeopleDirectoryProvider {
  return {
    channelType: 'slack',
    async search(query, { limit }): Promise<PeopleDirectoryLookup> {
      const q = query.trim();
      if (q.length === 0) return { outcome: 'resolved', people: [], partial: false };
      try {
        const result = await opts.channel.searchUsers(q, limit);
        return { outcome: 'resolved', people: result.users.map(toEntry), partial: result.truncated };
      } catch (err) {
        const code = slackErrorCode(err);
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'missing_scope' || code === 'not_authed' || code === 'invalid_auth' || code === 'account_inactive') {
          opts.log(`slack people directory unavailable (${code}) — add the users:read (and users:read.email) bot scopes to resolve people by name`);
          return { outcome: 'unavailable', code: 'not_configured', message };
        }
        return { outcome: 'unavailable', code: 'source_error', message };
      }
    },
  };
}

const USER_PRINCIPAL_PREFIX = 'user:';

/**
 * The reference Conductor writes into `human.principal.ref`: the part after
 * `user:` of the SDK's {@link channelUserPrincipal}, the one principal an
 * inbound turn of this person carries (`slack-user:<id>`, or the e-mail when
 * the profile has one). Same function on both sides, so an await finds the turn.
 */
export function slackPrincipalRef(user: Pick<SlackDirectoryUser, 'id' | 'email'>): string {
  const principal = channelUserPrincipal({ kind: 'slack-user', id: user.id, ...(user.email ? { email: user.email } : {}) });
  return principal.slice(USER_PRINCIPAL_PREFIX.length);
}

function toEntry(user: SlackDirectoryUser): PeopleDirectoryEntry {
  const displayName = [user.realName, user.displayName, user.name].find((n) => n && n.trim().length > 0)?.trim() ?? user.id;
  return {
    principalRef: slackPrincipalRef(user),
    displayName,
    ...(user.email && user.email.trim() ? { email: user.email.trim().toLowerCase() } : {}),
    channelUserId: user.id,
    ...(user.title && user.title.trim() ? { hint: user.title.trim() } : {}),
  };
}

/** `@slack/web-api` platform errors carry the API error string in `data.error`. */
function slackErrorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}
