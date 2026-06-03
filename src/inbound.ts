import type { IncomingTurn } from '@omadia/channel-sdk';

/**
 * Structural shape of the Slack events we route. Deliberately our OWN minimal
 * interfaces (not Slack's version-unstable generated event types): the Socket
 * Mode `slack_event` listener hands us loosely-typed payloads, so we narrow
 * them with these and runtime guards. We only model the fields we read.
 */
export interface SlackMessageEvent {
  /** `'message'` for channel/DM posts, `'app_mention'` for @-mentions. */
  type: 'message' | 'app_mention';
  /** Channel / DM / group id (C…, D…, G…). The reply + send target. */
  channel: string;
  /** Author user id (U…). Absent on some system message subtypes. */
  user?: string;
  /** Message text (mrkdwn). May contain `<@U…>` mention tokens. */
  text?: string;
  /** Message timestamp ("1701.0001") — also the reaction + thread anchor. */
  ts: string;
  /** Set when the message belongs to a thread. */
  thread_ts?: string;
  /** Present on non-plain messages (edits, joins, bot posts, …). */
  subtype?: string;
  /** Present when the message was posted by a bot (incl. our own replies). */
  bot_id?: string;
  /** `'im'` (DM), `'channel'`, `'group'` (private), `'mpim'` (group DM). */
  channel_type?: 'im' | 'channel' | 'group' | 'mpim';
}

/** The Socket Mode envelope body for an Events API delivery. */
export interface SlackEnvelopeBody {
  type: string; // 'events_api' for the events we care about
  team_id?: string;
  event?: SlackMessageEvent;
}

/** Typed metadata we stash on the {@link IncomingTurn} for the reply path. */
export interface SlackTurnMeta {
  /** Session-transcript bucket — thread-aware so each channel thread is its
   *  own session, while a DM is one continuous conversation. */
  sessionScope: string;
  /** thread_ts to reply under (channel messages) or undefined (DMs → top-level). */
  threadTs?: string;
  /** Slack workspace id, when carried on the envelope. */
  teamId?: string;
  channelType: NonNullable<SlackMessageEvent['channel_type']>;
  /** The triggering message ts (for reactions / dedup). */
  eventTs: string;
}

/** Pull trimmed plain text out of a Slack message. Returns `undefined` when
 *  there is nothing routable (empty / whitespace-only). */
export function extractText(event: SlackMessageEvent): string | undefined {
  const trimmed = event.text?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Strip the bot's own `<@U…>` mention tokens (and tidy the surrounding
 *  whitespace) so an `@bot frage…` message reaches the orchestrator as `frage…`. */
export function stripMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]+)?>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Thread-aware session scope. DMs collapse to one scope per channel; channel
 *  messages get a per-thread scope rooted at the thread's first message. */
export function sessionScope(event: SlackMessageEvent): string {
  if (event.channel_type === 'im') return `slack:${event.channel}`;
  const threadRoot = event.thread_ts ?? event.ts;
  return `slack:${event.channel}:${threadRoot}`;
}

/** Translate a native Slack message into the core {@link IncomingTurn} shape. */
export function buildIncomingTurn(
  channelId: string,
  event: SlackMessageEvent,
  text: string,
  teamId: string | undefined,
): IncomingTurn {
  const channelType = event.channel_type ?? 'channel';
  const isDm = channelType === 'im';
  const meta: SlackTurnMeta = {
    sessionScope: sessionScope(event),
    ...(isDm ? {} : { threadTs: event.thread_ts ?? event.ts }),
    ...(teamId ? { teamId } : {}),
    channelType,
    eventTs: event.ts,
  };
  return {
    channelId,
    conversationId: event.channel,
    userRef: {
      kind: 'slack-user',
      id: event.user ?? event.channel,
    },
    text,
    metadata: meta as unknown as Record<string, unknown>,
    rawEvent: event,
  };
}
