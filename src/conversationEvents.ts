import type {
  ChannelUserRef,
  ConversationMembershipEvent,
  ConversationMessageEvent,
} from '@omadia/channel-sdk';

import { stripMention } from './inbound.js';

/**
 * The Slack events besides a new message that a moderated conversation needs
 * (spec 2043 §5.3, §5.5): edits, deletions, reactions and members joining or
 * leaving. Our own minimal shapes, like `SlackMessageEvent`: only the fields
 * read, narrowed by runtime guards in {@link routeSlackEvent}.
 */
export interface SlackMessageChangedEvent {
  type: 'message';
  subtype: 'message_changed';
  channel: string;
  channel_type?: string;
  /** When the edit happened. */
  ts: string;
  message?: {
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
    /** Only a real edit carries it (an unfurl does not). */
    edited?: { user?: string; ts?: string };
  };
}

export interface SlackMessageDeletedEvent {
  type: 'message';
  subtype: 'message_deleted';
  channel: string;
  channel_type?: string;
  ts: string;
  deleted_ts?: string;
  previous_message?: { user?: string; ts?: string; bot_id?: string };
}

export interface SlackReactionEvent {
  type: 'reaction_added' | 'reaction_removed';
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  event_ts?: string;
}

export interface SlackMembershipEvent {
  type: 'member_joined_channel' | 'member_left_channel';
  user?: string;
  channel?: string;
  /** `C` public channel, `G` private channel. */
  channel_type?: string;
  /** Who added the member (`member_joined_channel` only, when Slack knows it). */
  inviter?: string;
  event_ts?: string;
}

export interface ConversationEventsDeps {
  /** The emitting channel plugin's catalog id. */
  channelId: string;
  /** This app's bot member id (empty before `init`). */
  selfUserId: () => string;
  /** This app's routing key `slack-bot:<member id>`. */
  channelKey: () => string | undefined;
  emitMessage?: (event: ConversationMessageEvent) => void;
  emitMembership?: (event: ConversationMembershipEvent) => void;
  deliveryOf?: (conversationId: string, channelKey: string) => 'all' | 'addressed' | 'none';
  /** A member list changed: forget any cached roster of the conversation. */
  onMembershipChanged?: (conversationId: string) => void;
  /** DM policy and allowlist, the same as for new messages. */
  admits: (conversationId: string, userId: string | undefined) => boolean;
  /** The sender's verified e-mail, when the profile gives one. */
  emailOf: (userId: string) => Promise<string | undefined>;
  log: (message: string, context?: Record<string, unknown>) => void;
}

/** Edit counters kept at most; the kernel assigns the authoritative revision. */
const REVISIONS_MAX = 1_000;
/** Conversations whose `bot_present` was already emitted, kept at most. */
const PRESENT_MAX = 2_000;

const SLACK_USER = 'slack-user' as const;

/** A Slack DM id starts with `D`; every other conversation is a group. */
export function conversationTypeOf(channelId: string): 'direct' | 'group' {
  return channelId.startsWith('D') ? 'direct' : 'group';
}

/** Slack's `ts` ("1701.000200", seconds) as ISO 8601; now when it is no number. */
export function slackTsToIso(ts: string | undefined): string {
  const date = new Date(Number.parseFloat(ts ?? '') * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** Does `text` mention the bot `<@U…>` (also `<@U…|name>`)? */
export function mentionsUser(text: string | undefined, userId: string): boolean {
  return !!text && !!userId && (text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`));
}

/**
 * Translates Slack's edit, deletion, reaction and membership events into the
 * kernel's conversation records. Every method is fire-and-forget and never
 * throws: a moderated conversation must not lose its turn path because one
 * record could not be built. Starts no turn.
 */
export class SlackConversationEvents {
  private readonly revisions = new Map<string, number>();
  private readonly presentIn = new Set<string>();

  constructor(private readonly deps: ConversationEventsDeps) {}

  /** `message_changed` with an `edited` stamp: the next revision of a human message. */
  async edited(event: SlackMessageChangedEvent, teamId: string | undefined): Promise<void> {
    const message = event.message;
    const author = message?.user;
    const messageTs = message?.ts;
    if (!message?.edited || !author || !messageTs || message.bot_id || this.isSelf(author)) return;
    const text = message.text ?? '';
    await this.emit(event.channel, author, {
      messageId: messageTs,
      revision: this.nextRevision(event.channel, messageTs),
      kind: 'edited',
      text: this.deps.selfUserId() ? stripMention(text, this.deps.selfUserId()) : text.trim(),
      ...(message.thread_ts && message.thread_ts !== messageTs ? { replyToMessageId: message.thread_ts } : {}),
      ...(mentionsUser(text, this.deps.selfUserId()) ? { addressedToBot: true } : {}),
      occurredAt: slackTsToIso(message.edited.ts ?? event.ts),
    }, teamId);
  }

  /** `message_deleted`: the message is gone (a deleted ballot no longer counts). */
  async deleted(event: SlackMessageDeletedEvent, teamId: string | undefined): Promise<void> {
    const previous = event.previous_message;
    const author = previous?.user;
    const messageTs = event.deleted_ts ?? previous?.ts;
    if (!author || !messageTs || previous?.bot_id || this.isSelf(author)) return;
    await this.emit(event.channel, author, {
      messageId: messageTs,
      revision: this.nextRevision(event.channel, messageTs),
      kind: 'deleted',
      occurredAt: slackTsToIso(event.ts),
    }, teamId);
  }

  /** `reaction_added` / `reaction_removed` on a message (bot scope `reactions:read`). */
  async reaction(event: SlackReactionEvent, teamId: string | undefined): Promise<void> {
    const { user, reaction, item } = event;
    if (!user || !reaction || item?.type !== 'message' || !item.channel || !item.ts || this.isSelf(user)) return;
    await this.emit(item.channel, user, {
      messageId: item.ts,
      revision: 0,
      kind: 'reaction',
      reaction: { name: reaction, removed: event.type === 'reaction_removed' },
      occurredAt: slackTsToIso(event.event_ts),
    }, teamId);
  }

  /**
   * `member_joined_channel` / `member_left_channel` (bot scopes
   * `channels:read`, `groups:read`): `members_added` / `members_removed`, or
   * `bot_added` when this app itself joined (with the inviter, when Slack
   * names one). The cached roster of the conversation is dropped either way.
   */
  membership(event: SlackMembershipEvent): void {
    const { user, channel } = event;
    if (!user || !channel) return;
    this.deps.onMembershipChanged?.(channel);
    if (!this.deps.emitMembership || !this.deps.admits(channel, user)) return;
    const member: ChannelUserRef = { kind: SLACK_USER, id: user };
    const base = {
      channelId: this.deps.channelId,
      channelType: 'slack',
      conversationId: channel,
      conversationType: conversationTypeOf(channel),
      members: [member],
      occurredAt: slackTsToIso(event.event_ts),
    } as const;
    const joined = event.type === 'member_joined_channel';
    const membershipEvent: ConversationMembershipEvent =
      joined && this.isSelf(user)
        ? { ...base, kind: 'bot_added', ...(event.inviter ? { addedBy: { kind: SLACK_USER, id: event.inviter } } : {}) }
        : { ...base, kind: joined ? 'members_added' : 'members_removed' };
    this.safely(() => this.deps.emitMembership?.(membershipEvent));
  }

  /**
   * `bot_present` (eligibility only): a human group message proves this app is
   * a member, also when it was added long before omadia ran. Once per
   * conversation and process; the sender is `addedBy`, best-effort.
   */
  present(conversationId: string, senderId: string): void {
    if (!this.deps.emitMembership || conversationTypeOf(conversationId) !== 'group') return;
    const self = this.deps.selfUserId();
    if (!self || this.presentIn.has(conversationId)) return;
    if (this.presentIn.size >= PRESENT_MAX) this.presentIn.clear();
    this.presentIn.add(conversationId);
    const event: ConversationMembershipEvent = {
      kind: 'bot_present',
      channelId: this.deps.channelId,
      channelType: 'slack',
      conversationId,
      conversationType: 'group',
      members: [{ kind: SLACK_USER, id: self }],
      addedBy: { kind: SLACK_USER, id: senderId },
      occurredAt: new Date().toISOString(),
    };
    this.safely(() => this.deps.emitMembership?.(event));
  }

  private async emit(
    conversationId: string,
    authorId: string,
    record: Pick<ConversationMessageEvent, 'messageId' | 'revision' | 'kind' | 'occurredAt'> &
      Partial<Pick<ConversationMessageEvent, 'text' | 'replyToMessageId' | 'addressedToBot' | 'reaction'>>,
    teamId: string | undefined,
  ): Promise<void> {
    const { emitMessage, deliveryOf } = this.deps;
    const channelKey = this.deps.channelKey();
    if (!emitMessage || !channelKey || !this.deps.admits(conversationId, authorId)) return;
    if (deliveryOf?.(conversationId, channelKey) === 'none') return;
    try {
      const email = await this.deps.emailOf(authorId);
      emitMessage({
        channelId: this.deps.channelId,
        channelType: 'slack',
        conversationId,
        conversationType: conversationTypeOf(conversationId),
        receivedByChannelKey: channelKey,
        author: { kind: SLACK_USER, id: authorId, ...(email ? { email } : {}) },
        ...(teamId ? { tenantId: teamId } : {}),
        ...record,
      });
    } catch (err) {
      this.deps.log(`Slack ${record.kind} event not emitted`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.log('Slack membership event not emitted', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private isSelf(userId: string): boolean {
    const self = this.deps.selfUserId();
    return self !== '' && userId === self;
  }

  /** A hint only: the kernel counts revisions itself (it survives our restart). */
  private nextRevision(channel: string, ts: string): number {
    const key = `${channel}:${ts}`;
    const next = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.delete(key);
    this.revisions.set(key, next);
    if (this.revisions.size > REVISIONS_MAX) {
      const oldest = this.revisions.keys().next().value;
      if (oldest !== undefined) this.revisions.delete(oldest);
    }
    return next;
  }
}
