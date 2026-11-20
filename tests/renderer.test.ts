import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  REMOVED_DECORATIONS,
  admitDecorations,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import { mdToSlack, renderSlackAnswer, SLACK_CHANNEL_TYPE, SLACK_DECORATIONS } from '../src/renderer.js';
import { BEN, MIRA, answer, notice } from './helpers.js';

function render(a: SemanticAnswer, conversationKey = 'slack:C1:1', history = new InMemorySpeakerHistoryStore()): string {
  return renderSlackAnswer(a, { nativeIdentity: false, conversationKey, speakerHistory: history });
}

test('one agent in a conversation: no name line, ever (criterion 29)', () => {
  const history = new InMemorySpeakerHistoryStore();
  assert.equal(render(answer('Hallo, ich schaue nach.'), 'slack:C1:1', history), 'Hallo, ich schaue nach.');
  assert.equal(render(answer('Fertig.'), 'slack:C1:1', history), 'Fertig.');
});

test('two agents in a conversation: a name line where the speaker would be unclear', () => {
  const history = new InMemorySpeakerHistoryStore();
  assert.equal(render(answer('Erste Antwort.', MIRA), 'slack:C1:1', history), 'Erste Antwort.');
  assert.equal(render(answer('Meine Sicht.', BEN), 'slack:C1:1', history), 'Ben: Meine Sicht.');
  assert.equal(render(answer('Zurück bei mir.', MIRA), 'slack:C1:1', history), 'Mira: Zurück bei mir.');
});

test('speaker history is per conversation', () => {
  const history = new InMemorySpeakerHistoryStore();
  render(answer('a', MIRA), 'slack:C1:1', history);
  assert.equal(render(answer('b', BEN), 'slack:C2:1', history), 'b');
});

test('a colleague contribution is attributed in plain text', () => {
  const text = render(
    answer('Ich habe Ben gefragt (siehe unten).', MIRA, {
      contributions: [{ id: 'c1', speaker: BEN, text: 'Das Budget reicht.', status: 'delivered' }],
    } as Partial<SemanticAnswer>),
  );
  assert.equal(text, 'Ich habe Ben gefragt (siehe unten).\n\nBen: Das Budget reicht.');
});

test('a system notice is its own text: no agent name, no attachment', () => {
  const text = render(
    answer('ignored', { kind: 'system' }, {
      systemNotice: notice('agent_selected', 'Du sprichst jetzt mit Mira.'),
      attachments: [{ kind: 'file', url: 'https://x.test/f', altText: 'f' }],
    } as Partial<SemanticAnswer>),
  );
  assert.equal(text, 'Du sprichst jetzt mit Mira.');
});

test('a choice card degrades to numbered plain text (criterion 30)', () => {
  const text = render(
    answer('', MIRA, {
      interactive: {
        kind: 'choice',
        question: 'Welche Variante?',
        options: [
          { label: 'Schnell', value: 'fast' },
          { label: 'Gründlich', value: 'deep' },
        ],
      },
    } as unknown as Partial<SemanticAnswer>),
  );
  assert.equal(text, 'Welche Variante?\n1) Schnell\n2) Gründlich');
});

test('attachments stay as plain links without an icon', () => {
  const text = render(answer('Hier.', MIRA, { attachments: [{ kind: 'image', url: 'https://x.test/a.png', altText: 'Chart' }] } as Partial<SemanticAnswer>));
  assert.equal(text, 'Hier.\n\n<https://x.test/a.png|Chart>');
});

test('no undeclared decoration reaches the user (criterion 31)', () => {
  const maximal = answer('Antwort.', MIRA, {
    followUps: [{ label: 'Mehr', prompt: 'Zeig mehr' }],
    disclaimer: 'Ohne Gewähr',
    verifier: { status: 'verified' },
    agentsConsulted: [{ agentId: 'a-ben', name: 'Ben' }],
    verbosity: { effective: 'brief', source: 'configured' },
  } as unknown as Partial<SemanticAnswer>);
  const text = render(maximal);
  assert.equal(text, 'Antwort.');
  for (const marker of ['💡', '👀', '🔎', '✨', 'Konsultiert', 'Direkte Antwort', 'Kürzer', 'Ohne Gewähr', 'Zeig mehr']) {
    assert.ok(!text.includes(marker), `rendered text must not contain ${marker}`);
  }
});

test('every decoration the Slack channel can attach is declared for slack', () => {
  const { admitted, refused } = admitDecorations(SLACK_CHANNEL_TYPE, SLACK_DECORATIONS);
  assert.deepEqual(refused, []);
  assert.deepEqual(admitted.map((d) => d.id), ['ai_disclosure_line']);
});

test('the removed decorations are refused for slack, including the receipt reaction', () => {
  const { admitted, refused } = admitDecorations(
    SLACK_CHANNEL_TYPE,
    REMOVED_DECORATIONS.map((id) => ({ id })),
  );
  assert.deepEqual(admitted, []);
  assert.equal(refused.length, REMOVED_DECORATIONS.length);
  assert.ok(refused.some((r) => r.id === 'receipt_reaction' && r.reason === 'removed'));
});

test('rich-only decorations are not declared for slack', () => {
  const { admitted } = admitDecorations(SLACK_CHANNEL_TYPE, [
    { id: 'decision_card' },
    { id: 'follow_up_options' },
    { id: 'answer_details' },
    { id: 'ai_disclosure_chip' },
  ]);
  assert.deepEqual(admitted, []);
});

test('mdToSlack converts links, bold and headings', () => {
  assert.equal(mdToSlack('**fett** und [Doku](https://a.test/x)'), '*fett* und <https://a.test/x|Doku>');
  assert.equal(mdToSlack('## Titel'), '*Titel*');
});
