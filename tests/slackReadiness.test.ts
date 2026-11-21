// Readiness of an app in one conversation (spec 2043 §5.3, kernel #2091):
// member, may read every message, can post; failures are reported, never thrown.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SlackConversationInfo } from '../src/slackChannel.js';
import { createSlackReadinessProvider, historyScopeFor, type SlackReadinessSource } from '../src/slackReadiness.js';

const CHANNEL: SlackConversationInfo = { isMember: true, isIm: false, isMpim: false, isPrivate: false, isArchived: false };
const ALL_SCOPES = ['chat:write', 'channels:history', 'groups:history', 'im:history', 'mpim:history', 'channels:read'];
const KEY = 'slack-bot:umira01';

const apiError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });

function provider(source: Partial<SlackReadinessSource> & { info?: () => Promise<SlackConversationInfo> }) {
  const app: SlackReadinessSource = {
    grantedScopes: 'grantedScopes' in source ? source.grantedScopes : ALL_SCOPES,
    conversationInfo: source.info ?? (async () => CHANNEL),
  };
  return createSlackReadinessProvider((key) => (key === KEY ? app : undefined));
}

test('a member app with the history and post scopes is ready, checked', async () => {
  const report = await provider({}).check('C1', { asChannelKey: 'SLACK-BOT:UMIRA01' });
  assert.deepEqual(report, { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] });
});

test('an unknown key is no identity, never another app', async () => {
  const report = await provider({}).check('C1', { asChannelKey: 'slack-bot:uother' });
  assert.equal(report.ready, false);
  assert.equal(report.missing[0]?.code, 'no_identity');
});

test('an app that is not in the channel is not installed', async () => {
  const notMember = await provider({ info: async () => ({ ...CHANNEL, isMember: false }) }).check('C1', { asChannelKey: KEY });
  assert.equal(notMember.missing[0]?.code, 'app_not_installed');
  const hidden = await provider({ info: async () => Promise.reject(apiError('channel_not_found')) }).check('G1', { asChannelKey: KEY });
  assert.equal(hidden.missing[0]?.code, 'app_not_installed');
  assert.equal(hidden.installed, false);
});

test('a missing history scope means it cannot read every message (consent_missing)', async () => {
  const report = await provider({ grantedScopes: ['chat:write', 'channels:history'] }).check('G1', {
    asChannelKey: KEY,
  });
  assert.equal(report.ready, false);
  assert.equal(report.canReadAllMessages, false);
  assert.equal(report.canPost, true);
  assert.equal(report.missing[0]?.code, 'consent_missing');
  assert.match(report.missing[0]?.message ?? '', /groups:history/);
});

test('an archived conversation or a missing chat:write cannot be posted to', async () => {
  const archived = await provider({ info: async () => ({ ...CHANNEL, isArchived: true }) }).check('C1', { asChannelKey: KEY });
  assert.deepEqual([archived.ready, archived.canPost, archived.missing[0]?.code], [false, false, 'cannot_post']);
  const noPost = await provider({ grantedScopes: ['channels:history'] }).check('C1', { asChannelKey: KEY });
  assert.deepEqual([noPost.ready, noPost.canPost, noPost.missing[0]?.code], [false, false, 'cannot_post']);
});

test('scopes Slack did not report: no known obstacle, but not verified', async () => {
  const report = await provider({ grantedScopes: undefined }).check('C1', { asChannelKey: KEY });
  assert.equal(report.ready, true);
  assert.equal(report.verified, false);
});

test('Slack errors are reported, never thrown', async () => {
  const scope = await provider({ info: async () => Promise.reject(apiError('missing_scope')) }).check('C1', { asChannelKey: KEY });
  assert.equal(scope.missing[0]?.code, 'graph_forbidden');
  const other = await provider({ info: async () => Promise.reject(new Error('socket hang up')) }).check('C1', { asChannelKey: KEY });
  assert.equal(other.missing[0]?.code, 'graph_error');
  assert.equal(other.ready, false);
});

test('a DM and a group DM count as installed; the history scope follows the conversation kind', async () => {
  const dm = await provider({ info: async () => ({ ...CHANNEL, isMember: false, isIm: true }) }).check('D1', { asChannelKey: KEY });
  assert.equal(dm.ready, true);
  const mpim = await provider({ info: async () => ({ ...CHANNEL, isMember: false, isMpim: true, isPrivate: true }) }).check('G2', { asChannelKey: KEY });
  assert.equal(mpim.installed, true);
  assert.equal(historyScopeFor('C1', CHANNEL), 'channels:history');
  assert.equal(historyScopeFor('C2', { ...CHANNEL, isPrivate: true }), 'groups:history');
  assert.equal(historyScopeFor('G2', { ...CHANNEL, isMpim: true }), 'mpim:history');
  assert.equal(historyScopeFor('D1', CHANNEL), 'im:history');
});
