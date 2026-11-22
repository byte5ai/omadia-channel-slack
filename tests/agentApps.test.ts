// Agents' own Slack apps (spec 2042 §5.3, §8 item 20): the identity provider
// checks the bot token with Slack, keeps the credentials in the plugin vault
// and starts the app; an agent app resolves on its own key and answers only
// as the agent whose identity it is; sends go out through exactly the app named.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import express from 'express';

import {
  AGENT_APP_PREFIX,
  SlackAppFleet,
  createSlackAgentIdentityProvider,
  credentialsFor,
  startStoredAgentApps,
  type AgentAppDeps,
  type SlackAgentApp,
  type SlackBotIdentity,
} from '../src/agentApps.js';
import { createAgentBotsEventsRouter } from '../src/eventsApiTransport.js';
import { buildIncomingTurn } from '../src/inbound.js';
import { SlackOutbox } from '../src/outbox.js';
import { createSlackSendProviders } from '../src/slackSendProviders.js';
import { createChannelState } from '../src/state.js';
import { handleSlackTurn } from '../src/turn.js';
import { MIRA, RecordingSink, SpyOutbox, agentReturning, answer } from './helpers.js';

// Shaped like Slack credentials, but not real ones.
const DEFAULT_TOKEN = 'xoxb-fake-default-app-token-0000000000';
const MIRA_TOKEN = 'xoxb-fake-mira-agent-app-token-111111111';
const MIRA_SECRET = 'a'.repeat(32);
const MIRA_APP_TOKEN = 'xapp-fake-mira-agent-app-level-token-22222';

const users = { userIdByEmail: async () => undefined };
const NOT_MEMBER = { isMember: false, isIm: false, isMpim: false, isPrivate: false, isArchived: false };

function app(member: string, sink = new RecordingSink(), member_of = true): SlackAgentApp & { closed: number } {
  const a = {
    botKey: `slack-bot:${member.toLowerCase()}`,
    botUserId: member,
    name: `bot-${member}`,
    send: { outbox: new SlackOutbox(sink, undefined, true), users, reactions: { addReaction: async () => undefined } },
    roster: { channelType: 'slack', getRoster: async () => undefined },
    readiness: { grantedScopes: undefined, conversationInfo: async () => ({ ...NOT_MEMBER, isMember: member_of }) },
    isMemberOf: async () => member_of,
    status: () => 'connected' as const,
    closed: 0,
    close: async () => {
      a.closed += 1;
    },
  };
  return a;
}

function vault() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k),
    keys: async () => [...data.keys()],
    set: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

function rig(mode: 'webhook' | 'socket', checkToken: (t: string) => Promise<SlackBotIdentity>, sink = new RecordingSink()) {
  const fleet = new SlackAppFleet({
    channelKey: () => 'slack-bot:udefault',
    send: { outbox: new SlackOutbox(sink), users, reactions: { addReaction: async () => undefined } },
    roster: { channelType: 'slack', getRoster: async () => undefined },
    readiness: { grantedScopes: undefined, conversationInfo: async () => NOT_MEMBER },
    botToken: DEFAULT_TOKEN,
  });
  const secrets = vault();
  const started: string[] = [];
  const logs: string[] = [];
  const deps: AgentAppDeps = {
    fleet,
    secrets,
    mode,
    checkToken,
    startAgentApp: async (_c, identity) => (started.push(identity.botUserId), app(identity.botUserId, sink)),
    log: (_l, m) => void logs.push(m),
  };
  return { fleet, secrets, started, logs, deps, provider: createSlackAgentIdentityProvider(deps), sink };
}

const mira = async (): Promise<SlackBotIdentity> => ({ botUserId: 'UMIRA01', name: 'mira', teamId: 'T1' });
const input = (credentials: Record<string, string>) => ({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials });

describe('credentials per transport', () => {
  test('the Events API needs the signing secret, Socket Mode the app-level token', () => {
    assert.equal(typeof credentialsFor('webhook', { bot_token: MIRA_TOKEN }), 'string');
    assert.deepEqual(credentialsFor('webhook', { bot_token: MIRA_TOKEN, signing_secret: MIRA_SECRET }), {
      bot_token: MIRA_TOKEN,
      signing_secret: MIRA_SECRET,
    });
    assert.equal(typeof credentialsFor('socket', { bot_token: MIRA_TOKEN }), 'string');
    assert.deepEqual(credentialsFor('socket', { bot_token: MIRA_TOKEN, app_token: MIRA_APP_TOKEN }), {
      bot_token: MIRA_TOKEN,
      app_token: MIRA_APP_TOKEN,
    });
    assert.equal(typeof credentialsFor('socket', { bot_token: 'xoxp-user-token-not-a-bot-0000000', app_token: MIRA_APP_TOKEN }), 'string');
  });
});

describe('identity provider', () => {
  test('identify names the app without a side effect; provision keeps the credentials and starts it', async () => {
    const r = rig('webhook', mira);
    const creds = input({ bot_token: MIRA_TOKEN, signing_secret: MIRA_SECRET });
    const named = await r.provider.identify(creds);
    assert.deepEqual(named, { ok: true, channelKey: 'slack-bot:umira01', externalRef: '@mira', displayName: 'mira' });
    assert.equal(r.secrets.data.size, 0, 'identify stores nothing');
    assert.deepEqual(r.started, [], 'identify starts nothing');
    const out = await r.provider.provision(creds, 'slack-bot:umira01');
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(JSON.parse(r.secrets.data.get(`${AGENT_APP_PREFIX}umira01`) ?? '{}'), {
      bot_token: MIRA_TOKEN,
      signing_secret: MIRA_SECRET,
    });
    assert.deepEqual(r.started, ['UMIRA01']);
    assert.equal(r.logs.join('\n').includes(MIRA_TOKEN), false, 'no credential is logged');
    assert.equal(r.provider.defaultChannelKey?.(), 'slack-bot:udefault');
  });

  test('refuses the channel’s own app, by token and by member id', async () => {
    const byToken = rig('webhook', mira);
    const a = await byToken.provider.identify(input({ bot_token: DEFAULT_TOKEN, signing_secret: MIRA_SECRET }));
    assert.equal(a.ok === false && a.code, 'already_in_use');
    const byMember = rig('webhook', async () => ({ botUserId: 'UDEFAULT', name: 'colleague', teamId: 'T1' }));
    const b = await byMember.provider.identify(input({ bot_token: MIRA_TOKEN, signing_secret: MIRA_SECRET }));
    assert.equal(b.ok === false && b.code, 'already_in_use');
    assert.equal(byMember.secrets.data.size, 0);
  });

  test('a token Slack rejects is invalid_credentials, a network failure unreachable', async () => {
    const rejected = rig('socket', async () => {
      throw Object.assign(new Error('An API error occurred: invalid_auth'), { data: { error: 'invalid_auth' } });
    });
    const a = await rejected.provider.identify(input({ bot_token: MIRA_TOKEN, app_token: MIRA_APP_TOKEN }));
    assert.equal(a.ok === false && a.code, 'invalid_credentials');
    const down = rig('socket', async () => {
      throw new Error('getaddrinfo ENOTFOUND slack.com');
    });
    const b = await down.provider.identify(input({ bot_token: MIRA_TOKEN, app_token: MIRA_APP_TOKEN }));
    assert.equal(b.ok === false && b.code, 'unreachable');
  });

  test('release stops the app and deletes its credentials; boot restarts stored apps', async () => {
    const r = rig('socket', mira);
    await r.provider.provision(input({ bot_token: MIRA_TOKEN, app_token: MIRA_APP_TOKEN }), 'slack-bot:umira01');
    const running = r.fleet.agentApp('slack-bot:umira01') as SlackAgentApp & { closed: number };
    await r.provider.release('SLACK-BOT:UMIRA01');
    assert.equal(running.closed, 1);
    assert.equal(r.secrets.data.size, 0);
    r.secrets.data.set(`${AGENT_APP_PREFIX}umira01`, JSON.stringify({ bot_token: MIRA_TOKEN, app_token: MIRA_APP_TOKEN }));
    await startStoredAgentApps(r.deps, async () => undefined);
    assert.deepEqual(r.fleet.agentAppKeys(), ['slack-bot:umira01']);
  });

  test('boot retries while Slack is unreachable; a replaced app is closed; nothing is held after closeAll', async () => {
    let calls = 0;
    const r = rig('socket', async () => {
      calls += 1;
      if (calls < 3) throw new Error('getaddrinfo ENOTFOUND slack.com');
      return mira();
    });
    r.secrets.data.set(`${AGENT_APP_PREFIX}umira01`, JSON.stringify({ bot_token: MIRA_TOKEN, app_token: MIRA_APP_TOKEN }));
    const states: string[] = [];
    await startStoredAgentApps(r.deps, async () => void states.push((await r.provider.status!('slack-bot:umira01')).state));
    assert.deepEqual(states, ['unknown', 'unknown']);
    const first = r.fleet.agentApp('slack-bot:umira01') as SlackAgentApp & { closed: number };
    await r.fleet.add(app('UMIRA01'));
    assert.equal(first.closed, 1, 'the replaced app is closed');
    await r.fleet.closeAll();
    const late = app('UMIRA01');
    assert.equal(await r.fleet.add(late), false);
    assert.equal(late.closed, 1);
  });
});

describe('fleet', () => {
  test('a send for an agent app goes out through exactly that app, without a name line; unknown keys are refused', async () => {
    const defaultSink = new RecordingSink();
    const miraSink = new RecordingSink();
    const r = rig('webhook', mira, defaultSink);
    await r.fleet.add(app('UMIRA01', miraSink));
    const { conversation } = createSlackSendProviders((key) => r.fleet.sendFor(key));
    assert.equal((await conversation.sendToConversation('C1', { text: 'Hallo von Mira' }, { asChannelKey: 'slack-bot:umira01' })).outcome, 'delivered');
    assert.deepEqual(miraSink.calls.map((c) => c.text), ['Hallo von Mira']);
    assert.equal(defaultSink.calls.length, 0);
    const unknown = await conversation.sendToConversation('C1', { text: 'x' }, { asChannelKey: 'slack-bot:uother' });
    assert.equal(unknown.outcome === 'unreachable' && unknown.code, 'not_permitted');
  });

  test('presentIn lists the agent apps that are members of the conversation', async () => {
    const r = rig('webhook', mira);
    await r.fleet.add(app('UMIRA01', new RecordingSink(), true));
    await r.fleet.add(app('UOTTO01', new RecordingSink(), false));
    assert.deepEqual(await r.fleet.presentIn('C1'), ['slack-bot:umira01']);
  });
});

describe('an agent app routes only to its own agent', () => {
  const ev = { type: 'message', channel: 'D1', user: 'U1', text: 'hallo', ts: '300.1', channel_type: 'im' } as const;

  test('resolves on its bot key and answers as the agent the kernel names exclusively', async () => {
    const outbox = new SpyOutbox();
    const keys: string[] = [];
    await handleSlackTurn(
      {
        route: (key) => (keys.push(key), { decision: 'bound', exclusive: true, chatAgent: agentReturning(answer('Hier ist Mira.', MIRA)), speaker: MIRA }),
        defaultAgent: agentReturning(answer('nie', MIRA)),
        outbox,
        log: () => undefined,
        ownBotKey: () => 'slack-bot:umira01',
      },
      buildIncomingTurn('slack-1', ev, 'hallo', 'T1'),
    );
    assert.deepEqual(keys, ['slack-bot:umira01']);
    assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Hier ist Mira.']);
  });

  test('a key the kernel does not know as an identity is refused: no other agent answers', async () => {
    const outbox = new SpyOutbox();
    const seen: unknown[] = [];
    await handleSlackTurn(
      {
        route: () => ({ decision: 'bound', chatAgent: agentReturning(answer('Standard', MIRA), seen as never), speaker: MIRA }),
        defaultAgent: agentReturning(answer('nie', MIRA)),
        outbox,
        log: () => undefined,
        ownBotKey: () => 'slack-bot:umira01',
      },
      buildIncomingTurn('slack-1', ev, 'hallo', 'T1'),
    );
    assert.equal(seen.length, 0);
    assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
    assert.match(outbox.sink.calls[0]?.text ?? '', /keinem Agenten zugeordnet/);
  });
});

describe('agent app webhooks', () => {
  async function post(router: express.Router, path: string, body: unknown, secret: string): Promise<number> {
    const server = express().use(router).listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const raw = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
      const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
        body: raw,
      });
      return res.status;
    } finally {
      server.close();
    }
  }

  test('each app is verified with its own signing secret; an unknown app is 404', async () => {
    const state = createChannelState();
    const ingested: unknown[] = [];
    const channel = { ingest: async (e: unknown) => void ingested.push(e), ingestCommand: async () => undefined };
    const router = createAgentBotsEventsRouter((member) =>
      member === 'umira01' ? { signingSecret: MIRA_SECRET, channel: channel as never, log: () => undefined, state } : undefined,
    );
    const challenge = { type: 'url_verification', challenge: 'c' };
    assert.equal(await post(router, '/umira01/events', challenge, MIRA_SECRET), 200);
    assert.equal(await post(router, '/umira01/events', challenge, 'b'.repeat(32)), 401);
    assert.equal(await post(router, '/uother/events', challenge, MIRA_SECRET), 404);
    assert.equal(await post(router, '/UMIRA01/events', challenge, MIRA_SECRET), 200, 'the member id as Slack shows it');
  });
});

describe('two facilitators (spec 2043 §9 criterion 9, issue #6)', () => {
  test('two agent apps post as two distinct identities in two groups, never through each other or the shared app', async () => {
    const shared = new RecordingSink();
    const { fleet } = rig('webhook', mira, shared);
    const miraSink = new RecordingSink();
    const benSink = new RecordingSink();
    await fleet.add(app('UMIRA01', miraSink));
    await fleet.add(app('UBEN01', benSink));
    const { conversation } = createSlackSendProviders((key) => fleet.sendFor(key));
    const a = await conversation.sendToConversation('C-GROUP-A', { text: 'Abstimmung offen' }, { asChannelKey: 'slack-bot:umira01' });
    const b = await conversation.sendToConversation('C-GROUP-B', { text: 'Runde zwei' }, { asChannelKey: 'slack-bot:uben01' });
    assert.equal(a.outcome, 'delivered');
    assert.equal(b.outcome, 'delivered');
    assert.deepEqual(miraSink.calls.map((c) => c.target), ['C-GROUP-A']);
    assert.deepEqual(benSink.calls.map((c) => c.target), ['C-GROUP-B']);
    assert.equal(shared.calls.length, 0);
    // Readiness is read per app as well: each key names its own app.
    assert.notEqual(fleet.readinessFor('slack-bot:umira01'), fleet.readinessFor('slack-bot:uben01'));
    assert.equal(fleet.readinessFor('slack-bot:unknown'), undefined);
  });
});
