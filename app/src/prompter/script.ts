// Teleprompter script model. Plain text with light markup:
//   # Section title        → section marker (not read aloud)
//   > private note         → stage direction shown dim (not read aloud)
//   [pause] [slow] …       → delivery cue chips (not read aloud)
//   *stress this*          → emphasis
//   blank line             → paragraph break
// Spoken words are expanded into canonical "units" (lowercase, contractions and numbers spelled out)
// so the follower can match what the speech recogniser hears against what's on screen.

export type TokenKind = 'word' | 'cue' | 'heading' | 'note' | 'para'

export interface Token {
  kind: TokenKind
  text: string
  emph?: boolean
  sentence: number     // -1 for tokens that aren't read aloud
  section: number
  unitStart: number    // first canonical unit for words; for markers, the unit that follows
  unitEnd: number
}

export interface Unit { w: string; tok: number; sentence: number }
export interface Sentence { unitStart: number; unitEnd: number; tokStart: number; text: string; section: number }
export interface Section { title: string; unitStart: number; tok: number }

export interface ParsedScript {
  tokens: Token[]
  units: Unit[]
  sentences: Sentence[]
  sections: Section[]
}

const CONTRACTIONS: Record<string, string> = {
  "can't": 'can not', cannot: 'can not', "won't": 'will not', "shan't": 'shall not', "ain't": 'is not',
  "let's": 'let us', "i'm": 'i am', "y'all": 'you all', gonna: 'going to', wanna: 'want to', gotta: 'got to',
}
const SUFFIXES: [string, string[]][] = [["n't", ['not']], ["'re", ['are']], ["'ve", ['have']], ["'ll", ['will']], ["'d", ['would']], ["'m", ['am']]]
// "it's"/"that's" → "it is"; possessives ("Pavan's") keep the bare word — the recogniser writes them either way.
const S_IS = new Set(['it', 'that', 'there', 'here', 'what', 'who', 'where', 'how', 'he', 'she', 'when', 'why',
  'everyone', 'everybody', 'nobody', 'something', 'nothing'])

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

export function numberWords(n: number): string[] {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) return [String(n)]
  if (n < 20) return [ONES[n]]
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]]
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numberWords(n % 100) : [])]
  // Years are read in pairs: 1999 → nineteen ninety nine, 2026 → twenty twenty six
  if (n >= 1100 && n < 2100 && n % 100 !== 0 && !(Math.floor(n / 100) % 10 === 0 && n % 100 < 10)) {
    return [...numberWords(Math.floor(n / 100)), ...(n % 100 < 10 ? ['oh', ONES[n % 100]] : numberWords(n % 100))]
  }
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as [number, string][]) {
    if (n >= size) {
      const rest = n % size
      return [...numberWords(Math.floor(n / size)), name, ...(rest ? numberWords(rest) : [])]
    }
  }
  return [String(n)]
}

/** Canonical units for one written word: "We're" → [we, are], "20%" → [twenty, percent], "$5M" → [five, million, dollars]. */
export function canon(raw: string): string[] {
  const s = raw.toLowerCase().replace(/[’‘`]/g, "'").replace(/[–—]/g, ' ')
    .replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/@/g, ' at ')
  const out: string[] = []
  for (let part of s.split(/[\s/-]+/)) {
    part = part.replace(/^[^a-z0-9$£€]+|[^a-z0-9%']+$/g, '').replace(/^'+|'+$/g, '')
    if (!part) continue
    const money = /^[$£€]/.test(part)
    const currency = part[0] === '£' ? 'pounds' : part[0] === '€' ? 'euros' : 'dollars'
    if (money) part = part.slice(1)
    const pct = part.endsWith('%')
    if (pct) part = part.slice(0, -1)
    const scale = /^(\d+(?:\.\d+)?)([kmb])$/.exec(part)
    if (scale) part = scale[1]
    if (/^\d[\d,]*(\.\d+)?$/.test(part)) {
      const [int, frac] = part.replace(/,/g, '').split('.')
      out.push(...numberWords(Number(int)))
      if (frac) out.push('point', ...frac.split('').map(d => ONES[Number(d)]))
      if (scale) out.push(scale[2] === 'k' ? 'thousand' : scale[2] === 'm' ? 'million' : 'billion')
    } else if (CONTRACTIONS[part]) {
      out.push(...CONTRACTIONS[part].split(' '))
    } else {
      const suf = SUFFIXES.find(([x]) => part.endsWith(x) && part.length > x.length)
      if (suf) {
        const stem = part.slice(0, -suf[0].length)
        out.push(stem === 'wo' ? 'will' : stem === 'ca' ? 'can' : stem, ...suf[1])
      } else if (part.endsWith("'s")) {
        const stem = part.slice(0, -2)
        out.push(...(S_IS.has(stem) ? [stem, 'is'] : [stem]))
      } else {
        const clean = part.replace(/'/g, '')
        if (clean) out.push(clean)
      }
    }
    if (pct) out.push('percent')
    if (money) out.push(currency)
  }
  return out
}

/** Canonical units for a whole utterance. */
export function canonText(text: string): string[] {
  return text.split(/\s+/).flatMap(canon)
}

const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/

export function parseScript(text: string): ParsedScript {
  const tokens: Token[] = []
  const units: Unit[] = []
  const sentences: Sentence[] = []
  const sections: Section[] = []
  let section = 0
  let open: Sentence | null = null
  let emph = false

  const closeSentence = () => {
    if (open && open.unitEnd > open.unitStart) sentences.push(open)
    open = null
  }
  const marker = (kind: TokenKind, txt: string) => {
    tokens.push({ kind, text: txt, sentence: -1, section, unitStart: units.length, unitEnd: units.length })
  }

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      closeSentence()
      if (tokens.length && tokens[tokens.length - 1].kind !== 'para') marker('para', '')
      continue
    }
    const heading = /^#{1,3}\s+(.+)$/.exec(line)
    if (heading) {
      closeSentence()
      // Anything before the first heading becomes an implicit "Opening" section.
      if (!sections.length && tokens.some(t => t.kind !== 'para')) sections.push({ title: 'Opening', unitStart: 0, tok: 0 })
      section = sections.length
      sections.push({ title: heading[1].trim(), unitStart: units.length, tok: tokens.length })
      marker('heading', heading[1].trim())
      continue
    }
    if (line.startsWith('>')) {
      closeSentence()
      marker('note', line.replace(/^>\s?/, ''))
      continue
    }
    for (const piece of line.match(/\[[^\]]{1,40}\]|\S+/g) ?? []) {
      const cue = /^\[([^\]]+)\]$/.exec(piece)
      if (cue) { marker('cue', cue[1].trim().toLowerCase()); continue }
      const startsEmph = /^[*_]{1,2}\S/.test(piece)
      const endsEmph = /\S[*_]{1,2}[.,!?;:"')\]]*$/.test(piece)
      const word = piece.replace(/^[*_]{1,2}/, '').replace(/[*_]{1,2}(?=[.,!?;:"')\]]*$)/, '')
      if (startsEmph) emph = true
      const wordEmph = emph
      if (endsEmph) emph = false
      const cu = canon(word)
      if (!cu.length) {   // pure punctuation ("—", "…"): shown, never read
        tokens.push({ kind: 'word', text: word, sentence: -1, section, unitStart: units.length, unitEnd: units.length })
        continue
      }
      if (!open) open = { unitStart: units.length, unitEnd: units.length, tokStart: tokens.length, text: '', section }
      const tok = tokens.length
      const sIdx = sentences.length
      tokens.push({ kind: 'word', text: word, emph: wordEmph || undefined, sentence: sIdx, section,
        unitStart: units.length, unitEnd: units.length + cu.length })
      for (const w of cu) units.push({ w, tok, sentence: sIdx })
      open.unitEnd = units.length
      open.text = open.text ? `${open.text} ${word}` : word
      if (ENDS_SENTENCE.test(word)) closeSentence()
    }
  }
  closeSentence()
  if (!sections.length) sections.push({ title: 'Script', unitStart: 0, tok: 0 })
  return { tokens, units, sentences, sections }
}

/** Index of the section containing a unit. */
export function sectionAt(script: ParsedScript, unit: number): number {
  let idx = 0
  for (let i = 0; i < script.sections.length; i++) if (script.sections[i].unitStart <= unit) idx = i
  return idx
}

/** Index of the sentence containing a unit (the last one past the end). */
export function sentenceAt(script: ParsedScript, unit: number): number {
  const s = script.sentences
  for (let i = 0; i < s.length; i++) if (unit < s[i].unitEnd) return i
  return s.length - 1
}

/** Words a reader actually says (cues, headings and notes excluded). */
export function spokenWordCount(text: string): number {
  return parseScript(text).tokens.filter(t => t.kind === 'word' && t.unitEnd > t.unitStart).length
}
