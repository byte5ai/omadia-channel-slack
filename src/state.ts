/**
 * Shared, in-memory channel state. A single instance is created in
 * `activate()` and read by the admin router (to render connection status) and
 * written by the Slack connection (on every lifecycle transition).
 *
 * It is intentionally a plain mutable object — there is exactly one writer
 * (the Socket Mode event loop) and N readers (admin-UI poll requests), and the
 * fields are independent scalars, so no locking is needed.
 */

export type ConnectionStatus =
  | 'starting' // activate() called, socket not yet created
  | 'connecting' // opening / re-opening the Socket Mode WebSocket
  | 'connected' // linked + receiving events
  | 'disconnected' // socket dropped, auto-reconnect pending
  | 'error'; // unexpected fatal error (see lastError) — e.g. bad token

/** The linked Slack identity once `auth.test` succeeds. */
export interface SlackIdentity {
  teamId: string;
  teamName?: string;
  botUserId: string;
  botUserName?: string;
}

export interface ChannelState {
  status: ConnectionStatus;
  /** The linked workspace + bot identity once connected, or null. */
  me: SlackIdentity | null;
  /** Last error message surfaced to the operator, or null. */
  lastError: string | null;
  /** Epoch-ms of the last state transition — lets the UI show "x s ago". */
  updatedAt: number;
}

export function createChannelState(): ChannelState {
  return {
    status: 'starting',
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
