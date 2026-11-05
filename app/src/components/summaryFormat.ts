// The backend stores summaries as a small Markdown subset (see format_summary in
// post_meeting_synthesis.py): "**Heading**" lines, "- " bullets, paragraphs and inline **bold**.
// These helpers render it and produce clipboard versions that paste cleanly into Slack and email.

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; items: string[] };

export type Segment = { text: string; bold: boolean };

const HEADING = /^\*\*([^*]+?)\*\*:?$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

export function parseSummary(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = HEADING.exec(line);
    const b = BULLET.exec(line);
    const last = blocks[blocks.length - 1];
    if (h) blocks.push({ kind: 'heading', text: h[1].replace(/:$/, '') });
    else if (b) {
      if (last?.kind === 'list') last.items.push(b[1]);
      else blocks.push({ kind: 'list', items: [b[1]] });
    } else blocks.push({ kind: 'para', text: line });
  }
  return blocks;
}

export function inline(text: string): Segment[] {
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(part =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? { text: part.slice(2, -2), bold: true }
      : { text: part, bold: false });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inlineHtml = (s: string) => inline(s).map(g => (g.bold ? `<b>${esc(g.text)}</b>` : esc(g.text))).join('');
const inlinePlain = (s: string) => inline(s).map(g => g.text).join('');

/** Rich text for Slack, Gmail, Outlook and Docs: bold headings and real bullet lists. */
export function toHtml(text: string, title?: string): string {
  const out: string[] = title ? [`<p><b>${esc(title)}</b></p>`] : [];
  for (const b of parseSummary(text)) {
    if (b.kind === 'heading') out.push(`<p><b>${esc(b.text)}</b></p>`);
    else if (b.kind === 'para') out.push(`<p>${inlineHtml(b.text)}</p>`);
    else out.push(`<ul>${b.items.map(i => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`);
  }
  return out.join('');
}

/** Plain-text fallback: no Markdown symbols, "•" bullets, blank line between sections. */
export function toPlain(text: string, title?: string): string {
  const out: string[] = title ? [title] : [];
  for (const b of parseSummary(text)) {
    if (b.kind === 'heading') out.push(`\n${b.text}`);
    else if (b.kind === 'para') out.push(`${out.length ? '\n' : ''}${inlinePlain(b.text)}`);
    else out.push(...b.items.map(i => `• ${inlinePlain(i)}`));
  }
  return out.join('\n').trim();
}
