/**
 * Validation of the language pack's ASR configuration (`asr-config.<lang>.json`, written by
 * tools/asr-bakeoff from the VOX-06 policy). Invalid configs fail closed: the session runs touch only.
 */
import type { AsrGrammar, ConfidenceTier, GrammarPhrase, PromptPolicy } from './types.ts';

const CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const LANG_RE = /^[a-z]{2,3}-[A-Z]{2}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const PROMPT_RE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const TOKEN_RE = /^[^\s@:#]+(?: [^\s@:#]+)*$/;

/**
 * Prompt families that are touch only by rule, whatever a config says (ONB-02, VOX-04: consent,
 * opt-ins and private reports are never answered by voice).
 */
export const TOUCH_ONLY_PROMPT_PREFIXES: readonly string[] = [
  'consent.',
  'optin.',
  'bands.',
  'report.private',
  'private.',
];

export class GrammarError extends Error {
  override readonly name = 'GrammarError';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new GrammarError(`${path} must be a number in [${min}, ${max}]`);
  }
  return v;
}

export function isTouchOnlyPrompt(promptId: string): boolean {
  return TOUCH_ONLY_PROMPT_PREFIXES.some((p) => promptId.startsWith(p));
}

/** Validate and freeze an ASR config. Throws {@link GrammarError} on any problem. */
export function parseGrammar(raw: unknown): AsrGrammar {
  if (!isObject(raw)) throw new GrammarError('asr config must be an object');
  if (raw.schema_version !== '1.0') throw new GrammarError('schema_version must be "1.0"');
  const language = raw.language;
  if (typeof language !== 'string' || !LANG_RE.test(language)) {
    throw new GrammarError('language must be a BCP-47 tag like hi-IN');
  }
  if (typeof raw.grammar_version !== 'string' || !SEMVER_RE.test(raw.grammar_version)) {
    throw new GrammarError('grammar_version must be semver');
  }
  if (typeof raw.engine !== 'string' || raw.engine.length === 0)
    throw new GrammarError('engine missing');
  if (typeof raw.model_id !== 'string' || raw.model_id.length === 0) {
    throw new GrammarError('model_id missing');
  }

  if (!isObject(raw.keywords) || Object.keys(raw.keywords).length === 0) {
    throw new GrammarError('keywords must be a non-empty object');
  }
  const keywords: Record<string, { phrases: GrammarPhrase[] }> = {};
  const seenTokens = new Map<string, string>();
  for (const [code, entry] of Object.entries(raw.keywords)) {
    if (!CODE_RE.test(code)) throw new GrammarError(`keyword code ${code} is not a closed code`);
    if (!isObject(entry) || !Array.isArray(entry.phrases) || entry.phrases.length === 0) {
      throw new GrammarError(`keywords.${code}.phrases must be a non-empty array`);
    }
    const phrases: GrammarPhrase[] = [];
    for (const [i, p] of entry.phrases.entries()) {
      if (!isObject(p) || typeof p.tokens !== 'string' || !TOKEN_RE.test(p.tokens.trim())) {
        throw new GrammarError(
          `keywords.${code}.phrases[${i}].tokens must be space-separated tokens`,
        );
      }
      const tokens = p.tokens.trim();
      const owner = seenTokens.get(tokens);
      if (owner !== undefined && owner !== code) {
        throw new GrammarError(`token sequence "${tokens}" maps to both ${owner} and ${code}`);
      }
      seenTokens.set(tokens, code);
      const phrase: { tokens: string; boost?: number; text?: string } = { tokens };
      if (p.boost !== undefined)
        phrase.boost = num(p.boost, `keywords.${code}.phrases[${i}].boost`, 0, 10);
      if (typeof p.text === 'string') phrase.text = p.text;
      phrases.push(phrase);
    }
    keywords[code] = { phrases };
  }

  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) {
    throw new GrammarError('tiers must be a non-empty array');
  }
  const tiers: ConfidenceTier[] = raw.tiers.map((t, i) => {
    if (!isObject(t)) throw new GrammarError(`tiers[${i}] must be an object`);
    return {
      keywords_threshold: num(t.keywords_threshold, `tiers[${i}].keywords_threshold`, 0, 1),
      confidence: num(t.confidence, `tiers[${i}].confidence`, 0, 1),
    };
  });
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1] as ConfidenceTier;
    const cur = tiers[i] as ConfidenceTier;
    if (cur.keywords_threshold <= prev.keywords_threshold || cur.confidence < prev.confidence) {
      throw new GrammarError(
        'tiers must be strictly ascending in threshold and non-decreasing in confidence',
      );
    }
  }

  if (!isObject(raw.prompts)) throw new GrammarError('prompts must be an object');
  const prompts: Record<string, PromptPolicy> = {};
  for (const [id, p] of Object.entries(raw.prompts)) {
    if (!PROMPT_RE.test(id)) throw new GrammarError(`prompt id ${id} is invalid`);
    if (!isObject(p) || !Array.isArray(p.vocabulary) || typeof p.voice_enabled !== 'boolean') {
      throw new GrammarError(`prompts.${id} needs vocabulary[] and voice_enabled`);
    }
    for (const code of p.vocabulary) {
      if (typeof code !== 'string' || !(code in keywords)) {
        throw new GrammarError(
          `prompts.${id}.vocabulary has ${String(code)} which has no keyword phrases`,
        );
      }
    }
    if (p.voice_enabled && isTouchOnlyPrompt(id)) {
      throw new GrammarError(
        `prompts.${id} is touch only by rule (consent, opt-ins, private reports)`,
      );
    }
    prompts[id] = {
      vocabulary: Object.freeze([...(p.vocabulary as string[])]),
      voice_enabled: p.voice_enabled,
    };
  }

  if (!isObject(raw.policy)) throw new GrammarError('policy must be an object');
  const pol = raw.policy;
  const policy = {
    min_propose_confidence: num(pol.min_propose_confidence, 'policy.min_propose_confidence', 0, 1),
    min_commit_confidence: num(pol.min_commit_confidence, 'policy.min_commit_confidence', 0, 1),
    noise_max_dbfs: num(pol.noise_max_dbfs, 'policy.noise_max_dbfs', -120, 0),
    max_listen_ms: num(pol.max_listen_ms, 'policy.max_listen_ms', 500, 30_000),
    vad_preroll_ms: num(pol.vad_preroll_ms, 'policy.vad_preroll_ms', 0, 1_000),
    settle_ms: num(pol.settle_ms, 'policy.settle_ms', 0, 2_000),
  };
  if (policy.min_commit_confidence < policy.min_propose_confidence) {
    throw new GrammarError('policy.min_commit_confidence must be >= min_propose_confidence');
  }

  return Object.freeze({
    schema_version: '1.0',
    language,
    grammar_version: raw.grammar_version,
    engine: raw.engine,
    model_id: raw.model_id,
    keywords: Object.freeze(keywords),
    tiers: Object.freeze(tiers),
    prompts: Object.freeze(prompts),
    policy: Object.freeze(policy),
  });
}

/** Render the grammar as a sherpa-onnx keywords buffer: `tokens @code [:boost]`, one phrase per line. */
export function toSherpaKeywords(grammar: AsrGrammar, codes?: readonly string[]): string {
  const wanted = codes ? new Set(codes) : null;
  const lines: string[] = [];
  for (const [code, entry] of Object.entries(grammar.keywords)) {
    if (wanted && !wanted.has(code)) continue;
    for (const p of entry.phrases) {
      lines.push(`${p.tokens} @${code}${p.boost !== undefined ? ` :${p.boost}` : ''}`);
    }
  }
  return lines.join('\n');
}
