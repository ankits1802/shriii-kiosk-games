/**
 * Shared scene lighting. The active backdrop publishes its interpolated time-of-day palette here and
 * characters, buttons and particles read it so the whole frame shares one light (tint, shadow direction
 * and length, rim colour).
 */
import type { Unsubscribe } from '../core/contracts.ts';
import { type ScenePalette, TIME_PALETTES } from './palettes.ts';

export class Lighting {
  private current: ScenePalette = TIME_PALETTES.golden_hour;
  private readonly listeners = new Set<(p: ScenePalette) => void>();

  get palette(): ScenePalette {
    return this.current;
  }

  /** Publish a new palette (called by the active backdrop while time of day animates). */
  set(p: ScenePalette): void {
    this.current = p;
    for (const l of this.listeners) l(p);
  }

  /** Subscribe to palette changes; the listener is called immediately with the current palette. */
  subscribe(listener: (p: ScenePalette) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
}
