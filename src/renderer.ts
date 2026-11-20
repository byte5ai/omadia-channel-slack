import {
  renderPlainAnswer,
  type OutgoingAttachment,
  type PlainAnswerOptions,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

/** The channel type this plugin declares to the SDK's decoration registry. */
export const SLACK_CHANNEL_TYPE = 'slack';

/**
 * Every decoration this channel can put around an answer. Slack renders text
 * only, so the single entry is the AI disclosure line, and the line is already
 * part of `answer.text` (the kernel applies the operator's
 * `ai_disclosure_frequency`, #2087). The channel adds nothing of its own: no
 * receipt reaction, follow-up list, disclaimer, verifier badge or consulted
 * footer (spec 2042 §5.14, #2086). `admitDecorations('slack', ...)` is what the
 * registry test runs this list through.
 */
export const SLACK_DECORATIONS: ReadonlyArray<{ readonly id: string }> = Object.freeze([
  { id: 'ai_disclosure_line' },
]);

export type SlackRenderOptions = PlainAnswerOptions;

/**
 * Render the orchestrator's channel-agnostic {@link SemanticAnswer} into one
 * Slack message in `mrkdwn`: what a colleague would write.
 *
 * The SDK's plain-text renderer decides the content (name line only where
 * INV-4 wants it, colleagues' contributions as "Mira: ...", a `system` notice
 * as its own text, cards as numbered text). This function only adds what is
 * content rather than decoration: attachments as plain links. It never adds a
 * status line, chip, footer or follow-up list.
 */
export function renderSlackAnswer(answer: SemanticAnswer, opts: SlackRenderOptions): string {
  const parts: string[] = [renderPlainAnswer(answer, opts)];
  // A system notice stands alone: no attachment can ride along under it.
  if (answer.speaker?.kind !== 'system') {
    const links = renderAttachments(answer.attachments);
    if (links) parts.push(links);
  }
  return mdToSlack(parts.filter((p) => p.trim().length > 0).join('\n\n')).trim();
}

/**
 * Best-effort Markdown → Slack `mrkdwn`. Slack uses `*bold*`, `_italic_`,
 * `~strike~`, `` `code` `` and `<url|label>` links. We only do the safe, common
 * conversions and leave anything ambiguous untouched.
 */
export function mdToSlack(md: string): string {
  return (
    md
      // [label](url)  →  <url|label>   (do links before bold so the URL is intact)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')
      // **bold** / __bold__  →  *bold*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      // strip leading markdown heading hashes, keep the heading text bold
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
  );
}

function renderAttachments(items: OutgoingAttachment[] | undefined): string | undefined {
  const lines = (items ?? []).map((a) => `<${a.url}|${a.altText}>`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}
