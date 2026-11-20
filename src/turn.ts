import {
  DEFAULT_PACE_PROFILE,
  channelUserPrincipal,
  isNoReply,
  logNoReplyDrop,
  parsePrincipal,
  parseSessionScope,
  runPacedTurn,
  turnPrincipal,
  type AgentSpeaker,
  type ChannelBindingResolver,
  type ChannelPaceProfile,
  type ChannelResolveResult,
  type ChatAgent,
  type IncomingTurn,
  type PaceClock,
  type SemanticAnswer,
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

/** Service-registry key of the per-binding router (`CHANNEL_RESOLVER_SERVICE` in the SDK). */
const CHANNEL_RESOLVER_SERVICE = 'channelResolver';

/** What the channel resolver made of a turn. */
export type AgentResolution =
  | {
      readonly kind: 'agent';
      readonly agent: ChatAgent;
      /** The agent that will answer, known before the answer (the pace acknowledgement speaks as it). */
      readonly speaker?: AgentSpeaker;
    }
  | {
      /**
       * No agent answers this turn. `agent` still handles `/agent` and `/agents`
       * and answers anything else with the `system` notice; `notice` is the
       * kernel's reason, posted by the channel when there is no `agent`.
       */
      readonly kind: 'refused';
      readonly agent?: ChatAgent;
      readonly notice?: SystemNotice;
    };

/** Who is asking and in which language the kernel writes its notices. */
export interface SlackRouteContext {
  readonly principal: string;
  readonly locale: string;
}

/**
 * Per-turn Agent resolution through `channelResolver@1` (S1 contract): the
 * resolver says `bound` (the turn belongs to this agent, with its `speaker`) or
 * `reject` (no agent answers; `notice` says why). `chatAgent` is set on both:
 * on `reject` it still carries out `/agent` and `/agents`. There is no fallback
 * agent (INV-7, #1598). `channelKeys` are tried most specific first; a `bound`
 * decision wins immediately, otherwise the first rejection stands.
 *
 * `defaultAgent` serves only a host WITHOUT the resolver (single-Agent /
 * Postgres-less deployment) or a resolver that throws, so a hiccup never
 * drops a turn. A throwing resolver is not a rejection.
 */
export function resolveAgentForTurn(
  services: ServiceLookup,
  channelKeys: ReadonlyArray<string | null | undefined>,
  defaultAgent: ChatAgent,
  route: SlackRouteContext,
): AgentResolution {
  const resolver = services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE);
  if (!resolver) return { kind: 'agent', agent: defaultAgent };
  let rejection: { agent?: ChatAgent; notice?: SystemNotice } | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const result = resolver.resolve(SLACK_CHANNEL_TYPE, key, { principal: route.principal, locale: route.locale });
      if (result.decision === 'bound' && result.chatAgent) {
        return { kind: 'agent', agent: result.chatAgent, ...(result.speaker ? { speaker: result.speaker } : {}) };
      }
      rejection ??= rejectionOf(result);
    }
  } catch {
    return { kind: 'agent', agent: defaultAgent };
  }
  if (!rejection) return { kind: 'agent', agent: defaultAgent };
  return { kind: 'refused', ...(rejection.agent ? { agent: rejection.agent } : {}), ...(rejection.notice ? { notice: rejection.notice } : {}) };
}

function rejectionOf(result: ChannelResolveResult): { agent?: ChatAgent; notice?: SystemNotice } {
  return {
    ...(result.chatAgent ? { agent: result.chatAgent } : {}),
    ...(result.notice ? { notice: result.notice } : {}),
  };
}

/**
 * The sender as a principal, in the one form every channel uses (S1 contract,
 * spec 2042 §5.3): `channelUserPrincipal` / `turnPrincipal` from the SDK, never
 * a form built here. A Slack message event carries no verified e-mail, so the
 * result is `user:slack-user:<member id, lowercase>`.
 */
export function slackSenderPrincipal(turn: Pick<IncomingTurn, 'userRef'>): string {
  return turnPrincipal(turn.userRef);
}

/**
 * Where a turn came from, in the SDK's terms (`ChatTurnInput.origin`): the
 * channel type, the sender as a principal ({@link slackSenderPrincipal}),
 * whether the platform says group or direct, and the channel-native
 * conversation id (the Slack channel id). Slack is not in the SDK's
 * memory-context allowlist, so the memory axes stay context-free, exactly as
 * for a turn without an origin.
 */
export function slackTurnOrigin(turn: IncomingTurn, meta: SlackTurnMeta): TurnOrigin {
  const userId = (turn.rawEvent as Partial<SlackMessageEvent> | undefined)?.user;
  const principal = userId ? parsePrincipal(channelUserPrincipal(turn.userRef)) : undefined;
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
 * Drive one agent turn and ship the result back to Slack. The text of the turn
 * reaches the kernel exactly as the user wrote it, including `/agent Mira`,
 * `/agent` and `/agents`: the ChatAgent the resolver returns carries them out
 * and answers from `system`. Everything sent goes through the outbox.
 *
 * Speaker rules (spec 2042 INV-3, §5.8):
 *  - the pace acknowledgement goes out under the agent the resolver announced
 *    (`speaker`), in the agent's words. Without a speaker there is nobody to
 *    say it as, so it is skipped: no acknowledgement is better than one
 *    under a wrong or no name;
 *  - an answer without a speaker is never posted (fail-closed): the user gets
 *    a `system` notice that something went wrong, and the missing speaker is
 *    logged;
 *  - a rejected turn is answered by `system` only: the ChatAgent of a
 *    rejection may carry out `/agent`, anything it says as an agent is
 *    replaced by the resolver's notice.
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
  try {
    const resolution = resolveAgentForTurn(deps.services, [turn.conversationId, meta.teamId], deps.defaultAgent, {
      principal: slackSenderPrincipal(turn),
      locale: PACE_LOCALE,
    });
    const refusal = resolution.kind === 'refused' ? resolution : undefined;
    const agent = resolution.agent;
    if (!agent) {
      // Only a refusal can lack an agent (an older platform sets no chatAgent on `reject`).
      await postNotice(deps, refusal?.notice, target);
      return;
    }
    const speaker = resolution.kind === 'agent' ? resolution.speaker : undefined;
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
          if (!speaker) {
            deps.log('warn', 'Slack pace acknowledgement skipped: the resolver named no speaker', {
              conversationId: turn.conversationId,
            });
            return;
          }
          await deps.outbox.deliverAck(text, speaker, target);
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
    const delivery = paced.deliverAsFollowUp ? { ...target, followUp: true } : target;
    if (refusal) {
      await deliverRefusedAnswer(deps, answer, refusal.notice, delivery);
      return;
    }
    if (!answer.speaker) {
      deps.log('error', 'Slack answer without a speaker withheld (fail-closed)', {
        conversationId: turn.conversationId,
      });
      await deps.outbox.deliverSystem('agent_error', TURN_FAILED_TEXT, delivery);
      return;
    }
    await deps.outbox.deliver(answer, delivery);
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

/** The kernel's `system` notice, or this plugin's own when the kernel gave none. */
function postNotice(deps: TurnDeps, notice: SystemNotice | undefined, target: DeliveryTarget): Promise<boolean> {
  return notice
    ? deps.outbox.deliverSystem(notice.code, notice.text, target)
    : deps.outbox.deliverSystem('no_agent', NO_AGENT_TEXT, target);
}

/** Only a `system` answer reaches the sender of a rejected turn. */
async function deliverRefusedAnswer(
  deps: TurnDeps,
  answer: SemanticAnswer,
  notice: SystemNotice | undefined,
  target: DeliveryTarget,
): Promise<void> {
  if (answer.speaker?.kind === 'system') {
    await deps.outbox.deliver(answer, target);
    return;
  }
  deps.log('warn', 'rejected Slack turn answered as an agent; replaced by the system notice');
  await postNotice(deps, notice, target);
}
