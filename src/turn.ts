import {
  DEFAULT_PACE_PROFILE,
  formatPrincipal,
  isNoReply,
  logNoReplyDrop,
  makePrincipal,
  parseSessionScope,
  runPacedTurn,
  type ChannelPaceProfile,
  type ChatAgent,
  type IncomingTurn,
  type PaceClock,
  type SystemNotice,
  type TurnOrigin,
} from '@omadia/channel-sdk';

import type { SlackMessageEvent, SlackTurnMeta } from './inbound.js';
import type { DeliveryTarget, SlackOutbox } from './outbox.js';
import { SLACK_CHANNEL_TYPE } from './renderer.js';

/** The slice of the plugin's service registry the turn path reads. */
export interface ServiceLookup {
  get<T>(name: string): T | undefined;
}

/**
 * Structural view of the kernel's `channelResolver@1` — the per-binding router
 * published by the multi-orchestrator runtime. Consumed directly (not via a
 * new SDK export) so this plugin keeps running on hosts whose
 * `@omadia/channel-sdk` predates the helper; the service itself is what the
 * helper wraps. `context` and `notice` are additive: a kernel that does not
 * know them ignores the argument and never sets the field.
 */
interface ChannelBindingResolver {
  resolve(
    channelType: string,
    channelKey: string,
    context?: { readonly principal?: string },
  ): {
    readonly decision: 'bound' | 'fallback' | 'reject';
    readonly chatAgent?: ChatAgent;
    readonly notice?: SystemNotice;
  };
}

const CHANNEL_RESOLVER_SERVICE = 'channelResolver';

/** What the channel resolver made of a turn. */
export type AgentResolution =
  | { readonly kind: 'agent'; readonly agent: ChatAgent }
  /** No agent answers this turn; `notice` is the kernel's reason, when it gave one. */
  | { readonly kind: 'refused'; readonly notice?: SystemNotice };

/**
 * Per-turn Agent resolution. Routes a turn to the Agent the operator bound to
 * its `(channelType, channelKey)` via `channelResolver@1`, falling back to
 * `defaultAgent` only when the resolver is not published (single-Agent / pre-US7
 * host) or throws, so a hiccup never drops a turn. `channelKeys` are tried most
 * specific first: a `bound` decision wins immediately, a `fallback` is
 * remembered and used only if no key is explicitly bound. When every key is
 * rejected the turn is refused, never answered by another agent (INV-7, #1598):
 * the caller posts the kernel's `system` notice.
 *
 * `principal` (`user:<slack member id>`) tells the kernel who is asking, so it
 * can apply that user's stored agent selection and availability.
 */
export function resolveAgentForTurn(
  services: ServiceLookup,
  channelKeys: ReadonlyArray<string | null | undefined>,
  defaultAgent: ChatAgent,
  principal: string | undefined,
): AgentResolution {
  const resolver = services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE);
  if (!resolver) return { kind: 'agent', agent: defaultAgent };
  let fallback: ChatAgent | undefined;
  let rejection: { notice?: SystemNotice } | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const decision = resolver.resolve(SLACK_CHANNEL_TYPE, key, principal ? { principal } : undefined);
      if (decision.decision === 'bound' && decision.chatAgent) return { kind: 'agent', agent: decision.chatAgent };
      if (decision.decision === 'fallback' && decision.chatAgent) fallback ??= decision.chatAgent;
      if (decision.decision === 'reject') rejection ??= decision.notice ? { notice: decision.notice } : {};
    }
  } catch {
    return { kind: 'agent', agent: defaultAgent };
  }
  if (fallback) return { kind: 'agent', agent: fallback };
  if (rejection) return { kind: 'refused', ...(rejection.notice ? { notice: rejection.notice } : {}) };
  return { kind: 'agent', agent: defaultAgent };
}

/**
 * Where a turn came from, in the SDK's terms (`ChatTurnInput.origin`): the
 * channel type, the sender as a principal (`user:<member id>`, the same id the
 * people directory hands out), whether the platform says group or direct, and
 * the channel-native conversation id (the Slack channel id). Slack is not in
 * the SDK's memory-context allowlist, so the memory axes stay context-free,
 * exactly as for a turn without an origin.
 */
export function slackTurnOrigin(turn: IncomingTurn, meta: SlackTurnMeta): TurnOrigin {
  const userId = (turn.rawEvent as Partial<SlackMessageEvent> | undefined)?.user;
  const principal = userId ? makePrincipal('user', userId) : undefined;
  return {
    channelType: SLACK_CHANNEL_TYPE,
    scope:
      meta.channelType === 'im' && userId
        ? { kind: 'personal', userId }
        : parseSessionScope(meta.sessionScope),
    ...(principal ? { principal } : {}),
    ...(turn.conversationType ? { conversationType: turn.conversationType } : {}),
    channelConversationId: turn.conversationId,
    messageId: meta.eventTs,
    ...(userId ? { speaker: { kind: turn.userRef.kind, id: userId } } : {}),
  };
}

export interface TurnDeps {
  readonly services: ServiceLookup;
  readonly defaultAgent: ChatAgent;
  readonly outbox: SlackOutbox;
  /** Timer seam for the pace tests; the real clock when absent. */
  readonly clock?: PaceClock;
  readonly log: (level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>) => void;
}

/**
 * A command's `response_url` answers for 30 minutes; the follow-up path starts
 * a little earlier so a reply never meets an expired URL. Plain messages have
 * no window: Events API / Socket Mode deliveries are acknowledged before the
 * turn starts and the answer is a `chat.postMessage`, valid at any time.
 */
const RESPONSE_URL_WINDOW_MS = 29 * 60 * 1000;

/**
 * Slack's pace: no typing indicator (a bot has none outside the AI-assistant
 * surface), one acknowledgement after the SDK default threshold, and a
 * follow-up when a slash command outlives its `response_url`.
 */
export function slackPaceProfile(meta: Pick<SlackTurnMeta, 'responseUrl'>): ChannelPaceProfile {
  return meta.responseUrl ? { ...DEFAULT_PACE_PROFILE, replyWindowMs: RESPONSE_URL_WINDOW_MS } : DEFAULT_PACE_PROFILE;
}

/** Locale of the pace acknowledgement (the plugin's own texts are German). */
const PACE_LOCALE = 'de';

const TURN_FAILED_TEXT = 'Dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.';
const NO_AGENT_TEXT = 'Für diese Unterhaltung ist kein Agent eingerichtet.';

/**
 * Drive one orchestrator turn and ship the result back to Slack. The text of
 * the turn reaches the kernel exactly as the user wrote it, including
 * `/agent Mira`: the kernel's management layer carries out agent selection and
 * answers with a `system` notice. Everything sent goes through the outbox.
 */
export async function handleSlackTurn(deps: TurnDeps, turn: IncomingTurn): Promise<void> {
  const meta = turn.metadata as unknown as SlackTurnMeta;
  const target: DeliveryTarget = {
    conversationId: turn.conversationId,
    conversationKey: meta.sessionScope,
    ...(meta.threadTs ? { threadTs: meta.threadTs } : {}),
    ...(meta.responseUrl ? { responseUrl: meta.responseUrl } : {}),
    ...(meta.commandUserId ? { commandUserId: meta.commandUserId } : {}),
  };
  const origin = slackTurnOrigin(turn, meta);
  const principal = origin.principal ? formatPrincipal(origin.principal) : undefined;
  try {
    const resolution = resolveAgentForTurn(
      deps.services,
      [turn.conversationId, meta.teamId],
      deps.defaultAgent,
      principal,
    );
    if (resolution.kind === 'refused') {
      await (resolution.notice
        ? deps.outbox.deliverSystem(resolution.notice.code, resolution.notice.text, target)
        : deps.outbox.deliverSystem('no_agent', NO_AGENT_TEXT, target));
      return;
    }
    const agent = resolution.agent;
    const paced = await runPacedTurn(
      () =>
        agent.chat({
          userMessage: turn.text,
          sessionScope: meta.sessionScope,
          userId: turn.userRef.id,
          origin,
        }),
      slackPaceProfile(meta),
      {
        sendAck: async (text) => {
          await deps.outbox.deliverAck(text, target);
        },
        onHookError: (hook, error) =>
          deps.log('warn', `Slack pace ${hook} failed`, { error: (error as Error).message }),
      },
      { locale: PACE_LOCALE, ...(deps.clock ? { clock: deps.clock } : {}) },
    );
    const answer = paced.result;
    if (isNoReply(answer)) {
      logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
      return;
    }
    await deps.outbox.deliver(answer, paced.deliverAsFollowUp ? { ...target, followUp: true } : target);
  } catch (err) {
    deps.log('error', 'failed to handle Slack turn', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    try {
      await deps.outbox.deliverSystem('agent_error', TURN_FAILED_TEXT, target);
    } catch {
      /* original error already logged — don't mask it with a send failure */
    }
  }
}
