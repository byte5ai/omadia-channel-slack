import type {
  SlackMembershipEvent,
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackReactionEvent,
} from './conversationEvents.js';
import type { SlackMessageEvent } from './inbound.js';

/**
 * Message subtypes that are still a person's new message: a thread reply also
 * sent to the channel, a message with a file. Every other subtype (joins,
 * topic changes, bot posts, edits, deletions) is no new message.
 */
export const HUMAN_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set(['thread_broadcast', 'file_share']);

/** What a transport hands one Slack event to (implemented by `SlackChannel`). */
export interface SlackEventTarget {
  ingest(event: SlackMessageEvent, teamId: string | undefined): Promise<void>;
  ingestEdit(event: SlackMessageChangedEvent, teamId: string | undefined): Promise<void>;
  ingestDeletion(event: SlackMessageDeletedEvent, teamId: string | undefined): Promise<void>;
  ingestReaction(event: SlackReactionEvent, teamId: string | undefined): Promise<void>;
  ingestMembership(event: SlackMembershipEvent): Promise<void>;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Dispatch one Slack Events API `event` (both transports): new messages and
 * mentions to `ingest`, edits and deletions, reactions, members joining and
 * leaving to their handlers. Anything else is ignored. The payload is narrowed
 * at runtime: a transport hands untyped JSON.
 */
export async function routeSlackEvent(target: SlackEventTarget, raw: unknown, teamId: string | undefined): Promise<void> {
  if (!raw || typeof raw !== 'object') return;
  const event = raw as { type?: unknown; subtype?: unknown; channel?: unknown; ts?: unknown };
  switch (event.type) {
    case 'app_mention':
      if (isText(event.channel) && isText(event.ts)) await target.ingest(raw as SlackMessageEvent, teamId);
      return;
    case 'message':
      if (!isText(event.channel) || !isText(event.ts)) return;
      if (event.subtype === 'message_changed') await target.ingestEdit(raw as SlackMessageChangedEvent, teamId);
      else if (event.subtype === 'message_deleted') await target.ingestDeletion(raw as SlackMessageDeletedEvent, teamId);
      // Bot posts and other subtypes are filtered (and logged) by `ingest`.
      else await target.ingest(raw as SlackMessageEvent, teamId);
      return;
    case 'reaction_added':
    case 'reaction_removed':
      await target.ingestReaction(raw as SlackReactionEvent, teamId);
      return;
    case 'member_joined_channel':
    case 'member_left_channel':
      await target.ingestMembership(raw as SlackMembershipEvent);
      return;
    default:
      return;
  }
}
