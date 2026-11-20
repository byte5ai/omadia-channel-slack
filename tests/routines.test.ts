// Triggers and routines on Slack (spec 2042 §5.12, §5.3): every turn opens the
// kernel's routines scope with a delivery ref naming the app, and a delivery
// goes out through exactly that app.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatAgent, SemanticAnswer } from '@omadia/channel-sdk';

import { buildIncomingTurn, type SlackMessageEvent } from '../src/inbound.js';
import { SlackOutbox } from '../src/outbox.js';
import { createSlackProactiveSend, createSlackRoutineTurn, parseDeliveryRef } from '../src/routines.js';
import { handleSlackTurn } from '../src/turn.js';
import { BEN, MIRA, RecordingSink, SpyOutbox } from './helpers.js';

const CHANNEL_ID = '@omadia/channel-slack';
const MIRA_KEY = 'slack-bot:umira0001';

function apps() {
  const shared = new RecordingSink();
  const mira = new RecordingSink();
  const users = { userIdByEmail: async () => undefined };
  const bots = {
    shared: { outbox: new SlackOutbox(shared), users },
    mira: { outbox: new SlackOutbox(mira, undefined, true), users },
  };
  const send = createSlackProactiveSend((key) => (key === undefined ? bots.shared : key === MIRA_KEY ? bots.mira : undefined));
  return { shared, mira, send };
}

test("a turn files its conversation, thread and, on an agent's own app, that app", () => {
  const seen: unknown[] = [];
  const routines = { beginRoutineTurn: (info: unknown) => (seen.push(info), <T,>(fn: () => Promise<T>) => fn()) };
  createSlackRoutineTurn(routines as never, CHANNEL_ID, () => MIRA_KEY)({ userId: 'U1', conversationId: 'C0AAAAAAA', conversationKey: 'slack:C0AAAAAAA', threadTs: '100.1' });
  createSlackRoutineTurn(routines as never, CHANNEL_ID, () => undefined)({ userId: 'U1', conversationId: 'D0AAAAAAA', conversationKey: 'slack:D0AAAAAAA' });
  assert.deepEqual(seen, [
    {
      userId: 'U1',
      channel: 'slack',
      conductorBinding: false,
      conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: 'C0AAAAAAA', conversationKey: 'slack:C0AAAAAAA', threadTs: '100.1', asChannelKey: MIRA_KEY },
    },
    { userId: 'U1', channel: 'slack', conductorBinding: false, conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: 'D0AAAAAAA', conversationKey: 'slack:D0AAAAAAA' } },
  ]);
});

test('the turn runs inside the scope, with the user id the agent sees', async () => {
  const events: unknown[] = [];
  let inside = false;
  const agent = {
    chat: async (input: { userId?: string }) => (events.push({ inside, userId: input.userId }), { text: 'ok', speaker: MIRA }),
  } as unknown as ChatAgent;
  const ev: SlackMessageEvent = { type: 'message', channel: 'C1', user: 'U1', text: 'erinnere mich', ts: '100.1', channel_type: 'channel' };
  await handleSlackTurn(
    {
      route: () => undefined,
      defaultAgent: agent,
      outbox: new SpyOutbox(),
      log: () => undefined,
      routineTurn: (info) => {
        events.push({ conversationId: info.conversationId, userId: info.userId });
        return async (fn) => {
          inside = true;
          try {
            return await fn();
          } finally {
            inside = false;
          }
        };
      },
    },
    buildIncomingTurn('slack-1', ev, 'erinnere mich', 'T1', {}),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { inside: true, userId: (events[0] as { userId: string }).userId });
});

test("a delivery goes out through the agent's own app, into the thread, without a name line", async () => {
  const a = apps();
  const ref = { kind: 'channel', conversationId: 'C0AAAAAAA', conversationKey: 'slack:C0AAAAAAA', threadTs: '100.1', asChannelKey: MIRA_KEY };
  await a.send(ref, { text: 'Dein Bericht ist fertig.', speaker: MIRA });
  await a.send(ref, { text: 'Noch etwas.', speaker: BEN });
  assert.deepEqual(a.mira.calls, [
    { kind: 'post', target: 'C0AAAAAAA', text: 'Dein Bericht ist fertig.', threadTs: '100.1' },
    { kind: 'post', target: 'C0AAAAAAA', text: 'Noch etwas.', threadTs: '100.1' },
  ]);
  assert.equal(a.shared.calls.length, 0);
});

test("through the installation's app it is named like an answer when the speaker changes", async () => {
  const a = apps();
  const ref = { kind: 'channel', conversationId: 'C0AAAAAAA', conversationKey: 'slack:C0AAAAAAA' };
  await a.send(ref, { text: 'Eins.', speaker: MIRA });
  await a.send(ref, { text: 'Zwei.', speaker: BEN });
  assert.equal(a.mira.calls.length, 0);
  assert.match(a.shared.calls[1]?.text ?? '', /Ben/);
});

test('an app that does not run here is an error; "nothing to report" is dropped', async () => {
  const a = apps();
  await assert.rejects(
    a.send({ kind: 'channel', conversationId: 'C0AAAAAAA', asChannelKey: 'slack-bot:uother001' }, { text: 'x', speaker: MIRA }),
    /no Slack app/,
  );
  await a.send({ kind: 'channel', conversationId: 'C0AAAAAAA', asChannelKey: MIRA_KEY }, { text: 'NO_REPLY', speaker: MIRA } as SemanticAnswer);
  assert.equal(a.shared.calls.length + a.mira.calls.length, 0);
});

test('reads only Slack conversations from a ref', () => {
  assert.deepEqual(parseDeliveryRef({ conversationId: 'C0AAAAAAA', asChannelKey: ' Slack-Bot:U1 ' }), {
    conversationId: 'C0AAAAAAA',
    conversationKey: 'slack:C0AAAAAAA',
    asChannelKey: 'slack-bot:u1',
  });
  assert.equal(parseDeliveryRef({ conversationId: '-100777' }), undefined);
  assert.equal(parseDeliveryRef('C0AAAAAAA'), undefined);
});
