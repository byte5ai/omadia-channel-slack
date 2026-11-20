import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSlackPeopleDirectoryProvider, slackPrincipalRef, type SlackDirectoryUser } from '../src/slackPeopleDirectory.js';
import { buildIncomingTurn } from '../src/inbound.js';
import { slackSenderPrincipal } from '../src/turn.js';

function directory(users: SlackDirectoryUser[]) {
  return createSlackPeopleDirectoryProvider({
    channel: { searchUsers: async () => ({ users, truncated: false }) },
    log: () => undefined,
  });
}

const ev = { type: 'message', channel: 'C1', user: 'U0ABC9', ts: '1.1', channel_type: 'channel' } as const;

test('the directory principalRef is the inbound turn principal without its user: prefix (with and without e-mail)', async () => {
  const people = await directory([
    { id: 'U0ABC9', realName: 'Ohne Mail' },
    { id: 'U0ABC9', realName: 'Mit Mail', email: 'Anna@Example.com' },
  ]).search('x', { limit: 10 });
  assert.equal(people.outcome, 'resolved');
  const refs = people.outcome === 'resolved' ? people.people.map((p) => p.principalRef) : [];
  assert.deepEqual(refs, ['slack-user:u0abc9', 'anna@example.com']);

  const withoutMail = slackSenderPrincipal(buildIncomingTurn('s', ev, 'x', 'T1'));
  const withMail = slackSenderPrincipal(buildIncomingTurn('s', ev, 'x', 'T1', {}, { email: 'anna@example.com' }));
  assert.equal(`user:${refs[0]}`, withoutMail);
  assert.equal(`user:${refs[1]}`, withMail);
});

test('the ref has no whitespace and survives the kernel canonicalisation (trim + lowercase)', () => {
  const ref = slackPrincipalRef({ id: 'U0ABC9', email: '  Anna@Example.com ' });
  assert.equal(ref, ref.trim().toLowerCase());
  assert.ok(!/\s/.test(ref));
});
