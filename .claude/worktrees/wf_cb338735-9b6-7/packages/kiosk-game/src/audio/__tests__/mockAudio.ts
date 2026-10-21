/**
 * Recording mock of the Web Audio API subset used by the engine: nodes remember their connections and
 * every AudioParam automation call, so tests can assert graph construction without real audio.
 */

export class MockParam {
  value: number;
  readonly calls: { method: string; args: number[] }[] = [];
  constructor(v = 0) {
    this.value = v;
  }
  private rec(method: string, args: number[], v?: number): this {
    this.calls.push({ method, args });
    if (v !== undefined) this.value = v;
    return this;
  }
  setValueAtTime(v: number, t: number): this {
    return this.rec('setValueAtTime', [v, t], v);
  }
  linearRampToValueAtTime(v: number, t: number): this {
    return this.rec('linearRampToValueAtTime', [v, t], v);
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    return this.rec('exponentialRampToValueAtTime', [v, t], v);
  }
  setTargetAtTime(v: number, t: number, c: number): this {
    return this.rec('setTargetAtTime', [v, t, c], v);
  }
  cancelScheduledValues(t: number): this {
    return this.rec('cancelScheduledValues', [t]);
  }
}

export class MockNode {
  readonly outputs: MockNode[] = [];
  disconnected = false;
  constructor(
    readonly ctx: MockAudioContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect<T>(dest: T): T {
    this.outputs.push(dest as unknown as MockNode);
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class MockGain extends MockNode {
  readonly gain = new MockParam(1);
  constructor(ctx: MockAudioContext) {
    super(ctx, 'gain');
  }
}

class MockSource extends MockNode {
  started: number | null = null;
  stopped: number | null = null;
  onended: (() => void) | null = null;
  buffer: unknown = null;
  loop = false;
  readonly frequency = new MockParam(440);
  readonly detune = new MockParam(0);
  readonly playbackRate = new MockParam(1);
  type = 'sine';
  wave: unknown = null;
  start(t = 0): void {
    this.started = t;
  }
  stop(t = 0): void {
    this.stopped = t;
  }
  setPeriodicWave(w: unknown): void {
    this.wave = w;
  }
}

class MockBiquad extends MockNode {
  type = 'lowpass';
  readonly frequency = new MockParam(350);
  readonly Q = new MockParam(1);
  readonly gain = new MockParam(0);
  constructor(ctx: MockAudioContext) {
    super(ctx, 'biquad');
  }
}

class MockCompressor extends MockNode {
  readonly threshold = new MockParam(-24);
  readonly knee = new MockParam(30);
  readonly ratio = new MockParam(12);
  readonly attack = new MockParam(0.003);
  readonly release = new MockParam(0.25);
  constructor(ctx: MockAudioContext) {
    super(ctx, 'compressor');
  }
}

class MockPanner extends MockNode {
  readonly pan = new MockParam(0);
  constructor(ctx: MockAudioContext) {
    super(ctx, 'panner');
  }
}

class MockConvolver extends MockNode {
  buffer: unknown = null;
  constructor(ctx: MockAudioContext) {
    super(ctx, 'convolver');
  }
}

export class MockBuffer {
  readonly channels: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(i: number): Float32Array {
    const c = this.channels[i];
    if (!c) throw new Error('channel');
    return c;
  }
}

export class MockAudioContext {
  readonly nodes: MockNode[] = [];
  readonly destination: MockNode;
  readonly sampleRate = 8000;
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  decoded: ArrayBuffer[] = [];
  constructor() {
    this.destination = new MockNode(this, 'destination');
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  createGain(): MockGain {
    return new MockGain(this);
  }
  createOscillator(): MockSource {
    return new MockSource(this, 'oscillator');
  }
  createBufferSource(): MockSource {
    return new MockSource(this, 'buffer');
  }
  createBiquadFilter(): MockBiquad {
    return new MockBiquad(this);
  }
  createDynamicsCompressor(): MockCompressor {
    return new MockCompressor(this);
  }
  createStereoPanner(): MockPanner {
    return new MockPanner(this);
  }
  createConvolver(): MockConvolver {
    return new MockConvolver(this);
  }
  createBuffer(ch: number, len: number, sr: number): MockBuffer {
    return new MockBuffer(ch, len, sr);
  }
  createPeriodicWave(
    real: Float32Array,
    imag: Float32Array,
  ): { real: Float32Array; imag: Float32Array } {
    return { real, imag };
  }
  async decodeAudioData(data: ArrayBuffer): Promise<MockBuffer> {
    this.decoded.push(data);
    return new MockBuffer(1, Math.max(1, data.byteLength), 8000);
  }
  /** Nodes of a kind. */
  ofKind(kind: string): MockNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }
}

/** Factory usable as an AudioContextFactory. */
export function mockFactory(): { ctx: MockAudioContext; factory: () => AudioContext } {
  const ctx = new MockAudioContext();
  return { ctx, factory: () => ctx as unknown as AudioContext };
}
