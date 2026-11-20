import type { ChatAgent, PaceClock, SemanticAnswer, Speaker, SystemNotice } from '@omadia/channel-sdk';

import { SlackOutbox, type SlackSink } from '../src/outbox.js';

export const MIRA: Speaker = { kind: 'agent', agentId: 'a-mira', slug: 'mira', displayName: 'Mira' };
export const BEN: Speaker = { kind: 'agent', agentId: 'a-ben', slug: 'ben', displayName: 'Ben' };

export function answer(text: string, speaker: Speaker | undefined = MIRA, extra: Partial<SemanticAnswer> = {}): SemanticAnswer {
  return { text, ...(speaker ? { speaker } : {}), ...extra } as SemanticAnswer;
}

export function notice(code: SystemNotice['code'], text: string): SystemNotice {
  return { code, text, locale: 'de' };
}

export interface SinkCall {
  kind: 'post' | 'command' | 'ephemeral';
  target: string;
  text: string;
  threadTs?: string;
}

/** A sink that records everything the plugin would send to Slack. */
export class RecordingSink implements SlackSink {
  readonly calls: SinkCall[] = [];
  async sendText(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
    this.calls.push({ kind: 'post', target: channel, text, ...(threadTs ? { threadTs } : {}) });
    return `${String(this.calls.length)}.000100`;
  }
  async replyToCommand(responseUrl: string, text: string): Promise<void> {
    this.calls.push({ kind: 'command', target: responseUrl, text });
  }
  async sendEphemeral(channel: string, user: string, text: string): Promise<void> {
    this.calls.push({ kind: 'ephemeral', target: `${channel}/${user}`, text });
  }
}

/** An outbox that also remembers every answer handed to it. */
export class SpyOutbox extends SlackOutbox {
  readonly answers: SemanticAnswer[] = [];
  constructor(readonly sink: RecordingSink = new RecordingSink()) {
    super(sink);
  }
  override deliver(a: SemanticAnswer, t: Parameters<SlackOutbox['deliver']>[1]): Promise<boolean> {
    this.answers.push(a);
    return super.deliver(a, t);
  }
}

export function agentReturning(a: SemanticAnswer, seen: Array<Parameters<ChatAgent['chat']>[0]> = []): ChatAgent {
  return {
    chat: async (input: Parameters<ChatAgent['chat']>[0]) => {
      seen.push(input);
      return a;
    },
  } as unknown as ChatAgent;
}

/** A manual clock: timers fire only when the test advances time (as in the kernel's channelPace test). */
export function manualClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; every?: number; id: number; done?: boolean }[] = [];
  let nextId = 1;
  const clock: PaceClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
    setInterval: (fn, ms) => {
      const t = { at: now + ms, fn, every: ms, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearInterval: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every !== undefined) due.at += due.every;
      else due.done = true;
      due.fn();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  return { clock, advance };
}
