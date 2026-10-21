import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/** Monorepo root: Turbopack must see packages/* and content/* (kiosk-game imports content JSON). */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** FastAPI origin; the browser talks to it through same-origin rewrites (no CORS, no token in URLs). */
const apiProxyTarget = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000').replace(
  /\/+$/,
  '',
);

const isProduction = process.env.NODE_ENV === 'production';

/**
 * `@shriii/kiosk-game` is authored for Vite and reads `import.meta.env.*`. Next.js has no
 * `import.meta.env`, so the handful of keys it reads are statically replaced here. The dev voice
 * placeholder (Web Speech, "DEV VOICE" banner) is forced off in production builds (BUILD_DECISIONS:
 * no runtime TTS in production).
 */
const kioskEnvShims: Record<string, string> = {
  'import.meta.env.DEV': JSON.stringify(!isProduction),
  'import.meta.env.PROD': JSON.stringify(isProduction),
  'import.meta.env.MODE': JSON.stringify(isProduction ? 'production' : 'development'),
  'import.meta.env.VITE_DEV_VOICE_PLACEHOLDER': JSON.stringify(
    !isProduction && process.env.NEXT_PUBLIC_DEV_VOICE_PLACEHOLDER === 'true' ? 'true' : 'false',
  ),
};

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Camera is never used (no facial signals). The microphone is only for opt-in closed-vocabulary
  // kiosk ASR, so it is allowed for this origin only.
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@shriii/kiosk-game', '@shriii/contracts'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  compiler: { define: kioskEnvShims },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${apiProxyTarget}/api/v1/:path*` },
      { source: '/healthz', destination: `${apiProxyTarget}/healthz` },
      { source: '/readyz', destination: `${apiProxyTarget}/readyz` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
