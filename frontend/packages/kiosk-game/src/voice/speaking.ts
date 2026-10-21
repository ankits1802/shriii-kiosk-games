/**
 * `speaking` observable shared by the voice services (VoiceService.speaking / onSpeakingChange).
 *
 * Every audible playback holds a token from {@link SpeakingTracker.begin} until it ends or is
 * interrupted; `speaking` is true while at least one token is held. Listeners hear only transitions.
 * The walkaway timer subscribes to pause while narration plays (KSK-04).
 */
import type { Unsubscribe } from '../core/contracts.ts';

export class SpeakingTracker {
  private active = 0;
  private readonly listeners = new Set<(speaking: boolean) => void>();

  /** True while any playback is audible. */
  get speaking(): boolean {
    return this.active > 0;
  }

  /** Mark a playback audible; call the returned function (idempotent) when it ends. */
  begin(): () => void {
    let done = false;
    this.active += 1;
    if (this.active === 1) this.emit(true);
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
      if (this.active === 0) this.emit(false);
    };
  }

  /** Subscribe to transitions. */
  subscribe(listener: (speaking: boolean) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(speaking: boolean): void {
    for (const l of [...this.listeners]) {
      try {
        l(speaking);
      } catch (err) {
        console.error('[voice] speaking listener failed', err);
      }
    }
  }
}
