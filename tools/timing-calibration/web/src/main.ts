import './style.css';
import {
  type Capture,
  captureFileName,
  type DeviceInfo,
  newCapture,
  SKU_PATTERN,
  serialiseCapture,
} from './capture.ts';
import { bestSyncEstimate, summariseFrames } from './lib.ts';
import {
  runAudio,
  runFrames,
  runSerialSync,
  runTouch,
  runVisual,
  serialAvailable,
} from './protocols.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const val = (id: string): string => $<HTMLInputElement>(id).value.trim();
const num = (id: string): number => Number($<HTMLInputElement>(id).value);

const stage = $<HTMLDivElement>('stage');
const patch = $<HTMLDivElement>('patch');
const stageStatus = $<HTMLDivElement>('stage-status');
const logEl = $<HTMLPreElement>('log');
const summaryEl = $<HTMLPreElement>('summary');

let capture: Capture | null = null;
let audioInfo: DeviceInfo['audio'] = {
  sample_rate: null,
  base_latency_ms: null,
  output_latency_ms: null,
  output_device: 'default',
};

function log(msg: string): void {
  logEl.textContent = `${new Date().toISOString().slice(11, 23)}  ${msg}\n${logEl.textContent ?? ''}`;
}

function device(): DeviceInfo {
  const hz = num('hz');
  return {
    hardware_sku: val('sku'),
    os_build: val('os') || 'unknown',
    firmware: val('fw') || 'unknown',
    shell: val('shell') || 'browser',
    user_agent: navigator.userAgent,
    refresh_hz_nominal: hz > 0 ? hz : null,
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio },
    audio: { ...audioInfo, output_device: val('audiodev') || 'default' },
  };
}

function current(): Capture {
  if (!SKU_PATTERN.test(val('sku')))
    throw new Error('hardware SKU must be a lower-case identifier');
  if (capture === null) capture = newCapture(device());
  capture.device = device();
  return capture;
}

function renderSummary(): void {
  if (!capture) {
    summaryEl.textContent = 'No measurements yet.';
    return;
  }
  const c = capture;
  const lines = [`SKU ${c.device.hardware_sku}  started ${c.created_at}`];
  lines.push(`visual: ${c.visual ? `${c.visual.trials.length} flashes` : '-'}`);
  lines.push(`touch:  ${c.touch ? `${c.touch.taps.length} taps` : '-'}`);
  if (c.audio) {
    const detected = c.audio.clicks.filter((k) => k.detected_ctx_s !== null).length;
    lines.push(`audio:  ${c.audio.clicks.length} clicks, ${detected} detected by loopback`);
  } else lines.push('audio:  -');
  const fr = c.frames ? summariseFrames(c.frames.raf_ms, c.device.refresh_hz_nominal) : null;
  lines.push(
    fr
      ? `frames: ${fr.n} at ${fr.refreshHz.toFixed(3)} Hz, sd ${fr.intervalSdMs.toFixed(3)} ms, ` +
          `dropped ${fr.droppedFrames} (${(fr.droppedRate * 100).toFixed(3)}%)`
      : 'frames: -',
  );
  const sync = c.sync ? bestSyncEstimate(c.sync.pairs) : null;
  lines.push(
    sync
      ? `sync:   ${c.sync?.pairs.length} pairs, best uncertainty ${sync.uncertaintyMs.toFixed(3)} ms`
      : 'sync:   - (or import a sync CSV at analysis)',
  );
  summaryEl.textContent = lines.join('\n');
}

async function onStage<T>(
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const ctrl = new AbortController();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') ctrl.abort();
  };
  stage.hidden = false;
  stageStatus.textContent = `${label} - Esc to stop`;
  window.addEventListener('keydown', onKey);
  try {
    await document.documentElement.requestFullscreen?.().catch(() => undefined);
    return await fn(ctrl.signal);
  } catch (err) {
    log(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    window.removeEventListener('keydown', onKey);
    stage.hidden = true;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }
}

const progress =
  (label: string) =>
  (done: number, total: number): void => {
    stageStatus.textContent = `${label} ${done}/${total} - Esc to stop`;
  };

function bind(id: string, run: () => Promise<void>): void {
  const btn = $<HTMLButtonElement>(id);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await run();
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
    } finally {
      btn.disabled = false;
      renderSummary();
    }
  });
}

bind('run-visual', async () => {
  const c = current();
  const size = num('vis-size');
  patch.style.width = `${size}px`;
  patch.style.height = `${size}px`;
  const opts = {
    n: num('vis-n'),
    minIsiMs: 250,
    maxIsiMs: 450,
    seed: num('seed'),
    flashFrames: num('vis-frames'),
  };
  const trials = await onStage('visual', (s) => runVisual(opts, patch, progress('flash'), s));
  if (trials) {
    c.visual = { patch: { x: 0, y: 0, size }, flash_frames: opts.flashFrames, trials };
    log(`visual: ${trials.length} flashes logged`);
  }
});

bind('run-touch', async () => {
  const c = current();
  const opts = { n: num('touch-n'), flashFrames: num('vis-frames') };
  const taps = await onStage('touch', (s) => runTouch(opts, stage, patch, progress('tap'), s));
  if (taps) {
    c.touch = { taps };
    log(`touch: ${taps.length} taps logged`);
  }
});

bind('run-audio', async () => {
  const c = current();
  const opts = {
    n: num('aud-n'),
    minIsiMs: 300,
    maxIsiMs: 600,
    seed: num('seed') + 1,
    loopback: $<HTMLInputElement>('aud-loop').checked,
    threshold: num('aud-thr'),
  };
  const res = await onStage('audio', (s) => runAudio(opts, progress('click'), s));
  if (res) {
    audioInfo = {
      sample_rate: res.context.sampleRate,
      base_latency_ms: res.context.baseLatencyMs,
      output_latency_ms: res.context.outputLatencyMs,
      output_device: val('audiodev') || 'default',
    };
    c.audio = { input_latency_ms: res.inputLatencyMs, clicks: res.clicks };
    c.device = device();
    log(`audio: ${res.clicks.length} clicks scheduled`);
  }
});

bind('run-frames', async () => {
  const c = current();
  const raf = await onStage('frames', (s) => runFrames(num('frames-s'), progress('ms'), s));
  if (raf) {
    c.frames = { raf_ms: raf };
    log(`frames: ${raf.length} rAF timestamps logged`);
  }
});

bind('run-sync', async () => {
  const c = current();
  const ctrl = new AbortController();
  const pairs = await runSerialSync(num('sync-n'), 25, () => undefined, ctrl.signal);
  c.sync = { pairs };
  log(`sync: ${pairs.length} ping-pong pairs`);
});

bind('download', async () => {
  const c = current();
  const blob = new Blob([serialiseCapture(c)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = captureFileName(c);
  a.click();
  URL.revokeObjectURL(a.href);
  log(`downloaded ${a.download}`);
});

bind('reset', async () => {
  capture = null;
  log('capture reset');
});

$<HTMLParagraphElement>('sync-hint').textContent = serialAvailable()
  ? 'Rig replies "<seq> <device_us>" to each "P<seq>" line.'
  : 'Web Serial unavailable here: export the rig sync log as CSV instead.';
renderSummary();
