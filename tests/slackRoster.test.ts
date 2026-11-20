import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rosterStatusOf } from '@omadia/channel-sdk';

import { ROSTER_CACHE_TTL_MS, ROSTER_MAX_MEMBERS, createSlackRosterProvider } from '../src/slackRoster.js';

function source(read: (channel: string) => Promise<{ memberIds: string[]; truncated: boolean }>) {
  const calls: string[] = [];
  return {
    calls,
    selfUserId: 'UBOT',
    conversationMembers: async (channel: string, max: number) => {
      calls.push(`${channel}:${String(max)}`);
      return read(channel);
    },
  };
}

const apiError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });

test('a fully read channel is complete, with the bot as self', async () => {
  const provider = createSlackRosterProvider({
    channel: source(async () => ({ memberIds: ['U1', 'U2', 'UBOT'], truncated: false })),
    log: () => undefined,
    now: () => Date.parse('2026-11-20T10:00:00Z'),
  });
  const roster = await provider.getRoster('C1');
  assert.equal(provider.channelType, 'slack');
  assert.equal(roster?.conversationType, 'group');
  assert.equal(roster ? rosterStatusOf(roster) : undefined, 'complete');
  assert.equal(roster?.partial, false);
  assert.equal(roster?.readAt, '2026-11-20T10:00:00.000Z');
  assert.deepEqual(roster?.participants.map((p) => p.userRef.id), ['U1', 'U2', 'UBOT']);
  assert.equal(roster?.participants.find((p) => p.userRef.id === 'UBOT')?.isBot, true);
  assert.equal(roster?.participants.find((p) => p.userRef.id === 'U1')?.isBot, undefined);
  assert.equal(roster?.self?.userRef.id, 'UBOT');
});

test('a DM id is a direct conversation', async () => {
  const provider = createSlackRosterProvider({
    channel: source(async () => ({ memberIds: ['U1', 'UBOT'], truncated: false })),
    log: () => undefined,
  });
  assert.equal((await provider.getRoster('D1'))?.conversationType, 'direct');
});

test('a list cut at the cap is partial, never complete', async () => {
  const src = source(async () => ({ memberIds: ['U1'], truncated: true }));
  const roster = await createSlackRosterProvider({ channel: src, log: () => undefined }).getRoster('C1');
  assert.equal(roster ? rosterStatusOf(roster) : undefined, 'partial');
  assert.equal(roster?.partial, true);
  assert.ok(src.calls[0]?.endsWith(`:${String(ROSTER_MAX_MEMBERS)}`));
  assert.match(roster?.statusDetail ?? '', /first 2000/);
});

test('a refused read is unknown with the missing scope named, and is not cached', async () => {
  const logs: string[] = [];
  let fail = true;
  const src = source(async () => {
    if (fail) throw apiError('missing_scope');
    return { memberIds: ['U1'], truncated: false };
  });
  const provider = createSlackRosterProvider({ channel: src, log: (m) => logs.push(m) });
  const bad = await provider.getRoster('G1');
  assert.equal(bad ? rosterStatusOf(bad) : undefined, 'unknown');
  assert.deepEqual(bad?.participants, []);
  assert.match(bad?.statusDetail ?? '', /groups:read/);
  assert.equal(logs.length, 1);
  fail = false; // the operator adds the scope: effective on the very next read
  const good = await provider.getRoster('G1');
  assert.equal(good ? rosterStatusOf(good) : undefined, 'complete');
});

test('not_in_channel and other errors are unknown with their reason', async () => {
  const mk = (code: string) => createSlackRosterProvider({ channel: source(async () => { throw apiError(code); }), log: () => undefined });
  assert.match((await mk('not_in_channel').getRoster('C1'))?.statusDetail ?? '', /not a member/);
  assert.match((await mk('ratelimited').getRoster('C1'))?.statusDetail ?? '', /ratelimited/);
});

test('reads are cached for a short time; fresh bypasses the cache', async () => {
  let t = 0;
  const src = source(async () => ({ memberIds: ['U1'], truncated: false }));
  const provider = createSlackRosterProvider({ channel: src, log: () => undefined, now: () => t });
  await provider.getRoster('C1');
  t += ROSTER_CACHE_TTL_MS - 1;
  await provider.getRoster('C1');
  assert.equal(src.calls.length, 1);
  await provider.getRoster('C1', { fresh: true });
  assert.equal(src.calls.length, 2);
  t += ROSTER_CACHE_TTL_MS + 1;
  await provider.getRoster('C1');
  assert.equal(src.calls.length, 3);
});

test('a blank conversation id is not resolvable', async () => {
  const provider = createSlackRosterProvider({ channel: source(async () => ({ memberIds: [], truncated: false })), log: () => undefined });
  assert.equal(await provider.getRoster('  '), undefined);
});
