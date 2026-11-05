import { deckReducer, initialDeck, type DeckState } from '../src/hud/cardDeck.ts'
import { align, createAligner, paginate } from '../src/hud/scriptAligner.ts'
import type { CoachCard } from '../src/hud/protocol.ts'
import assert from 'node:assert/strict'
import { parseSummary, toHtml, toPlain } from '../src/components/summaryFormat.ts'
const now = Date.now()
const c = (id: string, priority: 1|2|3, headline: string, ttl = 75, t = now): CoachCard =>
  ({ id, kind: 'question', headline, body: '', priority, ttl_s: ttl, trigger: 't', created_at_ms: t })
let s: DeckState = initialDeck
s = deckReducer(s, { type: 'card', card: c('a', 3, 'Ask who owns the migration timeline') })
assert.equal(s.active?.id, 'a')
s = deckReducer(s, { type: 'card', card: c('b', 1, 'Counter capacity concern with contractor budget') })
assert.equal(s.active?.id, 'b', 'p1 preempts'); assert.equal(s.queue[0].id, 'a')
s = deckReducer(s, { type: 'card', card: c('b', 1, 'dup') }); assert.equal(s.queue.length, 1, 'dedupe')
// Streamed card: headline first, body fills in place (active or queued), unknown ids are ignored
{
  let t = deckReducer(initialDeck, { type: 'card', card: { ...c('h', 2, 'Who owns QA?'), partial: true } })
  t = deckReducer(t, { type: 'card', card: { ...c('q', 3, 'Queued one'), partial: true } })
  t = deckReducer(t, { type: 'card_update', card: { ...c('h', 2, 'Who owns QA?'), body: '40 open bugs' } })
  assert.equal(t.active?.body, '40 open bugs'); assert.equal(t.active?.partial, false)
  t = deckReducer(t, { type: 'card_update', card: { ...c('q', 3, 'Queued one'), body: 'later' } })
  assert.equal(t.queue[0].body, 'later')
  assert.equal(deckReducer(t, { type: 'card_update', card: c('zz', 1, 'gone') }), t)
}
// I speak the card → pinned + used; a new p1 must not preempt while pinned
s = deckReducer(s, { type: 'speech', speaker: 'Me', text: 'we could counter the capacity concern with contractor', final: false })
assert.ok(s.pinned && s.used.includes('b'))
s = deckReducer(s, { type: 'card', card: c('d', 1, 'Something urgent here now') })
assert.equal(s.active?.id, 'b', 'no preempt while pinned')
s = deckReducer(s, { type: 'silence', speaker: 'Me' })
assert.equal(s.active?.id, 'd', 'advance after delivery'); assert.ok(!s.pinned)
// navigation + ttl
s = deckReducer(s, { type: 'next' }); assert.equal(s.active?.id, 'a')
s = deckReducer(s, { type: 'tick', now: now + 80_000 }); assert.equal(s.active, null); assert.equal(s.queue.length, 0)
// lock prevents ttl drop
s = deckReducer(initialDeck, { type: 'card', card: c('e', 2, 'x y z', 1) })
s = deckReducer(s, { type: 'toggleLock' }); s = deckReducer(s, { type: 'tick', now: now + 5000 }); assert.equal(s.active?.id, 'e')
// cap
s = initialDeck; for (let i = 0; i < 10; i++) s = deckReducer(s, { type: 'card', card: c('q' + i, 2, 'h' + i) })
assert.equal(s.queue.length, 6)
// aligner
const script = 'Bottom line: we prioritize enterprise. ARR grew 40% last quarter. The ask is two engineers for the migration.'
const al = createAligner(script)
al.pointer = align(al, 'bottom line we prioritize')
assert.equal(al.pointer, 4)
al.pointer = align(al, 'uh so ARR grew forty') // ASR said "forty", script "40%": 2/3 tail match
assert.equal(al.pointer, 4, 'below threshold stays put')
al.pointer = align(al, 'ARR grew 40% last quarter')
assert.equal(al.pointer, 10)
al.pointer = align(al, 'bottom line') ; assert.equal(al.pointer, 10, 'never moves back')
assert.ok(paginate(script, 8).length >= 2)
// Summary copy: Markdown subset -> rich HTML (Slack/email) and clean plain text
const sum = '**Bottom line:** Ship <enterprise> first.\n\n**Action items**\n- **Sarah** — Draft plan (Fri)\n- **Unassigned** — Staffing'
assert.deepEqual(parseSummary(sum).map(b => b.kind), ['para', 'heading', 'list'])
assert.equal(toHtml(sum, 'Sync · Tue'),
  '<p><b>Sync · Tue</b></p><p><b>Bottom line:</b> Ship &lt;enterprise&gt; first.</p><p><b>Action items</b></p>' +
  '<ul><li><b>Sarah</b> — Draft plan (Fri)</li><li><b>Unassigned</b> — Staffing</li></ul>')
assert.equal(toPlain(sum, 'Sync · Tue'),
  'Sync · Tue\n\nBottom line: Ship <enterprise> first.\n\nAction items\n• Sarah — Draft plan (Fri)\n• Unassigned — Staffing')
console.log('hud tests: all passed')
