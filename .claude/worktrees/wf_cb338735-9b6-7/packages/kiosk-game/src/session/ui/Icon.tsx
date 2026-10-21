/**
 * Inline SVG pictograms for the fallback shell (no text, no numerals; colour is never the only cue:
 * each icon has a distinct shape).
 */
import type { CSSProperties, ReactElement } from 'react';

export type IconName =
  | 'hand'
  | 'tick'
  | 'cross'
  | 'face_happy'
  | 'face_neutral'
  | 'face_sad'
  | 'adult'
  | 'child'
  | 'sun'
  | 'bin'
  | 'keep'
  | 'question'
  | 'box'
  | 'box_checked'
  | 'phone';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function paths(name: IconName): ReactElement {
  switch (name) {
    case 'tick':
      return <path d="M22 52 L42 72 L78 30" {...stroke} strokeWidth={12} />;
    case 'cross':
      return <path d="M28 28 L72 72 M72 28 L28 72" {...stroke} strokeWidth={12} />;
    case 'face_happy':
    case 'face_neutral':
    case 'face_sad': {
      const mouth =
        name === 'face_happy'
          ? 'M32 60 Q50 78 68 60'
          : name === 'face_neutral'
            ? 'M32 64 L68 64'
            : 'M32 70 Q50 54 68 70';
      return (
        <g>
          <circle cx="50" cy="50" r="40" {...stroke} />
          <circle cx="36" cy="40" r="5" fill="currentColor" />
          <circle cx="64" cy="40" r="5" fill="currentColor" />
          <path d={mouth} {...stroke} />
        </g>
      );
    }
    case 'adult':
      return (
        <g>
          <circle cx="50" cy="20" r="11" fill="currentColor" />
          <path d="M50 34 L50 66 M30 46 L70 46 M50 66 L36 92 M50 66 L64 92" {...stroke} />
        </g>
      );
    case 'child':
      return (
        <g>
          <circle cx="50" cy="46" r="10" fill="currentColor" />
          <path d="M50 58 L50 76 M38 66 L62 66 M50 76 L42 92 M50 76 L58 92" {...stroke} />
        </g>
      );
    case 'sun':
      return (
        <g>
          <circle cx="50" cy="50" r="18" fill="currentColor" />
          <path
            d="M50 12 L50 22 M50 78 L50 88 M12 50 L22 50 M78 50 L88 50 M23 23 L30 30 M70 70 L77 77 M23 77 L30 70 M70 30 L77 23"
            {...stroke}
          />
        </g>
      );
    case 'bin':
      return (
        <path
          d="M28 30 L72 30 M40 30 L42 20 L58 20 L60 30 M32 30 L36 84 L64 84 L68 30 M45 42 L45 74 M55 42 L55 74"
          {...stroke}
        />
      );
    case 'keep':
      return <path d="M30 20 L70 20 L70 86 L50 70 L30 86 Z" {...stroke} />;
    case 'question':
      return (
        <g>
          <path
            d="M34 34 Q34 16 50 16 Q66 16 66 32 Q66 44 50 50 L50 62"
            {...stroke}
            strokeWidth={10}
          />
          <circle cx="50" cy="80" r="6" fill="currentColor" />
        </g>
      );
    case 'box':
      return <rect x="20" y="20" width="60" height="60" rx="8" {...stroke} />;
    case 'box_checked':
      return (
        <g>
          <rect x="20" y="20" width="60" height="60" rx="8" {...stroke} />
          <path d="M32 50 L45 63 L70 36" {...stroke} />
        </g>
      );
    case 'phone':
      return <rect x="32" y="12" width="36" height="76" rx="8" {...stroke} />;
    default:
      return (
        <g>
          <path
            d="M34 54 L34 30 Q34 24 40 24 Q46 24 46 30 L46 50 L46 18 Q46 12 52 12 Q58 12 58 18 L58 50 L58 22 Q58 16 64 16 Q70 16 70 22 L70 62 Q70 88 48 88 Q34 88 26 74 L18 60 Q15 54 21 51 Q27 48 31 54 Z"
            fill="currentColor"
          />
        </g>
      );
  }
}

export function Icon({
  name,
  size = 96,
  style,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly style?: CSSProperties;
}): ReactElement {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {paths(name)}
    </svg>
  );
}
