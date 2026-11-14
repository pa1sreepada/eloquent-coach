// Wire protocol for ws://127.0.0.1:8000/ws/events/{meeting_id} (backend → UI).
export type Speaker = 'Me' | 'Participant'

export interface TranscriptEvent {
  type: 'transcript'
  kind: 'partial' | 'final'
  speaker: Speaker
  utterance_id: string
  text: string
  t0_ms: number
  t1_ms: number
  compute_ms: number
}

export type CardKind =
  | 'question' | 'counterpoint' | 'alignment' | 'bluf'
  | 'context' | 'risk' | 'answer' | 'bio'

export interface CoachCard {
  id: string
  partial?: boolean            // headline shown, body still being written
  kind: CardKind
  headline: string
  body: string
  priority: 1 | 2 | 3
  ttl_s: number
  trigger: string
  created_at_ms: number
}

/** partial: streamed headline-first; the body follows in a CardUpdateEvent with the same id. */
export interface CardEvent extends CoachCard { type: 'card'; partial?: boolean }

/** Final form of a card that was shown headline-first (body filled in, possibly empty). */
export interface CardUpdateEvent extends CoachCard { type: 'card_update' }

export interface TelemetryEvent {
  type: 'telemetry'
  talk_share_pct: number
  talk_share_recent_pct: number
  my_wpm: number
  filler_per_min: number
  fillers_total: number
  hedges_total: number
  monologue_s: number
  questions_asked: number
  avg_wait_after_question_s: number
  interruptions_by_me: number
  room_sentiment: number
  my_voiced_s: number
  others_voiced_s: number
  alerts: string[]
}

export type AsrProfile = 'ultra' | 'low' | 'balanced' | 'accurate'
export type AsrDevice = 'gpu' | 'cpu'

export interface AsrChannelStatus {
  device: AsrDevice
  profile: AsrProfile
  ceiling: AsrProfile          // best profile the current plan allows
  degraded: boolean            // governor stepped below the plan because the machine fell behind
  lag_p50_ms: number | null
  last_event: string | null
}

/** Sent at session start and whenever the adaptive governor changes a channel. */
export interface AsrStatusEvent {
  type: 'asr_status'
  pressure: boolean            // coaching defers low-priority cards while true
  channels: Record<Speaker, AsrChannelStatus>
  source: 'calibrated' | 'heuristic' | 'manual'
  reasons: string[]
  warnings: string[]
}

/** 'What do I say now?' lifecycle: pending → a card arrives → done, empty when nothing useful came back,
 *  or error when the LLM call itself failed (message says why). */
export interface AskEvent {
  type: 'ask'
  state: 'pending' | 'done' | 'empty' | 'error'
  message?: string
}

/** Sent only when coaching stops working (ok=false, with the server's reason) and when it recovers. */
export interface LlmStatusEvent {
  type: 'llm_status'
  ok: boolean
  message: string
}

export interface TrackedItem {
  kind: 'decision' | 'commitment' | 'parked'
  text: string
  owner: string | null
  speaker: string
  t_ms: number | null
}

/** Silent decision tracker: sent whenever the meeting gains a decision, commitment or parked topic. */
export interface TrackerEvent {
  type: 'tracker'
  decisions: TrackedItem[]
  commitments: TrackedItem[]
  parked: TrackedItem[]
  counts: { decisions: number; commitments: number; unowned: number; parked: number }
}

export type CoachEvent = TranscriptEvent | CardEvent | CardUpdateEvent | TelemetryEvent | AsrStatusEvent | AskEvent | LlmStatusEvent | TrackerEvent
