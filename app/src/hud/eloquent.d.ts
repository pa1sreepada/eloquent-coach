// Narrow, allowlisted bridge exposed by electron/preload.ts.
import type { PrompterCommand, PrompterPayload, PrompterSettings } from '../prompter/settings'

export type HudCommand = 'next' | 'prev' | 'dismiss' | 'toggleLock'

declare global {
  interface Window {
    eloquent?: {
      showHud(meetingId: number, script?: string): void
      hideHud(): void
      setLiveMeeting(meetingId: number | null): void
      getHudState(): Promise<{ meetingId: number | null; script: string }>
      setHudInteractive(on: boolean): void
      onHudMeeting(cb: (id: number) => void): () => void
      onHudScript(cb: (script: string) => void): () => void
      onHudCommand(cb: (cmd: HudCommand) => void): () => void
      openPrompter(payload: PrompterPayload): void
      updatePrompterSettings(settings: PrompterSettings): void
      stopPrompter(): void
      isPrompterOpen(): Promise<boolean>
      onPrompterClosed(cb: () => void): () => void
      onPrompterRunSaved(cb: (scriptId: number) => void): () => void
      getPrompterState(): Promise<PrompterPayload | null>
      onPrompterLoad(cb: (p: PrompterPayload) => void): () => void
      onPrompterSettings(cb: (s: PrompterSettings) => void): () => void
      onPrompterMeeting(cb: (id: number | null) => void): () => void
      onPrompterCommand(cb: (cmd: PrompterCommand) => void): () => void
      onPrompterNotice(cb: (msg: string) => void): () => void
      setPrompterInteractive(on: boolean): void
      prompterRunSaved(scriptId: number): void
      advanceSlide(): void
      closePrompter(): void
    }
  }
}
