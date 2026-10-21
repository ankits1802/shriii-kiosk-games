/**
 * Fixed-size RAM ring buffer for the VAD pre-roll. It never grows, never copies out (callers read
 * views), and `wipe()` zero-fills the whole backing store, so no audio survives a prompt window.
 */
export class SampleRing {
  private readonly data: Float32Array;
  private start = 0;
  private length = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0)
      throw new RangeError('capacity must be a non-negative integer');
    this.data = new Float32Array(capacity);
  }

  get capacity(): number {
    return this.data.length;
  }

  get size(): number {
    return this.length;
  }

  /** Append samples, overwriting the oldest when full. */
  push(samples: Float32Array): void {
    const cap = this.data.length;
    if (cap === 0) return;
    const src = samples;
    if (src.length >= cap) {
      this.data.set(src.subarray(src.length - cap));
      this.start = 0;
      this.length = cap;
      return;
    }
    let write = (this.start + this.length) % cap;
    let offset = 0;
    while (offset < src.length) {
      const n = Math.min(src.length - offset, cap - write);
      this.data.set(src.subarray(offset, offset + n), write);
      offset += n;
      write = (write + n) % cap;
    }
    const overflow = Math.max(0, this.length + src.length - cap);
    this.length = Math.min(cap, this.length + src.length);
    this.start = (this.start + overflow) % cap;
  }

  /** Oldest-to-newest views (at most two, because of wrap-around). Valid until the next mutation. */
  views(): Float32Array[] {
    if (this.length === 0) return [];
    const cap = this.data.length;
    const end = this.start + this.length;
    if (end <= cap) return [this.data.subarray(this.start, end)];
    return [this.data.subarray(this.start, cap), this.data.subarray(0, end - cap)];
  }

  /** Zero-fill the backing store and forget its contents. */
  wipe(): void {
    this.data.fill(0);
    this.start = 0;
    this.length = 0;
  }

  /** Number of non-zero samples in the backing store (privacy assertions in tests). */
  nonZeroSamples(): number {
    let n = 0;
    for (const v of this.data) if (v !== 0) n++;
    return n;
  }
}
