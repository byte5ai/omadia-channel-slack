// Native facilitators in Slack (issue #6, spec 2043 §5.3, §5.5, §6.4): the
// plugin's side of a moderated conversation on a simulated transport. Every
// human message, edit, deletion and reaction reaches the kernel's record under
// the receiving app's key; members joining and leaving reach it as membership
// events; the mention gate keeps deciding on turns.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationMembershipEvent, ConversationMessageEvent, IncomingTurn } from '@omadia/channel-sdk';

import { routeSlackEvent } from '../src/eventRouter.js';
import { SlackChannel, type AccessPolicy, type SlackChannelDeps } from '../src/slackChannel.js';
import { createChannelState } from '../src/state.js';

type Delivery = 'all' | 'addressed' | 'none';

type UsersInfo = (args: { user: string }) => Promise<unknown>;

const humanInfo: UsersInfo = async ({ user }) => ({ user: { profile: { email: `${user.toLowerCase()}@example.com` } } });

function rig(
  opts: {
    policy?: Partial<AccessPolicy>;
    delivery?: (conversationId: string) => Delivery;
    botId?: string;
    usersInfo?: UsersInfo;
    now?: () => number;
  } = {},
) {
  const messages: ConversationMessageEvent[] = [];
  const membership: ConversationMembershipEvent[] = [];
  const turns: IncomingTurn[] = [];
  const forgotten: string[] = [];
  const asked: string[] = [];
  const deps: SlackChannelDeps = {
    channelId: 'slack-1',
    botToken: 'xoxb-test',
    log: () => undefined,
    state: createChannelState(),
    policy: { respondInChannels: 'mention', allowDms: true, allowlist: new Set(), ...opts.policy },
    onMessage: async (t) => void turns.push(t),
    emitMessage: (e) => void messages.push(e),
    emitMembership: (e) => void membership.push(e),
    onMembershipChanged: (id) => void forgotten.push(id),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.delivery
      ? {
          deliveryOf: (conversationId: string, key: string) => {
            asked.push(key);
            return opts.delivery!(conversationId);
          },
        }
      : {}),
  };
  const channel = new SlackChannel(deps);
  const botId = opts.botId ?? 'UBOT';
  (channel as unknown as { botUserId: string }).botUserId = botId;
  const web = (channel as unknown as { web: { users: { info: (a: { user: string }) => Promise<unknown> } } }).web;
  web.users.info = opts.usersInfo ?? humanInfo;
  const deliver = (event: unknown) => routeSlackEvent(channel, event, 'T1');
  return { channel, messages, membership, turns, forgotten, asked, deliver };
}

const msg = (user: string, text: string, ts: string, extra: Record<string, unknown> = {}) => ({
  type: 'message',
  channel: 'CFAC',
  channel_type: 'channel',
  user,
  text,
  ts,
  ...extra,
});

test('field scenario (spec B §9 criterion 1) through plain text: four ranked votes, two without a mention, all recorded; only mentions start turns', async () => {
  // The facilitator's app holds an `all` subscription for CFAC only.
  const r = rig({ delivery: (id) => (id === 'CFAC' ? 'all' : 'none') });
  await r.deliver({ ...msg('UANNA', '<@UBOT> A > C > B', '100.1'), type: 'app_mention' });
  await r.deliver(msg('UBERT', 'C > A > B', '100.2'));
  await r.deliver(msg('UCARL', '<@UBOT> B > A > C', '100.3'));
  await r.deliver(msg('UDORA', '3: A, 2: B, 1: C', '100.4', { thread_ts: '99.0' }));

  assert.deepEqual(
    r.messages.map((m) => [m.author.id, m.text, m.addressedToBot === true]),
    [
      ['UANNA', 'A > C > B', true],
      ['UBERT', 'C > A > B', false],
      ['UCARL', 'B > A > C', true],
      ['UDORA', '3: A, 2: B, 1: C', false],
    ],
  );
  for (const m of r.messages) {
    assert.equal(m.kind, 'created');
    assert.equal(m.conversationId, 'CFAC');
    assert.equal(m.receivedByChannelKey, 'slack-bot:ubot');
    assert.equal(m.author.kind, 'slack-user');
    assert.equal(m.author.email, `${m.author.id.toLowerCase()}@example.com`);
  }
  assert.equal(r.messages[3]?.replyToMessageId, '99.0');
  assert.deepEqual(r.turns.map((t) => t.text), ['A > C > B', 'B > A > C'], 'the mention gate still decides on turns');
  assert.ok(r.asked.every((key) => key === 'slack-bot:ubot'));
});

test('in a group without a subscription nothing is recorded and the mention rules stay', async () => {
  const r = rig({ delivery: () => 'none' });
  await r.deliver({ ...msg('UBERT', 'C > A > B', '200.1'), channel: 'COTHER' });
  await r.deliver({ ...msg('UANNA', '<@UBOT> hallo', '200.2'), channel: 'COTHER', type: 'app_mention' });
  assert.equal(r.messages.length, 0);
  assert.deepEqual(r.turns.map((t) => t.text), ['hallo']);
});

test('an edit is the next revision of the message, a retry of it is not; an unfurl is no edit', async () => {
  const r = rig({ delivery: () => 'all' });
  const edit = (text: string, editedTs: string) => ({
    type: 'message',
    subtype: 'message_changed',
    channel: 'CFAC',
    ts: editedTs,
    message: { user: 'UBERT', text, ts: '100.2', edited: { user: 'UBERT', ts: editedTs } },
  });
  await r.deliver(edit('A > C > B', '150.0'));
  await r.deliver(edit('A > C > B', '150.0')); // Slack retry
  await r.deliver(edit('<@UBOT> A > B > C', '160.0'));
  await r.deliver({ type: 'message', subtype: 'message_changed', channel: 'CFAC', ts: '170.0', message: { user: 'UBERT', text: 'x', ts: '100.2' } });
  assert.deepEqual(
    r.messages.map((m) => [m.kind, m.messageId, m.revision, m.text, m.addressedToBot === true, m.occurredAt]),
    [
      ['edited', '100.2', 1, 'A > C > B', false, new Date(150_000).toISOString()],
      ['edited', '100.2', 2, 'A > B > C', true, new Date(160_000).toISOString()],
    ],
  );
  assert.equal(r.turns.length, 0, 'an edit starts no turn');
});

test('a deletion is recorded with its author; a bot post and our own messages are not', async () => {
  const r = rig({ delivery: () => 'all' });
  await r.deliver({ type: 'message', subtype: 'message_deleted', channel: 'CFAC', ts: '180.0', deleted_ts: '100.2', previous_message: { user: 'UBERT', ts: '100.2' } });
  await r.deliver({ type: 'message', subtype: 'message_deleted', channel: 'CFAC', ts: '181.0', deleted_ts: '100.9', previous_message: { user: 'UBOT', ts: '100.9' } });
  await r.deliver({ type: 'message', subtype: 'message_changed', channel: 'CFAC', ts: '182.0', message: { user: 'UX', bot_id: 'B1', text: 'x', ts: '100.8', edited: { ts: '182.0' } } });
  assert.deepEqual(r.messages.map((m) => [m.kind, m.messageId, m.author.id, m.text]), [['deleted', '100.2', 'UBERT', undefined]]);
});

test('reactions on a message are recorded (added and removed), our own are not', async () => {
  const r = rig({ delivery: () => 'all' });
  const reaction = (type: string, user: string) => ({ type, user, reaction: '+1', item: { type: 'message', channel: 'CFAC', ts: '300.1' }, event_ts: '301.0' });
  await r.deliver(reaction('reaction_added', 'UANNA'));
  await r.deliver(reaction('reaction_removed', 'UANNA'));
  await r.deliver(reaction('reaction_added', 'UBOT'));
  await r.deliver({ type: 'reaction_added', user: 'UANNA', reaction: '+1', item: { type: 'file', file: 'F1' } });
  assert.deepEqual(
    r.messages.map((m) => [m.kind, m.messageId, m.author.id, m.reaction]),
    [
      ['reaction', '300.1', 'UANNA', { name: '+1', removed: false }],
      ['reaction', '300.1', 'UANNA', { name: '+1', removed: true }],
    ],
  );
});

test('edits, deletions and reactions follow the subscription, the DM policy and the allowlist', async () => {
  const none = rig({ delivery: () => 'none' });
  await none.deliver({ type: 'reaction_added', user: 'UANNA', reaction: '+1', item: { type: 'message', channel: 'CFAC', ts: '1.1' } });
  assert.equal(none.messages.length, 0);
  const listed = rig({ policy: { allowlist: new Set(['COK']) } });
  await listed.deliver({ type: 'reaction_added', user: 'UANNA', reaction: '+1', item: { type: 'message', channel: 'CFAC', ts: '1.1' } });
  await listed.deliver({ type: 'reaction_added', user: 'UANNA', reaction: '+1', item: { type: 'message', channel: 'COK', ts: '1.1' } });
  assert.deepEqual(listed.messages.map((m) => m.conversationId), ['COK']);
  const dmOff = rig({ policy: { allowDms: false } });
  await dmOff.deliver({ type: 'message', subtype: 'message_deleted', channel: 'D1', ts: '2.0', deleted_ts: '1.0', previous_message: { user: 'UANNA', ts: '1.0' } });
  assert.equal(dmOff.messages.length, 0);
});

test('a member joining or leaving reaches the kernel and drops the cached roster; a retry is one event', async () => {
  const r = rig();
  const joined = { type: 'member_joined_channel', user: 'UEVA', channel: 'CFAC', channel_type: 'C', inviter: 'UANNA', event_ts: '400.0' };
  await r.deliver(joined);
  await r.deliver(joined);
  await r.deliver({ type: 'member_left_channel', user: 'UBERT', channel: 'CFAC', channel_type: 'C', event_ts: '401.0' });
  assert.deepEqual(
    r.membership.map((e) => [e.kind, e.conversationId, e.members.map((m) => m.id), e.occurredAt]),
    [
      ['members_added', 'CFAC', ['UEVA'], new Date(400_000).toISOString()],
      ['members_removed', 'CFAC', ['UBERT'], new Date(401_000).toISOString()],
    ],
  );
  assert.ok(r.membership.every((e) => e.channelId === 'slack-1' && e.channelType === 'slack' && e.conversationType === 'group'));
  assert.deepEqual(r.forgotten, ['CFAC', 'CFAC']);
});

test('the app itself being added is bot_added with the inviter', async () => {
  const r = rig();
  await r.deliver({ type: 'member_joined_channel', user: 'UBOT', channel: 'CNEW', channel_type: 'G', inviter: 'UANNA', event_ts: '500.0' });
  assert.equal(r.membership.length, 1);
  const event = r.membership[0];
  assert.equal(event?.kind, 'bot_added');
  assert.deepEqual(event?.kind === 'bot_added' ? event.addedBy : undefined, { kind: 'slack-user', id: 'UANNA' });
  assert.deepEqual(event?.members.map((m) => m.id), ['UBOT']);
});

test('a human group message proves presence once per conversation (bot_present); a DM does not', async () => {
  const r = rig();
  await r.deliver(msg('UANNA', 'hallo', '600.1'));
  await r.deliver(msg('UBERT', 'hallo', '600.2'));
  await r.deliver({ ...msg('UANNA', 'hallo', '600.3'), channel: 'D1', channel_type: 'im' });
  assert.deepEqual(
    r.membership.map((e) => [e.kind, e.conversationId, e.kind === 'bot_present' ? e.addedBy?.id : undefined]),
    [['bot_present', 'CFAC', 'UANNA']],
  );
});

test('membership outside the allowlist is not emitted, but the cached roster is still dropped', async () => {
  const r = rig({ policy: { allowlist: new Set(['COK']) } });
  await r.deliver({ type: 'member_joined_channel', user: 'UEVA', channel: 'CFAC', event_ts: '700.0' });
  assert.equal(r.membership.length, 0);
  assert.deepEqual(r.forgotten, ['CFAC']);
});

/** users.info that names UPOLL an app and gives people a display name. */
const appAwareInfo: UsersInfo = async ({ user }) =>
  user === 'UPOLL'
    ? { user: { is_bot: true, name: 'pollbot' } }
    : { user: { name: user.toLowerCase(), profile: { display_name: `Name ${user}`, email: `${user.toLowerCase()}@example.com` } } };

test('another app joining, leaving or reacting is no participant; people carry their display name', async () => {
  const r = rig({ delivery: () => 'all', usersInfo: appAwareInfo });
  await r.deliver({ type: 'member_joined_channel', user: 'UPOLL', channel: 'CFAC', event_ts: '800.0' });
  await r.deliver({ type: 'member_left_channel', user: 'UPOLL', channel: 'CFAC', event_ts: '800.5' });
  await r.deliver({ type: 'member_joined_channel', user: 'UEVA', channel: 'CFAC', event_ts: '801.0' });
  await r.deliver({ type: 'member_joined_channel', user: 'USLACKBOT', channel: 'CFAC', event_ts: '801.5' });
  assert.deepEqual(
    r.membership.map((e) => [e.kind, e.members]),
    [['members_added', [{ kind: 'slack-user', id: 'UEVA', displayName: 'Name UEVA', email: 'ueva@example.com' }]]],
  );
  assert.deepEqual(r.forgotten, ['CFAC', 'CFAC', 'CFAC', 'CFAC'], 'the roster is dropped for apps too');
  const reaction = (user: string) => ({ type: 'reaction_added', user, reaction: '+1', item: { type: 'message', channel: 'CFAC', ts: '300.1' }, event_ts: `${user}.1` });
  await r.deliver(reaction('UPOLL'));
  await r.deliver(reaction('UANNA'));
  assert.deepEqual(r.messages.map((m) => [m.kind, m.author.id]), [['reaction', 'UANNA']]);
});

test('bot_present is sent again after 12 hours, not before', async () => {
  let now = 1_000_000;
  const r = rig({ now: () => now });
  await r.deliver(msg('UANNA', 'hallo', '900.1'));
  now += 11 * 60 * 60 * 1000;
  await r.deliver(msg('UANNA', 'hallo', '900.2'));
  now += 60 * 60 * 1000;
  await r.deliver(msg('UBERT', 'hallo', '900.3'));
  assert.deepEqual(
    r.membership.map((e) => [e.kind, e.kind === 'bot_present' ? e.addedBy?.id : undefined, e.occurredAt]),
    [
      ['bot_present', 'UANNA', new Date(1_000_000).toISOString()],
      ['bot_present', 'UBERT', new Date(1_000_000 + 12 * 60 * 60 * 1000).toISOString()],
    ],
  );
});

test('the same edit after the dedup window is not emitted twice', async () => {
  const r = rig({ delivery: () => 'all' });
  const edit = { type: 'message', subtype: 'message_changed', channel: 'CFAC', ts: '150.0', message: { user: 'UBERT', text: 'A > B', ts: '100.2', edited: { ts: '150.0' } } };
  await r.deliver(edit);
  // Push the first delivery out of the handled-key window (1000 keys).
  for (let i = 0; i < 1_100; i += 1) {
    await r.deliver({ type: 'reaction_added', user: 'UANNA', reaction: 'x', item: { type: 'file' }, event_ts: `${String(i)}.0` });
  }
  await r.deliver(edit);
  await r.deliver({ ...edit, ts: '151.0', message: { ...edit.message, text: 'B > A', edited: { ts: '151.0' } } });
  assert.deepEqual(r.messages.map((m) => [m.kind, m.text, m.revision]), [['edited', 'A > B', 1], ['edited', 'B > A', 2]]);
});

test('deleting a message with thread replies (a tombstone) is a deletion, once', async () => {
  const r = rig({ delivery: () => 'all' });
  const tombstone = {
    type: 'message',
    subtype: 'message_changed',
    channel: 'CFAC',
    ts: '190.0',
    hidden: true,
    message: { type: 'message', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.', ts: '100.2', thread_ts: '100.2' },
    previous_message: { user: 'UBERT', ts: '100.2', text: 'A > B' },
  };
  await r.deliver(tombstone);
  await r.deliver({ type: 'message', subtype: 'message_deleted', channel: 'CFAC', ts: '191.0', deleted_ts: '100.2', previous_message: { user: 'UBERT', ts: '100.2' } });
  assert.deepEqual(r.messages.map((m) => [m.kind, m.messageId, m.author.id, m.occurredAt]), [['deleted', '100.2', 'UBERT', new Date(190_000).toISOString()]]);
});

test('an edit handed over while its created still waits is emitted after it', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const r = rig({
    delivery: () => 'all',
    usersInfo: async (args) => {
      if (first) {
        first = false;
        await gate;
      }
      return humanInfo(args);
    },
  });
  // Fire-and-forget, like the Events API transport.
  const created = r.deliver(msg('UBERT', 'A > B', '100.2'));
  const edited = r.deliver({ type: 'message', subtype: 'message_changed', channel: 'CFAC', ts: '150.0', message: { user: 'UBERT', text: 'B > A', ts: '100.2', edited: { ts: '150.0' } } });
  const other = r.deliver({ ...msg('UANNA', 'hi', '1.1'), channel: 'COTHER' });
  await other;
  assert.deepEqual(r.messages.map((m) => m.conversationId), ['COTHER'], 'another conversation is not held up');
  release();
  await Promise.all([created, edited]);
  assert.deepEqual(r.messages.filter((m) => m.conversationId === 'CFAC').map((m) => m.kind), ['created', 'edited']);
});
