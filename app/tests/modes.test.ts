import assert from 'node:assert/strict'
import { guessMode } from '../src/components/meetingModes.ts'

const cases: [string, string | null][] = [
  ['Q3 Earnings prep', 'Quarterly Financial Earnings'],
  ['Leadership handover: Payments org', 'Leadership Knowledge Transfer'],
  ['Checkout KT session', 'Technical Knowledge Transfer'],
  ['Sarah / Pavan 1:1', '1:1 Coaching & Feedback'],
  ['Skip-level with Raj', '1:1 Coaching & Feedback'],
  ['Platform team weekly sync', 'Team Meeting'],
  ['Peak readiness steerco', 'OKR & Delivery Review'],
  ['Vendor pricing call', 'Negotiation & Deal Mode'],
  ['Engineering all-hands', 'Fireside Chat & Guest Speaker'],
  ['Ideal customer profile', null],
  ['Lunch', null],
]
for (const [title, mode] of cases) assert.equal(guessMode(title), mode, title)
console.log('modes: ok')
