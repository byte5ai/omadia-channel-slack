import { LogLevel } from '@slack/logger';
import { WebClient } from '@slack/web-api';
import type { SlackDirectoryUser } from './slackPeopleDirectory.js';

import type { ConversationMessageEvent, IncomingTurn } from '@omadia/channel-sdk';

import {
  buildIncomingTurn,
  supportedLocale,
  commandToEvent,
  extractText,
  stripMention,
  type SlackMessageEvent,
  type SlackSenderProfile,
  type SlackSlashCommandPayload,
  type TurnSource,
} from './inbound.js';
import type { SlackSink } from './outbox.js';
import { makeSlackLogger, type LogSink } from './logger.js';
import { patchState, type ChannelState } from './state.js';

export interface AccessPolicy {
  /** In channels/groups: respond only to @mentions, or to every message. */
  respondInChannels: 'mention' | 'all';
  /** Respond to 1:1 direct messages. */
  allowDms: boolean;
  /** Channel ids (C…) and/or user ids (U…) allowed to interact. Empty = all. */
  allowlist: Set<string>;
}

export interface SlackChannelDeps {
  channelId: string;
  botToken: string;
  log: LogSink;
  state: ChannelState;
  policy: AccessPolicy;
  onMessage: (turn: IncomingTurn) => Promise<void>;
  /**
   * Tells the kernel about an inbound message (`core.emitConversationMessage`,
   * feature-detected: absent on an older kernel, then nothing is emitted). The
   * kernel stores it only for a subscribed conversation and drops it otherwise.
   */
  emitMessage?: (event: ConversationMessageEvent) => void;
  /**
   * `core.reportConversationMessage`: like `emitMessage`, but says whether the
   * kernel took the message as the typed answer to an open question
   * (`answeredCard`); then the message starts no turn. Absent on an older
   * kernel: `emitMessage` and the turn run as before.
   */
  reportMessage?: (event: ConversationMessageEvent) => Promise<{ answeredCard: boolean }>;
  /** `core.conversationDelivery`: what the bot identity is handed of a conversation. Absent: emit. */
  deliveryOf?: (conversationId: string, channelKey: string) => 'all' | 'addressed' | 'none';
}

/**
 * The key under which the kernel knows a Slack bot: `slack-bot:<bot member
 * id>`, lowercase like every routing key (spec 2042 §5.3). The same string for
 * the installation's own app and for an agent's own app: routing resolves an
 * agent app on it (exclusive), `asChannelKey` names it on sends, and message
 * events are received under it.
 */
export function slackBotChannelKey(botUserId: string): string {
  return `slack-bot:${botUserId.toLowerCase()}`;
}

/** `response_url`s are minted by Slack on this domain; anything else is refused. */
const RESPONSE_URL_HOST_SUFFIX = '.slack.com';

/** Cap on the dedup set of handled message keys. */
const HANDLED_KEYS_MAX = 1_000;

/** `users.list` cache for the people directory: one workspace walk per TTL,
 *  bounded so a huge workspace cannot pin memory; `truncated` tells the
 *  kernel the directory is only partially known. */
const USERS_CACHE_TTL_MS = 5 * 60 * 1000;
const USERS_PAGE_SIZE = 200;
const USERS_CACHE_MAX = 2_000;

/** Sender profiles (`users.info`): a known member keeps its profile for an hour, a failed lookup is retried after a minute, and a slow Slack never holds a turn longer than the timeout. */
const PROFILE_TTL_MS = 60 * 60 * 1000;
const PROFILE_FAILURE_TTL_MS = 60 * 1000;
const PROFILE_TIMEOUT_MS = 1_500;
const PROFILE_CACHE_MAX = 2_000;

/** The kernel's verdict on a message that would start a turn must never hold the turn longer than this. */
const REPORT_TIMEOUT_MS = 1_500;

/** `conversations.members` page size (Slack allows up to 1000; 200 is the documented default). */
const MEMBERS_PAGE_SIZE = 200;

/**
 * Transport-agnostic Slack channel core. Owns the {@link WebClient} (outbound
 * Web API + identity), the inbound de-duplication + access policy, and the
 * native-event → {@link IncomingTurn} translation. Both transports
 * (Socket Mode and the Events API webhook) funnel every inbound payload through
 * {@link ingest} (messages) or {@link ingestCommand} (the `/agent` slash
 * command), so the filtering, loop-guard and reply path are identical
 * regardless of how the event arrived. The channel sends no receipt reaction:
 * an undeclared decoration (spec 2042 §5.14); Slack has no typing indicator
 * for a bot outside its AI-assistant surface, so there is nothing to show
 * while the answer is being prepared.
 */
export class SlackChannel implements SlackSink {
  private readonly web: WebClient;
  private botUserId = '';
  private readonly profiles = new Map<string, { profile: SlackSenderProfile; expiresAt: number }>();
  private usersCache: { users: SlackDirectoryUser[]; truncated: boolean; fetchedAt: number } | undefined;
  /** `${channel}:${ts}` of messages already handled — Slack delivers a mention
   *  as BOTH an `app_mention` and a `message` event (and the Events API may
   *  retry), so we de-duplicate centrally. */
  private readonly handledKeys = new Set<string>();

  constructor(private readonly deps: SlackChannelDeps) {
    this.web = new WebClient(deps.botToken, {
      logger: makeSlackLogger(deps.log),
      logLevel: LogLevel.ERROR,
    });
  }

  /** Validate the bot token and learn our own identity — needed to ignore our
   *  own messages and strip the bot mention from `@bot …` text. Throws on a bad
   *  token so the caller can surface an `error` status. */
  async init(): Promise<void> {
    const auth = await this.web.auth.test();
    this.botUserId = typeof auth.user_id === 'string' ? auth.user_id : '';
    patchState(this.deps.state, {
      me: {
        botUserId: this.botUserId,
        teamId: typeof auth.team_id === 'string' ? auth.team_id : '',
        ...(typeof auth.user === 'string' ? { botUserName: auth.user } : {}),
        ...(typeof auth.team === 'string' ? { teamName: auth.team } : {}),
      },
    });
    this.deps.log('info', 'Slack bot token validated', {
      botUserId: this.botUserId,
      team: auth.team,
    });
  }

  /**
   * Process one inbound Slack event (a `message` or `app_mention`). Idempotent
   * per `${channel}:${ts}`. Applies the loop-guard, access policy and allowlist,
   * then drives an orchestrator turn.
   */
  async ingest(event: SlackMessageEvent, teamId: string | undefined): Promise<void> {
    await this.process(event, teamId, {});
  }

  /**
   * Process a native slash command (`/agent`, `/agents`). The text is handed
   * to the kernel unchanged as an ordinary inbound message (the kernel's
   * management layer parses it and answers with a `system` notice); the answer
   * goes back ephemerally through the command's `response_url`, so choosing an
   * agent does not clutter the channel. A command is an explicit address, so
   * it passes the channel-mention policy; DM and allowlist policy still apply.
   */
  async ingestCommand(payload: SlackSlashCommandPayload): Promise<void> {
    const event = commandToEvent(payload);
    if (!event) return;
    const responseUrl = validResponseUrl(payload.response_url);
    await this.process(event, payload.team_id, { command: responseUrl ? { responseUrl } : {} });
  }

  private async process(
    event: SlackMessageEvent,
    teamId: string | undefined,
    source: TurnSource,
  ): Promise<void> {
    const key = `${event.channel}:${event.ts}`;
    if (this.handledKeys.has(key)) return;
    this.handledKeys.add(key);
    this.trimHandledKeys();

    try {
      // Never react to bot posts (incl. our own replies) — prevents reply loops.
      if (event.bot_id || event.subtype === 'bot_message') return;
      if (this.botUserId && event.user === this.botUserId) return;

      const isMention = event.type === 'app_mention';
      // Plain message events with a subtype are edits/joins/etc. — skip them.
      // app_mention never carries a subtype.
      if (!isMention && event.subtype) return;

      const channelType = event.channel_type ?? 'channel';
      const isDm = channelType === 'im';

      // The kernel's message record sees every human message of a conversation
      // it moderates, also one that does not mention the bot (a typed answer to
      // a poll). It is no turn: the mention gate below still decides on that.
      // A message that WOULD start a turn waits (briefly) for the kernel's
      // verdict: taken as the answer to an open question, it starts no turn.
      const dmOff = isDm && !this.deps.policy.allowDms;
      const allowlisted = this.isAllowlisted(event);
      if (!source.command && !dmOff && allowlisted) {
        const startsTurn = isMention || isDm || this.deps.policy.respondInChannels === 'all';
        if (await this.emitCreated(event, teamId, startsTurn)) {
          this.deps.log('info', 'Slack message consumed as the answer to an open question: no turn', {
            channel: event.channel,
          });
          return;
        }
      }

      // Access policy. An explicit @mention (or slash command) always passes
      // the channel policy (the user asked for the bot by name); plain
      // messages are gated by DM / channel policy. Direct messages can be
      // switched off for commands too.
      if (isDm && !this.deps.policy.allowDms) {
        this.deps.log('info', 'Slack inbound skipped: DMs disabled', { channel: event.channel });
        return;
      }
      if (!isMention && !isDm && this.deps.policy.respondInChannels !== 'all') {
        this.deps.log('info', 'Slack inbound skipped: channel message without mention', {
          channel: event.channel,
        });
        return;
      }

      // Allowlist by channel id and/or user id.
      if (!this.isAllowlisted(event)) {
        this.deps.log('info', 'Slack message dropped (not allowlisted)', {
          channel: event.channel,
          user: event.user,
        });
        return;
      }

      let text = extractText(event);
      if (text && this.botUserId) text = stripMention(text, this.botUserId);
      if (!text) {
        this.deps.log('info', 'Slack inbound skipped: no text content', { channel: event.channel });
        return;
      }

      this.deps.log('info', 'Slack message received', {
        channel: event.channel,
        channelType,
        isMention,
        ...(source.command ? { command: true } : {}),
      });
      patchState(this.deps.state, { lastInboundAt: Date.now() });

      const profile = event.user ? await this.senderProfile(event.user) : {};
      await this.deps.onMessage(buildIncomingTurn(this.deps.channelId, event, text, teamId, source, profile));
    } catch (err) {
      this.deps.log('error', 'error handling inbound Slack message', {
        channel: event.channel,
        error: errMessage(err),
      });
    }
  }

  /**
   * E-mail and language of a sender (`users.info`, bot scope `users:read`;
   * `users:read.email` for the address). The e-mail makes the principal the
   * cross-channel one (`user:<e-mail>`), the language is the notice locale.
   * Never throws and never blocks a turn for long: an unknown profile is `{}`
   * (principal `user:slack-user:<id>`, German notices).
   */
  async senderProfile(userId: string): Promise<SlackSenderProfile> {
    const cached = this.profiles.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.profile;
    try {
      const res = await Promise.race([
        this.web.users.info({ user: userId, include_locale: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('users.info timed out')), PROFILE_TIMEOUT_MS).unref()),
      ]);
      const email = res.user?.profile?.email?.trim().toLowerCase();
      const locale = supportedLocale(res.user?.locale);
      const profile: SlackSenderProfile = { ...(email ? { email } : {}), ...(locale ? { locale } : {}) };
      this.rememberProfile(userId, profile, PROFILE_TTL_MS);
      return profile;
    } catch (err) {
      this.deps.log('warn', 'Slack sender profile unavailable', { error: errMessage(err) });
      this.rememberProfile(userId, {}, PROFILE_FAILURE_TTL_MS);
      return {};
    }
  }

  private rememberProfile(userId: string, profile: SlackSenderProfile, ttlMs: number): void {
    if (this.profiles.size >= PROFILE_CACHE_MAX) this.profiles.clear();
    this.profiles.set(userId, { profile, expiresAt: Date.now() + ttlMs });
  }

  private isAllowlisted(event: SlackMessageEvent): boolean {
    const { allowlist } = this.deps.policy;
    return (
      allowlist.size === 0 ||
      allowlist.has(event.channel) ||
      (event.user !== undefined && allowlist.has(event.user))
    );
  }

  /**
   * Emit a `created` conversation message (#2043, #2086): the conversation is
   * the Slack channel id, `messageId` the `ts`, a thread reply carries the
   * thread root as `replyToMessageId`, a mention of the bot sets
   * `addressedToBot`. Needs `emitMessage` and the bot's own id (after `init`);
   * skipped when the kernel says the bot is handed nothing of this conversation.
   * Never fails the turn.
   *
   * `awaitVerdict`: the message would start a turn, so ask the kernel
   * (`reportMessage`) whether it consumed the message as a typed answer and
   * wait at most {@link REPORT_TIMEOUT_MS}; a timeout or error means "not
   * consumed" and the turn runs as before. Returns `true` only for a consumed
   * message. Without `reportMessage` it is `emitMessage`, fire-and-forget.
   */
  private async emitCreated(event: SlackMessageEvent, teamId: string | undefined, awaitVerdict: boolean): Promise<boolean> {
    const { emitMessage, reportMessage, deliveryOf } = this.deps;
    if ((!emitMessage && !reportMessage) || !this.botUserId || !event.user) return false;
    const receivedByChannelKey = slackBotChannelKey(this.botUserId);
    if (deliveryOf?.(event.channel, receivedByChannelKey) === 'none') return false;
    try {
      const raw = extractText(event);
      const text = raw ? stripMention(raw, this.botUserId) : undefined;
      const isDm = (event.channel_type ?? 'channel') === 'im';
      const profile = deliveryOf ? await this.senderProfile(event.user) : {};
      const mentionsBot = event.type === 'app_mention' || (raw?.includes(`<@${this.botUserId}`) ?? false);
      const occurredAt = new Date(Number.parseFloat(event.ts) * 1000);
      const message: ConversationMessageEvent = {
        channelId: this.deps.channelId,
        channelType: 'slack',
        conversationId: event.channel,
        conversationType: isDm ? 'direct' : 'group',
        receivedByChannelKey,
        messageId: event.ts,
        revision: 0,
        kind: 'created',
        author: { kind: 'slack-user', id: event.user, ...(profile.email ? { email: profile.email } : {}) },
        ...(teamId ? { tenantId: teamId } : {}),
        ...(text ? { text } : {}),
        ...(event.thread_ts && event.thread_ts !== event.ts ? { replyToMessageId: event.thread_ts } : {}),
        ...(mentionsBot ? { addressedToBot: true } : {}),
        occurredAt: Number.isFinite(occurredAt.getTime()) ? occurredAt.toISOString() : new Date().toISOString(),
      };
      if (awaitVerdict && reportMessage) return await this.verdict(reportMessage, message);
      if (emitMessage) emitMessage(message);
      else void reportMessage?.(message).catch((err: unknown) => this.deps.log('warn', 'Slack message report failed', { error: errMessage(err) }));
      return false;
    } catch (err) {
      this.deps.log('warn', 'Slack message event not emitted', { error: errMessage(err) });
      return false;
    }
  }

  /** The kernel's verdict within {@link REPORT_TIMEOUT_MS}; unknown (late, failed) is `false`. */
  private async verdict(
    report: NonNullable<SlackChannelDeps['reportMessage']>,
    message: ConversationMessageEvent,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<{ answeredCard: false }>((resolve) => {
        timer = setTimeout(() => {
          this.deps.log('warn', 'Slack message report timed out: the turn runs as usual', { channel: message.conversationId });
          resolve({ answeredCard: false });
        }, REPORT_TIMEOUT_MS);
      });
      return (await Promise.race([report(message), timeout])).answeredCard === true;
    } catch (err) {
      this.deps.log('warn', 'Slack message report failed: the turn runs as usual', { error: errMessage(err) });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Post a message. `threadTs` threads the reply (channel messages); omit for
   *  DMs to reply at the top level. */
  /**
   * People directory (Conductor human steps): workspace members matching
   * `query` on handle / real name / display name / email, case-insensitive.
   * Slack has no user search API, so this walks `users.list` (bot scope
   * `users:read`, `users:read.email` for addresses) into a 5-minute cache and
   * filters locally. Bots, deleted users and Slackbot are excluded. Throws the
   * Web API error (with `data.error`) so the provider can map `missing_scope`
   * to "not configured".
   */
  async searchUsers(query: string, limit: number): Promise<{ users: SlackDirectoryUser[]; truncated: boolean }> {
    const needle = query.trim().toLowerCase();
    const cache = await this.workspaceUsers();
    const matches = cache.users.filter((u) =>
      [u.name, u.realName, u.displayName, u.email].some((v) => v !== undefined && v.toLowerCase().includes(needle)),
    );
    const cap = Math.max(1, Math.floor(limit));
    return { users: matches.slice(0, cap), truncated: cache.truncated || matches.length > cap };
  }

  private async workspaceUsers(): Promise<{ users: SlackDirectoryUser[]; truncated: boolean }> {
    if (this.usersCache && Date.now() - this.usersCache.fetchedAt < USERS_CACHE_TTL_MS) return this.usersCache;
    const users: SlackDirectoryUser[] = [];
    let cursor: string | undefined;
    let truncated = false;
    do {
      const page = await this.web.users.list({ limit: USERS_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const m of page.members ?? []) {
        if (!m.id || m.deleted || m.is_bot || m.id === 'USLACKBOT') continue;
        users.push({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.real_name ? { realName: m.real_name } : {}),
          ...(m.profile?.display_name ? { displayName: m.profile.display_name } : {}),
          ...(m.profile?.email ? { email: m.profile.email } : {}),
          ...(m.profile?.title ? { title: m.profile.title } : {}),
        });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
      if (users.length >= USERS_CACHE_MAX) {
        // Hard cap: drop the overflow of the last page too, and say so.
        if (users.length > USERS_CACHE_MAX || cursor) truncated = true;
        users.length = Math.min(users.length, USERS_CACHE_MAX);
        cursor = undefined;
      }
    } while (cursor);
    this.usersCache = { users, truncated, fetchedAt: Date.now() };
    return this.usersCache;
  }

  /**
   * Member id for an e-mail address (`users.lookupByEmail`; bot scope
   * `users:read.email`). `undefined` when nobody in the workspace has it;
   * throws the Web API error (with `data.error`) for anything else.
   */
  async userIdByEmail(email: string): Promise<string | undefined> {
    try {
      const res = await this.web.users.lookupByEmail({ email });
      return res.user?.id;
    } catch (err) {
      if ((err as { data?: { error?: unknown } }).data?.error === 'users_not_found') return undefined;
      throw err;
    }
  }

  async sendText(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
    const res = await this.web.chat.postMessage({
      channel,
      text,
      mrkdwn: true,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return typeof res.ts === 'string' ? res.ts : undefined;
  }

  /**
   * Answer a slash command ephemerally (only the person who typed it sees the
   * reply) through its one-shot `response_url`. Throws on a refused URL or a
   * non-2xx answer so the caller's error path runs.
   */
  async replyToCommand(responseUrl: string, text: string): Promise<void> {
    const url = validResponseUrl(responseUrl);
    if (!url) throw new Error('refusing a slash-command response_url that is not a Slack https URL');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text, mrkdwn: true }),
    });
    if (!res.ok) throw new Error(`slash-command response_url answered HTTP ${String(res.status)}`);
  }

  /** `chat.postEphemeral`: visible to `user` only. */
  async sendEphemeral(channel: string, user: string, text: string): Promise<void> {
    await this.web.chat.postEphemeral({ channel, user, text, mrkdwn: true } as Parameters<WebClient['chat']['postEphemeral']>[0]);
  }

  /**
   * Member ids of a conversation (`conversations.members`), paged. Needs the
   * `channels:read` / `groups:read` / `im:read` / `mpim:read` bot scopes that
   * match the conversation type. Stops at `max` ids and says so. Throws the
   * Web API error (with `data.error`) so the roster provider can report why.
   */
  async conversationMembers(
    channel: string,
    max: number,
  ): Promise<{ memberIds: string[]; truncated: boolean }> {
    const memberIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.web.conversations.members({
        channel,
        limit: Math.min(MEMBERS_PAGE_SIZE, max),
        ...(cursor ? { cursor } : {}),
      });
      for (const id of page.members ?? []) memberIds.push(id);
      cursor = page.response_metadata?.next_cursor || undefined;
      if (memberIds.length >= max) {
        const truncated = memberIds.length > max || cursor !== undefined;
        return { memberIds: memberIds.slice(0, max), truncated };
      }
    } while (cursor);
    return { memberIds, truncated: false };
  }

  /** The bot's own member id, once `init()` has run (empty before). */
  get selfUserId(): string {
    return this.botUserId;
  }

  /** The bot's routing key `slack-bot:<member id>`, once `init()` has run. */
  channelKey(): string | undefined {
    return this.botUserId ? slackBotChannelKey(this.botUserId) : undefined;
  }

  /** Is this bot a member of the conversation? For "who can be heard here". */
  async isMemberOf(conversationId: string): Promise<boolean> {
    try {
      const info = await this.web.conversations.info({ channel: conversationId });
      return info.channel?.is_member === true || info.channel?.is_im === true;
    } catch {
      return false;
    }
  }

  private trimHandledKeys(): void {
    if (this.handledKeys.size <= HANDLED_KEYS_MAX) return;
    let drop = 200;
    for (const old of this.handledKeys) {
      this.handledKeys.delete(old);
      if (--drop <= 0) break;
    }
  }
}

/** A Slack-minted `response_url` (https, `*.slack.com`), or `undefined`. */
export function validResponseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const isSlack = url.hostname === 'slack.com' || url.hostname.endsWith(RESPONSE_URL_HOST_SUFFIX);
    return url.protocol === 'https:' && isSlack ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
