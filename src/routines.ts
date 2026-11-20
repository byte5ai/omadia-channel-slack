/**
 * Triggers and routines on Slack (spec 2042 §5.12, §5.3).
 *
 *  - Every turn opens the kernel's routines scope (`beginRoutineTurn`): who
 *    the person is and where a later delivery goes. Only then does the
 *    kernel offer the agent its trigger tools and `manage_routine`. The
 *    delivery ref names the conversation (and thread) and, on an agent's own
 *    app, that app (`asChannelKey`, `slack-bot:<member id>`).
 *  - The proactive send (`publishProactiveSend('slack', …)`) delivers a
 *    trigger's or routine's message through exactly the app the ref names:
 *    an agent's own app without a name line, the installation's own app
 *    rendered like an answer (name line from the message's speaker). An app
 *    that no longer runs here is an error, never a substitute; the kernel
 *    delivers a ref that names an app only while it is still the agent's.
 */

import { isNoReply, type SemanticAnswer } from '@omadia/channel-sdk';
import type { RoutinesIntegration, RoutineTurnRunner } from '@omadia/plugin-api';

import { SLACK_CHANNEL_TYPE } from './renderer.js';
import type { SlackBotLookup } from './slackSendProviders.js';

/** The kernel's routines surface (`routinesIntegration@1`, optional_requires). */
export const ROUTINES_INTEGRATION_SERVICE = 'routinesIntegration';

type ProactiveSend = Parameters<RoutinesIntegration['publishProactiveSend']>[1];

/** The delivery ref a Slack turn files: the generic channel shape plus the thread. */
export interface SlackDeliveryRef {
  readonly kind: 'channel';
  readonly channelId: string;
  /** The Slack conversation (channel, DM) the turn came from. */
  readonly conversationId: string;
  /** The session scope (speaker history: who spoke here before). */
  readonly conversationKey: string;
  readonly threadTs?: string;
  /** The agent's own app the conversation runs through; absent = the installation's app. */
  readonly asChannelKey?: string;
}

export interface SlackRoutineTurnInfo {
  readonly userId: string;
  readonly conversationId: string;
  readonly conversationKey: string;
  readonly threadTs?: string;
}

/** Opens one turn's routines scope; the runner wraps the turn body. */
export type SlackRoutineTurn = (info: SlackRoutineTurnInfo) => RoutineTurnRunner;

export function createSlackRoutineTurn(
  routines: Pick<RoutinesIntegration, 'beginRoutineTurn'>,
  channelId: string,
  asChannelKey: () => string | undefined,
): SlackRoutineTurn {
  return ({ userId, conversationId, conversationKey, threadTs }) => {
    const key = asChannelKey();
    const conversationRef: SlackDeliveryRef = {
      kind: 'channel',
      channelId,
      conversationId,
      conversationKey,
      ...(threadTs ? { threadTs } : {}),
      ...(key ? { asChannelKey: key } : {}),
    };
    return routines.beginRoutineTurn({ userId, channel: SLACK_CHANNEL_TYPE, conversationRef });
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SLACK_CONVERSATION = /^[A-Z0-9]{8,}$/i;

/** Where a delivery ref points, or undefined when it is not one of ours. */
export function parseDeliveryRef(
  ref: unknown,
): { conversationId: string; conversationKey: string; threadTs?: string; asChannelKey: string | undefined } | undefined {
  if (!isRecord(ref) || typeof ref['conversationId'] !== 'string' || !SLACK_CONVERSATION.test(ref['conversationId'])) {
    return undefined;
  }
  const conversationId = ref['conversationId'];
  const conversationKey = typeof ref['conversationKey'] === 'string' ? ref['conversationKey'] : `${SLACK_CHANNEL_TYPE}:${conversationId}`;
  const threadTs = typeof ref['threadTs'] === 'string' ? ref['threadTs'] : undefined;
  const raw = ref['asChannelKey'];
  const asChannelKey = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : undefined;
  return { conversationId, conversationKey, ...(threadTs ? { threadTs } : {}), asChannelKey };
}

export function createSlackProactiveSend(lookup: SlackBotLookup): ProactiveSend {
  return async (conversationRef, message) => {
    const ref = parseDeliveryRef(conversationRef);
    if (!ref) throw new Error('not a Slack delivery: the ref names no Slack conversation');
    const app = lookup(ref.asChannelKey);
    if (!app) throw new Error(`no Slack app '${ref.asChannelKey ?? 'default'}' runs in this installation; nothing was sent`);
    // "Nothing to report this run": dropped, the run history keeps the turn.
    if (isNoReply(message)) return;
    // An agent's words carry its speaker; kernel texts (approvals, reminders) name nobody.
    const answer: SemanticAnswer =
      message.speaker?.kind === 'agent'
        ? { text: message.text, speaker: message.speaker }
        : { text: message.text, speaker: { kind: 'system' } };
    await app.outbox.deliverMessage(answer, {
      conversationId: ref.conversationId,
      conversationKey: ref.conversationKey,
      ...(ref.threadTs ? { threadTs: ref.threadTs } : {}),
    });
  };
}
