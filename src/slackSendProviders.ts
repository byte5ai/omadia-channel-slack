import type {
  ConversationSendOptions,
  ConversationSendProvider,
  SendProviderCapabilities,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendProvider,
} from '@omadia/channel-sdk';

import { SYSTEM_SPEAKER, type SlackOutbox } from './outbox.js';
import { SLACK_CHANNEL_TYPE } from './renderer.js';

/** The channel user kind this plugin gives Slack members (`IncomingTurn.userRef.kind`). */
const SLACK_USER_KIND = 'slack-user';

/** `user:slack-user:<id>` — the principal form of a Slack member without a verified e-mail. */
const SLACK_PRINCIPAL = /^user:slack-user:([a-z0-9]+)$/;
const EMAIL_PRINCIPAL = /^user:([^:\s]+@[^:\s]+)$/;

/** What the providers need from the Slack channel besides the outbox. */
export interface SlackUserLookup {
  /** Member id for an e-mail address (`users.lookupByEmail`, bot scope `users:read.email`). Throws the Web API error. */
  userIdByEmail(email: string): Promise<string | undefined>;
}

/**
 * Capabilities Slack declares: `asChannelKey` (the post goes out through
 * exactly the Slack app that key names, `slack-bot:<member id>`: the
 * installation's own app or an agent's own app, spec 2042 §5.3; an unknown
 * key is refused, never answered through another app); no polls or cards (the
 * sender falls back to a chat ballot, which is plain text); `@mentions` become
 * Slack member mentions.
 */
export const SLACK_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({ mentions: true, asChannelKey: true });

/** One Slack app the providers can post as. */
export interface SlackSendBot {
  readonly outbox: SlackOutbox;
  readonly users: SlackUserLookup;
}

/**
 * The app a send goes out as: `undefined` = the installation's own app, else
 * the app with exactly that key. `undefined` back = no such app runs here.
 */
export type SlackBotLookup = (asChannelKey: string | undefined) => SlackSendBot | undefined;

export interface SlackSendProviders {
  readonly targeted: TargetedSendProvider;
  readonly conversation: ConversationSendProvider;
}

type Unreachable = Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;

function unreachable(code: Unreachable['code'], message: string): Unreachable {
  return { outcome: 'unreachable', code, message };
}

/** `@slack/web-api` platform errors carry the API error string in `data.error`. */
function slackErrorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

function failure(err: unknown): Unreachable {
  const code = slackErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'user_not_found' || code === 'users_not_found') return unreachable('user_not_found', message);
  if (code === 'not_in_channel' || code === 'channel_not_found' || code === 'is_archived' || code === 'missing_scope') {
    return unreachable('not_permitted', message);
  }
  return unreachable('channel_error', message);
}

/** The text of a proactive message: mentions as Slack member mentions, attachments as plain links. */
export function proactiveText(message: TargetedMessage): string {
  let text = message.text;
  for (const mention of message.mentions ?? []) {
    if (mention.user.kind !== SLACK_USER_KIND) continue;
    text = text.replace(mention.text, `<@${mention.user.id}>`);
  }
  const links = (message.attachments ?? []).map((a) => `<${a.url}|${a.altText}>`);
  return [text, ...links].filter((part) => part.trim().length > 0).join('\n\n');
}

/** A poll or a card needs a channel that renders one; Slack declares neither, so nothing is posted. */
function refusedStructure(message: TargetedMessage): Unreachable | undefined {
  if (message.poll || message.card) {
    return unreachable('channel_error', 'Slack renders no polls or question cards here; send the ballot as plain text');
  }
  return undefined;
}

/** The Slack member a principal names: the channel's own user ref, or `user:slack-user:<id>`, or an e-mail principal. */
async function memberFor(
  target: { principalId: string; userRef?: { kind: string; id: string } },
  users: SlackUserLookup,
): Promise<string | Unreachable> {
  if (target.userRef) {
    return target.userRef.kind === SLACK_USER_KIND
      ? target.userRef.id
      : unreachable('no_binding', `a ${target.userRef.kind} user is not a Slack member`);
  }
  const principal = target.principalId.trim().toLowerCase();
  const byId = SLACK_PRINCIPAL.exec(principal);
  if (byId?.[1]) return byId[1].toUpperCase();
  const byEmail = EMAIL_PRINCIPAL.exec(principal);
  if (!byEmail?.[1]) return unreachable('no_binding', `no Slack member for ${target.principalId}`);
  try {
    const id = await users.userIdByEmail(byEmail[1]);
    return id ?? unreachable('user_not_found', `no Slack member with e-mail ${byEmail[1]}`);
  } catch (err) {
    return failure(err);
  }
}

/**
 * Proactive sends for the kernel (Conductor reminders and approvals, a routine's
 * report, an agent's post): a direct message to one member and a post into a
 * conversation, through the app `asChannelKey` names. Everything leaves through
 * that app's {@link SlackOutbox} (the one emitter), as the text the kernel
 * made, with no name line. Unreachability is RETURNED, never thrown, as the
 * provider contracts require.
 */
export function createSlackSendProviders(lookup: SlackBotLookup): SlackSendProviders {
  const botFor = (asChannelKey: string | undefined): SlackSendBot | Unreachable =>
    lookup(asChannelKey === undefined ? undefined : asChannelKey.trim().toLowerCase()) ??
    unreachable('not_permitted', `no Slack app '${String(asChannelKey)}' runs in this installation; nothing was posted`);
  const isBot = (value: SlackSendBot | Unreachable): value is SlackSendBot => 'outbox' in value;

  const post = async (opts: SlackSendBot, conversationId: string, message: TargetedMessage): Promise<TargetedDeliveryOutcome> => {
    const refused = refusedStructure(message);
    if (refused) return refused;
    const text = proactiveText(message);
    if (text.trim().length === 0) return unreachable('channel_error', 'nothing to send');
    try {
      const { messageId } = await opts.outbox.deliverMessage(
        { text, speaker: SYSTEM_SPEAKER },
        { conversationId, conversationKey: `${SLACK_CHANNEL_TYPE}:${conversationId}` },
      );
      // The Slack `ts`: what a typed reply to this message points at (the kernel's open question).
      return { outcome: 'delivered', ...(messageId ? { messageId } : {}) };
    } catch (err) {
      return failure(err);
    }
  };

  const targeted: TargetedSendProvider = {
    channelType: SLACK_CHANNEL_TYPE,
    supports: SLACK_SEND_CAPABILITIES,
    async sendToUser(target, message, sendOpts) {
      const bot = botFor(sendOpts?.asChannelKey);
      if (!isBot(bot)) return bot;
      const member = await memberFor(target, bot.users);
      // A DM is `chat.postMessage` to the member id: Slack opens the app's conversation with them.
      return typeof member === 'string' ? post(bot, member, message) : member;
    },
  };

  const conversation: ConversationSendProvider = {
    channelType: SLACK_CHANNEL_TYPE,
    supports: SLACK_SEND_CAPABILITIES,
    sendToConversation(conversationId: string, message: TargetedMessage, sendOpts?: ConversationSendOptions) {
      const bot = botFor(sendOpts?.asChannelKey);
      if (!isBot(bot)) return Promise.resolve(bot);
      return post(bot, conversationId, message);
    },
  };

  return { targeted, conversation };
}
