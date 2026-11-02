// Narrow, allowlisted bridge exposed by electron/preload.ts.
export type HudCommand = 'next' | 'prev' | 'dismiss' | 'toggleLock'

declare global {
  interface Window {
    eloquent?: {
      showHud(meetingId: number, script?: string): void
      hideHud(): void
      setHudInteractive(on: boolean): void
      onHudMeeting(cb: (id: number) => void): () => void
      onHudScript(cb: (script: string) => void): () => void
      onHudCommand(cb: (cmd: HudCommand) => void): () => void
    }
  }
}
