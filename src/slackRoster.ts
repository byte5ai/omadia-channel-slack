import type {
  ConversationParticipant,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { conversationTypeOf } from './conversationEvents.js';
import { SLACK_CHANNEL_TYPE } from './renderer.js';
import { SLACKBOT_USER_ID } from './slackProfiles.js';

/** The slice of {@link SlackChannel} the roster needs. */
export interface SlackMembersSource {
  readonly selfUserId: string;
  conversationMembers(channel: string, max: number): Promise<{ memberIds: string[]; truncated: boolean }>;
  /** `users.info`, cached; never throws (an unknown member is `{}`). */
  senderProfile?(userId: string): Promise<{ isBot?: boolean }>;
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
/** Members whose profile is looked up per read (bots marked); beyond, isBot stays open. */
export const ROSTER_PROFILE_LOOKUPS_MAX = 300;
/** Parallel `users.info` lookups per read (the cache answers repeats). */
const ROSTER_PROFILE_CONCURRENCY = 8;

/** Which members are apps or bots: own app, Slackbot, and `users.info` is_bot. */
async function botIdsOf(source: SlackMembersSource, memberIds: readonly string[]): Promise<Set<string>> {
  const bots = new Set<string>(memberIds.filter((id) => id === source.selfUserId || id === SLACKBOT_USER_ID));
  const lookup = source.senderProfile?.bind(source);
  if (!lookup) return bots;
  const queue = memberIds.filter((id) => !bots.has(id)).slice(0, ROSTER_PROFILE_LOOKUPS_MAX);
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        if ((await lookup(id)).isBot === true) bots.add(id);
      } catch {
        // A failed lookup leaves the member a person (the safe direction for an audience check).
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ROSTER_PROFILE_CONCURRENCY, queue.length) }, worker));
  return bots;
}

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
 * The member list holds ids only; `isBot` comes from `users.info` (cached):
 * this app, Slackbot and every other app or bot user (Jira, Giphy, another
 * agent's app) are marked, so a facilitator never expects their vote. At
 * most {@link ROSTER_PROFILE_LOOKUPS_MAX} members are looked up per read; a
 * member beyond that, or whose lookup failed, stays a person.
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
  /** Bumped by every forget(): a read that started before it is not cached (it may predate the change). */
  let generation = 0;

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
      generation += 1;
      cache.delete(conversationId.trim());
    },
    async getRoster(conversationId: string, opts?: ConversationRosterRequest) {
      const channelId = conversationId.trim();
      if (!channelId) return undefined;
      const hit = cache.get(channelId);
      if (!opts?.fresh && hit && now() - hit.at < ROSTER_CACHE_TTL_MS) return hit.roster;

      const readAt = new Date(now()).toISOString();
      const startedAt = generation;
      try {
        const { memberIds, truncated } = await deps.channel.conversationMembers(channelId, ROSTER_MAX_MEMBERS);
        const selfId = deps.channel.selfUserId;
        const bots = await botIdsOf(deps.channel, memberIds);
        const participants: ConversationParticipant[] = memberIds.map((id) => ({
          userRef: { kind: SLACK_USER_KIND, id },
          ...(bots.has(id) ? { isBot: true } : {}),
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
        if (startedAt === generation) remember(channelId, roster);
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
