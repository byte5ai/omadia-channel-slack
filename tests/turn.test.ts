import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paceAckText, type ChatAgent, type IncomingTurn } from '@omadia/channel-sdk';

import { buildIncomingTurn, type SlackMessageEvent } from '../src/inbound.js';
import { handleSlackTurn, resolveAgentForTurn, type ServiceLookup, type TurnDeps } from '../src/turn.js';
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

function services(resolve?: (type: string, key: string, ctx?: { principal?: string }) => unknown): ServiceLookup {
  return { get: <T>(name: string) => (name === 'channelResolver' && resolve ? ({ resolve } as unknown as T) : undefined) };
}

function deps(over: Partial<TurnDeps> & { outbox: SpyOutbox }): TurnDeps {
  return { services: services(), defaultAgent: agentReturning(answer('default')), log: noLog, ...over };
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
  assert.equal(seen[0]?.origin?.principal?.kind, 'user');
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
  const selection = new Map<string, ChatAgent>([['user:u2', b], ['user:u3', c]]);
  const resolve = (_t: string, _k: string, ctx?: { principal?: string }) => ({
    decision: 'bound',
    chatAgent: (ctx?.principal && selection.get(ctx.principal)) || a,
  });
  const run = async (user: string) => {
    const outbox = new SpyOutbox();
    // A new deps object per call = a plugin restart: it keeps no selection.
    await handleSlackTurn(deps({ outbox, services: services(resolve) }), turnFor({ user, ts: `${user}.1` }));
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
  await handleSlackTurn(deps({ outbox, services: services(resolve) }), turnFor());
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Mira ist hier nicht für dich verfügbar.']);
  assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
});

test('a rejection without a notice still says so, in a system message', async () => {
  const outbox = new SpyOutbox();
  await handleSlackTurn(deps({ outbox, services: services(() => ({ decision: 'reject' })) }), turnFor());
  assert.equal(outbox.answers.length, 1);
  assert.equal(outbox.answers[0]?.speaker?.kind, 'system');
  assert.match(outbox.sink.calls[0]?.text ?? '', /kein Agent/);
});

test('an explicit binding wins over a fallback and the workspace key is tried second', () => {
  const bound = agentReturning(answer('bound'));
  const fb = agentReturning(answer('fb'));
  const seenKeys: string[] = [];
  const r = resolveAgentForTurn(
    services((_t, key) => {
      seenKeys.push(key);
      return key === 'C1' ? { decision: 'fallback', chatAgent: fb } : { decision: 'bound', chatAgent: bound };
    }),
    ['C1', 'T1'],
    agentReturning(answer('default')),
    undefined,
  );
  assert.deepEqual(seenKeys, ['C1', 'T1']);
  assert.equal(r.kind === 'agent' && r.agent, bound);
});

test('a throwing resolver falls back to the default agent, so a hiccup never drops a turn', async () => {
  const outbox = new SpyOutbox();
  await handleSlackTurn(
    deps({ outbox, services: services(() => { throw new Error('down'); }) }),
    turnFor(),
  );
  assert.equal(outbox.sink.calls[0]?.text, 'default');
});

test('every output of every emitter path carries a speaker or is the one pace acknowledgement (criterion 5)', async () => {
  const outbox = new SpyOutbox();
  const boom: ChatAgent = { chat: async () => { throw new Error('model down'); } } as unknown as ChatAgent;
  await handleSlackTurn(deps({ outbox }), turnFor({ ts: '1.1' })); // agent answer
  await handleSlackTurn(deps({ outbox, services: services(() => ({ decision: 'reject', notice: notice('no_agent', 'Kein Agent.') })) }), turnFor({ ts: '1.2' })); // kernel notice
  await handleSlackTurn(deps({ outbox, services: services(() => ({ decision: 'reject' })) }), turnFor({ ts: '1.3' })); // own refusal
  await handleSlackTurn(deps({ outbox, defaultAgent: boom }), turnFor({ ts: '1.4' })); // own failure notice
  assert.equal(outbox.answers.length, 4);
  for (const a of outbox.answers) assert.ok(a.speaker, `answer "${a.text}" has no speaker`);
  assert.equal(outbox.answers[3]?.systemNotice?.code, 'agent_error');
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
  const done = handleSlackTurn(deps({ outbox, defaultAgent: slow, clock }), turnFor());
  await advance(7_999);
  assert.equal(outbox.sink.calls.length, 0, 'no acknowledgement for a normal wait');
  await advance(2);
  await advance(120_000);
  release();
  await done;
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), [paceAckText('de'), 'Fertig.']);
  assert.equal(outbox.answers.filter((a) => !a.speaker).length, 1, 'the acknowledgement is the only speaker-less message');
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
  const done = handleSlackTurn(deps({ outbox, defaultAgent: slow, clock }), turnFor(commandEvent, commandSource));
  await advance(8_001); // acknowledgement goes through the (still valid) response_url
  await advance(30 * 60 * 1000);
  release();
  await done;
  const kinds = outbox.sink.calls.map((c) => c.kind);
  assert.deepEqual(kinds, ['command', 'ephemeral']);
  assert.equal(outbox.sink.calls[1]?.target, 'C1/U1');
  assert.equal(outbox.sink.calls.filter((c) => c.text === paceAckText('de')).length, 1);
});
