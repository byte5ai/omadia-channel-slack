import { LogLevel } from '@slack/logger';
import { SocketModeClient } from '@slack/socket-mode';

import { makeSlackLogger, type LogSink } from './logger.js';
import type { SlackChannel } from './slackChannel.js';
import { errMessage } from './slackChannel.js';
import type { SlackEnvelopeBody } from './inbound.js';
import { patchState, type ChannelState } from './state.js';

export interface SocketModeTransportDeps {
  appToken: string;
  channel: SlackChannel;
  log: LogSink;
  state: ChannelState;
}

/**
 * Socket Mode transport — opens a long-lived WebSocket to Slack (no public
 * endpoint required). Best for local dev and behind-firewall installs; Slack
 * recommends the Events API (webhook) for highest production reliability and
 * Marketplace distribution. A single generic `slack_event` listener ACKs every
 * envelope and funnels message/app_mention payloads into {@link SlackChannel.ingest}.
 */
export class SocketModeTransport {
  private socket: SocketModeClient | undefined;
  private intentionalClose = false;

  constructor(private readonly deps: SocketModeTransportDeps) {}

  /** Kick off the connection without blocking — auth + the Socket Mode
   *  handshake can exceed the activate budget. */
  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.intentionalClose) return;
    try {
      patchState(this.deps.state, { status: 'connecting', lastError: null });

      // Validate the bot token + resolve identity before opening the socket.
      await this.deps.channel.init();

      const socket = new SocketModeClient({
        appToken: this.deps.appToken,
        logger: makeSlackLogger(this.deps.log),
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

      // Single generic listener: ACK every envelope (so Slack never retries),
      // then dispatch only Events-API message/app_mention payloads.
      socket.on(
        'slack_event',
        async (args: { ack: () => Promise<void>; body: SlackEnvelopeBody }) => {
          try {
            await args.ack();
          } catch {
            /* ack failure is non-fatal — Slack retries, channel dedup guards it */
          }
          const body = args.body;
          if (!body || body.type !== 'events_api' || !body.event) return;
          const event = body.event;
          if (event.type !== 'message' && event.type !== 'app_mention') return;
          await this.deps.channel.ingest(event, body.team_id);
        },
      );

      await socket.start();
    } catch (err) {
      const message = errMessage(err);
      patchState(this.deps.state, { status: 'error', lastError: message });
      this.deps.log('error', 'failed to start Slack Socket Mode', { error: message });
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
    patchState(this.deps.state, { status: 'connecting', lastError: null });
    void this.connect();
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.socket?.disconnect();
    } catch {
      /* noop */
    }
    this.socket = undefined;
  }
}
