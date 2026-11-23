import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatAgent, ConversationRoster, ConversationRosterProvider, IncomingTurn } from '@omadia/channel-sdk';

import { buildIncomingTurn, type SlackMessageEvent } from '../src/inbound.js';
import { handleSlackTurn, type TurnDeps } from '../src/turn.js';
import {
  createTurnParticipants,
  type ChatParticipantsProviderLike,
  type TurnContextLike,
} from '../src/turnParticipants.js';
import { SpyOutbox, agentReturning, answer } from './helpers.js';

const noLog = (): void => undefined;

function turnFor(over: Partial<SlackMessageEvent> = {}): IncomingTurn {
  const ev: SlackMessageEvent = { type: 'message', channel: 'C1', user: 'U1', text: 'hallo', ts: '100.1', channel_type: 'channel', ...over };
  return buildIncomingTurn('slack-1', ev, ev.text ?? '', 'T1', {});
}

function rosterOf(roster: ConversationRoster | undefined, seen: string[] = []): ConversationRosterProvider {
  return {
    channelType: 'slack',
    getRoster: async (conversationId: string) => {
      seen.push(conversationId);
      return roster;
    },
  };
}

const COMPLETE: ConversationRoster = {
  conversationType: 'group',
  participants: [
    { userRef: { kind: 'slack-user', id: 'U1' } },
    { userRef: { kind: 'slack-user', id: 'U2' } },
    { userRef: { kind: 'slack-user', id: 'UBOT' }, isBot: true },
  ],
  partial: false,
  status: 'complete',
  readAt: '2026-11-23T12:00:00.000Z',
};

/** A turn context that records the provider it was handed and runs the turn inside it. */
function recordingContext(): TurnContextLike & { installed: ChatParticipantsProviderLike[] } {
  const installed: ChatParticipantsProviderLike[] = [];
  return {
    installed,
    runWithChatParticipants: async (provider, fn) => {
      installed.push(provider);
      return fn();
    },
  };
}

test('a complete roster lists the people of the conversation, bots left out, and says it is complete', async () => {
  const ctx = recordingContext();
  const seen: string[] = [];
  const withParticipants = createTurnParticipants(rosterOf(COMPLETE, seen), ctx);
  await withParticipants('C1', async () => undefined);
  const provider = ctx.installed[0];
  assert.ok(provider, 'a provider is installed for the turn');
  assert.equal(provider.completeRoster, true);
  const people = await provider();
  assert.deepEqual(
    people.map((p) => p.channelUserId),
    ['U1', 'U2'],
  );
  assert.equal(people[0]?.aadObjectId, null);
  assert.equal(people[0]?.email, null);
  assert.deepEqual(seen, ['C1']);
});

test('a partial or unknown roster is no audience: the provider fails instead of naming a subset', async () => {
  for (const roster of [
    { ...COMPLETE, partial: true, status: 'partial' as const },
    { ...COMPLETE, participants: [], status: 'unknown' as const },
    undefined,
  ]) {
    const ctx = recordingContext();
    await createTurnParticipants(rosterOf(roster), ctx)('C1', async () => undefined);
    await assert.rejects(ctx.installed[0]!(), /roster/);
  }
});

test('a channel turn runs inside the participants scope; a DM does not', async () => {
  const ctx = recordingContext();
  const chats: string[] = [];
  const agent: ChatAgent = agentReturning(answer('ok'));
  const wrapped: ChatAgent = {
    ...agent,
    chat: async (input) => {
      chats.push(ctx.installed.length > 0 ? 'inside' : 'outside');
      return agent.chat(input);
    },
  } as ChatAgent;
  const deps = (outbox: SpyOutbox): TurnDeps => ({
    route: () => undefined,
    defaultAgent: wrapped,
    log: noLog,
    outbox: outbox as unknown as TurnDeps['outbox'],
    withParticipants: createTurnParticipants(rosterOf(COMPLETE), ctx),
  });

  await handleSlackTurn(deps(new SpyOutbox()), turnFor());
  assert.deepEqual(chats, ['inside']);

  ctx.installed.length = 0;
  await handleSlackTurn(deps(new SpyOutbox()), turnFor({ channel: 'D1', channel_type: 'im' }));
  assert.deepEqual(chats, ['inside', 'outside']);
});

test('without a turn context the turn runs as before', async () => {
  const chats: number[] = [];
  const agent = agentReturning(answer('ok'));
  const deps: TurnDeps = {
    route: () => undefined,
    defaultAgent: { ...agent, chat: async (i) => { chats.push(1); return agent.chat(i); } } as ChatAgent,
    log: noLog,
    outbox: new SpyOutbox() as unknown as TurnDeps['outbox'],
  };
  await handleSlackTurn(deps, turnFor());
  assert.equal(chats.length, 1);
});
