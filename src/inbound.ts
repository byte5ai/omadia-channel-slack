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
  /** Untyped JSON: `routeSlackEvent` narrows it (messages, edits, reactions, membership). */
  event?: unknown;
}

/**
 * The payload of a native Slack slash command (`/agent`). Arrives form-encoded
 * on the Events API route `<public_base_url>/api/slack/commands`, or as the
 * `body` of a `slash_commands` envelope in Socket Mode. Only the fields we read.
 */
export interface SlackSlashCommandPayload {
  /** The command as typed, with the slash: `/agent`. */
  command: string;
  /** Everything after the command name; empty for a bare `/agent`. */
  text?: string;
  user_id: string;
  channel_id: string;
  /** `directmessage` for a DM, `privategroup` for a private channel, else the channel name. */
  channel_name?: string;
  team_id?: string;
  /** One-shot reply URL (valid 30 min): the only way to answer ephemerally. */
  response_url?: string;
  /** Unique per invocation; the de-duplication key. */
  trigger_id?: string;
}

/** The slash commands this channel hands to the kernel's management layer. */
export const AGENT_SLASH_COMMANDS: ReadonlySet<string> = new Set(['/agent', '/agents']);

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
  /** The triggering message ts (for dedup and the origin's message id). */
  eventTs: string;
  /** Slash commands only: reply here, ephemerally, instead of posting. */
  responseUrl?: string;
  /** Slash commands only: who typed it. */
  commandUserId?: string;
  /** The sender's language (`de` / `en`) when Slack states it; the kernel's notices follow it. */
  locale?: string;
}

/** What Slack knows about the sender beyond the event (`users.info`). */
export interface SlackSenderProfile {
  /** The member's e-mail (bot scope `users:read.email`), lowercase. Slack confirms workspace e-mail addresses. */
  readonly email?: string;
  /** `de` or `en`; any other language is left out (the kernel then writes German). */
  readonly locale?: string;
}

/** `de-DE` / `en_US` → `de` / `en`; anything else → `undefined`. */
export function supportedLocale(raw: string | undefined): string | undefined {
  const language = raw?.trim().slice(0, 2).toLowerCase();
  return language === 'de' || language === 'en' ? language : undefined;
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

/** Extra facts about a turn that did not arrive as a plain message. */
export interface TurnSource {
  /** The turn is a slash command: channel-level scope, ephemeral reply. */
  command?: { responseUrl?: string };
}

/** Translate a native Slack message into the core {@link IncomingTurn} shape. */
export function buildIncomingTurn(
  channelId: string,
  event: SlackMessageEvent,
  text: string,
  teamId: string | undefined,
  source: TurnSource = {},
  profile: SlackSenderProfile = {},
): IncomingTurn {
  const channelType = event.channel_type ?? 'channel';
  const isDm = channelType === 'im';
  const command = source.command;
  const meta: SlackTurnMeta = {
    sessionScope: command ? commandSessionScope(event) : sessionScope(event),
    ...(isDm || command ? {} : { threadTs: event.thread_ts ?? event.ts }),
    ...(teamId ? { teamId } : {}),
    channelType,
    eventTs: event.ts,
    ...(command?.responseUrl ? { responseUrl: command.responseUrl } : {}),
    ...(command && event.user ? { commandUserId: event.user } : {}),
    ...(profile.locale ? { locale: profile.locale } : {}),
  };
  return {
    channelId,
    conversationId: event.channel,
    conversationType: isDm ? 'direct' : 'group',
    userRef: {
      kind: 'slack-user',
      id: event.user ?? event.channel,
      ...(profile.email ? { email: profile.email } : {}),
    },
    text,
    metadata: meta as unknown as Record<string, unknown>,
    rawEvent: event,
  };
}

/** `im` for a DM, `mpim` for a group DM, `group` for a private channel, else `channel`. */
function commandChannelType(payload: SlackSlashCommandPayload): NonNullable<SlackMessageEvent['channel_type']> {
  if (payload.channel_id.startsWith('D') || payload.channel_name === 'directmessage') return 'im';
  if (payload.channel_name?.startsWith('mpdm-')) return 'mpim';
  if (payload.channel_name === 'privategroup' || payload.channel_id.startsWith('G')) return 'group';
  return 'channel';
}

/**
 * Translate a slash command into the event shape the rest of the channel
 * understands. A command is an explicit address, so it is an `app_mention` for
 * the access policy. The text reaches the kernel exactly as typed, with the
 * command name in front (`/agent Mira`): the kernel's management layer parses
 * it, this plugin does not. Returns `undefined` for a command that is not ours
 * or carries no routable channel/user.
 */
export function commandToEvent(payload: SlackSlashCommandPayload): SlackMessageEvent | undefined {
  const command = payload.command?.trim().toLowerCase();
  if (!command || !AGENT_SLASH_COMMANDS.has(command)) return undefined;
  if (!payload.channel_id || !payload.user_id) return undefined;
  const argument = (payload.text ?? '').trim();
  return {
    type: 'app_mention',
    channel: payload.channel_id,
    user: payload.user_id,
    text: argument ? `${command} ${argument}` : command,
    // A slash command carries no message ts; trigger_id is unique per call.
    ts: payload.trigger_id ?? `cmd-${Date.now()}`,
    channel_type: commandChannelType(payload),
  };
}

/**
 * Session scope of a slash-command turn. Slack does not say which thread a
 * command was typed in (and does not allow commands in threads at all), so a
 * channel command belongs to the channel-level scope, a DM to the DM's.
 */
export function commandSessionScope(event: SlackMessageEvent): string {
  return `slack:${event.channel}`;
}
