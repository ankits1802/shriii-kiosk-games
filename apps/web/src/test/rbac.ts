/**
 * Test helper: the API's role -> permission matrix, read from the real rbac.py by Python (the
 * module only imports the standard library). Used by the parity and navigation tests and by the
 * e2e API mock so tests never drift from the server's RBAC.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RBAC_PY = fileURLToPath(
  new URL('../../../api/src/shriii_api/auth/rbac.py', import.meta.url),
);

const SCRIPT = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rbac", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
sys.modules["rbac"] = mod
spec.loader.exec_module(mod)
print(json.dumps({
  "permissions": [p.value for p in mod.Perm],
  "roles": {r.value: sorted(p.value for p in perms) for r, perms in mod.ROLE_PERMISSIONS.items()},
}))
`;

export interface RbacMatrix {
  readonly permissions: readonly string[];
  readonly roles: Readonly<Record<string, readonly string[]>>;
}

let cached: RbacMatrix | null | undefined;

/** The matrix, or null when no Python interpreter is available. */
export function loadRbacMatrix(): RbacMatrix | null {
  if (cached !== undefined) return cached;
  for (const exe of ['python', 'python3']) {
    const res = spawnSync(exe, ['-c', SCRIPT, RBAC_PY], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      cached = JSON.parse(res.stdout) as RbacMatrix;
      return cached;
    }
  }
  cached = null;
  return cached;
}

/** Permission names straight from the Perm enum source text (works without Python). */
export function permissionsFromSource(): string[] {
  const src = readFileSync(RBAC_PY, 'utf8');
  const block = src.slice(src.indexOf('class Perm('), src.indexOf('_RESEARCH_READ'));
  return [...block.matchAll(/^\s+[A-Z_]+\s*=\s*"([a-z_.]+)"/gm)].map((m) => m[1] as string);
}
