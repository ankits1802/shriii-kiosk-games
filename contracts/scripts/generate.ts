/**
 * Deterministic code generation from the canonical JSON Schemas in ../schemas.
 *
 * Outputs (all under src/generated, never edit by hand):
 *   - types.ts         TypeScript types (json-schema-to-typescript) for every contract
 *   - constants.ts     enum value tuples (event types, construct ids, ...) and schema ids
 *   - validators.js    Ajv standalone validators (strict writer + tolerant reader variants)
 *   - validators.d.ts  typings for validators.js
 *
 * Usage:  node scripts/generate.ts           (write files)
 *         node scripts/generate.ts --check   (fail if committed output drifts)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import addFormatsModule from 'ajv-formats';
import { compile } from 'json-schema-to-typescript';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const schemaDir = join(root, 'schemas');
const outDir = join(root, 'src', 'generated');
const BASE = 'https://shriii.local/contracts/';
const READER_BASE = 'https://shriii.local/contracts/reader/';
const check = process.argv.includes('--check');

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/** Contracts that get a public validator, keyed by exported function suffix. */
const CONTRACTS: Record<string, string> = {
  EventEnvelope: 'event-envelope.v1.schema.json',
  UploadBatch: 'upload-batch.v1.schema.json',
  UploadBatchResult: 'upload-batch-result.v1.schema.json',
  SessionContext: 'session-context.v1.schema.json',
  ContentManifest: 'content-manifest.v1.schema.json',
  GameTrialSpec: 'game-trial-spec.v1.schema.json',
  CriterionResponse: 'criterion-response.v1.schema.json',
  CriterionScaleScore: 'criterion-scale-score.v1.schema.json',
  ConsentArtefact: 'consent-artefact.v1.schema.json',
  ReportArtefact: 'report-artefact.v1.schema.json',
  ReleasePack: 'release-pack.v1.schema.json',
  ScoringDictionaryShared: 'scoring-dictionary-shared.v1.schema.json',
  ScoringDictionaryPathway: 'scoring-dictionary-pathway.v1.schema.json',
  Hypotheses: 'hypotheses.v1.schema.json',
  Gates: 'gates.v1.schema.json',
  Instrument: 'instrument.v1.schema.json',
  GameConfig: 'game-config.v1.schema.json',
  VoiceLineCatalogue: 'voice-line-catalogue.v1.schema.json',
  SessionPlan: 'session-plan.v1.schema.json',
};

function loadSchemas(): Map<string, JsonObject> {
  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
  const map = new Map<string, JsonObject>();
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(join(schemaDir, f), 'utf8')) as JsonObject;
    if (parsed.$id !== `${BASE}${f}`) {
      throw new Error(`${f}: $id must be ${BASE}${f}, got ${String(parsed.$id)}`);
    }
    map.set(f, parsed);
  }
  for (const file of Object.values(CONTRACTS)) {
    if (!map.has(file)) throw new Error(`missing contract schema ${file}`);
  }
  return map;
}

/* ------------------------------------------------------------------ restricted profile */

const BANNED_KEYWORDS = new Set([
  '$dynamicRef',
  '$dynamicAnchor',
  'unevaluatedProperties',
  'unevaluatedItems',
  'if',
  'then',
  'else',
  'dependentSchemas',
]);

/** PLT-02 restricted-profile linter. Returns a list of violations (empty = ok). */
export function lintProfile(file: string, node: Json, path = '#'): string[] {
  const errors: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((n, i) => {
      errors.push(...lintProfile(file, n, `${path}/${i}`));
    });
    return errors;
  }
  if (node === null || typeof node !== 'object') return errors;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [pk, pv] of Object.entries(v)) {
        errors.push(...lintProfile(file, pv, `${path}/properties/${pk}`));
      }
      continue;
    }
    if (BANNED_KEYWORDS.has(k)) errors.push(`${file} ${path}: banned keyword "${k}"`);
    if (k === 'oneOf') {
      const discr = (node as JsonObject).discriminator as JsonObject | undefined;
      if (!discr || typeof discr.propertyName !== 'string') {
        errors.push(`${file} ${path}: oneOf without discriminator`);
      }
    }
    errors.push(...lintProfile(file, v, `${path}/${k}`));
  }
  return errors;
}

/* ------------------------------------------------------------------ TypeScript types */

const pascal = (s: string): string =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

const fileKey = (file: string): string => file.replace(/\.v1\.schema\.json$/, '');

/** Build one bundle schema with every file's defs local, so json2ts emits each type exactly once. */
function bundleForTypes(schemas: Map<string, JsonObject>): JsonObject {
  const defs: JsonObject = {};
  const rootTitle = new Map<string, string>();
  for (const [file, s] of schemas) rootTitle.set(file, String(s.title ?? pascal(fileKey(file))));

  const rewrite = (node: Json, file: string): Json => {
    if (Array.isArray(node)) return node.map((n) => rewrite(n, file));
    if (node === null || typeof node !== 'object') return node;
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const [target, pointer] = v.split('#') as [string, string | undefined];
        const targetFile = target === '' ? file : target;
        if (!schemas.has(targetFile)) throw new Error(`${file}: unresolved $ref ${v}`);
        if (!pointer || pointer === '') {
          out.$ref = `#/$defs/${rootTitle.get(targetFile)}`;
        } else {
          const m = /^\/\$defs\/([A-Za-z0-9_]+)$/.exec(pointer);
          if (!m) throw new Error(`${file}: unsupported $ref pointer ${v}`);
          out.$ref = `#/$defs/${fileKey(targetFile)}__${m[1]}`;
        }
        continue;
      }
      if (k === '$schema' || k === '$id' || k === '$defs' || k === 'discriminator') continue;
      out[k] = rewrite(v, file);
    }
    return out;
  };

  for (const [file, s] of schemas) {
    const localDefs = (s.$defs ?? {}) as JsonObject;
    for (const [name, def] of Object.entries(localDefs)) {
      const rewritten = rewrite(def, file) as JsonObject;
      if (!rewritten.title) rewritten.title = pascal(name);
      defs[`${fileKey(file)}__${name}`] = rewritten;
    }
    const body = rewrite(s, file) as JsonObject;
    defs[rootTitle.get(file) as string] = body;
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ShriiiContracts',
    $defs: defs,
  };
}

async function generateTypes(schemas: Map<string, JsonObject>): Promise<string> {
  const bundle = bundleForTypes(schemas);
  const ts = await compile(bundle as never, 'ShriiiContracts', {
    bannerComment: '',
    unreachableDefinitions: true,
    additionalProperties: false,
    strictIndexSignatures: true,
    format: true,
    style: { singleQuote: true, semi: true, printWidth: 100, trailingComma: 'all' },
    cwd: schemaDir,
    $refOptions: { resolve: { external: false } as never },
  });
  // Drop the synthetic container interface for the bundle itself.
  const cleaned = ts.replace(/export interface ShriiiContracts \{[\s\S]*?\n\}\n?/, '');
  return `${HEADER}\n${cleaned.trim()}\n`;
}

const HEADER = `/* eslint-disable */
// biome-ignore-all lint: generated file
/**
 * GENERATED by contracts/scripts/generate.ts from schemas/*.schema.json.
 * Do not edit by hand. Run \`pnpm --filter @shriii/contracts generate\`.
 */`;

/* ------------------------------------------------------------------ constants */

function enumOf(schemas: Map<string, JsonObject>, file: string, def: string): string[] {
  const s = schemas.get(file);
  const d = (s?.$defs as JsonObject | undefined)?.[def] as JsonObject | undefined;
  const values = d?.enum;
  if (!Array.isArray(values)) throw new Error(`${file}#/$defs/${def} has no enum`);
  return values.map(String);
}

function generateConstants(schemas: Map<string, JsonObject>): string {
  const c = 'common.v1.schema.json';
  const tuples: Array<[string, string[], string]> = [
    [
      'EVENT_TYPES',
      enumOf(schemas, 'event-envelope.v1.schema.json', 'event_type'),
      'Every event_type in the v1 envelope.',
    ],
    [
      'CONSTRUCT_IDS',
      enumOf(schemas, c, 'construct_id'),
      'The 17 construct ids (plan section 4.3).',
    ],
    ['PATHWAYS', enumOf(schemas, c, 'pathway'), 'Assessment pathways.'],
    ['SITE_MODES', enumOf(schemas, c, 'site_mode'), 'Site modes.'],
    ['SESSION_MODES', enumOf(schemas, c, 'session_mode'), 'Session modes.'],
    ['BATTERY_ARMS', enumOf(schemas, c, 'battery_arm'), 'Pilot arms (some reserved).'],
    ['SLOT_FORMS', enumOf(schemas, c, 'slot_form'), 'Planned-missingness slot modules.'],
    ['CALIBRATION_LEVELS', enumOf(schemas, c, 'calibration_level'), 'Calibration levels.'],
    ['CALIBRATION_POLICIES', enumOf(schemas, c, 'calibration_policy'), 'Calibration policies.'],
    ['PHASES', enumOf(schemas, c, 'phase'), 'Trial phases.'],
    ['INPUT_MODES', enumOf(schemas, c, 'input_mode'), 'Response input modes.'],
    ['LATENCY_ANCHORS', enumOf(schemas, c, 'latency_anchor'), 'Latency anchors.'],
    ['REPORT_MODES', enumOf(schemas, c, 'report_mode'), 'Report modes.'],
    ['CONSENT_KINDS', enumOf(schemas, c, 'consent_kind'), 'Consent kinds (no camera kind exists).'],
    ['PARTNER_TYPES', enumOf(schemas, c, 'partner_type'), 'Co-play partner types.'],
    ['TIMING_FLAGS', enumOf(schemas, c, 'timing_flag'), 'Timing quality flags.'],
    ['SESSION_STATES', enumOf(schemas, c, 'session_state'), 'Session statechart states (KSK-02).'],
    ['AGE_BANDS', enumOf(schemas, c, 'age_band'), 'Persisted age bands.'],
    ['LITERACY_BANDS', enumOf(schemas, c, 'literacy_band'), 'Literacy bands.'],
    ['EDU_BANDS', enumOf(schemas, c, 'edu_band'), 'Education bands.'],
    ['GENDERS', enumOf(schemas, c, 'gender'), 'Gender options.'],
    ['DEVICE_FAMILIARITY', enumOf(schemas, c, 'device_familiarity'), 'Smartphone use bands.'],
    ['PLAYED_BEFORE', enumOf(schemas, c, 'played_before'), 'Played-before options.'],
    ['ITC_STATES', enumOf(schemas, c, 'itc_state'), 'ITC adaptation states.'],
    ['TRAIT_GATE_STATUSES', enumOf(schemas, c, 'trait_gate_status'), 'Trait gate statuses.'],
    ['BATTERY_GATE_STATUSES', enumOf(schemas, c, 'battery_gate_status'), 'Battery gate statuses.'],
    ['BANDS', enumOf(schemas, c, 'band'), 'Internal report band codes.'],
    [
      'EVENT_STATUSES',
      enumOf(schemas, 'upload-batch-result.v1.schema.json', 'event_status'),
      'Per-event ingestion statuses.',
    ],
  ];
  const lines: string[] = [HEADER, ''];
  const commonDefs = schemas.get('common.v1.schema.json')?.$defs as JsonObject | undefined;
  if (!commonDefs) throw new Error('common.v1.schema.json has no $defs');
  const ver = commonDefs.minor_schema_version as JsonObject;
  lines.push(`/** Current contract schema version written by v1 writers. */`);
  lines.push(`export const SCHEMA_VERSION = '1.0' as const;`);
  lines.push(`/** Accepted schema_version pattern for major 1. */`);
  lines.push(
    `export const SCHEMA_VERSION_PATTERN = ${JSON.stringify(String(ver.pattern))} as const;`,
  );
  lines.push(`/** Base URI of all contract $ids. */`);
  lines.push(`export const SCHEMA_BASE_URI = '${BASE}' as const;`);
  lines.push('');
  for (const [name, values, doc] of tuples) {
    lines.push(`/** ${doc} */`);
    lines.push(`export const ${name} = [`);
    for (const v of values) lines.push(`  ${JSON.stringify(v)},`);
    lines.push(`] as const;`);
    lines.push('');
  }
  lines.push(`/** Schema file (under schemas/) for each contract. */`);
  lines.push(`export const CONTRACT_SCHEMA_FILES = {`);
  for (const [k, f] of Object.entries(CONTRACTS)) lines.push(`  ${k}: ${JSON.stringify(f)},`);
  lines.push(`} as const;`);
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ Ajv standalone */

/** Reader variant: identical schemas but every additionalProperties:false is relaxed (tolerant readers). */
function toReader(node: Json): Json {
  if (Array.isArray(node)) return node.map(toReader);
  if (node === null || typeof node !== 'object') return node;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' && v === false) continue;
    if (k === '$id' && typeof v === 'string') {
      out.$id = v.replace(BASE, READER_BASE);
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      const props: JsonObject = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = toReader(pv);
      out[k] = props;
      continue;
    }
    out[k] = toReader(v);
  }
  return out;
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Ajv emits CommonJS require() for runtime helpers even in ESM mode; hoist them to ESM imports. */
function esmify(raw: string): string {
  const modules = [
    ...new Set([...raw.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1] as string)),
  ].sort();
  let code = raw.replace(/^"use strict";/, '');
  const imports = modules.map((m, i) => {
    code = code.split(`require("${m}")`).join(`__ajvRuntime${i}`);
    return `import * as __ajvNs${i} from '${m}.js';\nconst __ajvRuntime${i} = __ajvInterop(__ajvNs${i});`;
  });
  // CJS interop differs between Node ESM (default = module.exports) and bundlers (default = exports.default).
  const interop =
    imports.length === 0
      ? ''
      : "const __ajvInterop = (ns) => { const d = ns.default; if (d && typeof d === 'object') return d; if (typeof d === 'function') return { default: d }; return ns; };\n";
  return `// @ts-nocheck\n/* GENERATED by scripts/generate.ts (Ajv standalone). Do not edit. */\n${interop}${imports.join('\n')}\n${code}\n`;
}

/**
 * One standalone module per contract (strict writer + tolerant reader), so a consumer such as the
 * kiosk logger only bundles the validators it imports. No eval at runtime: CSP-safe.
 */
function generateValidators(schemas: Map<string, JsonObject>): Record<string, string> {
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: false,
    discriminator: true,
    allowUnionTypes: true,
    inlineRefs: false,
    // The restricted profile bans unevaluated*/$dynamicRef, so skip their (large) tracking code.
    unevaluated: false,
    dynamicRef: false,
    code: { source: true, esm: true, lines: false, optimize: true },
  });
  addFormats(ajv);
  for (const s of schemas.values()) {
    ajv.addSchema(s as never);
    ajv.addSchema(toReader(s) as never);
  }
  const files: Record<string, string> = {};
  const indexJs: string[] = ['/* GENERATED by scripts/generate.ts. Do not edit. */'];
  const indexDts: string[] = ['/* GENERATED by scripts/generate.ts. Do not edit. */'];
  for (const [name, file] of Object.entries(CONTRACTS)) {
    const mod = kebab(name);
    const strictRaw = standaloneCode(ajv, { [`validate${name}`]: `${BASE}${file}` });
    const readerRaw = standaloneCode(ajv, { [`read${name}`]: `${READER_BASE}${file}` });
    files[`validators/${mod}.js`] = esmify(strictRaw);
    files[`validators/${mod}.reader.js`] = esmify(readerRaw);
    files[`validators/${mod}.d.ts`] = [
      '/* GENERATED by scripts/generate.ts. Do not edit. */',
      `import type { ${name} } from '../types.ts';`,
      "import type { StandaloneValidator } from './validator-types.ts';",
      '',
      `/** Strict (writer) validator for ${name}: unknown properties are rejected. */`,
      `export declare const validate${name}: StandaloneValidator<${name}>;`,
      '',
    ].join('\n');
    files[`validators/${mod}.reader.d.ts`] = [
      '/* GENERATED by scripts/generate.ts. Do not edit. */',
      `import type { ${name} } from '../types.ts';`,
      "import type { StandaloneValidator } from './validator-types.ts';",
      '',
      `/** Tolerant (reader) validator for ${name}: unknown properties are accepted (minor N+1). */`,
      `export declare const read${name}: StandaloneValidator<${name}>;`,
      '',
    ].join('\n');
    for (const target of [indexJs, indexDts]) {
      target.push(`export { validate${name} } from './${mod}.js';`);
      target.push(`export { read${name} } from './${mod}.reader.js';`);
    }
  }
  files['validators/index.js'] = `${indexJs.join('\n')}\n`;
  files['validators/index.d.ts'] =
    `${indexDts.join('\n')}\nexport type { AjvErrorObject, StandaloneValidator } from './validator-types.ts';\n`;
  files['validators/validator-types.ts'] = [
    '/* GENERATED by scripts/generate.ts. Do not edit. */',
    '',
    '/** Minimal Ajv error shape exposed by the standalone validators. */',
    'export interface AjvErrorObject {',
    '  instancePath: string;',
    '  schemaPath: string;',
    '  keyword: string;',
    '  params: Record<string, unknown>;',
    '  message?: string;',
    '}',
    '',
    '/** A compiled standalone validator; `errors` is set after a failed call. */',
    'export interface StandaloneValidator<T> {',
    '  (data: unknown): data is T;',
    '  errors?: AjvErrorObject[] | null;',
    '}',
    '',
  ].join('\n');
  return files;
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  const schemas = loadSchemas();
  const lint = [...schemas].flatMap(([f, s]) => lintProfile(f, s));
  if (lint.length) {
    console.error(lint.join('\n'));
    process.exit(1);
  }
  const outputs: Record<string, string> = {
    'types.ts': await generateTypes(schemas),
    'constants.ts': generateConstants(schemas),
  };
  Object.assign(outputs, generateValidators(schemas));

  for (const dir of [outDir, join(outDir, 'validators')]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const drift: string[] = [];
  for (const [name, content] of Object.entries(outputs)) {
    const p = join(outDir, name);
    const normalized = content.replace(/\r\n/g, '\n');
    if (check) {
      const current = existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '';
      if (current !== normalized) drift.push(name);
    } else {
      writeFileSync(p, normalized, 'utf8');
    }
  }
  if (check && drift.length) {
    console.error(
      `Generated contract code is out of date: ${drift.join(', ')}. Run "pnpm --filter @shriii/contracts generate".`,
    );
    process.exit(1);
  }
  console.log(
    check
      ? 'contracts: generated code is up to date'
      : `contracts: wrote ${Object.keys(outputs).length} files`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
