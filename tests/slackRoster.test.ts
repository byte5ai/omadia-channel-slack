import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rosterStatusOf } from '@omadia/channel-sdk';

import { ROSTER_CACHE_TTL_MS, ROSTER_MAX_MEMBERS, ROSTER_PROFILE_LOOKUPS_MAX, createSlackRosterProvider } from '../src/slackRoster.js';

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

test('a join within the cache lifetime: the fresh query sees it, and a membership event drops the cached read', async () => {
  let members = ['U1', 'U2', 'UBOT'];
  const src = source(async () => ({ memberIds: members, truncated: false }));
  const provider = createSlackRosterProvider({ channel: src, log: () => undefined, now: () => 0 });
  await provider.getRoster('C1');
  members = [...members, 'U3'];
  assert.equal((await provider.getRoster('C1'))?.participants.length, 3, 'a cached read within the lifetime');
  const fresh = await provider.getRoster('C1', { fresh: true });
  assert.deepEqual(fresh?.participants.map((p) => p.userRef.id), ['U1', 'U2', 'UBOT', 'U3']);
  assert.equal(fresh ? rosterStatusOf(fresh) : undefined, 'complete');
  members = members.filter((id) => id !== 'U2');
  provider.forget('C1');
  assert.deepEqual((await provider.getRoster('C1'))?.participants.map((p) => p.userRef.id), ['U1', 'UBOT', 'U3']);
});

test('a read that fails on a later page is unknown, never complete, and the earlier read is not reported instead', async () => {
  let fail = false;
  const src = source(async () => {
    if (fail) throw apiError('ratelimited');
    return { memberIds: ['U1'], truncated: false };
  });
  const provider = createSlackRosterProvider({ channel: src, log: () => undefined, now: () => 0 });
  await provider.getRoster('C1');
  fail = true;
  const fresh = await provider.getRoster('C1', { fresh: true });
  assert.equal(fresh ? rosterStatusOf(fresh) : undefined, 'unknown');
  assert.deepEqual(fresh?.participants, []);
});

test('a read that started before a forget() is returned but not cached', async () => {
  let resolveRead: (v: { memberIds: string[]; truncated: boolean }) => void = () => undefined;
  let reads = 0;
  const provider = createSlackRosterProvider({
    channel: source(() => {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => (resolveRead = resolve));
      return Promise.resolve({ memberIds: ['U1', 'U2', 'UBOT'], truncated: false });
    }),
    log: () => undefined,
  });
  const stale = provider.getRoster('C1');
  provider.forget('C1'); // U2 joined while the first read was in flight
  resolveRead({ memberIds: ['U1', 'UBOT'], truncated: false });
  assert.deepEqual((await stale)?.participants.map((p) => p.userRef.id), ['U1', 'UBOT']);
  const next = await provider.getRoster('C1');
  assert.equal(reads, 2, 'the pre-forget read was not cached');
  assert.deepEqual(next?.participants.map((p) => p.userRef.id), ['U1', 'U2', 'UBOT']);
});

test('other apps, bots and Slackbot are marked isBot from users.info, people are not', async () => {
  const looked: string[] = [];
  const src = {
    ...source(async () => ({ memberIds: ['U1', 'UJIRA', 'UGIPHY', 'USLACKBOT', 'UBOT', 'U2'], truncated: false })),
    senderProfile: async (id: string) => {
      looked.push(id);
      if (id === 'U2') throw new Error('rate limited');
      return id === 'UJIRA' || id === 'UGIPHY' ? { isBot: true } : {};
    },
  };
  const roster = await createSlackRosterProvider({ channel: src, log: () => undefined }).getRoster('C1');
  const bots = roster?.participants.filter((p) => p.isBot === true).map((p) => p.userRef.id).sort();
  assert.deepEqual(bots, ['UBOT', 'UGIPHY', 'UJIRA', 'USLACKBOT']);
  assert.deepEqual(looked.sort(), ['U1', 'U2', 'UGIPHY', 'UJIRA'], 'own app and Slackbot need no lookup');
  assert.equal(roster?.participants.find((p) => p.userRef.id === 'U2')?.isBot, undefined, 'a failed lookup stays a person');
});

test('profile lookups per read are capped', async () => {
  const ids = Array.from({ length: ROSTER_PROFILE_LOOKUPS_MAX + 5 }, (_, i) => `U${String(i)}`);
  let lookups = 0;
  const src = {
    ...source(async () => ({ memberIds: ids, truncated: false })),
    senderProfile: async () => {
      lookups += 1;
      return { isBot: true };
    },
  };
  const roster = await createSlackRosterProvider({ channel: src, log: () => undefined }).getRoster('C1');
  assert.equal(lookups, ROSTER_PROFILE_LOOKUPS_MAX);
  assert.equal(roster?.participants.filter((p) => p.isBot === true).length, ROSTER_PROFILE_LOOKUPS_MAX);
});
