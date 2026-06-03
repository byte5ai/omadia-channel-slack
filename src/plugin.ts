import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as channelSdk from '@omadia/channel-sdk';
import {
  isNoReply,
  logNoReplyDrop,
  type ChatAgent,
  type ChannelHandle,
  type CoreApi,
  type IncomingTurn,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import { createEventsApiRouter } from './eventsApiTransport.js';
import type { SlackTurnMeta } from './inbound.js';
import { renderAnswer } from './renderer.js';
import { SlackChannel } from './slackChannel.js';
import { SocketModeTransport } from './socketModeTransport.js';
import { createChannelState, patchState } from './state.js';

const EVENTS_ROUTE_PREFIX = '/api/slack';
const EVENTS_PATH = `${EVENTS_ROUTE_PREFIX}/events`;

/**
 * Channel-plugin entry. The kernel's dynamic channel resolver imports this
 * module and calls the exported `activate(ctx, core)` (ChannelPlugin "shape
 * 1"). Picks a transport from config — the **Events API** webhook when a public
 * base URL is configured (production-recommended), otherwise **Socket Mode**
 * (zero-infra fallback for local dev / behind-firewall installs) — mounts the
 * status admin UI, and returns a handle the kernel closes on
 * deactivate/uninstall.
 */
export async function activate(ctx: PluginContext, core: CoreApi): Promise<ChannelHandle> {
  const channelId = ctx.agentId;

  const botToken = await ctx.secrets.get('bot_token');
  if (!botToken) {
    throw new Error(
      '@omadia/channel-slack requires a Bot User OAuth Token (bot_token, xoxb-…) — configure it in the plugin setup',
    );
  }

  const publicBaseUrl = (ctx.config.get<string>('public_base_url') ?? '').trim();
  const mode: 'webhook' | 'socket' = publicBaseUrl ? 'webhook' : 'socket';
  const requestUrl = publicBaseUrl ? joinUrl(publicBaseUrl, EVENTS_PATH) : undefined;

  const respondInChannels =
    ctx.config.get<string>('respond_in_channels') === 'all' ? 'all' : 'mention';
  const allowDms = ctx.config.get<boolean>('allow_dms') ?? true;
  const allowlist = parseAllowlist(ctx.config.get<string>('allowlist') ?? '');

  // Resolve the orchestrator's ChatAgent. Prefers the SDK's getChatAgent()
  // helper; falls back to the raw 'chatAgent' service lookup so the plugin
  // still runs on a host whose channel-sdk predates the helper.
  const agent = resolveChatAgent(ctx);
  if (!agent) {
    throw new Error(
      '@omadia/channel-slack: orchestrator unavailable (getChatAgent) — the orchestrator plugin must be installed and active',
    );
  }

  const state = createChannelState();
  state.mode = mode;

  // `let channel!` so the onMessage closure can reference the instance it is
  // attached to; the closure only fires once messages arrive (long after
  // construction), by which time `channel` is assigned.
  let channel!: SlackChannel;
  channel = new SlackChannel({
    channelId,
    botToken,
    log: (level, message, context) => core.log(level, message, context),
    state,
    policy: { respondInChannels, allowDms, allowlist },
    onMessage: (turn) => handleTurn(agent, core, channel, turn),
  });

  // Status admin UI. web-ui renders this as an iframe (manifest
  // `admin_ui_path`); the UI fetches its JSON API with RELATIVE paths so it
  // resolves through the `/bot-api` rewrite.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiAssetsPath = path.resolve(here, '../assets/admin-ui');

  const disposers: Array<() => void> = [];
  let onReconnect: () => Promise<void>;

  disposers.push(
    ctx.routes.register(
      '/api/slack-channel/admin',
      createAdminRouter({
        uiAssetsPath,
        state,
        smokeMode: ctx.smokeMode,
        ...(requestUrl ? { requestUrl } : {}),
        onReconnect: () => onReconnect(),
      }),
    ),
  );

  if (mode === 'webhook') {
    const signingSecret = await ctx.secrets.get('signing_secret');
    if (!signingSecret) {
      throw new Error(
        '@omadia/channel-slack: a public_base_url is set (Events API mode) but no signing_secret — add the Slack app Signing Secret in the plugin setup, or clear public_base_url to use Socket Mode',
      );
    }

    disposers.push(
      ctx.routes.register(
        EVENTS_ROUTE_PREFIX,
        createEventsApiRouter({ signingSecret, channel, log: core.log.bind(core), state }),
      ),
    );

    // Learn identity + validate the bot token in the background; the webhook
    // route is already mounted so url_verification can pass immediately.
    onReconnect = () => initWebhook(channel, core, state);
    void initWebhook(channel, core, state);

    core.log('info', 'Slack channel activated in Events API (webhook) mode', {
      adminUi: '/api/slack-channel/admin/index.html',
      requestUrl,
      respondInChannels,
      allowDms,
      allowlisted: allowlist.size,
    });
    core.log(
      'info',
      `Slack Events API ready — set this Request URL in your Slack app (Event Subscriptions): ${requestUrl ?? ''}`,
    );

    return { async close() { for (const d of disposers.reverse()) d(); } };
  }

  // Socket Mode fallback.
  const appToken = await ctx.secrets.get('app_token');
  if (!appToken) {
    throw new Error(
      '@omadia/channel-slack: no public_base_url set (Socket Mode) but no app_token — add an App-Level Token (xapp-…, scope connections:write), or set public_base_url to use the Events API',
    );
  }

  const transport = new SocketModeTransport({ appToken, channel, log: core.log.bind(core), state });
  onReconnect = () => transport.reconnect();
  transport.start();
  disposers.push(() => void transport.close());

  core.log('info', 'Slack channel activated in Socket Mode', {
    adminUi: '/api/slack-channel/admin/index.html',
    respondInChannels,
    allowDms,
    allowlisted: allowlist.size,
  });

  return { async close() { for (const d of disposers.reverse()) d(); } };
}

/** Validate the bot token + resolve identity for webhook mode, mapping the
 *  outcome onto the connection status. */
async function initWebhook(channel: SlackChannel, core: CoreApi, state: ReturnType<typeof createChannelState>): Promise<void> {
  try {
    patchState(state, { status: 'connecting', lastError: null });
    await channel.init();
    patchState(state, { status: 'connected' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patchState(state, { status: 'error', lastError: message });
    core.log('error', 'Slack bot token validation failed', { error: message });
  }
}

/** Drive one orchestrator turn and ship the rendered answer back to Slack. */
async function handleTurn(
  agent: ChatAgent,
  core: CoreApi,
  channel: SlackChannel,
  turn: IncomingTurn,
): Promise<void> {
  const meta = turn.metadata as unknown as SlackTurnMeta;
  try {
    const answer = await agent.chat({
      userMessage: turn.text,
      sessionScope: meta.sessionScope,
      userId: turn.userRef.id,
    });
    if (isNoReply(answer)) {
      logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
      return;
    }
    const text = renderAnswer(answer);
    if (text.trim().length === 0) return;
    await channel.sendText(turn.conversationId, text, meta.threadTs);
  } catch (err) {
    core.log('error', 'failed to handle Slack turn', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    try {
      await channel.sendText(
        turn.conversationId,
        '⚠️ Entschuldigung, dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.',
        meta.threadTs,
      );
    } catch {
      /* original error already logged — don't mask it with a send failure */
    }
  }
}

/**
 * Resolve the orchestrator's {@link ChatAgent}. Prefers the SDK helper
 * `getChatAgent(ctx)` (the blessed, typed path); falls back to the raw
 * service-registry lookup so the plugin also runs on a host whose
 * `@omadia/channel-sdk` predates the helper (the `chatAgent` service itself
 * has always been there). Accessed via the namespace so a missing export is
 * just `undefined` at runtime rather than a module-load error.
 */
function resolveChatAgent(ctx: PluginContext): ChatAgent | undefined {
  const helper = (channelSdk as { getChatAgent?: (c: PluginContext) => ChatAgent | undefined })
    .getChatAgent;
  if (helper) return helper(ctx);
  return ctx.services.get<{ agent: ChatAgent }>('chatAgent')?.agent;
}

/** Parse the comma-separated allowlist into a set of Slack channel / user ids. */
function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function joinUrl(base: string, suffixPath: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}${suffixPath.startsWith('/') ? suffixPath : `/${suffixPath}`}`;
}
