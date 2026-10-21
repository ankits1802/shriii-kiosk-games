import type { Card, Colour, Shape } from '../domain/cards.ts';

/** Saturated, distinguishable fills; every shape also carries a dark outline for contrast. */
export const FILL: Readonly<Record<Colour, string>> = {
  red: '#d7263d',
  green: '#1b9e4b',
  yellow: '#f4c20d',
  blue: '#1f5fd6',
};

/** Shape paths drawn in a 40x40 box centred on (0, 0). */
function ShapePath({ shape, fill }: { shape: Shape; fill: string }) {
  const common = { fill, stroke: '#1d1d1f', strokeWidth: 2, strokeLinejoin: 'round' as const };
  switch (shape) {
    case 'triangle':
      return <polygon points="0,-18 18,15 -18,15" {...common} />;
    case 'star':
      return (
        <polygon
          points="0,-19 5.6,-6.2 19,-5.9 8.4,2.6 12.1,16 0,8.4 -12.1,16 -8.4,2.6 -19,-5.9 -5.6,-6.2"
          {...common}
        />
      );
    case 'cross':
      return (
        <polygon
          points="-6,-18 6,-18 6,-6 18,-6 18,6 6,6 6,18 -6,18 -6,6 -18,6 -18,-6 -6,-6"
          {...common}
        />
      );
    case 'circle':
      return <circle r="17" {...common} />;
  }
}

const LAYOUT: Readonly<Record<number, readonly [number, number][]>> = {
  1: [[50, 70]],
  2: [
    [50, 38],
    [50, 102],
  ],
  3: [
    [50, 28],
    [50, 70],
    [50, 112],
  ],
  4: [
    [27, 40],
    [73, 40],
    [27, 100],
    [73, 100],
  ],
};

export function CardFace({ card, label }: { card: Card; label?: string }) {
  const points = LAYOUT[card.number] ?? [];
  return (
    <svg
      className="card-face"
      viewBox="0 0 100 140"
      role="img"
      aria-label={label ?? `${card.number} ${card.colour} ${card.shape}`}
      data-card={`${card.colour}-${card.shape}-${card.number}`}
    >
      <rect
        x="2"
        y="2"
        width="96"
        height="136"
        rx="10"
        fill="#ffffff"
        stroke="#c9c9cf"
        strokeWidth="2"
      />
      {points.map(([x, y]) => (
        <g
          key={`${x}-${y}`}
          transform={`translate(${x} ${y}) scale(${card.number === 4 ? 0.95 : 1})`}
        >
          <ShapePath shape={card.shape} fill={FILL[card.colour]} />
        </g>
      ))}
    </svg>
  );
}
