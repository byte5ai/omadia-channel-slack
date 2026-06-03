import { SocketModeClient } from '@slack/socket-mode';
import { LogLevel } from '@slack/logger';
import { WebClient } from '@slack/web-api';

import type { IncomingTurn } from '@omadia/channel-sdk';

import {
  buildIncomingTurn,
  extractText,
  stripMention,
  type SlackEnvelopeBody,
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

export interface SlackConnectionDeps {
  channelId: string;
  botToken: string;
  appToken: string;
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

/**
 * Owns the long-lived Slack Socket Mode connection: validate the bot token via
 * `auth.test`, open the WebSocket, drain inbound events, and send replies +
 * reactions through the Web API. Drives the shared {@link ChannelState} so the
 * admin UI can render connection status, and forwards each inbound text message
 * as an {@link IncomingTurn}.
 */
export class SlackConnection {
  private web: WebClient | undefined;
  private socket: SocketModeClient | undefined;
  private botUserId = '';
  private intentionalClose = false;
  /** `${channel}:${ts}` of messages already handled — Slack delivers a mention
   *  as BOTH an `app_mention` and a `message` event, so we de-duplicate. */
  private readonly handledKeys = new Set<string>();

  constructor(private readonly deps: SlackConnectionDeps) {}

  /** Kick off the connection without blocking — auth + the Socket Mode
   *  handshake can exceed the activate budget, so we drive state transitions
   *  in the background. */
  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.intentionalClose) return;
    const logger = makeSlackLogger(this.deps.log);
    try {
      patchState(this.deps.state, { status: 'connecting', lastError: null });

      this.web = new WebClient(this.deps.botToken, { logger, logLevel: LogLevel.ERROR });

      // Validate the bot token and learn our own identity (needed to ignore our
      // own messages and to strip the bot mention from `@bot …` text).
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

      const socket = new SocketModeClient({
        appToken: this.deps.appToken,
        logger,
        logLevel: LogLevel.ERROR,
      });
      this.socket = socket;

      socket.on('connected', () => {
        patchState(this.deps.state, { status: 'connected', lastError: null });
        this.deps.log('info', 'Slack Socket Mode connected');
      });
      socket.on('connecting', () => patchState(this.deps.state, { status: 'connecting' }));
      socket.on('reconnecting', () => patchState(this.deps.state, { status: 'connecting' }));
      socket.on('disconnected', (err?: unknown) => {
        if (this.intentionalClose) return;
        patchState(this.deps.state, { status: 'disconnected' });
        this.deps.log('warn', 'Slack Socket Mode disconnected — auto-reconnecting', {
          ...(err ? { error: errMessage(err) } : {}),
        });
      });

      // Single generic listener: we ACK every envelope (so Slack never retries)
      // and dispatch only Events-API message/app_mention payloads.
      socket.on('slack_event', async (args: { ack: () => Promise<void>; body: SlackEnvelopeBody }) => {
        try {
          await args.ack();
        } catch {
          /* ack failure is non-fatal — Slack will retry, our dedup guards it */
        }
        const body = args.body;
        if (!body || body.type !== 'events_api' || !body.event) return;
        const event = body.event;
        if (event.type !== 'message' && event.type !== 'app_mention') return;
        await this.onEvent(event, body.team_id);
      });

      await socket.start();
    } catch (err) {
      const message = errMessage(err);
      patchState(this.deps.state, { status: 'error', lastError: message });
      this.deps.log('error', 'failed to start Slack connection', { error: message });
    }
  }

  private async onEvent(event: SlackMessageEvent, teamId: string | undefined): Promise<void> {
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
  async sendText(channel: string, text: string, threadTs?: string): Promise<void> {
    if (!this.web) throw new Error('Slack Web client not connected');
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
      await this.web?.reactions.add({ channel, timestamp, name });
    } catch (err) {
      // `already_reacted` and missing-scope are common + harmless here.
      this.deps.log('warn', 'failed to add Slack reaction', { error: errMessage(err) });
    }
  }

  /** Operator-initiated reconnect: tear down the socket and re-open it. */
  async reconnect(): Promise<void> {
    this.deps.log('info', 'operator requested Slack reconnect');
    try {
      await this.socket?.disconnect();
    } catch {
      /* noop — we're replacing it anyway */
    }
    this.socket = undefined;
    this.web = undefined;
    patchState(this.deps.state, { status: 'connecting', lastError: null });
    void this.connect();
  }

  private trimHandledKeys(): void {
    if (this.handledKeys.size <= HANDLED_KEYS_MAX) return;
    let drop = 200;
    for (const old of this.handledKeys) {
      this.handledKeys.delete(old);
      if (--drop <= 0) break;
    }
  }

  /** Release the socket (ChannelHandle.close). */
  async close(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.socket?.disconnect();
    } catch {
      /* noop */
    }
    this.socket = undefined;
    this.web = undefined;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
