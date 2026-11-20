import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { IncomingTurn } from '@omadia/channel-sdk';

import type { SlackSlashCommandPayload } from '../src/inbound.js';
import { SlackChannel, validResponseUrl, type AccessPolicy } from '../src/slackChannel.js';
import { createChannelState } from '../src/state.js';

const URL_OK = 'https://hooks.slack.com/commands/T1/1/x';

type InfoCall = { user: string; include_locale?: boolean };

function make(policy: Partial<AccessPolicy> = {}, info: (args: InfoCall) => Promise<unknown> = async () => ({ user: {} })) {
  const turns: IncomingTurn[] = [];
  const reactions: unknown[] = [];
  const channel = new SlackChannel({
    channelId: 'slack-1',
    botToken: 'xoxb-test',
    log: () => undefined,
    state: createChannelState(),
    policy: { respondInChannels: 'mention', allowDms: true, allowlist: new Set(), ...policy },
    onMessage: async (t) => void turns.push(t),
  });
  // Any reaction would go through the Web client: record it.
  const web = (channel as unknown as { web: { reactions?: { add: (a: unknown) => Promise<void> } } }).web;
  if (web.reactions) web.reactions.add = async (a) => void reactions.push(a);
  // users.info is the sender profile lookup: never let a test reach Slack.
  const infoCalls: InfoCall[] = [];
  (web as unknown as { users: { info: (a: InfoCall) => Promise<unknown> } }).users.info = async (a) => (infoCalls.push(a), info(a));
  return { channel, turns, reactions, infoCalls };
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
