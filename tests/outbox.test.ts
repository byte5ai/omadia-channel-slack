import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SlackOutbox, systemAnswer } from '../src/outbox.js';
import { MIRA, RecordingSink, answer } from './helpers.js';

const target = { conversationId: 'C1', conversationKey: 'slack:C1:1' };

test('an answer is posted into the conversation, threaded where given', async () => {
  const sink = new RecordingSink();
  const outbox = new SlackOutbox(sink);
  assert.equal(await outbox.deliver(answer('Hallo.'), { ...target, threadTs: '1.1' }), true);
  assert.deepEqual(sink.calls, [{ kind: 'post', target: 'C1', text: 'Hallo.', threadTs: '1.1' }]);
});

test('an empty answer sends nothing', async () => {
  const sink = new RecordingSink();
  assert.equal(await new SlackOutbox(sink).deliver(answer('  '), target), false);
  assert.equal(sink.calls.length, 0);
});

test('system answers carry the system speaker and a notice', () => {
  const a = systemAnswer('agent_error', 'Fehler.');
  assert.equal(a.speaker?.kind, 'system');
  assert.equal(a.systemNotice?.code, 'agent_error');
});

test('a second agent in the same conversation gets a name line through the outbox', async () => {
  const sink = new RecordingSink();
  const outbox = new SlackOutbox(sink);
  await outbox.deliver(answer('eins', MIRA), target);
  await outbox.deliver(answer('zwei', { ...MIRA, agentId: 'x', displayName: 'Ben' }), target);
  assert.deepEqual(sink.calls.map((c) => c.text), ['eins', 'Ben: zwei']);
});

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(): Array<{ file: string; code: string }> {
  return readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => ({
      file,
      // Comments may mention the primitives; only code counts.
      code: readFileSync(join(srcDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    }));
}

const count = (code: string, re: RegExp): number => (code.match(re) ?? []).length;

test('emitter paths are counted: the outbox is the only caller of the sink, the channel the only sender (criterion 5)', () => {
  const all = sources();
  // Callers of the three sink methods: outbox.ts only, one call each.
  for (const { file, code } of all) {
    const calls = count(code, /\bsink\.(sendText|replyToCommand|sendEphemeral)\(/g);
    assert.equal(calls, file === 'outbox.ts' ? 3 : 0, `${file}: sink calls`);
  }
  // Raw Slack Web API / response_url senders: slackChannel.ts only.
  for (const { file, code } of all) {
    const posts = count(code, /\bchat\.post(Message|Ephemeral)\(/g) + count(code, /\bfetch\(/g);
    assert.equal(posts, file === 'slackChannel.ts' ? 3 : 0, `${file}: raw senders`);
  }
});

test('no receipt reaction exists any more (spec 5.14)', () => {
  for (const { file, code } of sources()) {
    assert.ok(!/reactions\.add|sendReaction|ACK_EMOJI/.test(code), `${file} still sends a reaction`);
  }
  const manifest = readFileSync(join(srcDir, '..', 'manifest.yaml'), 'utf8');
  assert.ok(!manifest.includes('reactions:write'), 'manifest still asks for reactions:write');
});
