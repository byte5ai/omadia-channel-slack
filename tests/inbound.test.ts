import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIncomingTurn, commandToEvent, type SlackSlashCommandPayload, type SlackTurnMeta } from '../src/inbound.js';

const payload = (over: Partial<SlackSlashCommandPayload> = {}): SlackSlashCommandPayload => ({
  command: '/agent',
  text: 'Mira',
  user_id: 'U1',
  channel_id: 'C1',
  channel_name: 'general',
  team_id: 'T1',
  response_url: 'https://hooks.slack.com/commands/T1/1/x',
  trigger_id: 'trig.1',
  ...over,
});

test('/agent <name> reaches the kernel as the plain text it was typed as', () => {
  assert.equal(commandToEvent(payload())?.text, '/agent Mira');
  assert.equal(commandToEvent(payload({ text: '  Mira Müller  ' }))?.text, '/agent Mira Müller');
});

test('a bare /agent and /agents pass through for the kernel to interpret', () => {
  assert.equal(commandToEvent(payload({ text: '' }))?.text, '/agent');
  assert.equal(commandToEvent(payload({ text: undefined }))?.text, '/agent');
  assert.equal(commandToEvent(payload({ command: '/agents', text: '' }))?.text, '/agents');
});

test('a command that is not ours is ignored', () => {
  assert.equal(commandToEvent(payload({ command: '/deploy' })), undefined);
  assert.equal(commandToEvent(payload({ user_id: '' })), undefined);
});

test('the conversation type is derived from the channel id and name', () => {
  assert.equal(commandToEvent(payload({ channel_id: 'D9', channel_name: 'directmessage' }))?.channel_type, 'im');
  assert.equal(commandToEvent(payload({ channel_id: 'G9', channel_name: 'privategroup' }))?.channel_type, 'group');
  assert.equal(commandToEvent(payload({ channel_id: 'C9', channel_name: 'mpdm-a--b-1' }))?.channel_type, 'mpim');
  assert.equal(commandToEvent(payload())?.channel_type, 'channel');
});

test('a command turn is channel-level, unthreaded and carries its response_url', () => {
  const ev = commandToEvent(payload())!;
  const turn = buildIncomingTurn('slack-1', ev, ev.text!, 'T1', { command: { responseUrl: 'https://hooks.slack.com/x' } });
  const meta = turn.metadata as unknown as SlackTurnMeta;
  assert.equal(meta.sessionScope, 'slack:C1');
  assert.equal(meta.threadTs, undefined);
  assert.equal(meta.responseUrl, 'https://hooks.slack.com/x');
  assert.equal(meta.commandUserId, 'U1');
  assert.equal(turn.conversationType, 'group');
});

test('a plain message keeps its thread scope and states direct vs group', () => {
  const ch = buildIncomingTurn('s', { type: 'message', channel: 'C1', user: 'U1', ts: '5.5', channel_type: 'channel' }, 'x', undefined);
  assert.equal((ch.metadata as unknown as SlackTurnMeta).sessionScope, 'slack:C1:5.5');
  assert.equal(ch.conversationType, 'group');
  const dm = buildIncomingTurn('s', { type: 'message', channel: 'D1', user: 'U1', ts: '5.5', channel_type: 'im' }, 'x', undefined);
  assert.equal(dm.conversationType, 'direct');
});
