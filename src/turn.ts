import {
  DEFAULT_PACE_PROFILE,
  channelUserPrincipal,
  isNoReply,
  logNoReplyDrop,
  parseAgentCommand,
  parsePrincipal,
  parseSessionScope,
  runPacedTurn,
  turnPrincipal,
  type AgentSpeaker,
  type ChannelPaceProfile,
  type ChannelRouteContext,
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
import type { SlackRoutineTurn } from './routines.js';
import { SLACK_CHANNEL_TYPE } from './renderer.js';

/**
 * Asks the channel resolver (`resolveChannelRoute` of the SDK, bound to the
 * plugin context) about one key. `undefined`: the host publishes no resolver
 * (single-Agent / Postgres-less deployment).
 */
export type RouteLookup = (channelKey: string, context: ChannelRouteContext) => ChannelResolveResult | undefined;

/** What the channel resolver made of a turn. */
export type AgentResolution =
  | {
      readonly kind: 'agent';
      readonly agent: ChatAgent;
      /** The agent that will answer, known before the answer (the pace acknowledgement speaks as it). */
      readonly speaker?: AgentSpeaker;
      /** The key IS this agent's own bot (spec 2042 §5.3). */
      readonly exclusive?: boolean;
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
      /** The refusal is about the agent whose own bot this key is. */
      readonly exclusive?: boolean;
    };

/** Who is asking and in which language the kernel writes its notices. */
export interface SlackRouteContext {
  readonly principal: string;
  /** `de` / `en` when Slack states the person's language; absent otherwise (the kernel then writes German). */
  readonly locale?: string;
}

/**
 * Per-turn Agent resolution through the channel resolver (S1 contract): `bound`
 * (the turn belongs to this agent, with its `speaker`) or `reject` (no agent
 * answers; `notice` says why). `chatAgent` is set on both: on `reject` it still
 * carries out `/agent` and `/agents`. There is no fallback agent (INV-7,
 * #1598), and the `chatAgent@1` singleton never answers when a resolver is
 * there: `defaultAgent` serves only a host WITHOUT a resolver. A resolver that
 * throws is an error of the turn (the caller answers with a `system` notice),
 * not a reason to ask the singleton.
 *
 * Keys, narrowest first: `channelKeys[0]` is the conversation key (the Slack
 * channel). The agent selection of `/agent` lives at that key plus the
 * principal (S1: the narrowest conversation key, never the workspace), so a
 * workspace binding (the second key) answers ordinary turns while the
 * `/agent` command still goes to the ChatAgent of the channel key, whoever the
 * binding names. Only to choose that ChatAgent the SDK's `parseAgentCommand`
 * recognises the command; the text itself is passed on untouched.
 */
export function resolveAgentForTurn(
  route: RouteLookup,
  channelKeys: ReadonlyArray<string | null | undefined>,
  defaultAgent: ChatAgent,
  context: SlackRouteContext,
  text: string,
): AgentResolution {
  const routeContext: ChannelRouteContext = {
    principal: context.principal,
    ...(context.locale ? { locale: context.locale } : {}),
  };
  let rejection: { agent?: ChatAgent; notice?: SystemNotice } | undefined;
  let hasResolver = false;
  for (const key of channelKeys) {
    if (!key) continue;
    const result = route(key, routeContext);
    if (!result) continue;
    hasResolver = true;
    if (result.decision === 'bound' && result.chatAgent) {
      // A command belongs to the narrowest key: its selection is stored there.
      if (rejection?.agent && parseAgentCommand(text)) return { kind: 'refused', ...rejection };
      return {
        kind: 'agent',
        agent: result.chatAgent,
        ...(result.speaker ? { speaker: result.speaker } : {}),
        ...(result.exclusive === true ? { exclusive: true } : {}),
      };
    }
    rejection ??= rejectionOf(result);
  }
  if (!hasResolver) return { kind: 'agent', agent: defaultAgent };
  return { kind: 'refused', ...(rejection ?? {}) };
}

function rejectionOf(result: ChannelResolveResult): { agent?: ChatAgent; notice?: SystemNotice; exclusive?: boolean } {
  return {
    ...(result.chatAgent ? { agent: result.chatAgent } : {}),
    ...(result.notice ? { notice: result.notice } : {}),
    ...(result.exclusive === true ? { exclusive: true } : {}),
  };
}

/**
 * The sender as a principal, in the one form every channel uses (S1 contract,
 * spec 2042 §5.3): `channelUserPrincipal` / `turnPrincipal` from the SDK, never
 * a form built here: `user:<e-mail>` when the sender's profile gave one
 * (`IncomingTurn.userRef.email`, from `users.info`), else
 * `user:slack-user:<member id, lowercase>`.
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
  const raw = turn.rawEvent as Partial<SlackMessageEvent> | undefined;
  const userId = raw?.user;
  // A DM reply in a thread answers the thread root: the `ts` this plugin
  // reports as `messageId` for its own sends (a reminder DM).
  const replyTo = meta.channelType === 'im' && raw?.thread_ts && raw.thread_ts !== meta.eventTs ? raw.thread_ts : undefined;
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
    // `TurnOrigin.replyToMessageId` since channel-sdk 0.3.11 (kernel #2157);
    // spread, so it type-checks against 0.3.9 too.
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  };
}

export interface TurnDeps {
  /** The channel resolver, bound to the plugin context (`resolveChannelRoute`). */
  readonly route: RouteLookup;
  readonly defaultAgent: ChatAgent;
  readonly outbox: SlackOutbox;
  /** Timer seam for the pace tests; the real clock when absent. */
  readonly clock?: PaceClock;
  readonly log: (level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>) => void;
  /**
   * Spec 2042 §5.3 — set for an agent's own Slack app: its key
   * `slack-bot:<bot member id>` (undefined until the token was checked).
   * Every turn is resolved on that key alone, and only an EXCLUSIVE answer
   * (the key IS the agent's identity) may answer: an app named after one
   * agent never answers as another.
   */
  readonly ownBotKey?: () => string | undefined;
  /**
   * Spec 2042 §5.12 — opens the kernel's routines scope for a person's turn,
   * so the agent may set triggers and routines that deliver back here
   * (through this app). Absent = the kernel publishes no routines.
   */
  readonly routineTurn?: SlackRoutineTurn;
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
/** An agent's own app the kernel does not know (any more) as that agent's identity. */
const UNOWNED_BOT_TEXT = 'Dieser Bot ist gerade keinem Agenten zugeordnet und antwortet deshalb nicht.';

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
    const ownBotKey = deps.ownBotKey ? deps.ownBotKey() ?? '' : undefined;
    const resolution = resolveAgentForTurn(
      deps.route,
      ownBotKey !== undefined ? [ownBotKey] : [turn.conversationId, meta.teamId],
      deps.defaultAgent,
      { principal: slackSenderPrincipal(turn), ...(meta.locale ? { locale: meta.locale } : {}) },
      turn.text,
    );
    if (ownBotKey !== undefined && resolution.exclusive !== true) {
      // The kernel does not know this app as an agent's identity (removed, or
      // not registered yet): its name belongs to an agent, so nobody else answers.
      deps.log('warn', "Slack agent app is no agent's identity; turn refused", { botKey: ownBotKey });
      await deps.outbox.deliverSystem('no_agent', UNOWNED_BOT_TEXT, target);
      return;
    }
    const refusal = resolution.kind === 'refused' ? resolution : undefined;
    const agent = resolution.agent;
    if (!agent) {
      // Only a refusal can lack an agent (an older platform sets no chatAgent on `reject`).
      await postNotice(deps, refusal?.notice, target);
      return;
    }
    const speaker = resolution.kind === 'agent' ? resolution.speaker : undefined;
    const chat = () =>
      agent.chat({
        userMessage: turn.text,
        sessionScope: meta.sessionScope,
        userId: turn.userRef.id,
        origin,
      });
    // The routines scope wraps the whole turn: who asks, and where a trigger
    // or routine the agent sets now delivers later.
    const scoped = deps.routineTurn?.({
      userId: turn.userRef.id,
      conversationId: turn.conversationId,
      conversationKey: meta.sessionScope,
      ...(meta.threadTs ? { threadTs: meta.threadTs } : {}),
    });
    const paced = await runPacedTurn(
      () => (scoped ? scoped(chat) : chat()),
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
      { locale: meta.locale ?? PACE_LOCALE, ...(deps.clock ? { clock: deps.clock } : {}) },
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
