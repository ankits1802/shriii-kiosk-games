/**
 * Generic object pool (particles, ripples, motes). Avoids GC pauses during timed play (KSK-14).
 */
export class Pool<T> {
  private readonly free: T[] = [];
  private created = 0;

  constructor(
    private readonly create: () => T,
    private readonly reset: (item: T) => void,
    private readonly max = 512,
  ) {}

  /** Take an item (re-used when available). Returns null when the pool cap is reached. */
  acquire(): T | null {
    const item = this.free.pop();
    if (item !== undefined) return item;
    if (this.created >= this.max) return null;
    this.created++;
    return this.create();
  }

  /** Return an item for re-use. */
  release(item: T): void {
    this.reset(item);
    this.free.push(item);
  }

  /** Items created so far. */
  get allocated(): number {
    return this.created;
  }

  /** Items currently idle. */
  get idle(): number {
    return this.free.length;
  }

  /** Drain the idle list through `dispose`. */
  drain(dispose: (item: T) => void): void {
    for (const item of this.free.splice(0)) dispose(item);
  }
}
