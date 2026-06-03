/**
 * Shared, in-memory channel state. A single instance is created in
 * `activate()` and read by the admin router (to render connection status) and
 * written by the active transport (Socket Mode lifecycle events / Events API
 * deliveries).
 *
 * It is intentionally a plain mutable object — there is exactly one logical
 * writer at a time and N readers (admin-UI poll requests), and the fields are
 * independent scalars, so no locking is needed.
 */

export type ConnectionStatus =
  | 'starting' // activate() called, transport not yet ready
  | 'connecting' // opening / re-opening the Socket Mode WebSocket
  | 'connected' // healthy: socket open (socket mode) or identity resolved + listening (webhook)
  | 'disconnected' // socket dropped, auto-reconnect pending (socket mode only)
  | 'error'; // unexpected fatal error (see lastError) — e.g. bad token

/** Which transport this instance is running. */
export type ChannelMode = 'webhook' | 'socket';

/** The linked Slack identity once `auth.test` succeeds. */
export interface SlackIdentity {
  teamId: string;
  teamName?: string;
  botUserId: string;
  botUserName?: string;
}

export interface ChannelState {
  status: ConnectionStatus;
  /** Active transport, or null before it is decided. */
  mode: ChannelMode | null;
  /** The linked workspace + bot identity once `auth.test` resolved, or null. */
  me: SlackIdentity | null;
  /** Last error message surfaced to the operator, or null. */
  lastError: string | null;
  /** Webhook mode: Slack completed the url_verification handshake (or a live
   *  event arrived), i.e. the Request URL is confirmed reachable. */
  urlVerified?: boolean;
  /** Epoch-ms of the last accepted inbound message — concrete proof the
   *  channel is receiving traffic. */
  lastInboundAt?: number;
  /** Epoch-ms of the last state transition — lets the UI show "x s ago". */
  updatedAt: number;
}

export function createChannelState(): ChannelState {
  return {
    status: 'starting',
    mode: null,
    me: null,
    lastError: null,
    updatedAt: Date.now(),
  };
}

/** Apply a partial update and bump `updatedAt` in one place. */
export function patchState(state: ChannelState, patch: Partial<ChannelState>): void {
  Object.assign(state, patch);
  state.updatedAt = Date.now();
}
