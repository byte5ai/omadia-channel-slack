import {
  InMemorySpeakerHistoryStore,
  type AgentSpeaker,
  type SemanticAnswer,
  type Speaker,
  type SpeakerHistoryStore,
  type SystemNotice,
} from '@omadia/channel-sdk';

import { renderSlackAnswer } from './renderer.js';

/** The two ways bytes leave this plugin towards Slack. */
export interface SlackSink {
  /** `chat.postMessage` into a conversation, optionally under a thread. */
  sendText(channel: string, text: string, threadTs?: string): Promise<void>;
  /** Answer a slash command ephemerally through its `response_url`. */
  replyToCommand(responseUrl: string, text: string): Promise<void>;
  /** `chat.postEphemeral`: only `user` sees it. For a command's follow-up once its `response_url` has expired. */
  sendEphemeral(channel: string, user: string, text: string): Promise<void>;
}

/** Where one message goes, and which conversation its speaker history belongs to. */
export interface DeliveryTarget {
  readonly conversationId: string;
  /** Session scope: the unit INV-4 reasons about ("several agents spoke here"). */
  readonly conversationKey: string;
  readonly threadTs?: string;
  /** Slash commands: reply here (ephemeral) instead of posting. */
  readonly responseUrl?: string;
  /** The person who typed the command (the only reader of an ephemeral follow-up). */
  readonly commandUserId?: string;
  /**
   * The work outlived the reply window of the inbound request (the command's
   * `response_url`): deliver as a new message instead. For a command that is an
   * ephemeral message, so a selection never becomes public.
   */
  readonly followUp?: boolean;
}

export const SYSTEM_SPEAKER: Speaker = Object.freeze({ kind: 'system' });

/** The plugin's own default locale for texts it has to write itself. */
const DEFAULT_LOCALE = 'de';

/** A `system` answer: the management layer (or this channel on its behalf) speaks. */
export function systemAnswer(code: SystemNotice['code'], text: string, locale = DEFAULT_LOCALE): SemanticAnswer {
  return { text, speaker: SYSTEM_SPEAKER, systemNotice: { code, text, locale } };
}

/**
 * The ONE emitter of this channel. Every user-visible Slack message, an
 * agent's answer, a kernel notice or a notice this plugin writes itself (a
 * failed turn), is a {@link SemanticAnswer} that goes through {@link deliver}:
 * rendered by the SDK's plain-text renderer, so the speaker rules (INV-3/4/7)
 * and the decoration rules (§5.14) hold for all of them. `outbox.test.ts`
 * counts the code paths that can reach {@link SlackSink} and fails when a
 * second one appears.
 *
 * Slack has one identity per installation (one bot token), so
 * `nativeIdentity` is false and the SDK adds a name line where several agents
 * speak. The speaker history is process-local: after a restart the first
 * answer of a one-agent conversation again gets no name line, and a
 * multi-agent conversation is recognised again from its second speaker on.
 */
export class SlackOutbox {
  constructor(
    private readonly sink: SlackSink,
    private readonly speakerHistory: SpeakerHistoryStore = new InMemorySpeakerHistoryStore(),
    private readonly nativeIdentity = false,
  ) {}

  /** Render and send one answer. Returns false when there was nothing to say. */
  async deliver(answer: SemanticAnswer, target: DeliveryTarget): Promise<boolean> {
    const text = renderSlackAnswer(answer, {
      nativeIdentity: this.nativeIdentity,
      conversationKey: target.conversationKey,
      speakerHistory: this.speakerHistory,
    });
    if (text.length === 0) return false;
    if (target.responseUrl && target.followUp && target.commandUserId) {
      await this.sink.sendEphemeral(target.conversationId, target.commandUserId, text);
    } else if (target.responseUrl && !target.followUp) {
      await this.sink.replyToCommand(target.responseUrl, text);
    } else {
      await this.sink.sendText(target.conversationId, text, target.threadTs);
    }
    return true;
  }

  /**
   * The pace acknowledgement (`runPacedTurn`, spec §5.8): the SDK's fixed
   * "on it" template, said under the agent that will answer (the resolver
   * announces it before the answer). The speaker is required: there is no
   * acknowledgement without somebody to say it.
   */
  deliverAck(text: string, speaker: AgentSpeaker, target: DeliveryTarget): Promise<boolean> {
    return this.deliver({ text, speaker }, target);
  }

  /** Send a `system` notice. */
  deliverSystem(code: SystemNotice['code'], text: string, target: DeliveryTarget): Promise<boolean> {
    return this.deliver(systemAnswer(code, text), target);
  }
}
