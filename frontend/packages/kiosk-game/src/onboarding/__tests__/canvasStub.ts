/**
 * Minimal CanvasRenderingContext2D stub for jsdom so Pixi Graphics with gradient fills can be built in
 * unit tests (drawing is never rasterised in tests). Import this module first in screen tests.
 */
const noop = (): void => undefined;

function fakeContext(canvas: HTMLCanvasElement): unknown {
  const gradient = { addColorStop: noop };
  return {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    lineWidth: 1,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    fillRect: noop,
    clearRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    resetTransform: noop,
    drawImage: noop,
    putImageData: noop,
    measureText: () => ({ width: 0 }),
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
}

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, kind: string) {
      return kind === '2d' ? fakeContext(this) : null;
    },
  });
}

export {};
