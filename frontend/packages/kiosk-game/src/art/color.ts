/**
 * Colour utilities for the procedural art kit. Colours are 0xRRGGBB numbers (Pixi convention).
 * Pure functions only, so they are unit-testable and usable outside a renderer.
 */

/** Split a 0xRRGGBB colour into 0..255 channels. */
export function rgbOf(color: number): readonly [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/** Build a 0xRRGGBB colour from 0..255 channels (clamped and rounded). */
export function fromRgb(r: number, g: number, b: number): number {
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/** Linear interpolation between two numbers. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp to [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Smoothstep easing on [0, 1]. */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Interpolate two colours in linear-light RGB (avoids muddy midpoints of sRGB lerp). */
export function mixColor(a: number, b: number, t: number): number {
  const [ar, ag, ab] = rgbOf(a);
  const [br, bg, bb] = rgbOf(b);
  const toLin = (v: number): number => (v / 255) ** 2.2;
  const toSrgb = (v: number): number => 255 * v ** (1 / 2.2);
  return fromRgb(
    toSrgb(lerp(toLin(ar), toLin(br), t)),
    toSrgb(lerp(toLin(ag), toLin(bg), t)),
    toSrgb(lerp(toLin(ab), toLin(bb), t)),
  );
}

/** Lighten towards white by `amount` (0..1). */
export function lighten(color: number, amount: number): number {
  return mixColor(color, 0xffffff, amount);
}

/** Darken towards black by `amount` (0..1). */
export function darken(color: number, amount: number): number {
  return mixColor(color, 0x000000, amount);
}

/** Multiply two colours channel-wise (light tinting). */
export function multiply(a: number, b: number): number {
  const [ar, ag, ab] = rgbOf(a);
  const [br, bg, bb] = rgbOf(b);
  return fromRgb((ar * br) / 255, (ag * bg) / 255, (ab * bb) / 255);
}

/** Desaturate by `amount` (0..1) using Rec. 709 luma. */
export function desaturate(color: number, amount: number): number {
  const [r, g, b] = rgbOf(color);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return fromRgb(lerp(r, y, amount), lerp(g, y, amount), lerp(b, y, amount));
}

/** WCAG relative luminance (0..1). */
export function relativeLuminance(color: number): number {
  const ch = rgbOf(color).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** CSS hex string (`#rrggbb`) for DOM overlays and the printable summary. */
export function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** CSS rgba() string. */
export function cssRgba(color: number, alpha: number): string {
  const [r, g, b] = rgbOf(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Convert sRGB to CIE L*a*b* (D65); used by the colour-vision tests (KSK-06 ΔE). */
export function toLab(color: number): readonly [number, number, number] {
  const lin = rgbOf(color).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = lin;
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference. */
export function deltaE(a: number, b: number): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * Simulate dichromat colour vision (Viénot/Brettel-style matrices in linear RGB).
 * Used in tests to check paired UI categories stay distinguishable without colour alone.
 */
export function simulateColorBlind(
  color: number,
  kind: 'protanopia' | 'deuteranopia' | 'tritanopia',
): number {
  const lin = rgbOf(color).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = lin;
  const m: Record<typeof kind, readonly number[]> = {
    protanopia: [
      0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
    ],
    deuteranopia: [
      0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
    ],
    tritanopia: [
      1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
    ],
  };
  const k = m[kind];
  const at = (i: number): number => k[i] ?? 0;
  const out = [
    at(0) * r + at(1) * g + at(2) * b,
    at(3) * r + at(4) * g + at(5) * b,
    at(6) * r + at(7) * g + at(8) * b,
  ].map((v) => {
    const c = clamp(v, 0, 1);
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  });
  return fromRgb(out[0] ?? 0, out[1] ?? 0, out[2] ?? 0);
}
