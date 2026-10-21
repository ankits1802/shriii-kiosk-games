import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(here, '..');
export const fixturesRoot = join(packageRoot, 'fixtures');
export const schemasRoot = join(packageRoot, 'schemas');

export interface Fixture {
  readonly contract: string;
  readonly name: string;
  readonly path: string;
  readonly data: unknown;
}

/** Load every fixture under fixtures/<kind>/<contract>/*.json. */
export function loadFixtures(kind: 'valid' | 'invalid' | 'forward-compat'): Fixture[] {
  const root = join(fixturesRoot, kind);
  const out: Fixture[] = [];
  for (const contract of readdirSync(root).sort()) {
    const dir = join(root, contract);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) continue;
      const path = join(dir, file);
      out.push({
        contract,
        name: basename(file, '.json'),
        path,
        data: JSON.parse(readFileSync(path, 'utf8')),
      });
    }
  }
  return out;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function listSchemaFiles(): string[] {
  return readdirSync(schemasRoot)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
}
