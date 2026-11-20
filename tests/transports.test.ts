import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';

import express from 'express';

import { createEventsApiRouter } from '../src/eventsApiTransport.js';
import type { SlackSlashCommandPayload } from '../src/inbound.js';
import type { SlackChannel } from '../src/slackChannel.js';
import { routeSocketEnvelope } from '../src/socketModeTransport.js';
import { createChannelState } from '../src/state.js';

const SECRET = 'signing-secret';

function fakeChannel() {
  const events: unknown[] = [];
  const commands: SlackSlashCommandPayload[] = [];
  const channel = {
    ingest: async (e: unknown) => void events.push(e),
    ingestCommand: async (p: SlackSlashCommandPayload) => void commands.push(p),
  } as unknown as SlackChannel;
  return { channel, events, commands };
}

async function withServer<T>(channel: SlackChannel, run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use('/api/slack', createEventsApiRouter({ signingSecret: SECRET, channel, log: () => undefined, state: createChannelState() }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${String(port)}`);
  } finally {
    server.close();
  }
}

function signed(body: string, ts = String(Math.floor(Date.now() / 1000)), secret = SECRET): Record<string, string> {
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

test('a signed form-encoded /agent command is acknowledged empty and ingested', async () => {
  const { channel, commands } = fakeChannel();
  const body = new URLSearchParams({ command: '/agent', text: 'Mira', user_id: 'U1', channel_id: 'C1', trigger_id: 't1' }).toString();
  await withServer(channel, async (base) => {
    const res = await fetch(`${base}/api/slack/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(commands[0]?.command, '/agent');
  assert.equal(commands[0]?.text, 'Mira');
});

test('a command with a bad signature or a stale timestamp is refused and not ingested', async () => {
  const { channel, commands } = fakeChannel();
  const body = 'command=%2Fagent&text=Mira&user_id=U1&channel_id=C1';
  await withServer(channel, async (base) => {
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    const bad = await fetch(`${base}/api/slack/commands`, { method: 'POST', headers: { ...headers, ...signed(body, undefined, 'other') }, body });
    assert.equal(bad.status, 401);
    const stale = await fetch(`${base}/api/slack/commands`, { method: 'POST', headers: { ...headers, ...signed(body, '1000') }, body });
    assert.equal(stale.status, 400);
  });
  assert.deepEqual(commands, []);
});

test('Socket Mode: slash_commands envelopes go to ingestCommand, events_api message events to ingest', async () => {
  const { channel, events, commands } = fakeChannel();
  await routeSocketEnvelope(channel, 'slash_commands', { command: '/agent', text: '', user_id: 'U1', channel_id: 'C1' });
  // The payload of an events_api envelope is an event_callback, not "events_api".
  await routeSocketEnvelope(channel, 'events_api', { type: 'event_callback', team_id: 'T1', event: { type: 'message', channel: 'C1', ts: '1.1' } });
  await routeSocketEnvelope(channel, 'events_api', { type: 'event_callback', event: { type: 'reaction_added' } });
  await routeSocketEnvelope(channel, 'interactive', { type: 'block_actions' });
  await routeSocketEnvelope(channel, undefined, undefined);
  assert.equal(commands.length, 1);
  assert.equal(events.length, 1);
});
