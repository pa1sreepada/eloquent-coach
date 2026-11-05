// Meeting types: [value stored on the meeting, short label]. The value decides the live coaching lens and the
// summary sections (matched by keyword in the backend), so keep the keywords when renaming.
export const MODES: [string, string][] = [
  ['General Executive', 'General'],
  ['Board & Investor Pitch', 'Board & Investor'],
  ['1:1 Coaching & Feedback', '1:1 & Feedback'],
  ['Negotiation & Deal Mode', 'Negotiation'],
  ['Conflict Resolution', 'Conflict'],
  ['OKR & Delivery Review', 'Delivery Review'],
  ['Fireside Chat & Guest Speaker', 'Fireside / Host'],
  ['YouTube & Learning Session', 'YouTube / Learning'],
];
