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
 * Capabilities Slack declares. One Slack app is ONE identity, so the plugin
 * cannot post "as" a given agent (`asChannelKey` is not declared and a send
 * that asks for it is refused); no polls or cards (the sender falls back to a
 * chat ballot, which is plain text); `@mentions` become Slack member mentions.
 * Without `asChannelKey` the kernel sends nothing as an agent's own identity
 * through these providers, so every message they deliver is a `system` one.
 */
export const SLACK_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({ mentions: true });

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
 * report): a direct message to one member and a post into a conversation.
 * Everything leaves through the {@link SlackOutbox} (the one emitter), as a
 * `system` message: the plugin has no identity of its own per agent to speak as.
 * Unreachability is RETURNED, never thrown, as the provider contracts require.
 */
export function createSlackSendProviders(opts: {
  readonly outbox: SlackOutbox;
  readonly users: SlackUserLookup;
}): SlackSendProviders {
  const post = async (conversationId: string, message: TargetedMessage): Promise<TargetedDeliveryOutcome> => {
    const refused = refusedStructure(message);
    if (refused) return refused;
    const text = proactiveText(message);
    if (text.trim().length === 0) return unreachable('channel_error', 'nothing to send');
    try {
      await opts.outbox.deliver(
        { text, speaker: SYSTEM_SPEAKER },
        { conversationId, conversationKey: `${SLACK_CHANNEL_TYPE}:${conversationId}` },
      );
      return { outcome: 'delivered' };
    } catch (err) {
      return failure(err);
    }
  };

  const targeted: TargetedSendProvider = {
    channelType: SLACK_CHANNEL_TYPE,
    supports: SLACK_SEND_CAPABILITIES,
    async sendToUser(target, message, sendOpts) {
      if (sendOpts?.asChannelKey) return unreachable('not_permitted', 'Slack has no identity per agent to send as');
      const member = await memberFor(target, opts.users);
      // A DM is `chat.postMessage` to the member id: Slack opens the app's conversation with them.
      return typeof member === 'string' ? post(member, message) : member;
    },
  };

  const conversation: ConversationSendProvider = {
    channelType: SLACK_CHANNEL_TYPE,
    supports: SLACK_SEND_CAPABILITIES,
    sendToConversation(conversationId: string, message: TargetedMessage, sendOpts?: ConversationSendOptions) {
      if (sendOpts?.asChannelKey) {
        return Promise.resolve(unreachable('not_permitted', 'Slack has no identity per agent to send as'));
      }
      return post(conversationId, message);
    },
  };

  return { targeted, conversation };
}
