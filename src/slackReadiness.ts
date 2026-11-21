import type { ChannelReadinessProvider } from '@omadia/channel-sdk';
import type { ChannelReadinessIssue, ChannelReadinessReport } from '@omadia/plugin-api';

import { SLACK_CHANNEL_TYPE } from './renderer.js';
import type { SlackConversationInfo } from './slackChannel.js';

/** What the readiness check needs of one app (implemented by `SlackChannel`). */
export interface SlackReadinessSource {
  /** Granted bot scopes (`auth.test`); `undefined` when Slack did not say. */
  readonly grantedScopes: readonly string[] | undefined;
  conversationInfo(conversationId: string): Promise<SlackConversationInfo>;
}

/** The bot scope that lets an app read every message of a conversation kind. */
export function historyScopeFor(conversationId: string, info: SlackConversationInfo): string {
  if (info.isIm || conversationId.startsWith('D')) return 'im:history';
  if (info.isMpim) return 'mpim:history';
  if (info.isPrivate || conversationId.startsWith('G')) return 'groups:history';
  return 'channels:history';
}

const POST_SCOPE = 'chat:write';

function slackErrorOf(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

function notReady(code: string, message: string, extra: Partial<ChannelReadinessReport> = {}): ChannelReadinessReport {
  return { ready: false, installed: false, canReadAllMessages: false, canPost: false, missing: [{ code, message }], ...extra };
}

/** Why `conversations.info` failed, as a readiness issue. */
function infoFailure(err: unknown): ChannelReadinessReport {
  const code = slackErrorOf(err);
  switch (code) {
    case 'channel_not_found':
    case 'not_in_channel':
      return notReady('app_not_installed', 'the app is not a member of this conversation: invite it with /invite @app');
    case 'missing_scope':
      return notReady('graph_forbidden', 'the app lacks the channels:read / groups:read / im:read / mpim:read bot scope to check the conversation');
    default:
      return notReady('graph_error', `Slack refused conversations.info${code ? ` (${code})` : ''}`);
  }
}

/**
 * Readiness of one app in one conversation (spec 2043 §5.3, §6.4; kernel
 * #2091): installed (member), may read every message, can post.
 *
 * Slack has no per-conversation consent like Teams RSC: an app that is a
 * member and holds the `*:history` scope of the conversation kind receives
 * every message, PROVIDED its event subscriptions include the matching
 * `message.*` event. Slack offers no API to read an app's event
 * subscriptions, so that part is the setup's (README); scopes are checked
 * from `auth.test`. When Slack did not report the scopes the report is
 * `verified: false` (no known obstacle, not proven). Never throws.
 */
export function createSlackReadinessProvider(
  sourceFor: (asChannelKey: string) => SlackReadinessSource | undefined,
): ChannelReadinessProvider {
  return {
    channelType: SLACK_CHANNEL_TYPE,
    async check(conversationId, opts) {
      const id = conversationId.trim();
      if (!id) return notReady('unsupported_conversation', 'no conversation id');
      const source = sourceFor(opts.asChannelKey.trim().toLowerCase());
      if (!source) return notReady('no_identity', `no Slack app of this installation runs as '${opts.asChannelKey}'`);
      let info: SlackConversationInfo;
      try {
        info = await source.conversationInfo(id);
      } catch (err) {
        return infoFailure(err);
      }
      // A DM or group DM it can read at all is one it is in.
      const installed = info.isMember || info.isIm || info.isMpim;
      if (!installed) {
        return notReady('app_not_installed', 'the app is not a member of this conversation: invite it with /invite @app');
      }
      const scopes = source.grantedScopes;
      const known = scopes !== undefined;
      const historyScope = historyScopeFor(id, info);
      const canReadAllMessages = !known || scopes.includes(historyScope);
      const canPost = !info.isArchived && (!known || scopes.includes(POST_SCOPE));
      const missing: ChannelReadinessIssue[] = [];
      if (!canReadAllMessages) {
        missing.push({ code: 'consent_missing', message: `the app lacks the ${historyScope} bot scope, so Slack does not deliver messages that do not mention it` });
      }
      if (info.isArchived) missing.push({ code: 'cannot_post', message: 'the conversation is archived' });
      else if (!canPost) missing.push({ code: 'cannot_post', message: `the app lacks the ${POST_SCOPE} bot scope` });
      return {
        ready: missing.length === 0,
        installed,
        canReadAllMessages,
        canPost,
        missing,
        ...(known ? {} : { verified: false }),
      };
    },
  };
}
