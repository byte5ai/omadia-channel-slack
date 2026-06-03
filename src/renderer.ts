import type {
  FollowUpOption,
  OutgoingAttachment,
  OutgoingChoiceCard,
  SemanticAnswer,
} from '@omadia/channel-sdk';

/**
 * Render the orchestrator's channel-agnostic {@link SemanticAnswer} into a
 * single Slack message in `mrkdwn`.
 *
 * v0.1.0 ships text-only: every richer element degrades gracefully (a choice
 * card becomes a "reply with one of these" list, follow-ups become copyable
 * suggestions, attachments become links). This matches the SDK's documented
 * graceful-degradation contract for connectors without rich UI. Block Kit
 * (the `block_kit` adapter) is a planned later version.
 */
export function renderAnswer(a: SemanticAnswer): string {
  const parts: string[] = [];

  const body = mdToSlack(a.text).trim();
  if (body) parts.push(body);

  if (a.interactive?.kind === 'choice') {
    parts.push(renderChoice(a.interactive));
  }

  const links = renderAttachments(a.attachments);
  if (links) parts.push(links);

  if (a.followUps && a.followUps.length > 0) {
    parts.push(renderFollowUps(a.followUps));
  }

  if (a.disclaimer) parts.push(`_${a.disclaimer}_`);

  return parts.join('\n\n');
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

function renderChoice(choice: OutgoingChoiceCard): string {
  const lines = [`*${choice.question}*`];
  if (choice.rationale) lines.push(`_${choice.rationale}_`);
  for (const opt of choice.options) lines.push(`• ${opt.label}`);
  lines.push('_Bitte antworte mit einer der Optionen._');
  return lines.join('\n');
}

function renderFollowUps(followUps: FollowUpOption[]): string {
  const lines = ['💡 _Du kannst auch fragen:_'];
  for (const f of followUps.slice(0, 5)) lines.push(`• ${f.prompt}`);
  return lines.join('\n');
}

function renderAttachments(items: OutgoingAttachment[] | undefined): string | undefined {
  const lines: string[] = [];
  for (const a of items ?? []) {
    const icon = a.kind === 'image' ? '🖼' : '📎';
    lines.push(`${icon} <${a.url}|${a.altText}>`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
