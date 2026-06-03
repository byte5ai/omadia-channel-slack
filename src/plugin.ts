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
import type { SlackTurnMeta } from './inbound.js';
import { renderAnswer } from './renderer.js';
import { SlackConnection } from './slackConnection.js';
import { createChannelState } from './state.js';

/**
 * Channel-plugin entry. The kernel's dynamic channel resolver imports this
 * module and calls the exported `activate(ctx, core)` (ChannelPlugin "shape
 * 1"). We open the Slack Socket Mode connection in the background, mount the
 * status admin UI, and return a handle the kernel closes on
 * deactivate/uninstall.
 */
export async function activate(ctx: PluginContext, core: CoreApi): Promise<ChannelHandle> {
  const channelId = ctx.agentId;

  // Both tokens are required secrets — collected at install (manifest setup
  // fields `bot_token` / `app_token`) and stored in the per-plugin vault.
  const botToken = await ctx.secrets.get('bot_token');
  const appToken = await ctx.secrets.get('app_token');
  if (!botToken || !appToken) {
    throw new Error(
      '@omadia/channel-slack requires both a Bot token (bot_token, xoxb-…) and an App-Level token (app_token, xapp-…) — configure them in the plugin setup',
    );
  }

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

  // `let conn!` so the onMessage closure can reference the instance it is
  // attached to; the closure only fires once messages arrive (long after
  // construction), by which time `conn` is assigned.
  let conn!: SlackConnection;
  conn = new SlackConnection({
    channelId,
    botToken,
    appToken,
    log: (level, message, context) => core.log(level, message, context),
    state,
    policy: { respondInChannels, allowDms, allowlist },
    onMessage: (turn) => handleTurn(agent, core, conn, turn),
  });

  // Status admin UI. web-ui renders this as an iframe (manifest
  // `admin_ui_path`); the UI fetches its JSON API with RELATIVE paths so it
  // resolves through the `/bot-api` rewrite.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiAssetsPath = path.resolve(here, '../assets/admin-ui');
  const disposeRoutes = ctx.routes.register(
    '/api/slack-channel/admin',
    createAdminRouter({
      uiAssetsPath,
      state,
      smokeMode: ctx.smokeMode,
      onReconnect: () => conn.reconnect(),
    }),
  );

  // Non-blocking — auth + Socket Mode handshake can exceed the activate budget.
  conn.start();

  core.log('info', 'Slack channel activated — open the admin UI to check connection status', {
    adminUi: '/api/slack-channel/admin/index.html',
    respondInChannels,
    allowDms,
    allowlisted: allowlist.size,
  });

  return {
    async close() {
      disposeRoutes();
      await conn.close();
    },
  };
}

/** Drive one orchestrator turn and ship the rendered answer back to Slack. */
async function handleTurn(
  agent: ChatAgent,
  core: CoreApi,
  conn: SlackConnection,
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
    await conn.sendText(turn.conversationId, text, meta.threadTs);
  } catch (err) {
    core.log('error', 'failed to handle Slack turn', {
      error: (err as Error).message,
      conversationId: turn.conversationId,
    });
    try {
      await conn.sendText(
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
