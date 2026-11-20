// Plain-text transcript for pasting into another app or LLM. Labels match the summary prompt:
// "Me" is the leader, everyone else is "Participant".
export interface CopyLine { speaker: string; text: string; timestamp?: string; voice?: string | null }

const clock = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
};

export function transcriptText(lines: CopyLine[], { times = true } = {}): string {
  return lines
    .filter(l => l.voice !== 'echo' && l.text.trim())   // echo lines repeat a Participant line
    .map(l => {
      const who = l.speaker !== 'Me' ? 'Participant' : l.voice === 'room' ? 'Participant (in the room)' : 'Me';
      const at = times ? clock(l.timestamp) : '';
      return `${at ? `[${at}] ` : ''}${who}: ${l.text.trim().replace(/\s+/g, ' ')}`;
    })
    .join('\n');
}

export function llmHandoff(prompt: string, lines: CopyLine[]): string {
  return `${prompt.trim()}\n\nTRANSCRIPT:\n${transcriptText(lines)}\n`;
}
