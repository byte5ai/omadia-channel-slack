import type {
  ConversationParticipant,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { conversationTypeOf } from './conversationEvents.js';
import { SLACK_CHANNEL_TYPE } from './renderer.js';

/** The slice of {@link SlackChannel} the roster needs. */
export interface SlackMembersSource {
  readonly selfUserId: string;
  conversationMembers(channel: string, max: number): Promise<{ memberIds: string[]; truncated: boolean }>;
}

export interface SlackRosterDeps {
  channel: SlackMembersSource;
  log: (message: string) => void;
  /** Injected for tests. */
  now?: () => number;
}

/** The roster provider, plus a way to drop a conversation's cached read. */
export interface SlackRosterProvider extends ConversationRosterProvider {
  /** Members joined or left: the next read asks Slack again (also without `fresh`). */
  forget(conversationId: string): void;
}

/** A roster read is reused this long; `fresh: true` bypasses it. */
export const ROSTER_CACHE_TTL_MS = 30_000;
/** Members listed at most; more than this is reported `partial`. */
export const ROSTER_MAX_MEMBERS = 2_000;
/** Cached conversations kept at most (oldest dropped first). */
const ROSTER_CACHE_MAX_ENTRIES = 500;

const SLACK_USER_KIND = 'slack-user' as const;

/** Bot-scope names that make `conversations.members` work, by conversation kind. */
const SCOPE_BY_PREFIX: Readonly<Record<string, string>> = {
  C: 'channels:read',
  G: 'groups:read',
  D: 'im:read',
};

function apiErrorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

function unknownRoster(channelId: string, readAt: string, detail: string): ConversationRoster {
  return {
    conversationType: conversationTypeOf(channelId),
    participants: [],
    partial: true,
    status: 'unknown',
    readAt,
    statusDetail: detail,
  };
}

/** Why a read failed, in words an operator can act on. */
function failureDetail(channelId: string, code: string | undefined): string {
  switch (code) {
    case 'missing_scope': {
      const scope = SCOPE_BY_PREFIX[channelId.charAt(0)] ?? 'channels:read';
      return `the Slack app lacks the ${scope} bot scope (conversations.members); mpim:read covers group DMs`;
    }
    case 'not_in_channel':
      return 'the bot is not a member of this channel, so Slack hides its members';
    case 'channel_not_found':
      return 'Slack does not know this conversation (or the bot cannot see it)';
    default:
      return `Slack refused the member list${code ? ` (${code})` : ''}`;
  }
}

/**
 * Slack's {@link ConversationRosterProvider}: who is in a conversation, from
 * `conversations.members`. The kernel's audience floor (S2, fail-closed) needs
 * it before an agent answers in a group.
 *
 * Honest status, never a guess:
 *  - `complete`: Slack listed every member;
 *  - `partial`: the list stopped at {@link ROSTER_MAX_MEMBERS};
 *  - `unknown`: Slack refused (missing scope, bot not in the channel, ...), with
 *    the reason in `statusDetail`.
 *
 * The member list holds ids only, so `isBot` is stated for the bot itself
 * (`self`) and left open for everyone else: another app in the channel is
 * counted as a participant, the safe direction for an audience check.
 * A read is cached for {@link ROSTER_CACHE_TTL_MS}; `fresh: true` always asks
 * Slack, and a member joining or leaving drops the cached read
 * ({@link SlackRosterProvider.forget}). A failed read is never cached and never
 * `complete`: a failure on any page is `unknown`.
 * One provider per app: the plugin picks the app `asChannelKey` names before
 * it gets here (`SlackAppFleet.rosterProvider`).
 */
export function createSlackRosterProvider(deps: SlackRosterDeps): SlackRosterProvider {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { roster: ConversationRoster; at: number }>();

  const remember = (channelId: string, roster: ConversationRoster): void => {
    cache.delete(channelId);
    cache.set(channelId, { roster, at: now() });
    if (cache.size > ROSTER_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  return {
    channelType: SLACK_CHANNEL_TYPE,
    forget(conversationId: string): void {
      cache.delete(conversationId.trim());
    },
    async getRoster(conversationId: string, opts?: ConversationRosterRequest) {
      const channelId = conversationId.trim();
      if (!channelId) return undefined;
      const hit = cache.get(channelId);
      if (!opts?.fresh && hit && now() - hit.at < ROSTER_CACHE_TTL_MS) return hit.roster;

      const readAt = new Date(now()).toISOString();
      try {
        const { memberIds, truncated } = await deps.channel.conversationMembers(channelId, ROSTER_MAX_MEMBERS);
        const selfId = deps.channel.selfUserId;
        const participants: ConversationParticipant[] = memberIds.map((id) => ({
          userRef: { kind: SLACK_USER_KIND, id },
          ...(id === selfId ? { isBot: true } : {}),
        }));
        const roster: ConversationRoster = {
          conversationType: conversationTypeOf(channelId),
          participants,
          ...(selfId ? { self: { userRef: { kind: SLACK_USER_KIND, id: selfId }, isBot: true } } : {}),
          partial: truncated,
          status: truncated ? 'partial' : 'complete',
          readAt,
          ...(truncated ? { statusDetail: `only the first ${String(ROSTER_MAX_MEMBERS)} members were read` } : {}),
        };
        remember(channelId, roster);
        return roster;
      } catch (err) {
        const detail = failureDetail(channelId, apiErrorCode(err));
        deps.log(`Slack roster for ${channelId} unavailable: ${detail}`);
        // Not cached: a missing scope fixed by the operator must take effect at once.
        return unknownRoster(channelId, readAt, detail);
      }
    },
  };
}
