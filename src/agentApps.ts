/**
 * Agents' own Slack apps (spec 2042 §5.3, §8 item 20).
 *
 * An operator gives an agent an app of its own: a Slack app created from the
 * same app manifest as the channel's app, named like the agent, installed to
 * the workspace. Its credentials are entered on the agent's page in omadia:
 * the Bot User OAuth Token (`xoxb-…`) and, matching the channel's transport,
 * the Signing Secret (Events API, `public_base_url` set) or an App-Level
 * Token (`xapp-…`, Socket Mode). The kernel hands them to
 * {@link createSlackAgentIdentityProvider} once; this plugin checks the bot
 * token with `auth.test`, keeps the credentials in its own vault
 * (`agent_app_<member id>`), starts the app and returns its routing key
 * `slack-bot:<member id>`. The kernel stores (agent, key) and from then on
 * routes every turn through that app to the agent, and posts the agent's
 * messages through it.
 *
 * {@link SlackAppFleet} holds every running app (the installation's own one and
 * the agent apps) and answers the per-identity questions the kernel asks.
 */

import { WebClient } from '@slack/web-api';

import type {
  AgentIdentityField,
  AgentIdentityProvider,
  AgentIdentityProvisionOutcome,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { SLACK_CHANNEL_TYPE } from './renderer.js';
import { slackBotChannelKey } from './slackChannel.js';
import type { SlackSendBot } from './slackSendProviders.js';

/** Vault key of an agent app's credentials (JSON). */
export const AGENT_APP_PREFIX = 'agent_app_';
const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{20,}$/;
const APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{20,}$/;
const SIGNING_SECRET_RE = /^[a-f0-9]{32}$/i;
const PRESENCE_TTL_MS = 60_000;

/** The credentials of one agent app, as stored in the vault. */
export interface AgentAppCredentials {
  readonly bot_token: string;
  readonly signing_secret?: string;
  readonly app_token?: string;
}

export const AGENT_APP_FIELDS: readonly AgentIdentityField[] = Object.freeze([
  {
    key: 'bot_token',
    label: { en: 'Bot User OAuth Token (xoxb-…)', de: 'Bot User OAuth Token (xoxb-…)' },
    help: {
      en: 'Create a Slack app for this agent from the same app manifest as the channel’s app, named like the agent, install it to the workspace and paste its bot token.',
      de: 'Lege für diesen Agenten eine Slack-App aus demselben App-Manifest wie die App des Kanals an, benannt wie der Agent, installiere sie im Workspace und füge ihren Bot-Token ein.',
    },
    secret: true,
  },
  {
    key: 'signing_secret',
    label: { en: 'Signing Secret (Events API)', de: 'Signing Secret (Events API)' },
    help: {
      en: 'Needed when the channel uses the Events API (public base URL set). Set the app’s Request URL to <base>/api/slack/agent-bots/<member id>/events; the agent page shows the member id after connecting.',
      de: 'Nötig, wenn der Kanal die Events API nutzt (Public-Base-URL gesetzt). Request-URL der App: <base>/api/slack/agent-bots/<Member-ID>/events; die Member-ID steht nach dem Verbinden auf der Agent-Seite.',
    },
    secret: true,
    required: false,
  },
  {
    key: 'app_token',
    label: { en: 'App-Level Token (xapp-…, Socket Mode)', de: 'App-Level-Token (xapp-…, Socket Mode)' },
    help: {
      en: 'Needed when the channel uses Socket Mode (no public base URL). Scope connections:write.',
      de: 'Nötig, wenn der Kanal Socket Mode nutzt (keine Public-Base-URL). Scope connections:write.',
    },
    secret: true,
    required: false,
  },
]);

/** One running agent app as the fleet sees it. */
export interface SlackAgentApp {
  /** `slack-bot:<member id>`. */
  readonly botKey: string;
  readonly botUserId: string;
  readonly name: string;
  readonly send: SlackSendBot;
  readonly roster: ConversationRosterProvider;
  isMemberOf(conversationId: string): Promise<boolean>;
  status(): 'connected' | 'connecting' | 'error';
  close(): Promise<void>;
}

/** The installation's own app: its key is known once its token was checked. */
export interface SlackDefaultApp {
  channelKey(): string | undefined;
  readonly send: SlackSendBot;
  readonly roster: ConversationRosterProvider;
  /** The bot token of the installation's own app, to refuse it as an agent app. */
  readonly botToken: string;
}

export class SlackAppFleet {
  private readonly agentApps = new Map<string, SlackAgentApp>();
  private readonly presence = new Map<string, { readonly at: number; readonly keys: readonly string[] }>();

  constructor(readonly defaultApp: SlackDefaultApp) {}

  agentApp(botKey: string): SlackAgentApp | undefined {
    return this.agentApps.get(botKey);
  }

  agentAppKeys(): readonly string[] {
    return [...this.agentApps.keys()];
  }

  /** The agent app with this member id (lowercase), for its webhook. */
  agentAppByMember(botUserId: string): SlackAgentApp | undefined {
    return this.agentApps.get(slackBotChannelKey(botUserId));
  }

  add(app: SlackAgentApp): void {
    this.agentApps.set(app.botKey, app);
    this.presence.clear();
  }

  remove(botKey: string): SlackAgentApp | undefined {
    const app = this.agentApps.get(botKey);
    this.agentApps.delete(botKey);
    this.presence.clear();
    return app;
  }

  private isDefaultKey(key: string | undefined): boolean {
    return key === undefined || key === this.defaultApp.channelKey();
  }

  sendFor(asChannelKey: string | undefined): SlackSendBot | undefined {
    if (this.isDefaultKey(asChannelKey)) return this.defaultApp.send;
    return this.agentApps.get(asChannelKey as string)?.send;
  }

  rosterProvider(): ConversationRosterProvider {
    return {
      channelType: SLACK_CHANNEL_TYPE,
      getRoster: (conversationId: string, opts?: ConversationRosterRequest): Promise<ConversationRoster | undefined> => {
        const key = opts?.asChannelKey?.trim().toLowerCase();
        if (this.isDefaultKey(key)) return this.defaultApp.roster.getRoster(conversationId, opts);
        const app = key === undefined ? undefined : this.agentApps.get(key);
        return app ? app.roster.getRoster(conversationId, opts) : Promise.resolve(undefined);
      },
    };
  }

  async presentIn(conversationId: string): Promise<readonly string[]> {
    const id = conversationId.trim();
    if (!id) return [];
    const cached = this.presence.get(id);
    if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) return cached.keys;
    const checks = await Promise.all(
      [...this.agentApps.values()].map(async (app) => ((await app.isMemberOf(id).catch(() => false)) ? app.botKey : undefined)),
    );
    const keys = checks.filter((k): k is string => k !== undefined);
    this.presence.set(id, { at: Date.now(), keys });
    return keys;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.agentApps.values()].map((a) => a.close()));
  }
}

export interface AgentAppSecrets {
  get(key: string): Promise<string | undefined>;
  keys(): Promise<string[]>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What Slack says about a bot token. */
export interface SlackBotIdentity {
  readonly botUserId: string;
  readonly name: string;
  readonly teamId: string;
}

export type BotTokenCheck = (botToken: string) => Promise<SlackBotIdentity>;

/** `auth.test` for a bot token. Throws the Web API error (`data.error`). */
export const checkBotToken: BotTokenCheck = async (botToken) => {
  const auth = await new WebClient(botToken).auth.test();
  if (typeof auth.user_id !== 'string' || auth.user_id === '') throw new Error('auth.test returned no bot member id');
  return {
    botUserId: auth.user_id,
    name: typeof auth.user === 'string' ? auth.user : auth.user_id,
    teamId: typeof auth.team_id === 'string' ? auth.team_id : '',
  };
};

export interface AgentAppDeps {
  readonly fleet: SlackAppFleet;
  readonly secrets: AgentAppSecrets;
  /** The channel's transport: agent apps use the same one. */
  readonly mode: 'webhook' | 'socket';
  /** Builds and starts the runtime of an agent app. */
  readonly startAgentApp: (credentials: AgentAppCredentials, identity: SlackBotIdentity) => Promise<SlackAgentApp>;
  readonly checkToken?: BotTokenCheck;
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const refuse = (
  code: Extract<AgentIdentityProvisionOutcome, { ok: false }>['code'],
  message: string,
): AgentIdentityProvisionOutcome => ({ ok: false, code, message });

const REJECTED_TOKEN_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']);

function slackErrorOf(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The credentials the transport needs, or why they are not usable. */
export function credentialsFor(
  mode: 'webhook' | 'socket',
  raw: Readonly<Record<string, string>>,
): AgentAppCredentials | string {
  const botToken = raw['bot_token']?.trim() ?? '';
  if (!BOT_TOKEN_RE.test(botToken)) return 'the bot token must be a Bot User OAuth Token (xoxb-…)';
  if (mode === 'webhook') {
    const signingSecret = raw['signing_secret']?.trim() ?? '';
    if (!SIGNING_SECRET_RE.test(signingSecret)) {
      return 'this channel uses the Events API: the app’s Signing Secret is required';
    }
    return { bot_token: botToken, signing_secret: signingSecret };
  }
  const appToken = raw['app_token']?.trim() ?? '';
  if (!APP_TOKEN_RE.test(appToken)) return 'this channel uses Socket Mode: an App-Level Token (xapp-…) is required';
  return { bot_token: botToken, app_token: appToken };
}

export function createSlackAgentIdentityProvider(deps: AgentAppDeps): AgentIdentityProvider {
  const check = deps.checkToken ?? checkBotToken;
  return {
    channelType: SLACK_CHANNEL_TYPE,
    fields: AGENT_APP_FIELDS,
    async provision(input) {
      const credentials = credentialsFor(deps.mode, input.credentials);
      if (typeof credentials === 'string') return refuse('invalid_input', credentials);
      if (credentials.bot_token === deps.fleet.defaultApp.botToken) {
        return refuse('already_in_use', 'this is the Slack channel’s own app');
      }
      let identity: SlackBotIdentity;
      try {
        identity = await check(credentials.bot_token);
      } catch (err) {
        return REJECTED_TOKEN_ERRORS.has(slackErrorOf(err) ?? '')
          ? refuse('invalid_credentials', 'Slack rejected this bot token')
          : refuse('unreachable', 'Slack could not be reached to check the token');
      }
      const botKey = slackBotChannelKey(identity.botUserId);
      if (botKey === deps.fleet.defaultApp.channelKey()) return refuse('already_in_use', 'this is the Slack channel’s own app');
      const vaultKey = `${AGENT_APP_PREFIX}${identity.botUserId.toLowerCase()}`;
      // The same app again (re-entered or rotated credentials): restart it.
      await deps.fleet.remove(botKey)?.close();
      await deps.secrets.set(vaultKey, JSON.stringify(credentials));
      try {
        deps.fleet.add(await deps.startAgentApp(credentials, identity));
      } catch (err) {
        await deps.secrets.delete(vaultKey);
        deps.log('error', `agent app ${botKey} for '${input.agentSlug}' did not start: ${errorMessage(err)}`);
        return refuse('unreachable', 'the app could not be started');
      }
      deps.log('info', `agent app @${identity.name} (${botKey}) started for agent '${input.agentSlug}'`);
      return { ok: true, channelKey: botKey, externalRef: `@${identity.name}`, displayName: identity.name };
    },
    async release(channelKey) {
      const key = channelKey.trim().toLowerCase();
      await deps.fleet.remove(key)?.close();
      const member = /^slack-bot:([a-z0-9]+)$/.exec(key)?.[1];
      if (member) await deps.secrets.delete(`${AGENT_APP_PREFIX}${member}`);
      deps.log('info', `agent app ${key} stopped and its credentials removed`);
    },
    async status(channelKey) {
      const app = deps.fleet.agentApp(channelKey.trim().toLowerCase());
      if (!app) return { state: 'stopped', detail: 'the app is not running in this installation (credentials missing or rejected)' };
      const state = app.status();
      return { state: state === 'error' ? 'stopped' : 'running', detail: state };
    },
    defaultChannelKey: () => deps.fleet.defaultApp.channelKey(),
    presentIn: (conversationId) => deps.fleet.presentIn(conversationId),
  };
}

/** Start every agent app whose credentials are in the vault (boot). */
export async function startStoredAgentApps(deps: AgentAppDeps): Promise<void> {
  const check = deps.checkToken ?? checkBotToken;
  const keys = (await deps.secrets.keys()).filter((k) => k.startsWith(AGENT_APP_PREFIX));
  for (const key of keys) {
    try {
      const raw = await deps.secrets.get(key);
      if (!raw) continue;
      const credentials = credentialsFor(deps.mode, JSON.parse(raw) as Record<string, string>);
      if (typeof credentials === 'string') {
        deps.log('warn', `agent app from vault key ${key} not started: ${credentials}`);
        continue;
      }
      const identity = await check(credentials.bot_token);
      if (deps.fleet.agentApp(slackBotChannelKey(identity.botUserId))) continue;
      deps.fleet.add(await deps.startAgentApp(credentials, identity));
    } catch (err) {
      deps.log('warn', `agent app from vault key ${key} did not start: ${errorMessage(err)}`);
    }
  }
  deps.log('info', `slack agent apps running: ${String(deps.fleet.agentAppKeys().length)}`);
}
