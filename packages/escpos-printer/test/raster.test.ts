import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import {
  bitmapsEqual,
  blackRatio,
  createBitmap,
  getDot,
  scaleBitmap,
  setDot,
  sliceRows,
  stackCentered,
} from '../src/bitmap.ts';
import { dither } from '../src/dither.ts';
import { cmd, encodeRasterJob, rasterBands } from '../src/escpos.ts';
import { fitToWidth, resizeGray, toGray } from '../src/image.ts';
import { decodePng, encodePng } from '../src/png.ts';
import { qrBitmap, qrMatrix } from '../src/qr.ts';
import { blackFractionInColumns, gradient, monoToRgba, solid } from './helpers.ts';

const flat = { black: 0, white: 255, gamma: 1 } as const;

describe('tone and resampling', () => {
  it('composites alpha on white paper', () => {
    const g = toGray(solid(2, 2, 0, 0), flat);
    expect([...g.data]).toEqual([255, 255, 255, 255]);
    const half = toGray(solid(1, 1, 0, 128), flat);
    expect(half.data[0]).toBeCloseTo(127, 0);
  });

  it('applies levels', () => {
    expect(toGray(solid(1, 1, 20), { black: 24, white: 222, gamma: 1 }).data[0]).toBe(0);
    expect(toGray(solid(1, 1, 230), { black: 24, white: 222, gamma: 1 }).data[0]).toBe(255);
  });

  it('rejects a mis-sized buffer', () => {
    expect(() => toGray({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(RangeError);
  });

  it('area-averages when downscaling', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1)
      for (let x = 0; x < 4; x += 1) {
        const v = (x + y) % 2 === 0 ? 0 : 255;
        data.set([v, v, v, 255], (y * 4 + x) * 4);
      }
    const small = resizeGray(toGray({ width: 4, height: 4, data }, flat), 2, 2);
    for (const v of small.data) expect(v).toBeCloseTo(127.5, 3);
    const third = resizeGray(toGray(solid(9, 3, 200), flat), 2, 1);
    expect(third.data[0]).toBeCloseTo(200, 3);
  });

  it('fits to the head width preserving aspect ratio', () => {
    const g = fitToWidth(toGray(solid(1152, 400, 255)), 576);
    expect([g.width, g.height]).toEqual([576, 200]);
    const up = fitToWidth(toGray(solid(288, 100, 0), flat), 576);
    expect([up.width, up.height]).toEqual([576, 200]);
    expect(up.data[0]).toBe(0);
  });
});

describe('dithering', () => {
  for (const algorithm of ['threshold', 'floyd-steinberg', 'atkinson'] as const) {
    it(`${algorithm}: pure white stays white and pure black stays black`, () => {
      expect(blackRatio(dither(toGray(solid(64, 32, 255), flat), { algorithm }))).toBe(0);
      expect(blackRatio(dither(toGray(solid(64, 32, 0), flat), { algorithm }))).toBe(1);
    });
  }

  it('Floyd–Steinberg preserves mean tone', () => {
    for (const v of [64, 128, 192]) {
      const r = blackRatio(dither(toGray(solid(128, 128, v), flat), { algorithm: 'floyd-steinberg' }));
      expect(r).toBeCloseTo(1 - v / 255, 1);
    }
  });

  it('Atkinson keeps light areas cleaner than Floyd–Steinberg (3/4 error diffusion)', () => {
    const light = toGray(solid(128, 128, 225), flat);
    const fs = blackRatio(dither(light, { algorithm: 'floyd-steinberg' }));
    const at = blackRatio(dither(light, { algorithm: 'atkinson' }));
    expect(at).toBeLessThan(fs);
  });

  it('a gradient produces monotonically decreasing dot density', () => {
    const bmp = dither(toGray(gradient(512, 64), flat), { algorithm: 'floyd-steinberg' });
    const bands = Array.from({ length: 8 }, (_, i) => blackFractionInColumns(bmp, i * 64, (i + 1) * 64));
    for (let i = 1; i < bands.length; i += 1) expect(bands[i]).toBeLessThan(bands[i - 1] ?? 1);
    expect(bands[0]).toBeGreaterThan(0.85);
    expect(bands[7]).toBeLessThan(0.15);
  });

  it('threshold is a hard cut', () => {
    const bmp = dither(toGray(gradient(256, 1), flat), { algorithm: 'threshold', threshold: 128 });
    expect(getDot(bmp, 127, 0)).toBe(true);
    expect(getDot(bmp, 128, 0)).toBe(false);
  });
});

describe('bitmap helpers', () => {
  it('packs MSB first with 1 = black', () => {
    const b = createBitmap(10, 1);
    setDot(b, 0, 0, true);
    setDot(b, 9, 0, true);
    expect([...b.data]).toEqual([0x80, 0x40]);
    expect(b.bytesPerRow).toBe(2);
  });

  it('stacks, scales and slices', () => {
    const a = createBitmap(4, 2);
    setDot(a, 0, 0, true);
    const s = stackCentered([a, a], 16, 3);
    expect([s.width, s.height]).toEqual([16, 7]);
    expect(getDot(s, 6, 0)).toBe(true);
    expect(getDot(s, 6, 5)).toBe(true);
    const big = scaleBitmap(a, 3);
    expect(getDot(big, 2, 2)).toBe(true);
    expect(getDot(big, 3, 0)).toBe(false);
    expect(sliceRows(s, 5, 7).height).toBe(2);
    expect(() => stackCentered([createBitmap(20, 1)], 16)).toThrow(RangeError);
  });
});

describe('ESC/POS encoding', () => {
  it('emits the exact GS v 0 header and image bytes', () => {
    const b = createBitmap(16, 3);
    b.data.set([0xff, 0x00, 0x0f, 0xf0, 0xaa, 0x55]);
    expect([...(rasterBands(b, 128)[0] ?? [])]).toEqual([
      0x1d, 0x76, 0x30, 0x00, 0x02, 0x00, 0x03, 0x00, 0xff, 0x00, 0x0f, 0xf0, 0xaa, 0x55,
    ]);
  });

  it('splits tall images into bands', () => {
    const bands = rasterBands(createBitmap(576, 300), 128);
    expect(bands.map((b) => (b[6] ?? 0) | ((b[7] ?? 0) << 8))).toEqual([128, 128, 44]);
    expect(bands.map((b) => b.length)).toEqual([8 + 72 * 128, 8 + 72 * 128, 8 + 72 * 44]);
  });

  it('wraps a job in init / centre / feed / cut', () => {
    const job = encodeRasterJob(createBitmap(8, 1));
    expect([...job.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01]);
    expect([...job.subarray(job.length - 7)]).toEqual([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]);
    expect([...cmd.status(4)]).toEqual([0x10, 0x04, 0x04]);
    expect(() => cmd.rasterHeader(0, 1)).toThrow(RangeError);
  });
});

describe('raster QR', () => {
  it('renders a scannable QR with a 4-module quiet zone', () => {
    const url = 'https://shriii.example/r/01928c6e-7d3a-7b2c-8f00-1234567890ab';
    const bmp = qrBitmap(url);
    const modules = qrMatrix(url).length + 8;
    expect(bmp.width % modules).toBe(0);
    expect(bmp.width).toBeLessThanOrEqual(384);
    const dots = bmp.width / modules;
    for (let x = 0; x < 4 * dots; x += 1) expect(getDot(bmp, x, Math.floor(bmp.height / 2))).toBe(false);
    const img = monoToRgba(bmp);
    expect(jsQR(img.data, img.width, img.height)?.data).toBe(url);
  });

  it('refuses payloads that do not fit', () => {
    expect(() => qrBitmap('x'.repeat(1500), { maxWidth: 200 })).toThrow(/too long/);
    expect(() => qrBitmap('x', { quietZone: 2 })).toThrow(/quiet zone/);
  });
});

describe('PNG', () => {
  it('round-trips a bitmap including odd widths', () => {
    const b = createBitmap(13, 5);
    for (let i = 0; i < 13; i += 2) setDot(b, i, i % 5, true);
    const back = decodePng(encodePng(b));
    expect(bitmapsEqual(back, b)).toBe(true);
    expect([...encodePng(b).subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  });
});
