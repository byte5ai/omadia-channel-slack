import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paceAckText, type AgentSpeaker, type ChatAgent, type IncomingTurn, type SemanticAnswer } from '@omadia/channel-sdk';

import { buildIncomingTurn, type SlackMessageEvent } from '../src/inbound.js';
import {
  handleSlackTurn,
  resolveAgentForTurn,
  slackSenderPrincipal,
  type RouteLookup,
  type SlackRouteContext,
  type TurnDeps,
} from '../src/turn.js';
import { BEN, MIRA, SpyOutbox, agentReturning, answer, manualClock, notice } from './helpers.js';

type ChatInput = Parameters<ChatAgent['chat']>[0];

const noLog = (): void => undefined;

function event(over: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return { type: 'message', channel: 'C1', user: 'U1', text: 'hallo', ts: '100.1', channel_type: 'channel', ...over };
}

function turnFor(over: Partial<SlackMessageEvent> = {}, source = {}): IncomingTurn {
  const ev = event(over);
  return buildIncomingTurn('slack-1', ev, ev.text ?? '', 'T1', source);
}

type RouteCtx = { principal?: string; locale?: string };

const ROUTE: SlackRouteContext = { principal: 'user:slack-user:u1' };

/** A resolver stub: `resolve` answers per key; none = a host without a channel resolver. */
function services(resolve?: (type: string, key: string, ctx?: RouteCtx) => unknown): RouteLookup {
  return (key, ctx) => (resolve ? (resolve('slack', key, ctx) as ReturnType<RouteLookup>) : undefined);
}

/** A resolver that binds every turn to `agent` and announces `speaker` up front. */
function boundTo(agent: ChatAgent, speaker: AgentSpeaker | null = MIRA as AgentSpeaker): RouteLookup {
  return services(() => ({ decision: 'bound', chatAgent: agent, ...(speaker ? { speaker } : {}) }));
}

function deps(over: Partial<TurnDeps> & { outbox: SpyOutbox }): TurnDeps {
  return { route: services(), defaultAgent: agentReturning(answer('default')), log: noLog, ...over };
}

test('the user text reaches the agent unchanged, /agent included, with origin and sessionScope', async () => {
  const outbox = new SpyOutbox();
  const seen: ChatInput[] = [];
  const agent = agentReturning(answer('Du sprichst jetzt mit Mira.', { kind: 'system' }, { systemNotice: notice('agent_selected', 'Du sprichst jetzt mit Mira.') }), seen);
  await handleSlackTurn(deps({ outbox, defaultAgent: agent }), turnFor({ text: '/agent Mira' }));
  assert.equal(seen[0]?.userMessage, '/agent Mira');
  assert.equal(seen[0]?.userId, 'U1');
  assert.equal(seen[0]?.origin?.channelType, 'slack');
  assert.equal(seen[0]?.origin?.conversationType, 'group');
  assert.equal(seen[0]?.origin?.channelConversationId, 'C1');
  assert.deepEqual(seen[0]?.origin?.principal, { kind: 'user', userId: 'slack-user:u1' });
  assert.equal(outbox.sink.calls[0]?.text, 'Du sprichst jetzt mit Mira.');
});

test('a DM is a direct conversation with a personal origin scope', async () => {
  const outbox = new SpyOutbox();
  const seen: ChatInput[] = [];
  await handleSlackTurn(
    deps({ outbox, defaultAgent: agentReturning(answer('ok'), seen) }),
    turnFor({ channel: 'D1', channel_type: 'im' }),
  );
  assert.equal(seen[0]?.origin?.conversationType, 'direct');
  assert.deepEqual(seen[0]?.origin?.scope, { kind: 'personal', userId: 'U1' });
  assert.equal(outbox.sink.calls[0]?.threadTs, undefined);
});

test('conversation bound to A; U selects B, V selects C: each keeps reaching their own agent, also after a restart (criterion 1)', async () => {
  const a = agentReturning(answer('von A', { ...MIRA, displayName: 'A' }));
  const b = agentReturning(answer('von B', BEN));
  const c = agentReturning(answer('von C', { ...BEN, displayName: 'C', agentId: 'a-c' }));
  // The kernel owns the selection; the plugin only tells it who is asking.
  const selection = new Map<string, ChatAgent>([['user:slack-user:u2', b], ['user:slack-user:u3', c]]);
  const resolve = (_t: string, _k: string, ctx?: RouteCtx) => ({
    decision: 'bound',
    chatAgent: (ctx?.principal && selection.get(ctx.principal)) || a,
  });
  const run = async (user: string) => {
    const outbox = new SpyOutbox();
    // A new deps object per call = a plugin restart: it keeps no selection.
    await handleSlackTurn(deps({ outbox, route: services(resolve) }), turnFor({ user, ts: `${user}.1` }));
    return outbox.sink.calls[0]?.text;
  };
  assert.equal(await run('U1'), 'von A');
  assert.equal(await run('U2'), 'von B');
  assert.equal(await run('U3'), 'von C');
  assert.equal(await run('U2'), 'von B');
});

test('a resolver rejection is a system notice, never another agent (INV-7)', async () => {
  const outbox = new SpyOutbox();
  const resolve = () => ({ decision: 'reject', notice: notice('agent_not_available', 'Mira ist hier nicht für dich verfügbar.') });
  await handleSlackTurn(deps({ outbox, route: services(resolve) }), turnFor());
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Mira ist hier nicht für dich verfügbar.']);
  assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
});

test('a rejection without a notice still says so, in a system message', async () => {
  const outbox = new SpyOutbox();
  await handleSlackTurn(deps({ outbox, route: services(() => ({ decision: 'reject' })) }), turnFor());
  assert.equal(outbox.answers.length, 1);
  assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
  assert.match(outbox.sink.calls[0]?.text ?? '', /kein Agent/);
});

test('/agent, /agent and /agents reach the ChatAgent of a rejection as plain text; its system answer is posted', async () => {
  for (const text of ['/agent Mira', '/agent', '/agents']) {
    const outbox = new SpyOutbox();
    const seen: ChatInput[] = [];
    const chatAgent = agentReturning(answer('Auswahl verarbeitet.', { kind: 'system' }, { systemNotice: notice('agent_selected', 'Auswahl verarbeitet.') }), seen);
    const resolve = () => ({ decision: 'reject', chatAgent, notice: notice('no_agent', 'Kein Agent.') });
    await handleSlackTurn(deps({ outbox, route: services(resolve) }), turnFor({ text }));
    assert.equal(seen[0]?.userMessage, text, `${text} is passed through unchanged`);
    assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Auswahl verarbeitet.']);
    assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
  }
});

test('a rejected turn is never answered as an agent: the resolver notice replaces it', async () => {
  const outbox = new SpyOutbox();
  const resolve = () => ({ decision: 'reject', chatAgent: agentReturning(answer('Ich bin Mira.')), notice: notice('agent_not_available', 'Mira ist hier nicht verfügbar.') });
  await handleSlackTurn(deps({ outbox, route: services(resolve) }), turnFor());
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Mira ist hier nicht verfügbar.']);
  assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
  assert.equal(outbox.answers[0]?.systemNotice?.code, 'agent_not_available');
});

test('a rejection is no pace case: no acknowledgement is announced for it', async () => {
  const { clock, advance } = manualClock();
  const outbox = new SpyOutbox();
  let release: () => void = () => undefined;
  const slow = { chat: () => new Promise((r) => { release = () => r(answer('Kein Agent.', { kind: 'system' })); }) } as unknown as ChatAgent;
  const done = handleSlackTurn(deps({ outbox, clock, route: services(() => ({ decision: 'reject', chatAgent: slow })) }), turnFor());
  await advance(60_000);
  release();
  await done;
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Kein Agent.']);
});

test('a bound key wins over a rejection and the workspace key is tried second', () => {
  const bound = agentReturning(answer('bound'));
  const seenKeys: string[] = [];
  const r = resolveAgentForTurn(
    services((_t, key) => {
      seenKeys.push(key);
      return key === 'C1' ? { decision: 'reject', chatAgent: agentReturning(answer('x')) } : { decision: 'bound', chatAgent: bound, speaker: MIRA };
    }),
    ['C1', 'T1'],
    agentReturning(answer('default')),
    ROUTE,
    'hallo',
  );
  assert.deepEqual(seenKeys, ['C1', 'T1']);
  assert.equal(r.kind === 'agent' && r.agent, bound);
  assert.equal(r.kind === 'agent' && r.speaker, MIRA);
});

test('the resolver is asked with the sender principal, and without a locale when Slack named none', () => {
  const asked: Array<{ type: string; key: string; ctx?: RouteCtx }> = [];
  resolveAgentForTurn(
    services((type, key, ctx) => {
      asked.push({ type, key, ...(ctx ? { ctx } : {}) });
      return { decision: 'bound', chatAgent: agentReturning(answer('x')) };
    }),
    ['C1'],
    agentReturning(answer('default')),
    ROUTE,
    'hallo',
  );
  assert.deepEqual(asked, [{ type: 'slack', key: 'C1', ctx: { principal: 'user:slack-user:u1' } }]);
});

test('the principal is the SDK form: user:<kind>:<id> lowercase, user:<email> when the channel verified one', () => {
  assert.equal(slackSenderPrincipal(turnFor({ user: 'U0ABC9' })), 'user:slack-user:u0abc9');
  const withMail = { userRef: { kind: 'slack-user', id: 'U1', email: ' Anna@Example.com ' } };
  assert.equal(slackSenderPrincipal(withMail), 'user:anna@example.com');
});

test('a throwing resolver is an error of the turn: system notice, the singleton agent is NOT asked', async () => {
  const outbox = new SpyOutbox();
  let asked = 0;
  const singleton = { chat: async () => { asked += 1; return answer('Singleton.'); } } as unknown as ChatAgent;
  await handleSlackTurn(deps({ outbox, defaultAgent: singleton, route: services(() => { throw new Error('down'); }) }), turnFor());
  assert.equal(asked, 0);
  assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
  assert.equal(outbox.answers[0]?.systemNotice?.code, 'agent_error');
});

test('the singleton answers only on a host without a channel resolver', async () => {
  const outbox = new SpyOutbox();
  await handleSlackTurn(deps({ outbox }), turnFor());
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['default']);
});

// S1: the agent selection lives at the narrowest conversation key (the channel), never the workspace.
test('/agent goes to the ChatAgent of the channel key although the binding lies on the workspace key', async () => {
  const seenChannel: ChatInput[] = [];
  const seenTeam: ChatInput[] = [];
  const channelAgent = agentReturning(answer('Du sprichst jetzt mit Ben.', { kind: 'system' }, { systemNotice: notice('agent_selected', 'Du sprichst jetzt mit Ben.') }), seenChannel);
  const teamAgent = agentReturning(answer('Ich bin Mira.', MIRA), seenTeam);
  const resolve = (_t: string, key: string) =>
    key === 'C1'
      ? { decision: 'reject', chatAgent: channelAgent, notice: notice('no_agent', 'Kein Agent.') }
      : { decision: 'bound', chatAgent: teamAgent, speaker: MIRA };
  for (const text of ['/agent Ben', '/agent', '/agents']) {
    const outbox = new SpyOutbox();
    await handleSlackTurn(deps({ outbox, route: services(resolve) }), turnFor({ text }));
    assert.equal(seenChannel.at(-1)?.userMessage, text, `${text} reaches the channel-key agent unchanged`);
    assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
  }
  assert.equal(seenTeam.length, 0, 'the workspace-bound agent never sees the command');

  // An ordinary message still reaches the workspace-bound agent, and a sentence that merely mentions /agent is ordinary text.
  const outbox = new SpyOutbox();
  await handleSlackTurn(deps({ outbox, route: services(resolve) }), turnFor({ text: 'Was macht /agent eigentlich?', ts: '9.9' }));
  assert.equal(seenTeam[0]?.userMessage, 'Was macht /agent eigentlich?');
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Ich bin Mira.']);
});

test('a binding on the channel key itself is used directly, the workspace key is never asked', async () => {
  const keys: string[] = [];
  const bound = agentReturning(answer('A'));
  const r = resolveAgentForTurn(
    services((_t, key) => (keys.push(key), { decision: 'bound', chatAgent: bound, speaker: MIRA })),
    ['C1', 'T1'],
    agentReturning(answer('default')),
    ROUTE,
    '/agent Mira',
  );
  assert.deepEqual(keys, ['C1']);
  assert.equal(r.kind === 'agent' && r.agent, bound);
});

test('every output of every emitter path carries a speaker (criterion 5)', async () => {
  const outbox = new SpyOutbox();
  const boom: ChatAgent = { chat: async () => { throw new Error('model down'); } } as unknown as ChatAgent;
  await handleSlackTurn(deps({ outbox }), turnFor({ ts: '1.1' })); // agent answer
  await handleSlackTurn(deps({ outbox, route: services(() => ({ decision: 'reject', notice: notice('no_agent', 'Kein Agent.') })) }), turnFor({ ts: '1.2' })); // kernel notice
  await handleSlackTurn(deps({ outbox, route: services(() => ({ decision: 'reject' })) }), turnFor({ ts: '1.3' })); // own refusal
  await handleSlackTurn(deps({ outbox, defaultAgent: boom }), turnFor({ ts: '1.4' })); // own failure notice
  await handleSlackTurn(deps({ outbox, route: boundTo(agentReturning({ text: 'Nichts.' } as SemanticAnswer)) }), turnFor({ ts: '1.5' })); // answer without speaker: withheld
  assert.equal(outbox.answers.length, 5);
  for (const a of outbox.answers) assert.ok(a.speaker, `answer "${a.text}" has no speaker`);
  assert.equal(outbox.answers[3]?.systemNotice?.code, 'agent_error');
  assert.equal(outbox.answers[4]?.systemNotice?.code, 'agent_error');
  assert.ok(!outbox.sink.calls.some((c) => c.text === 'Nichts.'), 'the speaker-less answer was not posted');
  assert.ok(!/[⚠️👀💡]/u.test(outbox.sink.calls[3]?.text ?? ''), 'the failure notice has no emoji decoration');
});

test('the NO_REPLY sentinel sends nothing', async () => {
  const outbox = new SpyOutbox();
  await handleSlackTurn(deps({ outbox, defaultAgent: agentReturning(answer('NO_REPLY')) }), turnFor());
  assert.equal(outbox.sink.calls.length, 0);
});

test('a slow turn acknowledges exactly once, then the answer follows (pace)', async () => {
  const { clock, advance } = manualClock();
  const outbox = new SpyOutbox();
  let release: () => void = () => undefined;
  const slow = {
    chat: () => new Promise((r) => { release = () => r(answer('Fertig.')); }),
  } as unknown as ChatAgent;
  const done = handleSlackTurn(deps({ outbox, route: boundTo(slow), clock }), turnFor());
  await advance(7_999);
  assert.equal(outbox.sink.calls.length, 0, 'no acknowledgement for a normal wait');
  await advance(2);
  await advance(120_000);
  release();
  await done;
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), [paceAckText('de'), 'Fertig.']);
  assert.deepEqual(outbox.answers.map((a) => a.speaker), [MIRA, MIRA], 'the acknowledgement speaks as the agent, not as system');
  assert.equal(outbox.answers[0]?.systemNotice, undefined);
});

test('the pace acknowledgement is said by the agent the resolver announced, in a thread like the answer', async () => {
  const { clock, advance } = manualClock();
  const outbox = new SpyOutbox();
  let release: () => void = () => undefined;
  const slow = { chat: () => new Promise((r) => { release = () => r(answer('Fertig.', BEN)); }) } as unknown as ChatAgent;
  const done = handleSlackTurn(deps({ outbox, route: boundTo(slow, BEN as AgentSpeaker), clock }), turnFor());
  await advance(8_001);
  release();
  await done;
  assert.equal(outbox.answers[0]?.speaker, BEN);
  assert.equal(outbox.sink.calls[0]?.threadTs, '100.1');
});

test('without a speaker from the resolver there is no acknowledgement (nobody to say it), the answer still follows', async () => {
  const { clock, advance } = manualClock();
  const outbox = new SpyOutbox();
  const logs: string[] = [];
  let release: () => void = () => undefined;
  const slow = { chat: () => new Promise((r) => { release = () => r(answer('Fertig.')); }) } as unknown as ChatAgent;
  const done = handleSlackTurn(deps({ outbox, route: boundTo(slow, null), clock, log: (_l, m) => logs.push(m) }), turnFor());
  await advance(8_001);
  release();
  await done;
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Fertig.']);
  assert.ok(logs.some((m) => /acknowledgement skipped/.test(m)));
});

test('a fast turn gets no acknowledgement', async () => {
  const { clock } = manualClock();
  const outbox = new SpyOutbox();
  await handleSlackTurn(deps({ outbox, clock }), turnFor());
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['default']);
});

const RESPONSE_URL = 'https://hooks.slack.com/commands/T1/1/x';
const commandSource = { command: { responseUrl: RESPONSE_URL } };
const commandEvent = { type: 'app_mention', text: '/agent Mira', ts: 'trig.1' } as const;

test('a slash command answers ephemerally through its response_url, in the channel-level session', async () => {
  const outbox = new SpyOutbox();
  const seen: ChatInput[] = [];
  const agent = agentReturning(answer('Du sprichst jetzt mit Mira.', { kind: 'system' }), seen);
  await handleSlackTurn(deps({ outbox, defaultAgent: agent }), turnFor(commandEvent, commandSource));
  assert.deepEqual(outbox.sink.calls, [{ kind: 'command', target: RESPONSE_URL, text: 'Du sprichst jetzt mit Mira.' }]);
  assert.equal(seen[0]?.sessionScope, 'slack:C1');
});

test('a command that outlives its response_url window is delivered as an ephemeral follow-up, not a public post', async () => {
  const { clock, advance } = manualClock();
  const outbox = new SpyOutbox();
  let release: () => void = () => undefined;
  const slow = { chat: () => new Promise((r) => { release = () => r(answer('Spät.', { kind: 'system' })); }) } as unknown as ChatAgent;
  const done = handleSlackTurn(deps({ outbox, route: boundTo(slow), clock }), turnFor(commandEvent, commandSource));
  await advance(8_001); // acknowledgement goes through the (still valid) response_url
  await advance(30 * 60 * 1000);
  release();
  await done;
  const kinds = outbox.sink.calls.map((c) => c.kind);
  assert.deepEqual(kinds, ['command', 'ephemeral']);
  assert.equal(outbox.sink.calls[1]?.target, 'C1/U1');
  assert.equal(outbox.sink.calls.filter((c) => c.text === paceAckText('de')).length, 1);
});

test('the resolver gets the sender language, and the pace acknowledgement speaks it', async () => {
  const asked: Array<RouteCtx | undefined> = [];
  const { clock, advance } = manualClock();
  const outbox = new SpyOutbox();
  let release: () => void = () => undefined;
  const slow = { chat: () => new Promise((r) => { release = () => r(answer('Done.')); }) } as unknown as ChatAgent;
  const route = services((_t, _k, ctx) => (asked.push(ctx), { decision: 'bound', chatAgent: slow, speaker: MIRA }));
  const turn = buildIncomingTurn('slack-1', event(), 'hello', 'T1', {}, { locale: 'en' });
  const done = handleSlackTurn(deps({ outbox, route, clock }), turn);
  await advance(8_001);
  release();
  await done;
  assert.deepEqual(asked, [{ principal: 'user:slack-user:u1', locale: 'en' }]);
  assert.equal(outbox.sink.calls[0]?.text, paceAckText('en'));
});

test('a verified e-mail makes the routing principal user:<e-mail> and reaches the origin', async () => {
  const outbox = new SpyOutbox();
  const seen: ChatInput[] = [];
  const asked: Array<RouteCtx | undefined> = [];
  const route = services((_t, _k, ctx) => (asked.push(ctx), { decision: 'bound', chatAgent: agentReturning(answer('ok'), seen), speaker: MIRA }));
  await handleSlackTurn(deps({ outbox, route }), buildIncomingTurn('slack-1', event(), 'hi', 'T1', {}, { email: 'anna@example.com' }));
  assert.equal(asked[0]?.principal, 'user:anna@example.com');
  assert.deepEqual(seen[0]?.origin?.principal, { kind: 'user', userId: 'anna@example.com' });
});

test('a DM reply in a thread names the message it answers (replyToMessageId, channel-sdk 0.3.11); a channel thread and a top-level DM do not', async () => {
  const originOf = async (over: Partial<SlackMessageEvent>) => {
    const seen: ChatInput[] = [];
    await handleSlackTurn(deps({ outbox: new SpyOutbox(), defaultAgent: agentReturning(answer('ok'), seen) }), turnFor(over));
    return seen[0]?.origin as (Record<string, unknown> & { messageId?: string }) | undefined;
  };
  // The reminder DM this plugin sent was reported with messageId = its ts '90.5'.
  const reply = await originOf({ channel: 'D1', channel_type: 'im', ts: '100.1', thread_ts: '90.5' });
  assert.equal(reply?.['replyToMessageId'], '90.5');
  assert.equal(reply?.messageId, '100.1');
  const topLevel = await originOf({ channel: 'D1', channel_type: 'im', ts: '100.1' });
  assert.equal(topLevel?.['replyToMessageId'], undefined);
  const root = await originOf({ channel: 'D1', channel_type: 'im', ts: '100.1', thread_ts: '100.1' });
  assert.equal(root?.['replyToMessageId'], undefined);
  const group = await originOf({ channel: 'C1', channel_type: 'channel', ts: '100.1', thread_ts: '90.5' });
  assert.equal(group?.['replyToMessageId'], undefined, 'private turns only');
});
