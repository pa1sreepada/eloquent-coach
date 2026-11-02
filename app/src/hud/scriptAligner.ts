// Voice-following teleprompter: advances a pointer through a prepared script
// as the user's live (partial) transcript matches upcoming words.
const norm = (s: string) => s.toLowerCase().match(/[a-z0-9%$']+/g) ?? []

export interface AlignerState { words: string[]; pointer: number }

export function createAligner(script: string): AlignerState {
  return { words: norm(script), pointer: 0 }
}

/**
 * Match the tail of what I just said against a window ahead of the pointer.
 * Returns the new pointer (index of the next word to read). Never moves back.
 */
export function align(
  st: AlignerState, spoken: string, opts = { tail: 6, window: 40, threshold: 0.6 },
): number {
  const said = norm(spoken).slice(-opts.tail)
  if (said.length < 2) return st.pointer
  const end = Math.min(st.words.length, st.pointer + opts.window)
  let best = -1
  let bestScore = 0
  for (let i = st.pointer; i < end; i++) {
    // Candidate: script words ending at i should equal `said`.
    const start = i - said.length + 1
    let hit = 0
    for (let k = 0; k < said.length; k++) {
      const w = st.words[start + k]
      if (w !== undefined && w === said[k]) hit++
    }
    const score = hit / said.length
    if (score > bestScore || (score === bestScore && score > 0 && i < best)) {
      bestScore = score
      best = i
    }
  }
  return bestScore >= opts.threshold ? Math.max(st.pointer, best + 1) : st.pointer
}

/** Split script into pages of ~N words at sentence boundaries for paging. */
export function paginate(script: string, maxWords = 28): string[] {
  const sentences = script.split(/(?<=[.!?])\s+/).filter(Boolean)
  const pages: string[] = []
  let cur: string[] = []
  let n = 0
  for (const s of sentences) {
    const w = s.split(/\s+/).length
    if (n + w > maxWords && cur.length) { pages.push(cur.join(' ')); cur = []; n = 0 }
    cur.push(s); n += w
  }
  if (cur.length) pages.push(cur.join(' '))
  return pages
}
