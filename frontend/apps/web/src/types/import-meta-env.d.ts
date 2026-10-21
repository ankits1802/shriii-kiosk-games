/**
 * `@shriii/kiosk-game` is authored for Vite and reads `import.meta.env`. next.config.ts statically
 * replaces these keys (compiler.define); this declaration lets the web app type-check the package.
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly VITE_DEV_VOICE_PLACEHOLDER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
