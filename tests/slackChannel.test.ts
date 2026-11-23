import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import type { ConversationMessageEvent, IncomingTurn } from '@omadia/channel-sdk';

import type { SlackSlashCommandPayload } from '../src/inbound.js';
import {
  PROBE_CLIENT_OPTIONS,
  SCOPES_TTL_MS,
  SlackChannel,
  validResponseUrl,
  type AccessPolicy,
  type SlackChannelDeps,
} from '../src/slackChannel.js';
import { createChannelState } from '../src/state.js';

const URL_OK = 'https://hooks.slack.com/commands/T1/1/x';

type InfoCall = { user: string; include_locale?: boolean };

function make(
  policy: Partial<AccessPolicy> = {},
  info: (args: InfoCall) => Promise<unknown> = async () => ({ user: {} }),
  extra: Partial<Pick<SlackChannelDeps, 'emitMessage' | 'reportMessage' | 'deliveryOf'>> = {},
) {
  const turns: IncomingTurn[] = [];
  const logs: string[] = [];
  const reactions: unknown[] = [];
  const channel = new SlackChannel({
    channelId: 'slack-1',
    botToken: 'xoxb-test',
    log: (level, message) => void logs.push(`${level}: ${message}`),
    state: createChannelState(),
    policy: { respondInChannels: 'mention', allowDms: true, allowlist: new Set(), ...policy },
    onMessage: async (t) => void turns.push(t),
    ...extra,
  });
  // `init()` would learn the bot's own member id from Slack; the tests state it.
  (channel as unknown as { botUserId: string }).botUserId = 'UBOT';
  // Any reaction would go through the Web client: record it.
  const web = (channel as unknown as { web: { reactions?: { add: (a: unknown) => Promise<void> } } }).web;
  if (web.reactions) web.reactions.add = async (a) => void reactions.push(a);
  // users.info is the sender profile lookup: never let a test reach Slack.
  const infoCalls: InfoCall[] = [];
  (web as unknown as { users: { info: (a: InfoCall) => Promise<unknown> } }).users.info = async (a) => (infoCalls.push(a), info(a));
  return { channel, turns, reactions, infoCalls, logs };
}

const command = (over: Partial<SlackSlashCommandPayload> = {}): SlackSlashCommandPayload => ({
  command: '/agent', text: 'Mira', user_id: 'U1', channel_id: 'C1', channel_name: 'general', response_url: URL_OK, trigger_id: 't1', ...over,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('an accepted message starts a turn and posts NO reaction (receipt reaction removed)', async () => {
  const { channel, turns, reactions } = make();
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' }, 'T1');
  assert.equal(turns.length, 1);
  assert.deepEqual(reactions, []);
});

test('a slash command starts a turn with the typed text, even where channel messages need a mention', async () => {
  const { channel, turns } = make({ respondInChannels: 'mention' });
  await channel.ingestCommand(command());
  assert.equal(turns[0]?.text, '/agent Mira');
});

test('a repeated command (same trigger_id) is handled once', async () => {
  const { channel, turns } = make();
  await channel.ingestCommand(command());
  await channel.ingestCommand(command());
  assert.equal(turns.length, 1);
});

test('DM policy and allowlist still apply to commands', async () => {
  const dmOff = make({ allowDms: false });
  await dmOff.channel.ingestCommand(command({ channel_id: 'D1', channel_name: 'directmessage' }));
  assert.equal(dmOff.turns.length, 0);
  const listed = make({ allowlist: new Set(['C9']) });
  await listed.channel.ingestCommand(command());
  assert.equal(listed.turns.length, 0);
  await listed.channel.ingestCommand(command({ channel_id: 'C9', trigger_id: 't2' }));
  assert.equal(listed.turns.length, 1);
});

test('only Slack https response_urls are accepted', () => {
  assert.equal(validResponseUrl(URL_OK), URL_OK);
  assert.equal(validResponseUrl('http://hooks.slack.com/x'), undefined);
  assert.equal(validResponseUrl('https://evil.example/x'), undefined);
  assert.equal(validResponseUrl('https://slack.com.evil.example/x'), undefined);
  assert.equal(validResponseUrl('not a url'), undefined);
  assert.equal(validResponseUrl(undefined), undefined);
});

test('a command with a foreign response_url still runs, but has no ephemeral target', async () => {
  const { channel, turns } = make();
  await channel.ingestCommand(command({ response_url: 'https://evil.example/x' }));
  assert.equal((turns[0]?.metadata as { responseUrl?: string }).responseUrl, undefined);
});

test('replyToCommand posts an ephemeral message to the response_url', async () => {
  const { channel } = make();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  await channel.replyToCommand(URL_OK, 'Du sprichst jetzt mit Mira.');
  assert.equal(calls[0]?.url, URL_OK);
  assert.equal(calls[0]?.body.response_type, 'ephemeral');
  assert.equal(calls[0]?.body.text, 'Du sprichst jetzt mit Mira.');
});

test('replyToCommand refuses a foreign URL and surfaces a failed post', async () => {
  const { channel } = make();
  await assert.rejects(channel.replyToCommand('https://evil.example/x', 't'), /not a Slack https URL/);
  globalThis.fetch = (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;
  await assert.rejects(channel.replyToCommand(URL_OK, 't'), /HTTP 404/);
});

test('the sender profile gives the turn an e-mail principal and the language, cached per member', async () => {
  const { channel, turns, infoCalls } = make({}, async () => ({ user: { locale: 'en-US', profile: { email: ' Anna@Example.com ' } } }));
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: 'a', ts: '1.1' }, 'T1');
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: 'b', ts: '1.2' }, 'T1');
  assert.equal(turns[0]?.userRef.email, 'anna@example.com');
  assert.equal((turns[0]?.metadata as { locale?: string }).locale, 'en');
  assert.deepEqual(infoCalls, [{ user: 'U1', include_locale: true }], 'one users.info call for two messages');
});

test('a language other than de/en is left out, and no e-mail means no e-mail on the turn', async () => {
  const { channel, turns } = make({}, async () => ({ user: { locale: 'fr-FR', profile: {} } }));
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: 'a', ts: '1.1' }, 'T1');
  assert.equal(turns[0]?.userRef.email, undefined);
  assert.equal((turns[0]?.metadata as { locale?: string }).locale, undefined);
});

test('a failing profile lookup never drops the turn: German notices, id principal', async () => {
  const { channel, turns } = make({}, async () => { throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }); });
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: 'a', ts: '1.1' }, 'T1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.userRef.email, undefined);
});

function emitting(policy: Partial<AccessPolicy> = {}, deliveryOf?: SlackChannelDeps['deliveryOf']) {
  const events: ConversationMessageEvent[] = [];
  const made = make(policy, undefined, { emitMessage: (e) => void events.push(e), ...(deliveryOf ? { deliveryOf } : {}) });
  return { ...made, events };
}

test('a thread reply is emitted as a created message with replyToMessageId, keyed by the bot identity', async () => {
  const { channel, events } = emitting();
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: '2', ts: '200.2', thread_ts: '100.1', channel_type: 'channel' }, 'T1');
  assert.equal(events.length, 1);
  assert.deepEqual(
    { ...events[0], occurredAt: undefined },
    {
      channelId: 'slack-1',
      channelType: 'slack',
      conversationId: 'C1',
      conversationType: 'group',
      receivedByChannelKey: 'slack-bot:ubot',
      messageId: '200.2',
      revision: 0,
      kind: 'created',
      author: { kind: 'slack-user', id: 'U1' },
      tenantId: 'T1',
      text: '2',
      replyToMessageId: '100.1',
      occurredAt: undefined,
    },
  );
  assert.equal(events[0]?.occurredAt, new Date(200_200).toISOString());
});

test('a top-level message has no replyToMessageId and a thread root is not a reply to itself', async () => {
  const { channel, events } = emitting();
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: 'a', ts: '300.1', channel_type: 'channel' }, 'T1');
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: 'b', ts: '300.2', thread_ts: '300.2', channel_type: 'channel' }, 'T1');
  assert.deepEqual(events.map((e) => e.replyToMessageId), [undefined, undefined]);
});

test('a mention of the bot sets addressedToBot, a plain message does not; the bot mention is stripped from the text', async () => {
  const { channel, events, turns } = emitting();
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> Antwort 2', ts: '1.1', channel_type: 'channel' }, 'T1');
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: 'hey <@UBOT> 3', ts: '1.2', channel_type: 'channel' }, 'T1');
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U2', text: 'nur so', ts: '1.3', channel_type: 'channel' }, 'T1');
  assert.deepEqual(events.map((e) => e.addressedToBot), [true, true, undefined]);
  assert.equal(events[0]?.text, 'Antwort 2');
  assert.equal(events.length, 3, 'also the message that starts no turn is recorded');
  assert.equal(turns.length, 2, 'the mention gate still decides on turns: a message event naming the bot is a mention too');
});

test('a mention whose message event arrives before its app_mention starts exactly one turn', async () => {
  const { channel, turns } = make();
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: '<@UBOT> 1. A 2. C 3. B', ts: '6.6', channel_type: 'channel' }, 'T1');
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> 1. A 2. C 3. B', ts: '6.6', channel_type: 'channel' }, 'T1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.text, '1. A 2. C 3. B');
});

test('a thread reply also sent to the channel and a message with a file are new messages; a join is not', async () => {
  const { channel, events } = emitting();
  await channel.ingest({ type: 'message', subtype: 'thread_broadcast', channel: 'C1', user: 'U1', text: 'A > B', ts: '7.1', thread_ts: '7.0', channel_type: 'channel' }, 'T1');
  await channel.ingest({ type: 'message', subtype: 'file_share', channel: 'C1', user: 'U2', text: 'B > A', ts: '7.2', channel_type: 'channel' }, 'T1');
  await channel.ingest({ type: 'message', subtype: 'channel_join', channel: 'C1', user: 'U3', text: '<@U3> has joined', ts: '7.3', channel_type: 'channel' }, 'T1');
  assert.deepEqual(events.map((e) => e.messageId), ['7.1', '7.2']);
});

test('the mention delivered twice (app_mention and message) is emitted once', async () => {
  const { channel, events } = emitting();
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: '<@UBOT> x', ts: '5.5', channel_type: 'channel' }, 'T1');
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> x', ts: '5.5', channel_type: 'channel' }, 'T1');
  assert.equal(events.length, 1);
});

test('nothing is emitted without emitConversationMessage, and the turn is unaffected', async () => {
  const { channel, turns } = make();
  await channel.ingest({ type: 'app_mention', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' }, 'T1');
  assert.equal(turns.length, 1);
});

test('nothing is emitted when the kernel hands the bot nothing of the conversation, with the bot key asked', async () => {
  const asked: string[] = [];
  const { channel, events } = emitting({}, (conversation, key) => (asked.push(`${conversation}/${key}`), 'none'));
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: 'x', ts: '1.1', channel_type: 'channel' }, 'T1');
  assert.deepEqual(events, []);
  assert.deepEqual(asked, ['C1/slack-bot:ubot']);
});

test('slash commands, disabled DMs and non-allowlisted channels are not emitted', async () => {
  const cmd = emitting();
  await cmd.channel.ingestCommand(command());
  const dm = emitting({ allowDms: false });
  await dm.channel.ingest({ type: 'message', channel: 'D1', user: 'U1', text: 'x', ts: '1.1', channel_type: 'im' }, 'T1');
  const listed = emitting({ allowlist: new Set(['C9']) });
  await listed.channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: 'x', ts: '1.1', channel_type: 'channel' }, 'T1');
  assert.deepEqual([cmd.events.length, dm.events.length, listed.events.length], [0, 0, 0]);
});

test('a DM is emitted as a direct conversation', async () => {
  const { channel, events } = emitting();
  await channel.ingest({ type: 'message', channel: 'D1', user: 'U1', text: '1', ts: '1.1', channel_type: 'im' }, 'T1');
  assert.equal(events[0]?.conversationType, 'direct');
});

type Verdict = { answeredCard: boolean };
const MENTION = { type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> 2', ts: '400.2', thread_ts: '400.1', channel_type: 'channel' } as const;

function reporting(report: (e: ConversationMessageEvent) => Promise<Verdict>, policy: Partial<AccessPolicy> = {}) {
  const reported: ConversationMessageEvent[] = [];
  const emitted: ConversationMessageEvent[] = [];
  const made = make(policy, undefined, {
    reportMessage: async (e) => (reported.push(e), report(e)),
    emitMessage: (e) => void emitted.push(e),
  });
  return { ...made, reported, emitted };
}

test('a message the kernel consumed as the answer to an open question starts no turn', async () => {
  const { channel, turns, reported, emitted } = reporting(async () => ({ answeredCard: true }));
  await channel.ingest(MENTION, 'T1');
  assert.equal(turns.length, 0);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.replyToMessageId, '400.1');
  assert.equal(emitted.length, 0, 'reported, not emitted twice');
});

test('a message the kernel did not consume starts the turn as before', async () => {
  const { channel, turns, reported } = reporting(async () => ({ answeredCard: false }));
  await channel.ingest(MENTION, 'T1');
  assert.equal(reported.length, 1);
  assert.equal(turns.length, 1);
});

test('a failing report is logged and the turn runs (never thrown)', async () => {
  const { channel, turns, logs } = reporting(async () => { throw new Error('kernel down'); });
  await channel.ingest(MENTION, 'T1');
  assert.equal(turns.length, 1);
  assert.ok(logs.some((l) => /report failed/.test(l)));
});

test('a report that takes too long never holds the turn: it runs after the timeout, answeredCard unknown = false', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { channel, turns, logs } = reporting(() => new Promise<Verdict>(() => undefined));
    const done = channel.ingest(MENTION, 'T1');
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.equal(turns.length, 0, 'still waiting inside the timeout');
    mock.timers.tick(1_500);
    await done;
    assert.equal(turns.length, 1);
    assert.ok(logs.some((l) => /timed out/.test(l)));
  } finally {
    mock.timers.reset();
  }
});

test('without reportConversationMessage the message is emitted and the turn runs as before', async () => {
  const { channel, turns, events } = emitting();
  await channel.ingest(MENTION, 'T1');
  assert.equal(events.length, 1);
  assert.equal(turns.length, 1);
});

test('a message that starts no turn is not held for a verdict: it is emitted fire-and-forget', async () => {
  const { channel, turns, emitted, reported } = reporting(() => new Promise<Verdict>(() => undefined));
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U2', text: '2', ts: '1.5', thread_ts: '1.1', channel_type: 'channel' }, 'T1');
  assert.equal(turns.length, 0);
  assert.equal(emitted.length, 1);
  assert.equal(reported.length, 0);
});

test('a DM is a turn case too: a consumed typed answer in a DM starts no turn', async () => {
  const { channel, turns } = reporting(async () => ({ answeredCard: true }));
  await channel.ingest({ type: 'message', channel: 'D1', user: 'U1', text: '1', ts: '2.2', channel_type: 'im' }, 'T1');
  assert.equal(turns.length, 0);
});

test('addReaction calls reactions.add as this app with the channel, the message ts and the emoji name', async () => {
  const { channel, reactions } = make();
  await channel.addReaction('C1', '1701.0001', '+1');
  assert.deepEqual(reactions, [{ channel: 'C1', timestamp: '1701.0001', name: '+1' }]);
});

test('conversationMembers: a failure on page two throws (the roster turns it into unknown), never a short list', async () => {
  const { channel } = make();
  const web = (channel as unknown as { web: { conversations: { members: (a: { cursor?: string }) => Promise<unknown> } } }).web;
  web.conversations.members = async ({ cursor }) => {
    if (!cursor) return { members: ['U1', 'U2'], response_metadata: { next_cursor: 'p2' } };
    throw Object.assign(new Error('An API error occurred: ratelimited'), { data: { ok: false, error: 'ratelimited' } });
  };
  await assert.rejects(channel.conversationMembers('C1', 2_000), /ratelimited/);
});

test('readiness probes use a client without retries and a short timeout', async () => {
  const { channel } = make();
  const probe = (channel as unknown as { probe: { retryConfig: unknown; axios: { defaults: { timeout?: number } } } }).probe;
  assert.deepEqual(probe.retryConfig, { retries: 0 });
  assert.equal(probe.axios.defaults.timeout, PROBE_CLIENT_OPTIONS.timeout);
  assert.ok(PROBE_CLIENT_OPTIONS.timeout <= 10_000);
});

test('granted scopes are re-read through auth.test once stale; a failed refresh keeps the last ones', async () => {
  let now = 1_000;
  const channel = new SlackChannel({
    channelId: 'slack-1',
    botToken: 'xoxb-test',
    log: () => undefined,
    state: createChannelState(),
    policy: { respondInChannels: 'mention', allowDms: true, allowlist: new Set() },
    onMessage: async () => undefined,
    now: () => now,
  });
  const answers: Array<() => Promise<unknown>> = [
    async () => ({ user_id: 'UBOT', response_metadata: { scopes: ['chat:write'] } }),
    async () => ({ user_id: 'UBOT', response_metadata: { scopes: ['chat:write', 'channels:history'] } }),
    async () => Promise.reject(new Error('socket hang up')),
  ];
  let calls = 0;
  const stub = { test: async () => answers[calls++]!() };
  (channel as unknown as { web: { auth: unknown } }).web.auth = stub;
  (channel as unknown as { probe: { auth: unknown } }).probe.auth = stub;
  await channel.init();
  assert.deepEqual(await channel.refreshScopes(), ['chat:write'], 'fresh after init: no call');
  assert.equal(calls, 1);
  now += SCOPES_TTL_MS;
  assert.deepEqual(await channel.refreshScopes(), ['chat:write', 'channels:history']);
  assert.equal(calls, 2);
  now += SCOPES_TTL_MS;
  assert.deepEqual(await channel.refreshScopes(), ['chat:write', 'channels:history']);
  assert.equal(calls, 3);
});

test('a recorded message names its author with the Slack display name (slack#6)', async () => {
  const events: ConversationMessageEvent[] = [];
  const { channel } = make({}, async () => ({ user: { profile: { display_name: 'Marcel Wege' } } }), {
    emitMessage: (e) => void events.push(e),
    deliveryOf: () => 'all',
  });
  await channel.ingest({ type: 'message', channel: 'C1', user: 'U1', text: '1,3,2', ts: '7.7', channel_type: 'channel' }, 'T1');
  assert.equal(events[0]?.author.displayName, 'Marcel Wege');
});
