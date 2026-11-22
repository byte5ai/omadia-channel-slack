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
  AgentIdentityRefusal,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { SLACK_CHANNEL_TYPE } from './renderer.js';
import { slackBotChannelKey } from './slackChannel.js';
import type { SlackReadinessSource } from './slackReadiness.js';
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
  /** Membership, scopes: what the readiness check reads of this app. */
  readonly readiness: SlackReadinessSource;
  isMemberOf(conversationId: string): Promise<boolean>;
  status(): 'connected' | 'connecting' | 'error';
  close(): Promise<void>;
}

/** The installation's own app: its key is known once its token was checked. */
export interface SlackDefaultApp {
  channelKey(): string | undefined;
  readonly send: SlackSendBot;
  readonly roster: ConversationRosterProvider;
  readonly readiness: SlackReadinessSource;
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

  private closed = false;
  /** Apps whose start waits for Slack to become reachable again (boot). */
  private readonly retrying = new Set<string>();

  /**
   * Hold a started app. An app that runs under the key already is closed
   * first (never two connections for one app), and after {@link closeAll}
   * nothing is held: a late start is closed at once. `false` = not added.
   */
  async add(app: SlackAgentApp): Promise<boolean> {
    if (this.closed) {
      await app.close();
      return false;
    }
    const previous = this.agentApps.get(app.botKey);
    this.agentApps.set(app.botKey, app);
    this.retrying.delete(app.botKey);
    this.presence.clear();
    if (previous && previous !== app) await previous.close();
    return true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  markRetrying(botKey: string, retrying: boolean): void {
    if (retrying) this.retrying.add(botKey);
    else this.retrying.delete(botKey);
  }

  isRetrying(botKey: string): boolean {
    return this.retrying.has(botKey);
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

  /** The app `asChannelKey` names (no key: the installation's own app); unknown key: none, never another app. */
  readinessFor(asChannelKey: string | undefined): SlackReadinessSource | undefined {
    if (this.isDefaultKey(asChannelKey)) return this.defaultApp.readiness;
    return this.agentApps.get(asChannelKey as string)?.readiness;
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
    this.closed = true;
    const running = [...this.agentApps.values()];
    this.agentApps.clear();
    this.retrying.clear();
    await Promise.all(running.map((a) => a.close()));
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

const refuse = (code: AgentIdentityRefusal['code'], message: string): AgentIdentityRefusal => ({ ok: false, code, message });

const REJECTED_TOKEN_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']);

function slackErrorOf(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

function isRejectedToken(err: unknown): boolean {
  return REJECTED_TOKEN_ERRORS.has(slackErrorOf(err) ?? '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isRefusal = (value: object): value is AgentIdentityRefusal => (value as { ok?: unknown }).ok === false;

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

/** Which app the credentials are, or why they are refused. */
async function appOf(
  deps: AgentAppDeps,
  raw: Readonly<Record<string, string>>,
): Promise<{ credentials: AgentAppCredentials; identity: SlackBotIdentity } | AgentIdentityRefusal> {
  const credentials = credentialsFor(deps.mode, raw);
  if (typeof credentials === 'string') return refuse('invalid_input', credentials);
  if (credentials.bot_token === deps.fleet.defaultApp.botToken) return refuse('already_in_use', 'this is the Slack channel’s own app');
  try {
    const identity = await (deps.checkToken ?? checkBotToken)(credentials.bot_token);
    if (slackBotChannelKey(identity.botUserId) === deps.fleet.defaultApp.channelKey()) {
      return refuse('already_in_use', 'this is the Slack channel’s own app');
    }
    return { credentials, identity };
  } catch (err) {
    return isRejectedToken(err)
      ? refuse('invalid_credentials', 'Slack rejected this bot token')
      : refuse('unreachable', 'Slack could not be reached to check the token');
  }
}

export function createSlackAgentIdentityProvider(deps: AgentAppDeps): AgentIdentityProvider {
  return {
    channelType: SLACK_CHANNEL_TYPE,
    fields: AGENT_APP_FIELDS,
    // No side effect: the kernel decides whether this app is free.
    async identify(input) {
      const found = await appOf(deps, input.credentials);
      if (isRefusal(found)) return found;
      const { identity } = found;
      return { ok: true, channelKey: slackBotChannelKey(identity.botUserId), externalRef: `@${identity.name}`, displayName: identity.name };
    },
    // Called only for an app no agent owns (the kernel checked).
    async provision(input, channelKey) {
      const found = await appOf(deps, input.credentials);
      if (isRefusal(found)) return found;
      const { credentials, identity } = found;
      const botKey = slackBotChannelKey(identity.botUserId);
      if (botKey !== channelKey.trim().toLowerCase()) return refuse('invalid_input', 'the token names another app than the one checked');
      if (deps.fleet.isClosed) return refuse('unreachable', 'the Slack channel is shutting down');
      const vaultKey = `${AGENT_APP_PREFIX}${identity.botUserId.toLowerCase()}`;
      await deps.secrets.set(vaultKey, JSON.stringify(credentials));
      try {
        // `add` closes an app that still ran under this key (nobody owned it).
        if (!(await deps.fleet.add(await deps.startAgentApp(credentials, identity)))) {
          return refuse('unreachable', 'the Slack channel is shutting down');
        }
      } catch (err) {
        await deps.secrets.delete(vaultKey);
        deps.log('error', `agent app ${botKey} for '${input.agentSlug}' did not start: ${errorMessage(err)}`);
        return refuse('unreachable', 'the app could not be started');
      }
      deps.log('info', `agent app @${identity.name} (${botKey}) started for agent '${input.agentSlug}'`);
      return { ok: true };
    },
    async release(channelKey) {
      const key = channelKey.trim().toLowerCase();
      deps.fleet.markRetrying(key, false);
      await deps.fleet.remove(key)?.close();
      const member = /^slack-bot:([a-z0-9]+)$/.exec(key)?.[1];
      if (member) await deps.secrets.delete(`${AGENT_APP_PREFIX}${member}`);
      deps.log('info', `agent app ${key} stopped and its credentials removed`);
    },
    async status(channelKey) {
      const key = channelKey.trim().toLowerCase();
      const app = deps.fleet.agentApp(key);
      if (app) {
        const state = app.status();
        return { state: state === 'error' ? 'stopped' : 'running', detail: state };
      }
      if (deps.fleet.isRetrying(key)) return { state: 'unknown', detail: 'Slack is not reachable; the app starts as soon as it is' };
      return { state: 'stopped', detail: 'the app is not running in this installation (credentials missing or rejected)' };
    },
    defaultChannelKey: () => deps.fleet.defaultApp.channelKey(),
    presentIn: (conversationId) => deps.fleet.presentIn(conversationId),
  };
}

/** Backoff of a stored app whose start failed because Slack was not reachable. */
export const BOOT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000];

/**
 * Start every agent app whose credentials are in the vault (boot), all at
 * once. A token Slack REJECTS stays where it is and the app stays stopped;
 * any other failure (Slack unreachable during a deploy) is retried with backoff.
 */
export async function startStoredAgentApps(
  deps: AgentAppDeps,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const check = deps.checkToken ?? checkBotToken;
  const keys = (await deps.secrets.keys()).filter((k) => k.startsWith(AGENT_APP_PREFIX));
  const startOne = async (key: string): Promise<void> => {
    const botKey = `slack-bot:${key.slice(AGENT_APP_PREFIX.length)}`;
    for (let attempt = 0; !deps.fleet.isClosed; attempt++) {
      let credentials: AgentAppCredentials | string;
      try {
        const raw = await deps.secrets.get(key);
        if (!raw) return;
        credentials = credentialsFor(deps.mode, JSON.parse(raw) as Record<string, string>);
      } catch {
        deps.log('warn', `agent app from vault key ${key} not started: unreadable credentials`);
        return;
      }
      if (typeof credentials === 'string') {
        deps.log('warn', `agent app from vault key ${key} not started: ${credentials}`);
        return;
      }
      try {
        const identity = await check(credentials.bot_token);
        if (deps.fleet.agentApp(slackBotChannelKey(identity.botUserId))) return;
        await deps.fleet.add(await deps.startAgentApp(credentials, identity));
        return;
      } catch (err) {
        if (isRejectedToken(err)) {
          deps.log('warn', `agent app from vault key ${key} not started: Slack rejects its token`);
          return;
        }
        const delay = BOOT_RETRY_DELAYS_MS[Math.min(attempt, BOOT_RETRY_DELAYS_MS.length - 1)] ?? 300_000;
        deps.fleet.markRetrying(botKey, true);
        deps.log('warn', `agent app from vault key ${key} did not start (${errorMessage(err)}); retrying in ${String(delay)} ms`);
        await sleep(delay);
      }
    }
  };
  await Promise.all(keys.map(startOne));
  deps.log('info', `slack agent apps running: ${String(deps.fleet.agentAppKeys().length)}`);
}
