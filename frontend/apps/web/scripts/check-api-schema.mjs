// Fails when src/generated/api-schema.ts is stale relative to backend/api/openapi.json.
// openapi-typescript needs the TypeScript 5 JS API (the repo uses TypeScript 7), so it runs through
// `pnpm dlx` with its own TypeScript 5.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const committed = join(root, 'src', 'generated', 'api-schema.ts');
const dir = mkdtempSync(join(tmpdir(), 'shriii-api-schema-'));
const fresh = join(dir, 'api-schema.ts');

try {
  execFileSync(
    'pnpm',
    [
      'dlx',
      '--package=openapi-typescript@7.13.0',
      '--package=typescript@5.9.3',
      'openapi-typescript',
      join(root, '..', '..', '..', 'backend', 'api', 'openapi.json'),
      '-o',
      fresh,
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  const normalise = (s) => s.replace(/\r\n/g, '\n');
  if (normalise(readFileSync(fresh, 'utf8')) !== normalise(readFileSync(committed, 'utf8'))) {
    console.error('api-schema.ts is stale: run `pnpm --filter web api:generate`.');
    process.exitCode = 1;
  } else {
    console.log('api-schema.ts matches backend/api/openapi.json');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
