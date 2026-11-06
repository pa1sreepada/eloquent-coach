// Teleprompter display preferences. Shared through localStorage by the main window and the prompter window
// (same origin), so a change in either is picked up by the other.
export interface PrompterSettings {
  fontSize: number        // px
  width: number           // window px
  height: number          // window px
  eyeLine: number         // where the line I'm reading sits, as a fraction of the text area height
  opacity: number         // background opacity
  mirror: boolean         // flip horizontally for beam-splitter teleprompter glass
  paceBand: number        // ± wpm around the script's target before nudging
  bridge: boolean         // suggest a line to get back on script after a long ad-lib
  bridgeAfterS: number
  advanceSlides: boolean  // press → in the front app at each [next slide] cue (macOS, needs Accessibility)
}

export const DEFAULT_PROMPTER: PrompterSettings = {
  fontSize: 30, width: 760, height: 280, eyeLine: 0.32, opacity: 0.88, mirror: false,
  paceBand: 20, bridge: true, bridgeAfterS: 10, advanceSlides: false,
}

const KEY = 'prompterSettings'

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

export function sanitizePrompter(raw: Partial<PrompterSettings> | null | undefined): PrompterSettings {
  const r = raw ?? {}
  const d = DEFAULT_PROMPTER
  return {
    fontSize: clamp(r.fontSize, 16, 72, d.fontSize),
    width: clamp(r.width, 420, 1400, d.width),
    height: clamp(r.height, 160, 800, d.height),
    eyeLine: clamp(r.eyeLine, 0.12, 0.6, d.eyeLine),
    opacity: clamp(r.opacity, 0.4, 1, d.opacity),
    mirror: typeof r.mirror === 'boolean' ? r.mirror : d.mirror,
    paceBand: clamp(r.paceBand, 5, 60, d.paceBand),
    bridge: typeof r.bridge === 'boolean' ? r.bridge : d.bridge,
    bridgeAfterS: clamp(r.bridgeAfterS, 4, 60, d.bridgeAfterS),
    advanceSlides: typeof r.advanceSlides === 'boolean' ? r.advanceSlides : d.advanceSlides,
  }
}

export function loadPrompterSettings(): PrompterSettings {
  try { return sanitizePrompter(JSON.parse(localStorage.getItem(KEY) || 'null')) } catch { return { ...DEFAULT_PROMPTER } }
}

export function savePrompterSettings(s: PrompterSettings) {
  localStorage.setItem(KEY, JSON.stringify(sanitizePrompter(s)))
}

/** What the main window hands the prompter window when it opens. */
export interface PrompterPayload {
  scriptId: number | null
  title: string
  content: string
  targetWpm: number
  settings: PrompterSettings
  meetingId?: number | null   // set by the main process when a meeting is live: follow its mic instead
}

export type PrompterCommand = 'pause' | 'prev' | 'next' | 'finish'
