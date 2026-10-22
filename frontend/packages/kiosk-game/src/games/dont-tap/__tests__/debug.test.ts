import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { ModuleId } from '../../../core/contracts.ts';
import { samplePersona } from '../kit/bot.ts';
import { DEV_FACTORIES } from '../kit/dev/registry.ts';
import { runHeadless } from '../kit/testing/headless.ts';

it.skipIf(!process.env.DBG_OUT)(
  'debug timeline',
  async () => {
    const out: unknown[] = [];
    const moduleId = (process.env.DBG_MODULE ?? 'dont_tap') as ModuleId;
    const make = DEV_FACTORIES[moduleId as keyof typeof DEV_FACTORIES];
    if (!make) throw new Error(`no factory for ${moduleId}`);
    let a = Number(process.env.DBG_PERSONA ?? -1) >>> 0;
    const next = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const persona = process.env.DBG_PERSONA ? samplePersona({ next } as never) : undefined;
    if (persona) out.push(persona);
    const r = await runHeadless({
      moduleId,
      factory: () => make(persona ? { persona } : {}),
      seed: Number(process.env.DBG_SEED ?? 123),
    });
    const evs = r.events;
    const t0 = evs.find((e) => e.event_type === 'module_start')?.timing.t_mono_ms ?? 0;
    for (const e of evs) {
      const key = `${e.event_type}:${e.task?.block_id ?? ''}`;
      const show =
        e.event_type === 'trial_start' ||
        e.event_type === 'response' ||
        e.event_type === 'module_start' ||
        e.event_type === 'module_end' ||
        e.event_type === 'context_shift';
      if (!show) continue;
      out.push([
        Math.round(e.timing.t_mono_ms - t0),
        key,
        e.task?.trial_index,
        e.event_type === 'response'
          ? (e.payload as { response_value: unknown }).response_value
          : '',
      ]);
    }
    out.push(r.result, r.voiceLines);
    for (const e of evs.filter((x) => x.event_type === 'invalid').slice(0, 3)) out.push(e);
    writeFileSync(process.env.DBG_OUT as string, out.map((o) => JSON.stringify(o)).join('\n'));
  },
  60000,
);
