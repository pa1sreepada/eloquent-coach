// Meeting types: [value stored on the meeting, short label]. The value decides the live coaching lens and the
// summary sections (matched by keyword in the backend), so keep the keywords when renaming.
export const MODES: [string, string][] = [
  ['General Executive', 'General'],
  ['Team Meeting', 'Team Meeting'],
  ['Board & Investor Pitch', 'Board & Investor'],
  ['1:1 Coaching & Feedback', '1:1 & Feedback'],
  ['Negotiation & Deal Mode', 'Negotiation'],
  ['Conflict Resolution', 'Conflict'],
  ['OKR & Delivery Review', 'Delivery Review'],
  ['Quarterly Financial Earnings', 'Quarterly Earnings'],
  ['Technical Knowledge Transfer', 'Technical KT'],
  ['Leadership Knowledge Transfer', 'Leadership KT'],
  ['Fireside Chat & Guest Speaker', 'Fireside / Host'],
  ['YouTube & Learning Session', 'YouTube / Learning'],
];

// First match wins, so the specific types come before the broad ones.
const GUESSES: [RegExp, string][] = [
  [/\b(earnings|quarterly results|q[1-4] results|financial review)\b/i, 'Quarterly Financial Earnings'],
  [/\b(board|investor|investors|fundrais)/i, 'Board & Investor Pitch'],
  [/\b(leadership (kt|transition|handover)|transition plan)\b/i, 'Leadership Knowledge Transfer'],
  [/\b(kt|knowledge transfer|handover|hand-over|onboarding|walkthrough|deep dive|tech talk)\b/i, 'Technical Knowledge Transfer'],
  [/\b(negotiat|contract|pricing|deal|vendor|procurement)/i, 'Negotiation & Deal Mode'],
  [/\b(escalation|conflict|retro on incident|postmortem dispute)\b/i, 'Conflict Resolution'],
  [/\b(okr|qbr|delivery review|program review|status review|roadmap review|steerco|steering)\b/i, 'OKR & Delivery Review'],
  [/(\b1:1\b|\b1-1\b|\bone[- ]on[- ]one\b|\b1on1\b|\bskip[- ]level\b)/i, '1:1 Coaching & Feedback'],
  [/\b(fireside|keynote|panel|ama|all[- ]hands|town ?hall)\b/i, 'Fireside Chat & Guest Speaker'],
  [/\b(team (meeting|sync|standup|weekly)|standup|stand-up|staff meeting|weekly sync)\b/i, 'Team Meeting'],
];

/** Best-guess meeting type from a calendar title; null when nothing obvious matches. */
export function guessMode(title: string): string | null {
  for (const [re, mode] of GUESSES) if (re.test(title)) return mode;
  return null;
}
