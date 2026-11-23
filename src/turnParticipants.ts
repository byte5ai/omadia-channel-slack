import type { ConversationRosterProvider } from '@omadia/channel-sdk';

/**
 * Who is in a Slack conversation, handed to the kernel for one turn.
 *
 * The kernel bounds a group turn by everyone present (audience floor, #2048)
 * and scopes member memory by it. It reads that list from the turn's
 * `chatParticipants` provider, which the channel installs around the turn with
 * `turnContext.runWithChatParticipants` (Teams and Telegram do the same).
 * Without it every tool call in a channel is refused as "audience unknown",
 * so a facilitator could not even start (slack#6 live run, 2026-11-23).
 *
 * The list comes from the app the turn arrived through (its roster provider),
 * people only. Slack's `conversations.members` lists every member, so a
 * `complete` read is the whole room; a `partial` or `unknown` read is no
 * audience at all: the provider fails and the kernel closes the floor instead
 * of trusting a subset.
 */

/** Mirror of the kernel's `ChatParticipant` (harness-orchestrator/chatParticipants.ts). */
export interface ChatParticipantLike {
  channelUserId: string;
  aadObjectId: string | null;
  displayName: string;
  email: string | null;
  userPrincipalName: string | null;
}

/** Mirror of the kernel's `ChatParticipantsProvider`. */
export type ChatParticipantsProviderLike = (() => Promise<ChatParticipantLike[]>) & {
  readonly completeRoster?: boolean;
};

/** The slice of the kernel's `turnContext` service this plugin uses. */
export interface TurnContextLike {
  runWithChatParticipants<T>(provider: ChatParticipantsProviderLike, fn: () => Promise<T>): Promise<T>;
}

/** Runs a turn in `conversationId` with its participants known to the kernel. */
export type WithParticipants = <T>(conversationId: string, run: () => Promise<T>) => Promise<T>;

export function createTurnParticipants(roster: ConversationRosterProvider, turnContext: TurnContextLike): WithParticipants {
  return <T>(conversationId: string, run: () => Promise<T>): Promise<T> => {
    const read = async (): Promise<ChatParticipantLike[]> => {
      const result = await roster.getRoster(conversationId);
      if (!result || result.status !== 'complete') {
        throw new Error(`Slack roster of ${conversationId} is ${result?.status ?? 'unknown'}, not complete`);
      }
      return result.participants
        .filter((p) => p.isBot !== true)
        .map((p) => ({
          channelUserId: p.userRef.id,
          aadObjectId: null,
          displayName: p.userRef.id,
          email: null,
          userPrincipalName: null,
        }));
    };
    const provider: ChatParticipantsProviderLike = Object.assign(read, { completeRoster: true });
    return turnContext.runWithChatParticipants(provider, run);
  };
}
