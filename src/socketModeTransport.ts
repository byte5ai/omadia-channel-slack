import { LogLevel } from '@slack/logger';
import { SocketModeClient } from '@slack/socket-mode';

import { makeSlackLogger, type LogSink } from './logger.js';
import type { SlackChannel } from './slackChannel.js';
import { errMessage } from './slackChannel.js';
import { routeSlackEvent } from './eventRouter.js';
import type { SlackEnvelopeBody, SlackSlashCommandPayload } from './inbound.js';
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
 * envelope and funnels Events API payloads through {@link routeSlackEvent}
 * and `/agent` slash commands into {@link SlackChannel.ingestCommand}.
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
      // then dispatch Events API payloads (routeSlackEvent) and slash commands.
      socket.on(
        'slack_event',
        async (args: { ack: () => Promise<void>; type?: string; body: unknown }) => {
          try {
            await args.ack();
          } catch {
            /* ack failure is non-fatal — Slack retries, channel dedup guards it */
          }
          await routeSocketEnvelope(this.deps.channel, args.type, args.body);
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

/**
 * Dispatch one acknowledged Socket Mode envelope. The envelope `type` tells
 * the kinds apart (`events_api`, `slash_commands`); the payload of an
 * `events_api` envelope is an Events API callback (`type: 'event_callback'`),
 * so the kind is NOT read from the payload.
 */
export async function routeSocketEnvelope(
  channel: SlackChannel,
  envelopeType: string | undefined,
  body: unknown,
): Promise<void> {
  if (!body || typeof body !== 'object') return;
  if (envelopeType === 'slash_commands') {
    await channel.ingestCommand(body as SlackSlashCommandPayload);
    return;
  }
  if (envelopeType !== 'events_api') return;
  const payload = body as SlackEnvelopeBody;
  await routeSlackEvent(channel, payload.event, payload.team_id);
}
