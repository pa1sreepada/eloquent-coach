import assert from 'node:assert/strict'
import { canon, canonText, parseScript, spokenWordCount } from '../src/prompter/script.ts'
import {
  PARAPHRASED, READ, SKIPPED, createFollower, hear, nextSentence, prevSentence, reentryText, report, seek, setPaused, type Follower,
} from '../src/prompter/follower.ts'
import { DEFAULT_PROMPTER, sanitizePrompter } from '../src/prompter/settings.ts'

// ---- canonical words: what the script says vs. what ASR writes
assert.deepEqual(canon("we're"), ['we', 'are'])
assert.deepEqual(canon('20%'), ['twenty', 'percent'])
assert.deepEqual(canon('$5M'), ['five', 'million', 'dollars'])
assert.deepEqual(canon('2026'), ['twenty', 'twenty', 'six'])
assert.deepEqual(canonText('R&D, follow-up'), ['r', 'and', 'd', 'follow', 'up'])

// ---- markup: sections, notes and cues are shown but never expected to be spoken
const S = `# Why now
Good morning everyone. Thanks for making time today. [pause]
> smile here
Our revenue grew 20% last quarter, and we're on track for $5M by 2026.
# The ask
I need *two decisions* from this group today. First, approve the hiring plan for the platform team. [look up]
Second, agree that pricing moves to annual contracts in March.
# Close
That's the whole ask. Thank you.`
const parsed = parseScript(S)
assert.deepEqual(parsed.sections.map(s => s.title), ['Why now', 'The ask', 'Close'])
assert.deepEqual(parsed.tokens.filter(t => t.kind === 'cue').map(t => t.text), ['pause', 'look up'])
assert.ok(parsed.tokens.some(t => t.kind === 'note' && t.text === 'smile here'))
assert.ok(parsed.tokens.some(t => t.kind === 'word' && t.emph && t.text === 'two'))
assert.ok(!parsed.units.some(u => u.w === 'smile' || u.w === 'pause'), 'notes and cues are not spoken')
assert.equal(parseScript('Just one line.').sections[0].title, 'Script')
assert.equal(spokenWordCount('Hi [pause] there.\n> note\nWe grew 20%.'), 5, 'written words, cues and notes excluded')

// ---- following: speak word by word like streaming ASR (partials, then a final)
let t = 0, n = 0
function say(f: Follower, text: string) {
  const id = `u${n++}`, ws = text.split(' ')
  for (let i = 1; i <= ws.length; i++) { t += 300; hear(f, { id, text: ws.slice(0, i).join(' '), final: false }, t) }
  t += 200
  hear(f, { id, text, final: true, t0_ms: 0, t1_ms: ws.length * 400 }, t)
}
const fresh = () => { t = 0; return createFollower(S) }
const unitOf = (f: Follower, word: string) => f.script.units.findIndex(u => u.w === word)

{ // fillers, "the" inserted, numbers spoken as words, contraction expanded
  const f = fresh()
  say(f, 'good morning everyone')
  say(f, 'um thanks for making the uh time today')
  say(f, 'our revenue you know grew like twenty percent last quarter')
  say(f, 'and we are on track for five million by twenty twenty six')
  assert.equal(f.mode, 'tracking')
  assert.equal(f.cursor, unitOf(f, 'need') - 1, 'cursor sits at "I need…"')
  assert.ok(f.stats.fillers >= 2, 'fillers counted')
  for (let u = 0; u < f.cursor; u++) assert.equal(f.status[u], READ)
}
{ // chatter before starting doesn't move anything
  const f = fresh()
  say(f, 'can everyone hear me okay'); say(f, 'great')
  assert.equal(f.mode, 'ready'); assert.equal(f.cursor, 0); assert.equal(f.startedAt, null)
  say(f, 'good morning everyone')
  assert.equal(f.mode, 'tracking'); assert.equal(f.cursor, 3)
}
{ // a short aside keeps tracking; a longer ad-lib goes off script and waits, then picks up where I rejoin
  const f = fresh()
  say(f, 'good morning everyone'); say(f, 'and wow what a crowd')
  assert.equal(f.mode, 'tracking'); assert.equal(f.cursor, 3)
  say(f, 'thanks for making time today')
  say(f, 'before the numbers let me tell you a quick story about a customer we met in Denver last week')
  assert.equal(f.mode, 'offscript'); assert.equal(f.cursor, 8)
  assert.match(reentryText(f, 3), /^Our revenue grew/)
  say(f, 'anyway our revenue grew twenty percent last quarter')
  assert.equal(f.mode, 'tracking'); assert.equal(f.cursor, 15)
  assert.equal(report(f, t).adlib_count, 1)
}
{ // jumping ahead skips the middle and finishes; skipped sentences are reported
  const f = fresh()
  say(f, 'good morning everyone thanks for making time today')
  say(f, 'actually let me skip ahead given time')
  say(f, "that's the whole ask thank you")
  assert.equal(f.mode, 'done')
  const r = report(f, t)
  assert.ok(r.finished)
  assert.equal(r.skipped.length, 4)
  assert.equal(f.status[unitOf(f, 'revenue')], SKIPPED)
  assert.ok(r.coverage_pct < 40)
}
{ // going back to repeat a sentence doesn't jump forward or mark anything skipped
  const f = fresh()
  say(f, 'good morning everyone thanks for making time today our revenue grew twenty percent last quarter')
  say(f, 'sorry let me say that again')
  say(f, 'our revenue grew twenty percent last quarter')
  assert.equal(f.mode, 'tracking'); assert.equal(f.cursor, 15)
  assert.equal(report(f, t).skipped.length, 0)
}
{ // saying a sentence in my own words still counts it, marked as paraphrased
  const f = fresh()
  say(f, 'good morning everyone thanks for making time today our revenue grew twenty percent last quarter and we are on track for five million by twenty twenty six')
  say(f, 'I need two decisions from this group today')
  say(f, 'so the hiring plan for our platform team needs your approve today')
  assert.ok(f.cursor >= unitOf(f, 'second'), `moved past the sentence (cursor ${f.cursor})`)
  const hiring = unitOf(f, 'hiring')
  assert.ok(f.status[hiring] === READ || f.status[hiring] === PARAPHRASED)
}
{ // manual controls: pause ignores speech, next/prev move a sentence, seek jumps
  const f = fresh()
  say(f, 'good morning everyone')
  setPaused(f, true, t)
  say(f, 'thanks for making time today')
  assert.equal(f.mode, 'paused'); assert.equal(f.cursor, 3)
  setPaused(f, false, t)
  assert.equal(f.mode, 'tracking')
  nextSentence(f, t); assert.equal(f.cursor, 8)
  prevSentence(f, t); assert.equal(f.cursor, 3)
  seek(f, unitOf(f, 'second'), t); assert.equal(f.cursor, unitOf(f, 'second'))
  say(f, 'second agree that pricing moves to annual contracts in March')
  assert.equal(f.cursor, f.script.sentences[f.script.sentences.length - 2].unitStart, 'at "That\'s the whole ask"')
}
{ // stays fast on a long script
  const long = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} talks about topic ${i % 17} and the plan for team ${i % 5}.`).join(' ')
  const f = createFollower(long)
  const t0 = performance.now()
  for (let i = 0; i < 100; i++) hear(f, { id: `x${i}`, text: 'this is something completely unrelated to the script we wrote', final: false }, i * 100)
  assert.ok((performance.now() - t0) / 100 < 50, 'under 50 ms per transcript update')
}

// ---- settings are clamped
assert.equal(sanitizePrompter({ fontSize: 500 }).fontSize, 72)
assert.equal(sanitizePrompter({ mirror: 'yes' as unknown as boolean }).mirror, DEFAULT_PROMPTER.mirror)
assert.deepEqual(sanitizePrompter(null), DEFAULT_PROMPTER)

console.log('prompter ok')
