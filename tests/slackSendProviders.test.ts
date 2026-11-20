import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCardReply, renderCardAsText, type ChatAgent, type QuestionCard } from '@omadia/channel-sdk';

import { SlackOutbox } from '../src/outbox.js';
import {
  SLACK_CONVERSATION_CAPABILITIES,
  SLACK_SEND_CAPABILITIES,
  createSlackSendProviders,
  proactiveText,
  type SlackReactor,
} from '../src/slackSendProviders.js';
import { buildIncomingTurn } from '../src/inbound.js';
import { handleSlackTurn } from '../src/turn.js';
import { MIRA, RecordingSink, SpyOutbox, agentReturning, answer } from './helpers.js';

const BALLOT: QuestionCard = {
  id: 'poll-1',
  title: 'Wann passt der Termin?',
  questions: [
    {
      id: 'when',
      kind: 'single_choice',
      label: 'Wähle einen Slot',
      options: [
        { id: 'mon', label: 'Montag 10 Uhr' },
        { id: 'tue', label: 'Dienstag 14 Uhr' },
      ],
    },
  ],
} as unknown as QuestionCard;

const OWN_KEY = 'slack-bot:ubot';
const AGENT_KEY = 'slack-bot:uagent';

type ReactionCall = { channel: string; timestamp: string; name: string };

/** Records `reactions.add` calls; `fail` makes it throw a Web API error the way @slack/web-api does. */
class RecordingReactor implements SlackReactor {
  readonly calls: ReactionCall[] = [];
  constructor(private readonly fail?: string) {}
  async addReaction(channel: string, timestamp: string, name: string): Promise<void> {
    this.calls.push({ channel, timestamp, name });
    if (this.fail) throw Object.assign(new Error(`An API error occurred: ${this.fail}`), { data: { ok: false, error: this.fail } });
  }
}

function setup(users: { userIdByEmail(email: string): Promise<string | undefined> } = { userIdByEmail: async () => undefined }) {
  const sink = new RecordingSink();
  const outbox = new SlackOutbox(sink);
  // One app: no key and its own key name it, nothing else does.
  const bot = { outbox, users, reactions: new RecordingReactor() };
  const providers = createSlackSendProviders((key) => (key === undefined || key === OWN_KEY ? bot : undefined));
  return { sink, providers, reactor: bot.reactions };
}

test('the providers declare mentions and the named identity: no poll, no card; the conversation provider reacts', () => {
  const { providers } = setup();
  assert.deepEqual(providers.targeted.supports, { mentions: true, asChannelKey: true });
  assert.equal(providers.targeted.supports, SLACK_SEND_CAPABILITIES);
  assert.deepEqual(providers.conversation.supports, { mentions: true, asChannelKey: true, reactions: true });
  assert.equal(providers.conversation.supports, SLACK_CONVERSATION_CAPABILITIES);
  assert.equal(typeof providers.conversation.react, 'function');
  assert.equal(providers.targeted.channelType, 'slack');
  assert.equal(providers.conversation.channelType, 'slack');
});

test('a conversation post goes into the channel as plain system text through the outbox', async () => {
  const { sink, providers } = setup();
  const out = await providers.conversation.sendToConversation('C9', { text: 'Erinnerung: Review heute.' });
  assert.deepEqual(out, { outcome: 'delivered', messageId: '1.000100' }, 'the Slack ts, what a reply points at');
  assert.deepEqual(sink.calls, [{ kind: 'post', target: 'C9', text: 'Erinnerung: Review heute.' }]);
});

test('a mention of a Slack member becomes a Slack mention, a foreign user stays text', () => {
  const text = proactiveText({
    text: 'Hallo @Anna und @Ben',
    mentions: [
      { user: { kind: 'slack-user', id: 'U1' }, text: '@Anna' },
      { user: { kind: 'teams-aad', id: 'x' }, text: '@Ben' },
    ],
  });
  assert.equal(text, 'Hallo <@U1> und @Ben');
});

test('attachments ride along as plain links', async () => {
  const { sink, providers } = setup();
  await providers.conversation.sendToConversation('C9', {
    text: 'Bericht',
    attachments: [{ url: 'https://example.com/r.pdf', altText: 'Report' }] as never,
  });
  assert.equal(sink.calls[0]?.text, 'Bericht\n\n<https://example.com/r.pdf|Report>');
});

test('a send as its own key goes out; one for an app that does not run here is refused, never posted under another', async () => {
  const own = setup();
  const delivered = await own.providers.conversation.sendToConversation('C9', { text: 'x' }, { asChannelKey: 'SLACK-BOT:UBOT' });
  assert.equal(delivered.outcome, 'delivered');
  const { sink, providers } = setup();
  const conv = await providers.conversation.sendToConversation('C9', { text: 'x' }, { asChannelKey: 'slack:T1:B1' });
  const dm = await providers.targeted.sendToUser({ principalId: 'user:slack-user:u1' }, { text: 'x' }, { asChannelKey: 'slack:T1:B1' });
  assert.equal(conv.outcome, 'unreachable');
  assert.equal(dm.outcome, 'unreachable');
  assert.equal(sink.calls.length, 0);
});

test('a poll or a question card is refused with channel_error and nothing is posted (sender falls back to a plain-text ballot)', async () => {
  const { sink, providers } = setup();
  const poll = { pollId: 'p', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  const a = await providers.conversation.sendToConversation('C9', { text: 'Q?', poll });
  const b = await providers.conversation.sendToConversation('C9', { text: 'Q?', card: BALLOT });
  for (const out of [a, b]) {
    assert.equal(out.outcome, 'unreachable');
    assert.equal(out.outcome === 'unreachable' && out.code, 'channel_error');
  }
  assert.equal(sink.calls.length, 0);
});

test('a DM goes to the member named by the user ref, by `user:slack-user:<id>`, or by e-mail', async () => {
  const lookups: string[] = [];
  const { sink, providers } = setup({ userIdByEmail: async (email) => (lookups.push(email), email === 'anna@example.com' ? 'U7' : undefined) });
  await providers.targeted.sendToUser({ principalId: 'user:whatever', userRef: { kind: 'slack-user', id: 'U1' } }, { text: 'eins' });
  await providers.targeted.sendToUser({ principalId: 'user:slack-user:u2' }, { text: 'zwei' });
  await providers.targeted.sendToUser({ principalId: 'user:anna@example.com' }, { text: 'drei' });
  assert.deepEqual(sink.calls.map((c) => c.target), ['U1', 'U2', 'U7']);
  assert.deepEqual(lookups, ['anna@example.com']);
});

test('unreachable people are returned, not thrown', async () => {
  const { sink, providers } = setup({
    userIdByEmail: async (email) => {
      if (email === 'scope@example.com') throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
      return undefined;
    },
  });
  const codes = async (principalId: string, userRef?: { kind: string; id: string }): Promise<string | undefined> => {
    const out = await providers.targeted.sendToUser({ principalId, ...(userRef ? { userRef: userRef as never } : {}) }, { text: 'x' });
    return out.outcome === 'unreachable' ? out.code : out.outcome;
  };
  assert.equal(await codes('user:nobody@example.com'), 'user_not_found');
  assert.equal(await codes('user:scope@example.com'), 'not_permitted');
  assert.equal(await codes('user:teams-aad:abc'), 'no_binding');
  assert.equal(await codes('user:x', { kind: 'teams-aad', id: 'abc' }), 'no_binding');
  assert.equal(sink.calls.length, 0);
});

test('a Slack API failure while posting is returned as unreachable', async () => {
  const failing = {
    sendText: async () => { throw Object.assign(new Error('not_in_channel'), { data: { error: 'not_in_channel' } }); },
    replyToCommand: async () => undefined,
    sendEphemeral: async () => undefined,
  };
  const bot = { outbox: new SlackOutbox(failing), users: { userIdByEmail: async () => undefined } };
  const providers = createSlackSendProviders(() => bot);
  const out = await providers.conversation.sendToConversation('C9', { text: 'x' });
  assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
});

// Criterion 30: a poll / a facilitation contribution works through plain text.
test('criterion 30: a ballot posted as text is answered by a typed reply that parses to the same value a card would carry', async () => {
  const { sink, providers } = setup();
  const question = BALLOT.questions[0]!;
  const ballotText = renderCardAsText(BALLOT);
  const out = await providers.conversation.sendToConversation('C1', { text: ballotText });
  assert.equal(out.outcome, 'delivered');
  assert.match(sink.calls[0]?.text ?? '', /1\) Montag 10 Uhr\n2\) Dienstag 14 Uhr/);

  // The person types "2" in the channel: an ordinary inbound turn whose text reaches the agent unchanged.
  const outbox = new SpyOutbox();
  const seen: Array<Parameters<ChatAgent['chat']>[0]> = [];
  const ev = { type: 'message', channel: 'C1', user: 'U1', text: '2', ts: '200.1', channel_type: 'channel' } as const;
  await handleSlackTurn(
    { route: () => undefined, defaultAgent: agentReturning(answer('Danke.', MIRA), seen), outbox, log: () => undefined },
    buildIncomingTurn('slack-1', ev, '2', 'T1'),
  );
  assert.equal(seen[0]?.userMessage, '2');
  assert.deepEqual(parseCardReply(question, seen[0]?.userMessage ?? ''), {
    ok: true,
    value: { questionId: 'when', kind: 'single_choice', optionId: 'tue' },
  });
  // A reply that does not fit is not guessed.
  assert.equal(parseCardReply(question, 'vielleicht').ok, false);
});

test('criterion 30: a contribution typed in plain text reaches the agent as it was written', async () => {
  const outbox = new SpyOutbox();
  const seen: Array<Parameters<ChatAgent['chat']>[0]> = [];
  const ev = { type: 'message', channel: 'C1', user: 'U1', text: 'Mein Beitrag: der Release sollte Freitag sein', ts: '201.1', channel_type: 'channel' } as const;
  await handleSlackTurn(
    { route: () => undefined, defaultAgent: agentReturning(answer('Notiert.', MIRA), seen), outbox, log: () => undefined },
    buildIncomingTurn('slack-1', ev, ev.text, 'T1'),
  );
  assert.equal(seen[0]?.userMessage, 'Mein Beitrag: der Release sollte Freitag sein');
  assert.deepEqual(outbox.sink.calls.map((c) => c.text), ['Notiert.']);
});

// Spec 2043 §5.14: the facilitator acknowledges a contribution with a thumbs-up instead of an echo.
test('react: a thumbs-up (`+1`) on the message ts of the channel, as the named app, nothing posted', async () => {
  const { sink, providers, reactor } = setup();
  const out = await providers.conversation.react?.('C9', '1701.000200', 'acknowledge', { asChannelKey: 'SLACK-BOT:UBOT' });
  assert.deepEqual(out, { outcome: 'reacted' });
  assert.deepEqual(reactor.calls, [{ channel: 'C9', timestamp: '1701.000200', name: '+1' }]);
  assert.equal(sink.calls.length, 0);
});

test('react: each app reacts as itself; an unknown or missing key is refused, never set through another app', async () => {
  const own = new RecordingReactor();
  const agent = new RecordingReactor();
  const users = { userIdByEmail: async () => undefined };
  const bots = new Map([
    [OWN_KEY, { outbox: new SlackOutbox(new RecordingSink()), users, reactions: own }],
    [AGENT_KEY, { outbox: new SlackOutbox(new RecordingSink(), undefined, true), users, reactions: agent }],
  ]);
  const providers = createSlackSendProviders((key) => (key === undefined ? bots.get(OWN_KEY) : bots.get(key)));
  const react = providers.conversation.react!;
  assert.deepEqual(await react('C1', '1.1', 'acknowledge', { asChannelKey: AGENT_KEY }), { outcome: 'reacted' });
  assert.equal(agent.calls.length, 1);
  assert.equal(own.calls.length, 0);

  const unknown = await react('C1', '1.1', 'acknowledge', { asChannelKey: 'slack-bot:unobody' });
  const missing = await react('C1', '1.1', 'acknowledge', undefined as never);
  const blank = await react('C1', '1.1', 'acknowledge', { asChannelKey: '  ' });
  for (const out of [unknown, missing, blank]) {
    assert.equal(out.outcome, 'unreachable');
    assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
  }
  assert.equal(own.calls.length, 0, 'never through the shared app');
  assert.equal(agent.calls.length, 1);
});

test('react: already_reacted is the goal reached', async () => {
  const reactions = new RecordingReactor('already_reacted');
  const providers = createSlackSendProviders(() => ({ outbox: new SlackOutbox(new RecordingSink()), users: { userIdByEmail: async () => undefined }, reactions }));
  assert.deepEqual(await providers.conversation.react?.('C1', '1.1', 'acknowledge', { asChannelKey: OWN_KEY }), { outcome: 'reacted' });
});

test('react: Slack errors are returned with Slack\'s message, never thrown', async () => {
  const codeFor = async (error: string): Promise<{ code: string; message: string } | undefined> => {
    const reactions = new RecordingReactor(error);
    const providers = createSlackSendProviders(() => ({ outbox: new SlackOutbox(new RecordingSink()), users: { userIdByEmail: async () => undefined }, reactions }));
    const out = await providers.conversation.react!('C1', '1.1', 'acknowledge', { asChannelKey: OWN_KEY });
    return out.outcome === 'unreachable' ? { code: out.code, message: out.message } : undefined;
  };
  assert.deepEqual(await codeFor('message_not_found'), { code: 'channel_error', message: 'An API error occurred: message_not_found' });
  assert.equal((await codeFor('ratelimited'))?.code, 'channel_error');
  assert.equal((await codeFor('too_many_reactions'))?.code, 'channel_error');
  for (const refused of ['missing_scope', 'channel_not_found', 'is_archived', 'no_permission', 'thread_locked', 'not_reactable']) {
    assert.equal((await codeFor(refused))?.code, 'not_permitted', refused);
  }
  // A non-API error (network) is a channel error too.
  const providers = createSlackSendProviders(() => ({
    outbox: new SlackOutbox(new RecordingSink()),
    users: { userIdByEmail: async () => undefined },
    reactions: { addReaction: async () => { throw new Error('socket hang up'); } },
  }));
  assert.deepEqual(await providers.conversation.react!('C1', '1.1', 'acknowledge', { asChannelKey: OWN_KEY }), {
    outcome: 'unreachable', code: 'channel_error', message: 'socket hang up',
  });
});

test('react: an unknown reaction or a missing message address is refused without calling Slack', async () => {
  const { providers, reactor } = setup();
  const react = providers.conversation.react!;
  const outs = [
    await react('C1', '1.1', 'party' as never, { asChannelKey: OWN_KEY }),
    await react('C1', '1.1', 'toString' as never, { asChannelKey: OWN_KEY }),
    await react('', '1.1', 'acknowledge', { asChannelKey: OWN_KEY }),
    await react('C1', ' ', 'acknowledge', { asChannelKey: OWN_KEY }),
  ];
  for (const out of outs) assert.equal(out.outcome === 'unreachable' && out.code, 'channel_error');
  assert.equal(reactor.calls.length, 0);
});

test('react addresses the message the inbound event reported: channel id + ts', async () => {
  const { providers, reactor } = setup();
  const ev = { type: 'message', channel: 'C42', user: 'U1', text: 'Mein Beitrag', ts: '1701.000300', channel_type: 'channel' } as const;
  const turn = buildIncomingTurn('slack-1', ev, ev.text, 'T1');
  await providers.conversation.react!(turn.conversationId, ev.ts, 'acknowledge', { asChannelKey: OWN_KEY });
  assert.deepEqual(reactor.calls, [{ channel: 'C42', timestamp: '1701.000300', name: '+1' }]);
});
