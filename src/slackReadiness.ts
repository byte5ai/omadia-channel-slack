import type { ChannelReadinessProvider, MeetingSourceProvider } from '@omadia/channel-sdk';
import type {
  ChannelReadinessIssue,
  ChannelReadinessReport,
  SessionCapabilitySnapshot,
  SessionInputCapability,
  SessionOutputCapability,
} from '@omadia/plugin-api';

import { SLACK_CHANNEL_TYPE } from './renderer.js';
import type { AccessPolicy, SlackConversationInfo } from './slackChannel.js';

/** What the readiness check needs of one app (implemented by `SlackChannel`). */
export interface SlackReadinessSource {
  /** Granted bot scopes (`auth.test`); `undefined` when Slack did not say. */
  readonly grantedScopes: readonly string[] | undefined;
  /** The granted scopes, re-read when stale (`SlackChannel.refreshScopes`). Absent: {@link grantedScopes}. */
  refreshScopes?(): Promise<readonly string[] | undefined>;
  /** The DM policy and allowlist the app applies to every inbound event. Absent: admits everything. */
  readonly policy?: Pick<AccessPolicy, 'allowDms' | 'allowlist'>;
  conversationInfo(conversationId: string): Promise<SlackConversationInfo>;
}

function scopesOf(source: SlackReadinessSource): Promise<readonly string[] | undefined> {
  return source.refreshScopes ? source.refreshScopes() : Promise.resolve(source.grantedScopes);
}

/** A direct message (1:1 DM)? */
function isDirect(conversationId: string, info: Pick<SlackConversationInfo, 'isIm'>): boolean {
  return info.isIm || conversationId.startsWith('D');
}

/**
 * What the app's own access policy drops of this conversation, the same gate
 * `SlackChannel` applies before anything reaches the kernel: DMs switched off
 * (nothing arrives: `unsupported_conversation`), or an allowlist without this
 * conversation (only allowlisted members' messages arrive: `consent_missing`).
 */
export function policyIssueFor(
  conversationId: string,
  info: Pick<SlackConversationInfo, 'isIm'>,
  policy: Pick<AccessPolicy, 'allowDms' | 'allowlist'> | undefined,
): ChannelReadinessIssue | undefined {
  if (!policy) return undefined;
  if (isDirect(conversationId, info) && !policy.allowDms) {
    return {
      code: 'unsupported_conversation',
      message: 'direct messages are switched off in the Slack channel settings (allow DMs), so nothing of this conversation reaches omadia',
    };
  }
  if (policy.allowlist.size > 0 && !policy.allowlist.has(conversationId)) {
    return {
      code: 'consent_missing',
      message: 'the Slack channel allowlist does not list this conversation, so only messages of allowlisted members reach omadia: add the conversation id to the allowlist',
    };
  }
  return undefined;
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
 * from `auth.test` (re-read when stale), and the app's own DM policy and
 * allowlist are applied like on inbound events. Because the event
 * subscriptions cannot be proven, every report is `verified: false`: no known
 * obstacle, not a verified state. Never throws.
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
      const scopes = await scopesOf(source);
      const known = scopes !== undefined;
      const historyScope = historyScopeFor(id, info);
      const hasHistory = !known || scopes.includes(historyScope);
      const policyIssue = policyIssueFor(id, info, source.policy);
      const canReadAllMessages = hasHistory && policyIssue === undefined;
      const canPost = !info.isArchived && (!known || scopes.includes(POST_SCOPE));
      const missing: ChannelReadinessIssue[] = [];
      if (policyIssue) missing.push(policyIssue);
      if (!hasHistory) {
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
        // The `message.*` event subscriptions cannot be read through any Slack API.
        verified: false,
      };
    },
  };
}

/** The bot scope without which Slack sends no `reaction_added` / `reaction_removed`. */
export const REACTIONS_READ_SCOPE = 'reactions:read';

const GROUP_OUTPUTS: readonly SessionOutputCapability[] = ['text', 'mentions', 'private_messages'];
const DIRECT_OUTPUTS: readonly SessionOutputCapability[] = ['text'];

/**
 * What a Slack conversation offers a facilitator (spec 2043 §6.1), as it
 * reaches the kernel: text and edits always; reactions only when the app
 * holds `reactions:read` (without it Slack sends no reaction events);
 * mentions and private messages (DMs) out of a group. Deletions and members
 * joining or leaving reach the kernel too, but the capability vocabulary has
 * no name for them (they are message and membership events). Chat only: Slack
 * huddles are not visible to an app. `undefined` for an unknown app.
 */
export function createSlackMeetingSource(
  sourceFor: (asChannelKey: string | undefined) => SlackReadinessSource | undefined,
  now: () => Date = () => new Date(),
): MeetingSourceProvider {
  return {
    channelType: SLACK_CHANNEL_TYPE,
    async snapshot(conversationId, opts): Promise<SessionCapabilitySnapshot | undefined> {
      const id = conversationId.trim();
      const source = sourceFor(opts.asChannelKey?.trim().toLowerCase());
      if (!id || !source) return undefined;
      const scopes = await scopesOf(source).catch(() => source.grantedScopes);
      const inputs: SessionInputCapability[] = ['text', 'message_edits'];
      if (scopes?.includes(REACTIONS_READ_SCOPE)) inputs.push('reactions');
      return {
        channelType: SLACK_CHANNEL_TYPE,
        conversationId: id,
        ...(opts.sessionRef !== undefined ? { sessionRef: opts.sessionRef } : {}),
        modality: 'chat',
        inputs,
        outputs: id.startsWith('D') ? DIRECT_OUTPUTS : GROUP_OUTPUTS,
        capturedAt: now().toISOString(),
      };
    },
  };
}
