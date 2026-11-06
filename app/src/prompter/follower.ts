// Voice-following engine. Feeds on the speech recogniser's partial/final transcripts and keeps a cursor
// (next canonical unit to read) in a parsed script. It tolerates fillers and small ad-libs, notices
// when I go off script, re-acquires the script wherever I pick it back up (even another section),
// and recognises when I paraphrase a sentence instead of reading it word for word.
import { canonText, parseScript, sectionAt, sentenceAt, type ParsedScript } from './script.ts'

export type FollowMode = 'ready' | 'tracking' | 'offscript' | 'paused' | 'done'

/** Per-unit outcome, for the screen and the rehearsal report. */
export const UNREAD = 0, READ = 1, SKIPPED = 2, PARAPHRASED = 3

// Pure hesitation noises: dropped before matching.
const HARD_FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'eh', 'hmm', 'hm', 'mm', 'mhm', 'mmm'])
// Words people add to sound conversational; cheap to insert between script words.
const SOFT = new Set(['like', 'so', 'basically', 'actually', 'literally', 'right', 'okay', 'ok', 'well', 'just',
  'really', 'you', 'know', 'i', 'mean', 'kind', 'sort', 'of', 'and', 'the', 'a', 'yeah', 'anyway', 'honestly',
  'now', 'look', 'see', 'think', 'guess', 'totally', 'very', 'pretty', 'quite', 'oh', 'yes', 'no', 'folks', 'guys'])
// Script words a speaker can drop without it meaning they skipped anything.
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'it', 'that', 'this',
  'we', 'i', 'you', 'so', 'at', 'be', 'with', 'as', 'by', 'or', 'our', 'your', 'my', 'will', 'can', 'do', 'have',
  'has', 'was', 'were', 'but', 'if', 'then', 'there', 'their', 'they', 'just', 'very', 'really', 'not', 'all'])

export interface FollowOptions {
  tail: number          // spoken words considered per update
  lookBack: number      // units behind the cursor searched locally
  lookAhead: number     // units ahead of the cursor searched locally
  offScriptWords: number
}
export const DEFAULT_OPTIONS: FollowOptions = { tail: 14, lookBack: 30, lookAhead: 70, offScriptWords: 6 }

export interface Adlib { atUnit: number; startMs: number; endMs: number; words: number }

export interface Follower {
  script: ParsedScript
  opts: FollowOptions
  cursor: number
  mode: FollowMode
  status: Uint8Array
  // Spoken stream (canonical words, fillers removed): finished utterances + the one in progress.
  done: string[]
  doneOffset: number
  cur: string[]
  curId: string | null
  lastMatchAbs: number      // absolute stream index of the last word matched to the script
  trailing: number          // content words said since then
  driftAt: number | null    // when I last left the script
  adlibs: Adlib[]
  startedAt: number | null
  endedAt: number | null
  lastHeard: number
  lastAdvance: number
  pausedFrom: FollowMode | null
  progress: { t: number; cursor: number }[]
  pace: { t: number; words: number; ms: number }[]
  section: number
  sectionSince: number
  sectionMs: number[]
  stats: { spokenWords: number; fillers: number; speakingMs: number; paraphrased: number; jumps: number }
}

export function createFollower(text: string | ParsedScript, opts: Partial<FollowOptions> = {}): Follower {
  const script = typeof text === 'string' ? parseScript(text) : text
  return {
    script, opts: { ...DEFAULT_OPTIONS, ...opts }, cursor: 0, mode: 'ready',
    status: new Uint8Array(script.units.length),
    done: [], doneOffset: 0, cur: [], curId: null, lastMatchAbs: -1, trailing: 0, driftAt: null, adlibs: [],
    startedAt: null, endedAt: null, lastHeard: 0, lastAdvance: 0, pausedFrom: null, progress: [], pace: [],
    section: 0, sectionSince: 0, sectionMs: script.sections.map(() => 0),
    stats: { spokenWords: 0, fillers: 0, speakingMs: 0, paraphrased: 0, jumps: 0 },
  }
}

// ---------------------------------------------------------------- word similarity
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]
}

/** Match score of a spoken word against a script word: exact, same stem, near-miss spelling, or a mismatch. */
export function wordScore(said: string, script: string): number {
  if (said === script) return 2
  if (said.length >= 4 && script.length >= 4 && said.slice(0, 4) === script.slice(0, 4)
    && Math.abs(said.length - script.length) <= 3) return 1.3          // plan / planning / planned
  if (said.length >= 5 && script.length >= 5
    && 1 - editDistance(said, script) / Math.max(said.length, script.length) >= 0.75) return 1   // recogniser misspelling
  return -1
}

// ---------------------------------------------------------------- alignment
interface Hit { start: number; end: number; matches: number; row: number; score: number; matched: number[] }

/**
 * Local alignment of the spoken tail against units[a, b). Returns the best place the tail ends in the script,
 * weighing alignment quality, words said since (ad-lib), and distance from the cursor.
 */
function search(f: Follower, tail: string[], a: number, b: number, strict: boolean): Hit | null {
  const units = f.script.units
  const n = tail.length
  const m = b - a
  if (n === 0 || m <= 0) return null
  const W = m + 1
  const H = new Float64Array((n + 1) * W)
  const M = new Float64Array((n + 1) * W)     // weighted matches along the chosen path
  const S = new Int32Array((n + 1) * W)       // path start column
  const D = new Int8Array((n + 1) * W)        // traceback: 1 diag, 2 up (inserted word), 3 left (skipped word)
  // Cost of words said after a candidate end (they're ad-lib if the candidate is right).
  const trail = new Float64Array(n + 1)
  for (let i = n - 1; i >= 0; i--) trail[i] = trail[i + 1] + (i + 1 < n ? (SOFT.has(tail[i + 1]) ? 0.1 : 0.4) : 0)
  let best: Hit | null = null
  let bestTotal = -Infinity
  for (let i = 1; i <= n; i++) {
    const said = tail[i - 1]
    const ins = SOFT.has(said) ? 0.25 : 0.9
    for (let j = 1; j <= m; j++) {
      const w = units[a + j - 1].w
      const del = STOP.has(w) ? 0.35 : 0.9
      const k = i * W + j
      const sub = wordScore(said, w)
      const diag = H[k - W - 1] + sub
      const up = H[k - W] - ins
      const left = H[k - 1] - del
      let h = 0, mm = 0, st = j, dir = 0
      if (diag > h) { h = diag; mm = M[k - W - 1] + (sub > 0 ? (STOP.has(w) ? 0.5 : 1) : 0); st = H[k - W - 1] > 0 ? S[k - W - 1] : j; dir = 1 }
      if (up > h) { h = up; mm = M[k - W]; st = S[k - W]; dir = 2 }
      if (left > h) { h = left; mm = M[k - 1]; st = S[k - 1]; dir = 3 }
      H[k] = h; M[k] = mm; S[k] = st; D[k] = dir
      if (sub <= 0 || h <= 0) continue      // a candidate end must be a matched word
      const end = a + j
      const d = end - f.cursor
      const prior = strict ? 0.004 * Math.abs(d) : d >= 0 ? 0.015 * d : 0.1 * -d
      const total = h - trail[i - 1] - prior
      const start = a + (j === S[k] ? j : S[k]) - 1
      // Weak evidence is enough only when I'm simply continuing from the cursor, not mid ad-lib.
      const near = !strict && f.startedAt !== null && f.trailing < 3 && start >= f.cursor - 3 && start <= f.cursor + 3
      const minMatches = strict ? 4 : near ? 1.5 : 3
      if (mm < minMatches || h < (strict ? 7 : 2 * minMatches - 0.8)) continue
      if (total > bestTotal) { bestTotal = total; best = { start, end, matches: mm, row: i - 1, score: h, matched: [] } }
    }
  }
  if (best) {   // trace back which script units were actually said
    let i = best.row + 1, j = best.end - a
    while (i > 0 && j > 0 && H[i * W + j] > 0) {
      const dir = D[i * W + j]
      if (dir === 1) { if (wordScore(tail[i - 1], units[a + j - 1].w) > 0) best.matched.push(a + j - 1); i--; j-- }
      else if (dir === 2) i--
      else if (dir === 3) j--
      else break
    }
    best.matched.reverse()
  }
  return best
}

// ---------------------------------------------------------------- stream helpers
const total = (f: Follower) => f.doneOffset + f.done.length + f.cur.length
function wordAt(f: Follower, abs: number): string | undefined {
  const i = abs - f.doneOffset
  return i < f.done.length ? f.done[i] : f.cur[i - f.done.length]
}
function tailWords(f: Follower, n: number): string[] {
  const t = total(f)
  const out: string[] = []
  for (let k = Math.max(f.doneOffset, t - n); k < t; k++) out.push(wordAt(f, k)!)
  return out
}
function contentSince(f: Follower, abs: number): number {
  let c = 0
  for (let k = Math.max(abs + 1, f.doneOffset, total(f) - 80); k < total(f); k++) if (!SOFT.has(wordAt(f, k)!)) c++
  return c
}

// ---------------------------------------------------------------- state changes
function enterSection(f: Follower, now: number) {
  const s = sectionAt(f.script, Math.min(f.cursor, f.script.units.length - 1))
  if (s !== f.section) {
    f.sectionMs[f.section] += now - f.sectionSince
    f.section = s
    f.sectionSince = now
  }
}

function moveTo(f: Follower, end: number, now: number, fill: (u: number) => number) {
  for (let u = f.cursor; u < end; u++) if (f.status[u] === UNREAD) f.status[u] = fill(u)
  f.cursor = Math.max(0, Math.min(end, f.script.units.length))
  f.lastAdvance = now
  f.progress.push({ t: now, cursor: f.cursor })
  if (f.progress.length > 200) f.progress.splice(0, f.progress.length - 200)
  enterSection(f, now)
}

function start(f: Follower, now: number) {
  if (f.startedAt === null) { f.startedAt = now; f.sectionSince = now; f.section = sectionAt(f.script, f.cursor) }
}

function backOnScript(f: Follower, now: number) {
  if (f.mode === 'offscript' && f.driftAt !== null) {
    f.adlibs.push({ atUnit: f.cursor, startMs: f.driftAt, endMs: now, words: f.trailing })
  }
  f.driftAt = null
  f.trailing = 0
}

function finishIfDone(f: Follower, now: number) {
  if (f.script.units.length && f.cursor >= f.script.units.length && f.mode !== 'done') {
    f.mode = 'done'
    f.endedAt = now
    f.sectionMs[f.section] += now - f.sectionSince
    f.sectionSince = now
  }
}

function applyHit(f: Follower, hit: Hit, now: number) {
  const tail = Math.min(total(f), f.opts.tail)
  f.lastMatchAbs = total(f) - tail + hit.row
  start(f, now)
  if (hit.end < f.cursor) {
    // Re-reading: a few words back is just me repeating myself; further back means I restarted a passage.
    if (f.cursor - hit.end > 3 && hit.matches >= 3) moveTo(f, hit.end, now, () => READ)
    else f.lastAdvance = now
  } else if (hit.end > f.cursor) {
    const first = hit.matched[0] ?? hit.start
    if (first - f.cursor > 12) f.stats.jumps++
    // Small gaps are words the recogniser dropped or I swallowed; longer runs are passages I skipped.
    const read = new Set<number>()
    let prev = f.cursor - 1
    for (const u of hit.matched) {
      if (u < f.cursor) { prev = Math.max(prev, u); continue }
      if (u - prev - 1 <= 3) for (let x = prev + 1; x < u; x++) read.add(x)
      read.add(u)
      prev = u
    }
    moveTo(f, hit.end, now, u => (read.has(u) ? READ : SKIPPED))
  }
  const trailing = contentSince(f, f.lastMatchAbs)
  if (trailing === 0) backOnScript(f, now)
  f.trailing = trailing
  if (trailing > 0 && f.driftAt === null) f.driftAt = now
  f.mode = trailing >= f.opts.offScriptWords ? 'offscript' : 'tracking'
  finishIfDone(f, now)
}

const stem = (w: string) => w.slice(0, 5)
const contentStems = (words: string[]) => new Set(words.filter(w => w.length >= 3 && !STOP.has(w) && !SOFT.has(w)).map(stem))

/** I said the gist of the current (or next) sentence in my own words: move past it. */
function paraphrase(f: Follower, words: string[], now: number): boolean {
  const said = contentStems(words)
  if (said.size < 2 || !f.script.sentences.length) return false
  const si = sentenceAt(f.script, f.cursor)
  for (const idx of [si, si + 1]) {
    const s = f.script.sentences[idx]
    if (!s) continue
    const from = idx === si ? Math.max(f.cursor, s.unitStart) : s.unitStart
    const need = contentStems(f.script.units.slice(from, s.unitEnd).map(u => u.w))
    if (need.size < 2) continue
    let hit = 0
    for (const w of need) if (said.has(w)) hit++
    if (hit >= Math.min(3, need.size) && hit / need.size >= 0.5) {
      start(f, now)
      moveTo(f, s.unitEnd, now, u => (u >= from ? PARAPHRASED : SKIPPED))
      f.stats.paraphrased++
      f.lastMatchAbs = total(f) - 1
      backOnScript(f, now)
      f.mode = 'tracking'
      finishIfDone(f, now)
      return true
    }
  }
  return false
}

export interface Heard { id: string; text: string; final: boolean; t0_ms?: number; t1_ms?: number }

/** Feed one transcript event (partial or final) for my own voice. Returns true if anything visible changed. */
export function hear(f: Follower, e: Heard, now: number): boolean {
  f.lastHeard = now
  if (f.mode === 'paused' || f.mode === 'done') return false
  const all = canonText(e.text)
  const words = all.filter(w => !HARD_FILLERS.has(w))
  if (f.curId !== null && f.curId !== e.id) {   // previous utterance never finalised: keep what we had
    f.done.push(...f.cur)
  }
  f.curId = e.id
  f.cur = words
  if (f.lastMatchAbs >= total(f)) f.lastMatchAbs = total(f) - 1   // a partial got shorter
  const before = { cursor: f.cursor, mode: f.mode, trailing: f.trailing }

  const tail = tailWords(f, f.opts.tail)
  let hit: Hit | null = null
  if (tail.length >= 2 || (tail.length === 1 && f.startedAt !== null)) {
    const U = f.script.units.length
    hit = search(f, tail, Math.max(0, f.cursor - f.opts.lookBack), Math.min(U, f.cursor + f.opts.lookAhead), false)
    // Lost locally: look across the whole script (I may have jumped ahead or gone back a section).
    if (!hit && tail.length >= 4) hit = search(f, tail, 0, U, true)
  }
  if (hit) applyHit(f, hit, now)
  else if (!(e.final && paraphrase(f, words, now)) && f.startedAt !== null) {
    f.trailing = contentSince(f, f.lastMatchAbs)
    if (f.trailing > 0 && f.driftAt === null) f.driftAt = now
    if (f.trailing >= f.opts.offScriptWords) f.mode = 'offscript'
  }

  if (e.final) {
    f.done.push(...f.cur)
    f.cur = []
    f.curId = null
    if (f.done.length > 300) { f.doneOffset += f.done.length - 200; f.done = f.done.slice(-200) }
    const ms = Math.max(0, (e.t1_ms ?? 0) - (e.t0_ms ?? 0))
    f.stats.spokenWords += words.length
    f.stats.fillers += all.length - words.length
    f.stats.speakingMs += ms
    if (ms > 0) {
      f.pace.push({ t: now, words: words.length, ms })
      if (f.pace.length > 60) f.pace.shift()
    }
  }
  return before.cursor !== f.cursor || before.mode !== f.mode || before.trailing !== f.trailing
}

// ---------------------------------------------------------------- manual control
export function seek(f: Follower, unit: number, now: number) {
  if (f.mode === 'done') { f.mode = 'tracking'; f.endedAt = null }
  start(f, now)
  const target = Math.max(0, Math.min(unit, f.script.units.length))
  if (target > f.cursor) moveTo(f, target, now, () => SKIPPED)
  else { f.cursor = target; f.lastAdvance = now; enterSection(f, now) }
  f.lastMatchAbs = total(f) - 1     // what I said before the jump is not ad-lib
  backOnScript(f, now)
  if (f.mode !== 'paused') f.mode = 'tracking'
  finishIfDone(f, now)
}

export function nextSentence(f: Follower, now: number) {
  const s = f.script.sentences
  const i = sentenceAt(f.script, f.cursor)
  seek(f, s[i] && f.cursor < s[i].unitStart ? s[i].unitStart : s[i + 1]?.unitStart ?? f.script.units.length, now)
}

export function prevSentence(f: Follower, now: number) {
  const s = f.script.sentences
  const i = sentenceAt(f.script, f.cursor)
  if (!s.length) return
  const cur = s[Math.min(i, s.length - 1)]
  seek(f, f.cursor > cur.unitStart + 1 ? cur.unitStart : s[Math.max(0, i - 1)].unitStart, now)
}

export function setPaused(f: Follower, paused: boolean, now: number) {
  if (paused && f.mode !== 'paused') {
    f.pausedFrom = f.mode
    f.mode = 'paused'
    if (f.driftAt !== null && f.pausedFrom === 'offscript') f.adlibs.push({ atUnit: f.cursor, startMs: f.driftAt, endMs: now, words: f.trailing })
    f.driftAt = null
  } else if (!paused && f.mode === 'paused') {
    f.done.push(...f.cur); f.cur = []; f.curId = null
    f.lastMatchAbs = total(f) - 1    // whatever I said while paused (Q&A) is not ad-lib
    f.trailing = 0
    f.mode = f.pausedFrom === 'done' ? 'done' : f.startedAt === null ? 'ready' : 'tracking'
    f.pausedFrom = null
  }
}

// ---------------------------------------------------------------- read-outs
/** Recent speaking pace in words per minute (my words, including ad-libs), or null when there's too little speech. */
export function currentWpm(f: Follower, now: number, windowMs = 30_000): number | null {
  let words = 0, ms = 0
  for (const p of f.pace) if (now - p.t <= windowMs) { words += p.words; ms += p.ms }
  return ms >= 3000 ? Math.round(words / (ms / 60_000)) : null
}

/** Seconds left at my recent pace through the script (falls back to targetWpm). */
export function etaSeconds(f: Follower, now: number, targetWpm: number): number {
  const left = Math.max(0, f.script.units.length - f.cursor)
  const recent = f.progress.filter(p => now - p.t <= 60_000)
  let perSec = targetWpm / 60
  if (recent.length >= 2) {
    const dt = (recent[recent.length - 1].t - recent[0].t) / 1000
    const du = recent[recent.length - 1].cursor - recent[0].cursor
    if (dt >= 8 && du > 5) perSec = du / dt
  }
  return Math.round(left / perSec)
}

/** Where to scroll to: the confirmed cursor, glided a few words ahead at my pace while I'm mid-sentence. */
export function leadCursor(f: Follower, now: number): number {
  if (f.mode !== 'tracking' || now - f.lastHeard > 900) return f.cursor
  const recent = f.progress.filter(p => now - p.t <= 15_000)
  if (recent.length < 2) return f.cursor
  const rate = (recent[recent.length - 1].cursor - recent[0].cursor) / Math.max(1, (recent[recent.length - 1].t - recent[0].t) / 1000)
  return Math.min(f.script.units.length, f.cursor + Math.min(4, Math.max(0, rate * (now - f.lastAdvance) / 1000)))
}

export function adlibSeconds(f: Follower, now: number): number {
  return f.mode === 'offscript' && f.driftAt !== null ? Math.round((now - f.driftAt) / 1000) : 0
}

/** The words I should pick back up with: the rest of the current sentence (or the next one). */
export function reentryText(f: Follower, maxWords = 10): string {
  const s = f.script.sentences
  const i = sentenceAt(f.script, f.cursor)
  if (!s[i]) return ''
  const toks = f.script.tokens
  const fromTok = f.cursor < f.script.units.length ? f.script.units[f.cursor].tok : toks.length
  const out: string[] = []
  for (let t = Math.max(fromTok, s[i].tokStart); t < toks.length && out.length < maxWords; t++) {
    if (toks[t].kind === 'word' && toks[t].unitEnd > toks[t].unitStart) out.push(toks[t].text)
    else if (toks[t].kind === 'heading') break
  }
  return out.join(' ')
}

/** What I've said since leaving the script (for the bridge-back suggestion). */
export function adlibText(f: Follower, maxWords = 50): string {
  const t = total(f)
  const out: string[] = []
  for (let k = Math.max(f.lastMatchAbs + 1, f.doneOffset, t - maxWords); k < t; k++) out.push(wordAt(f, k)!)
  return out.join(' ')
}

export interface RunReport {
  duration_s: number
  avg_wpm: number | null
  coverage_pct: number       // read or paraphrased
  paraphrased: number        // sentences said in my own words
  skipped: string[]          // sentences I skipped past
  not_reached: number        // sentences left when I stopped
  adlib_count: number
  adlib_s: number
  longest_adlib_s: number
  fillers: number
  jumps: number
  sections: { title: string; seconds: number }[]
  finished: boolean
}

export function report(f: Follower, now: number): RunReport {
  const end = f.endedAt ?? now
  const units = f.script.units.length || 1
  let covered = 0
  for (const s of f.status) if (s === READ || s === PARAPHRASED) covered++
  const adlibs = [...f.adlibs]
  if (f.mode === 'offscript' && f.driftAt !== null) adlibs.push({ atUnit: f.cursor, startMs: f.driftAt, endMs: end, words: f.trailing })
  const adlibMs = adlibs.map(a => a.endMs - a.startMs)
  const skipped: string[] = []
  let notReached = 0
  for (const s of f.script.sentences) {
    const st = Array.from(f.status.subarray(s.unitStart, s.unitEnd))
    if (s.unitEnd > f.cursor) { if (f.mode !== 'done') notReached++ }
    else if (st.filter(x => x === SKIPPED || x === UNREAD).length / st.length >= 0.6) skipped.push(s.text)
  }
  const sectionMs = [...f.sectionMs]
  if (f.startedAt !== null && f.endedAt === null) sectionMs[f.section] += now - f.sectionSince
  return {
    duration_s: f.startedAt === null ? 0 : Math.round((end - f.startedAt) / 1000),
    avg_wpm: f.stats.speakingMs >= 3000 ? Math.round(f.stats.spokenWords / (f.stats.speakingMs / 60_000)) : null,
    coverage_pct: Math.round((covered / units) * 100),
    paraphrased: f.stats.paraphrased,
    skipped,
    not_reached: notReached,
    adlib_count: adlibs.length,
    adlib_s: Math.round(adlibMs.reduce((x, y) => x + y, 0) / 1000),
    longest_adlib_s: Math.round(Math.max(0, ...adlibMs) / 1000),
    fillers: f.stats.fillers,
    jumps: f.stats.jumps,
    sections: f.script.sections.map((s, i) => ({ title: s.title, seconds: Math.round(sectionMs[i] / 1000) })),
    finished: f.mode === 'done' || (f.mode === 'paused' && f.pausedFrom === 'done'),
  }
}
