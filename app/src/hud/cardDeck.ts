import type { CoachCard, Speaker } from './protocol'

export const MAX_QUEUE = 6
const USED_OVERLAP = 0.5

export interface DeckState {
  active: CoachCard | null
  queue: CoachCard[]            // sorted: priority asc, then newest first
  used: string[]                // ids of cards the user actually spoke
  pinned: boolean               // user is speaking from the active card
  locked: boolean               // user froze the deck (hotkey L)
  speaking: Speaker | null
}

export type DeckAction =
  | { type: 'card'; card: CoachCard }
  | { type: 'speech'; speaker: Speaker; text: string; final: boolean }
  | { type: 'silence'; speaker: Speaker }
  | { type: 'tick'; now: number }
  | { type: 'next' } | { type: 'prev' } | { type: 'dismiss' } | { type: 'toggleLock' }

export const initialDeck: DeckState = {
  active: null, queue: [], used: [], pinned: false, locked: false, speaking: null,
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9%$']+/g) ?? []

/** Fraction of the card's content words that appear in what I said. */
export function overlap(card: CoachCard, spoken: string): number {
  const words = new Set(tokenize(card.headline).filter(w => w.length > 2))
  if (words.size === 0) return 0
  const said = new Set(tokenize(spoken))
  let hit = 0
  for (const w of words) if (said.has(w)) hit++
  return hit / words.size
}

const byPriority = (a: CoachCard, b: CoachCard) =>
  a.priority - b.priority || b.created_at_ms - a.created_at_ms

const expired = (c: CoachCard, now: number) => now - c.created_at_ms > c.ttl_s * 1000

function promote(s: DeckState): DeckState {
  if (s.active || s.queue.length === 0) return s
  const [head, ...rest] = s.queue
  return { ...s, active: head, queue: rest }
}

export function deckReducer(s: DeckState, a: DeckAction): DeckState {
  switch (a.type) {
    case 'card': {
      if (s.active?.id === a.card.id || s.queue.some(c => c.id === a.card.id)) return s
      // Preempt a lower-priority active card unless I'm mid-delivery or locked.
      if (s.active && !s.pinned && !s.locked && a.card.priority < s.active.priority) {
        const queue = [s.active, ...s.queue].sort(byPriority).slice(0, MAX_QUEUE)
        return { ...s, active: a.card, queue }
      }
      const queue = [...s.queue, a.card].sort(byPriority).slice(0, MAX_QUEUE)
      return promote({ ...s, queue })
    }
    case 'speech': {
      const next = { ...s, speaking: a.speaker }
      if (a.speaker !== 'Me' || !s.active) return next
      const ov = overlap(s.active, a.text)
      if (ov >= USED_OVERLAP && !s.used.includes(s.active.id)) {
        return { ...next, pinned: true, used: [...s.used, s.active.id].slice(-50) }
      }
      return ov > 0 ? { ...next, pinned: true } : next
    }
    case 'silence': {
      if (a.speaker !== 'Me') return { ...s, speaking: null }
      const base = { ...s, speaking: null, pinned: false }
      // I finished delivering the active card → advance.
      if (!s.locked && s.active && s.used.includes(s.active.id)) {
        return promote({ ...base, active: null })
      }
      return base
    }
    case 'tick': {
      const queue = s.queue.filter(c => !expired(c, a.now))
      const dropActive = s.active && !s.pinned && !s.locked && expired(s.active, a.now)
      if (queue.length === s.queue.length && !dropActive) return s
      return promote({ ...s, queue, active: dropActive ? null : s.active })
    }
    case 'next': {
      if (s.queue.length === 0) return s
      const [head, ...rest] = s.queue
      return { ...s, active: head, queue: s.active ? [...rest, s.active] : rest, pinned: false }
    }
    case 'prev': {
      if (s.queue.length === 0) return s
      const last = s.queue[s.queue.length - 1]
      const rest = s.queue.slice(0, -1)
      return { ...s, active: last, queue: s.active ? [s.active, ...rest] : rest, pinned: false }
    }
    case 'dismiss':
      return promote({ ...s, active: null, pinned: false })
    case 'toggleLock':
      return { ...s, locked: !s.locked }
  }
}
