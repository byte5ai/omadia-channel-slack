import { LogLevel } from '@slack/logger';
import { WebClient } from '@slack/web-api';
import type { SlackDirectoryUser } from './slackPeopleDirectory.js';

import type { IncomingTurn } from '@omadia/channel-sdk';

import {
  buildIncomingTurn,
  extractText,
  stripMention,
  type SlackMessageEvent,
} from './inbound.js';
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
}

/** Reaction posted on every accepted message — OpenClaw-style — so the user
 *  sees their message was picked up before the (slower) answer arrives. */
const ACK_EMOJI = 'eyes';

/** Cap on the dedup set of handled message keys. */
const HANDLED_KEYS_MAX = 1_000;

/** `users.list` cache for the people directory: one workspace walk per TTL,
 *  bounded so a huge workspace cannot pin memory; `truncated` tells the
 *  kernel the directory is only partially known. */
const USERS_CACHE_TTL_MS = 5 * 60 * 1000;
const USERS_PAGE_SIZE = 200;
const USERS_CACHE_MAX = 2_000;

/**
 * Transport-agnostic Slack channel core. Owns the {@link WebClient} (outbound
 * Web API + identity), the inbound de-duplication + access policy, and the
 * native-event → {@link IncomingTurn} translation. Both transports
 * (Socket Mode and the Events API webhook) funnel every inbound payload through
 * {@link ingest}, so the filtering, loop-guard, ACK reaction and reply path are
 * identical regardless of how the event arrived.
 */
export class SlackChannel {
  private readonly web: WebClient;
  private botUserId = '';
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
   * then ACKs with a reaction and drives an orchestrator turn.
   */
  async ingest(event: SlackMessageEvent, teamId: string | undefined): Promise<void> {
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

      // Access policy. An explicit @mention always passes (the user asked for
      // the bot by name); plain messages are gated by DM / channel policy.
      if (!isMention) {
        if (isDm && !this.deps.policy.allowDms) {
          this.deps.log('info', 'Slack inbound skipped: DMs disabled', { channel: event.channel });
          return;
        }
        if (!isDm && this.deps.policy.respondInChannels !== 'all') {
          this.deps.log('info', 'Slack inbound skipped: channel message without mention', {
            channel: event.channel,
          });
          return;
        }
      }

      // Allowlist by channel id and/or user id.
      if (this.deps.policy.allowlist.size > 0) {
        const allowed =
          this.deps.policy.allowlist.has(event.channel) ||
          (event.user !== undefined && this.deps.policy.allowlist.has(event.user));
        if (!allowed) {
          this.deps.log('info', 'Slack message dropped (not allowlisted)', {
            channel: event.channel,
            user: event.user,
          });
          return;
        }
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
      });
      patchState(this.deps.state, { lastInboundAt: Date.now() });

      // ACK first (OpenClaw-style) so the user immediately sees it was picked up.
      void this.sendReaction(event.channel, event.ts, ACK_EMOJI);
      await this.deps.onMessage(buildIncomingTurn(this.deps.channelId, event, text, teamId));
    } catch (err) {
      this.deps.log('error', 'error handling inbound Slack message', {
        channel: event.channel,
        error: errMessage(err),
      });
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

  async sendText(channel: string, text: string, threadTs?: string): Promise<void> {
    await this.web.chat.postMessage({
      channel,
      text,
      mrkdwn: true,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  /** Add an emoji reaction (ACK). Best-effort — never throws into the caller. */
  async sendReaction(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel, timestamp, name });
    } catch (err) {
      // `already_reacted` and missing-scope are common + harmless here.
      this.deps.log('warn', 'failed to add Slack reaction', { error: errMessage(err) });
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

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
