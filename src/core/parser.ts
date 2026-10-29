// The natural-language query parser — a faithful port of the Go tool's
// pkg/find/parser.go. It turns a free-text query ("nvidia h100 8gpu",
// "amd genoa 64gb", "cheapest graviton 8 cores") into a structured ParsedQuery
// that criteria.ts then compiles into a regex + filters.
//
// Pure: no DOM, no I/O. Tokenization is longest-phrase-first against the
// metadata catalogs so multi-word names ("sapphire rapids", "rtx pro 6000")
// resolve before single-word fallbacks.

import {
  ProcessorDatabase,
  VendorAliases,
  GPUDatabase,
  GPUAliases,
  SizeCategories,
  NetworkBandwidthTiers,
  NetworkAliases,
  lookupApp,
} from "../metadata/index.js";
import type { Architecture } from "./types.js";

/** Semantic classification of a parsed word. */
export type TokenType =
  | "unknown"
  | "vendor"
  | "processor"
  | "gpu"
  | "size"
  | "vcpu"
  | "memory"
  | "gpuCount"
  /** Bare "gpu"/"accelerator" — "must have at least one GPU", no model named. */
  | "gpuAny"
  /** Per-GPU VRAM, e.g. "80gb vram" — distinct from `memory` (system RAM). */
  | "gpuMemory"
  /** Host memory marked as such, e.g. "64gb ram" (Go TokenHostMemory, #236). */
  | "hostMemory"
  | "architecture"
  | "networkSpeed"
  | "efa"
  | "nestedVirt"
  | "physicalCores"
  | "app"
  | "qualitative";

/** A single classified word from a query. */
export interface Token {
  type: TokenType;
  /** Normalized canonical value, e.g. "nvidia", "128gb". */
  value: string;
  /** Original input text before normalization. */
  raw: string;
}

/** Structured output of parseQuery — all constraints extracted from the text. */
export interface ParsedQuery {
  vendors: string[];
  processors: string[];
  gpus: string[];
  sizes: string[];
  /** Minimum vCPU count; 0 = unconstrained. */
  minVcpu: number;
  /** Minimum physical core count; 0 = unconstrained. */
  minPhysCores: number;
  /** Minimum memory in GiB; 0 = unconstrained. */
  minMemory: number;
  /** Minimum number of GPUs; 0 = unconstrained. */
  gpuCount: number;
  /**
   * True when the query asked for a GPU without naming one ("gpu", "accelerator").
   * Distinct from `gpus`, which holds named models — this only requires gpus >= 1.
   */
  requireGpu: boolean;
  /** Minimum VRAM per GPU in GiB; 0 = unconstrained. Not system memory. */
  minGpuMemory: number;
  /** "x86_64" | "arm64"; empty = both. */
  architecture: Architecture | "";
  /** Minimum network bandwidth in Gbps; 0 = unconstrained. */
  minNetworkGbps: number;
  requireEfa: boolean;
  requireNestedV: boolean;
  /** If true, match exact vCPU/memory values instead of minimum. */
  exactMatch: boolean;
  /** Parsed tokens in input order (diagnostics). */
  rawTokens: Token[];
  /**
   * Words the parser could not classify, in input order. Surfacing these is what
   * turns a silently-dropped constraint into a visible one: "gpu with 80gb" used
   * to discard "gpu" with no signal at all (#37).
   */
  ignored: string[];
  /** Application names (resolved to hardware in buildCriteria). */
  apps: string[];
  /**
   * The bare size ("24gb") a GPU query read as per-GPU memory rather than host
   * memory; absent if none (Go GPUMemoryRead, #236). See `memoryReadingNote`.
   */
  gpuMemoryRead?: string;
}

/** Qualitative sort derived from keywords like "cheapest", "fastest". */
export type SortPreference = "default" | "cheapest" | "expensive" | "newest" | "performant";

const numberRegex = /^\d+$/;
const memoryRegex = /^(\d+(?:\.\d+)?)\s*(gb|gib|g)$/;
const networkSpeedRegex = /^(\d+)\s*(gbps|g)$/;

/**
 * Words meaning "any GPU will do". Not in GPUAliases, which maps to specific
 * cards — a bare "gpu" names no model, so it can't resolve to instance types
 * and has to become a filter instead (#37).
 */
const gpuAnyWords = new Set([
  "gpu", "gpus", "accelerator", "accelerators", "graphics-card", "graphics-cards",
]);

/** Words that mark a preceding memory figure as per-GPU VRAM rather than DRAM. */
const vramWords = new Set(["vram", "hbm", "gpu-memory", "gpumemory"]);

/** Words that mark a preceding memory figure as host memory (Go #236). */
const hostMemWords = new Set(["memory", "mem", "ram"]);

/**
 * Classify a memory size by the words after it, at words[next…] (Go
 * memoryToken, #236): "ram" / "memory" / "mem" / "host memory" / "host ram"
 * mark HOST memory; "vram" / "hbm" / "gpu memory" / "gpu mem" / "gpu ram" /
 * "per gpu" mark PER-GPU memory. With none it is a bare `memory` token, whose
 * meaning depends on the rest of the query (see parseQuery). Returns the token
 * and how many following words it consumed.
 */
function memoryToken(size: string, words: string[], next: number): { token: Token; consumed: number } {
  const first = words[next] ?? "";
  const second = words[next + 1] ?? "";
  if (hostMemWords.has(first)) return { token: { type: "hostMemory", value: size, raw: `${size} ${first}` }, consumed: 1 };
  if (first === "host" && hostMemWords.has(second)) {
    return { token: { type: "hostMemory", value: size, raw: `${size} host ${second}` }, consumed: 2 };
  }
  if (vramWords.has(first)) return { token: { type: "gpuMemory", value: size, raw: `${size} ${first}` }, consumed: 1 };
  if ((first === "gpu" && hostMemWords.has(second)) || (first === "per" && second === "gpu")) {
    return { token: { type: "gpuMemory", value: size, raw: `${size} ${first} ${second}` }, consumed: 2 };
  }
  return { token: { type: "memory", value: size, raw: size }, consumed: 0 };
}

/**
 * The parts of a hyphenated and/or "!"/"+"-suffixed word, or undefined when
 * there is nothing to split (so classification can't recurse forever). Ports
 * Go normalizeHyphenatedToken (#130).
 */
function hyphenatedSubwords(word: string): string[] | undefined {
  const stripped = word.replace(/[!+]$/, "");
  if (!stripped.includes("-")) return stripped === word || stripped === "" ? undefined : [stripped];
  const parts = stripped.split("-").filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * The attached count form, "8gpu"/"8gpus". Go's parser only handles the spaced
 * form ("8 gpus"), so `8gpu` falls through to `unknown` there — which is why both
 * projects' headline example, "nvidia h100 8gpu efa", has always silently dropped
 * its count. Same defect class as #37: a constraint that disappears without a
 * word. A bare "8x" is deliberately *not* accepted — it reads as a multiplier of
 * anything (nodes, tasks), so guessing GPUs would be inventing a constraint
 * rather than reading one.
 */
const attachedGpuCountRegex = /^(\d+)gpus?$/;

// Longest multi-word key across the processor/GPU catalogs and GPU aliases,
// computed from the data so the phrase matcher stays correct as it grows.
const maxPhraseWords = computeMaxPhraseWords();
function computeMaxPhraseWords(): number {
  let max = 1;
  const consider = (key: string) => {
    const n = key.split(/\s+/).length;
    if (n > max) max = n;
  };
  for (const k of Object.keys(ProcessorDatabase)) consider(k);
  for (const k of Object.keys(GPUDatabase)) consider(k);
  for (const k of Object.keys(GPUAliases)) consider(k);
  return max;
}

// Try the longest multi-word phrase starting at words[i] (maxPhraseWords…2)
// against the processor DB, GPU DB, and GPU aliases (in that precedence).
function matchPhrase(words: string[], i: number): { token: Token; consumed: number } | null {
  const remaining = words.length - i;
  const upper = Math.min(maxPhraseWords, remaining);
  for (let n = upper; n >= 2; n--) {
    const phrase = words.slice(i, i + n).join(" ");
    if (ProcessorDatabase[phrase]) return { token: { type: "processor", value: phrase, raw: phrase }, consumed: n };
    if (GPUDatabase[phrase]) return { token: { type: "gpu", value: phrase, raw: phrase }, consumed: n };
    const alias = GPUAliases[phrase];
    if (alias) return { token: { type: "gpu", value: alias, raw: phrase }, consumed: n };
  }
  return null;
}

/** Parse a natural-language query into structured search criteria. Throws on empty/conflicting input. */
export function parseQuery(query: string): ParsedQuery {
  const normalized = query.toLowerCase().trim();
  if (normalized === "") throw new Error("empty query");

  const words = normalized.split(/\s+/);
  const tokens = classifyTokens(words);

  const pq: ParsedQuery = {
    vendors: [], processors: [], gpus: [], sizes: [],
    minVcpu: 0, minPhysCores: 0, minMemory: 0, gpuCount: 0,
    requireGpu: false, minGpuMemory: 0,
    architecture: "", minNetworkGbps: 0,
    requireEfa: false, requireNestedV: false, exactMatch: false,
    rawTokens: tokens, ignored: [], apps: [],
  };
  let bareMemory = 0;
  let bareMemoryRaw = "";

  for (const token of tokens) {
    switch (token.type) {
      case "vendor": pq.vendors.push(token.value); break;
      case "processor": pq.processors.push(token.value); break;
      case "gpu": pq.gpus.push(token.value); break;
      case "size": pq.sizes.push(token.value); break;
      case "vcpu": { const v = parseInt(token.value, 10); if (!Number.isNaN(v)) pq.minVcpu = v; break; }
      case "physicalCores": { const v = parseInt(token.value, 10); if (!Number.isNaN(v)) pq.minPhysCores = v; break; }
      case "memory": { const v = parseMemory(token.value); if (v !== null) (bareMemory = v), (bareMemoryRaw = token.raw); break; }
      case "hostMemory": { const v = parseMemory(token.value); if (v !== null) pq.minMemory = v; break; }
      case "gpuCount": { const v = parseInt(token.value, 10); if (!Number.isNaN(v)) pq.gpuCount = v; break; }
      case "gpuAny": pq.requireGpu = true; break;
      case "gpuMemory": { const v = parseMemory(token.value); if (v !== null) pq.minGpuMemory = v; break; }
      case "architecture": pq.architecture = token.value as Architecture; break;
      case "networkSpeed": { const v = parseNetworkSpeed(token.value); if (v !== null) pq.minNetworkGbps = v; break; }
      case "efa": pq.requireEfa = true; break;
      case "nestedVirt": pq.requireNestedV = true; break;
      case "app": pq.apps.push(token.value); break;
      case "unknown": if (!isFiller(token.value)) pq.ignored.push(token.raw); break;
    }
  }

  // A bare size ("80gb", no "ram"/"vram" after it) means memory PER GPU in a
  // query for a GPU — "gpu with 80gb", and since Go #236 also "h100 80gb" /
  // "a100 80gb" (the 80 GB parts) — and host memory otherwise. An explicit
  // marker on the other kind decides it: "24gb vram 64gb" makes the bare size
  // host memory, "a10g 64gb ram 24gb" makes it per-GPU. Ports Go
  // assignBareMemory. (truffle-ts used to keep a named card's bare size as host
  // memory, so "a100 80gb" matched p4d's 40 GB A100s by their 1152 GiB of RAM.)
  if (bareMemory > 0) {
    const wantsGpu = pq.gpus.length > 0 || pq.requireGpu || pq.gpuCount > 0 || pq.minGpuMemory > 0;
    if (pq.minGpuMemory === 0 && wantsGpu) {
      pq.minGpuMemory = bareMemory;
      pq.gpuMemoryRead = bareMemoryRaw;
    } else if (pq.minMemory === 0) {
      pq.minMemory = bareMemory;
    }
  }

  // A query whose words are all unknown would match — and a live finder would
  // price — every instance type (Go #229). Refuse it, naming the words.
  if (pq.ignored.length > 0 && !hasConstraints(pq)) throw new UnrecognizedQueryError(pq.ignored);

  // Any VRAM or GPU-count constraint implies a GPU is required, so callers only
  // ever need to check requireGpu rather than all three.
  if (pq.minGpuMemory > 0 || pq.gpuCount > 0) pq.requireGpu = true;

  validate(pq);
  return pq;
}

/**
 * Grammatical filler that carries no constraint. These are excluded from
 * `ignored` so the diagnostic stays signal — reporting "ignored: with, for"
 * trains users to ignore the notice, which defeats its purpose.
 */
const fillerWords = new Set([
  "with", "for", "and", "or", "a", "an", "the", "of", "on", "in", "to",
  "at", "least", "min", "minimum", "max", "maximum", "that", "has", "have",
  "i", "need", "want", "me", "my", "something", "instance", "instances",
  "type", "types", "machine", "node", "nodes", "please",
]);
function isFiller(word: string): boolean {
  return fillerWords.has(word);
}

function classifyTokens(words: string[]): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // Multi-word patterns first, longest-match-first.
    const phrase = matchPhrase(words, i);
    if (phrase) {
      tokens.push(phrase.token);
      i += phrase.consumed - 1;
      continue;
    }

    // App catalog takes priority over hardware tokens.
    const app = lookupApp(word);
    if (app) {
      tokens.push({ type: "app", value: app.name, raw: word });
      continue;
    }

    if (VendorAliases[word]) {
      tokens.push({ type: "vendor", value: VendorAliases[word], raw: word });
    } else if (ProcessorDatabase[word]) {
      tokens.push({ type: "processor", value: word, raw: word });
    } else if (GPUDatabase[word]) {
      tokens.push({ type: "gpu", value: word, raw: word });
    } else if (GPUAliases[word]) {
      tokens.push({ type: "gpu", value: GPUAliases[word], raw: word });
    } else if (SizeCategories[word]) {
      tokens.push({ type: "size", value: word, raw: word });
    } else if (attachedGpuCountRegex.test(word)) {
      tokens.push({ type: "gpuCount", value: word.replace(/gpus?$/, ""), raw: word });
    } else if (gpuAnyWords.has(word)) {
      // Bare "gpu" with no preceding count. A count ("4 gpus") is consumed by the
      // number branch below as a gpuCount token before it ever reaches here.
      tokens.push({ type: "gpuAny", value: "gpu", raw: word });
    } else if (word === "efa") {
      tokens.push({ type: "efa", value: "efa", raw: word });
    } else if (word === "nested-virt" || word === "nested-virtualization" || word === "nestedvirt") {
      tokens.push({ type: "nestedVirt", value: "nested-virt", raw: word });
    } else if (NetworkAliases[word]) {
      const alias = NetworkAliases[word];
      if (alias === "efa") tokens.push({ type: "efa", value: "efa", raw: word });
      else tokens.push({ type: "networkSpeed", value: alias, raw: word });
    } else if (networkSpeedRegex.test(word)) {
      tokens.push({ type: "networkSpeed", value: word, raw: word });
    } else if (word === "x86_64" || word === "x86-64" || word === "x86" || word === "amd64") {
      tokens.push({ type: "architecture", value: "x86_64", raw: word });
    } else if (word === "arm64" || word === "arm" || word === "aarch64") {
      tokens.push({ type: "architecture", value: "arm64", raw: word });
    } else if (numberRegex.test(word)) {
      // Look ahead for units.
      const next = i + 1 < words.length ? words[i + 1] : undefined;
      if (next === "physical" && i + 2 < words.length && (words[i + 2] === "cores" || words[i + 2] === "core")) {
        tokens.push({ type: "physicalCores", value: word, raw: `${word} physical cores` });
        i += 2;
      } else if (next === "cores" || next === "core" || next === "vcpus" || next === "vcpu" || next === "cpus" || next === "cpu") {
        tokens.push({ type: "vcpu", value: word, raw: `${word} ${next}` });
        i++;
      } else if (next === "gpus" || next === "gpu") {
        tokens.push({ type: "gpuCount", value: word, raw: `${word} ${next}` });
        i++;
      } else if (next !== undefined && (memoryRegex.test(next) || next.endsWith("gb") || next.endsWith("gib") || next.endsWith("g"))) {
        // "80 gb vram" / "64 gb ram" — the unit is a separate word, so the
        // marker starts two ahead.
        const { token, consumed } = memoryToken(word + next, words, i + 2);
        tokens.push(token);
        i += 1 + consumed;
      } else {
        tokens.push({ type: "unknown", value: word, raw: word });
      }
    } else if (memoryRegex.test(word)) {
      // "80gb vram" / "64gb ram" — the unit is attached, so the marker is next.
      const { token, consumed } = memoryToken(word, words, i + 1);
      tokens.push(token);
      i += consumed;
    } else if (qualitativeKeywords.has(word)) {
      tokens.push({ type: "qualitative", value: word, raw: word });
    } else if (hyphenatedSubwords(word)) {
      // A Modal-style GPU spec string arrives as ONE word: "rtx-pro-6000",
      // "a100-80gb", "h100!", "b200+". Re-classify its parts as if they had been
      // space-separated (Go normalizeHyphenatedToken, #130), so "a100-80gb"
      // reads like "a100 80gb". A part that still means nothing stays unknown.
      tokens.push(...classifyTokens(hyphenatedSubwords(word)!));
    } else {
      tokens.push({ type: "unknown", value: word, raw: word });
    }
  }
  return tokens;
}

/** Parse a memory string ("32gb", "64gib") to GiB. Returns null on bad format. */
export function parseMemory(s: string): number | null {
  const m = s.toLowerCase().trim().match(memoryRegex);
  if (!m) return null;
  const value = parseFloat(m[1]);
  return Number.isNaN(value) ? null : value; // all units treated as GiB
}

/** Parse a network-speed string ("10gbps", "100g") to Gbps. Returns null on bad format. */
export function parseNetworkSpeed(s: string): number | null {
  const norm = s.toLowerCase().trim();
  if (NetworkBandwidthTiers[norm]) {
    const m = norm.match(/^(\d+)/);
    if (m) { const v = parseInt(m[1], 10); if (!Number.isNaN(v)) return v; }
  }
  const m = norm.match(networkSpeedRegex);
  if (m) { const v = parseInt(m[1], 10); return Number.isNaN(v) ? null : v; }
  return null;
}

const qualitativeKeywords = new Set([
  "cheap", "cheapest", "affordable", "budget",
  "fast", "fastest", "quick", "slow", "slowest",
  "expensive", "premium", "best", "worst", "optimal",
  "powerful", "performant", "efficient", "inefficient",
  "popular", "recommended", "new", "newest", "latest",
  "old", "oldest", "legacy",
]);

const qualitativeSortMap: Record<string, SortPreference> = {
  cheap: "cheapest", cheapest: "cheapest", affordable: "cheapest", budget: "cheapest",
  expensive: "expensive", premium: "expensive",
  fast: "performant", fastest: "performant", powerful: "performant", performant: "performant",
  new: "newest", newest: "newest", latest: "newest",
};

/** The sort preference derived from any qualitative keyword in the query. */
export function sortPreference(pq: ParsedQuery): SortPreference {
  for (const t of pq.rawTokens) {
    if (t.type === "qualitative") {
      const pref = qualitativeSortMap[t.value];
      if (pref) return pref;
    }
  }
  return "default";
}

/** Qualitative keywords found in the query (raw forms). */
export function qualitativeTokens(pq: ParsedQuery): string[] {
  return pq.rawTokens.filter((t) => t.type === "qualitative").map((t) => t.raw);
}

/** Throw if the query mixes conflicting architectures (from processors/vendors/explicit). */
function validate(pq: ParsedQuery): void {
  const archSet = new Set<string>();
  for (const proc of pq.processors) {
    const info = ProcessorDatabase[proc];
    if (info) archSet.add(info.architecture);
  }
  for (const vendor of pq.vendors) {
    for (const info of Object.values(ProcessorDatabase)) {
      if (info.vendor === vendor) archSet.add(info.architecture);
    }
  }
  if (pq.architecture !== "") archSet.add(pq.architecture);
  if (archSet.size > 1) {
    throw new Error(`conflicting architectures: ${[...archSet].join(", ")}`);
  }
}

/** Whether the query constrains the search at all (Go hasConstraints). */
export function hasConstraints(pq: ParsedQuery): boolean {
  return (
    pq.vendors.length > 0 || pq.processors.length > 0 || pq.gpus.length > 0 || pq.sizes.length > 0 ||
    pq.apps.length > 0 || pq.minVcpu > 0 || pq.minPhysCores > 0 || pq.minMemory > 0 || pq.minGpuMemory > 0 ||
    pq.gpuCount > 0 || pq.requireGpu || pq.architecture !== "" || pq.minNetworkGbps > 0 || pq.requireEfa ||
    pq.requireNestedV
  );
}

/**
 * Whether one space-free word is fully understood by the parser — every token
 * it yields is classified (Go IsRecognizedTerm, #130). The pattern router asks
 * this first, so a GPU name like "a100" or "a100-80gb" is never read as an
 * instance-type name.
 */
export function isRecognizedTerm(word: string): boolean {
  const w = word.trim().toLowerCase();
  if (w === "" || /\s/.test(w)) return false;
  const toks = classifyTokens([w]);
  return toks.length > 0 && toks.every((t) => t.type !== "unknown");
}

/**
 * The one-line note for a query whose bare size was read as per-GPU memory,
 * saying how to ask for host memory instead (Go MemoryReadingNote, #236).
 */
export function memoryReadingNote(pq: ParsedQuery): string {
  if (!pq.gpuMemoryRead) return "";
  return `Note: reading "${pq.gpuMemoryRead}" as memory per GPU (at least ${pq.minGpuMemory} GB/GiB, as the GPU is sold); write "${pq.gpuMemoryRead} ram" for host memory`;
}

/**
 * Thrown by parseQuery for a query with unknown words and nothing that narrows
 * the search (Go UnrecognizedQueryError, #229) — "zzqx" used to match all 231
 * bundled types. `suggestions` maps a term to the closest known word.
 */
export class UnrecognizedQueryError extends Error {
  readonly terms: string[];
  readonly suggestions: Record<string, string>;
  constructor(terms: string[]) {
    const suggestions = suggestTerms(terms);
    const parts = terms.map((t) => `"${t}"${suggestions[t] ? ` (did you mean "${suggestions[t]}"?)` : ""}`);
    super(
      `no recognised search terms; unknown ${terms.length > 1 ? "terms" : "term"}: ${parts.join(", ")}\n` +
        "Try a vendor (amd, intel, graviton), processor (turin, ice lake), GPU (h100, a10g), " +
        'family (g5, m7i), size (xlarge, large), or specs (16 cores, 64gb), or an instance-type pattern such as "g5.*"',
    );
    this.name = "UnrecognizedQueryError";
    this.terms = terms;
    this.suggestions = suggestions;
  }
}

/** Words that look like an instance family, for the pattern suggestion. */
const familyShaped = /^[a-z]+[0-9][a-z0-9-]*$/;

/**
 * For each term with a close match in the parser's vocabulary, that match:
 * within edit distance 2 (1 for words of four letters or fewer), smallest
 * distance first, then longest shared prefix, then alphabetical. A
 * family-shaped term with no close match is suggested as a pattern ("zz9q" →
 * "zz9q.*"). Ports Go SuggestTerms.
 */
export function suggestTerms(terms: readonly string[]): Record<string, string> {
  const vocab = vocabulary();
  const out: Record<string, string> = {};
  for (const term of terms) {
    const t = term.toLowerCase();
    const limit = t.length <= 4 ? 1 : 2;
    let best = "";
    let bestD = limit + 1;
    let bestP = 0;
    for (const w of vocab) {
      const d = editDistance(t, w, limit);
      const p = sharedPrefix(t, w);
      if (d < bestD || (d === bestD && d <= limit && p > bestP)) (best = w), (bestD = d), (bestP = p);
    }
    if (best !== "" && best !== t) out[term] = best;
    else if (familyShaped.test(t)) out[term] = `${t}.*`;
  }
  return out;
}

let vocabCache: string[] | undefined;
/** Every single word the parser recognises on its own, sorted (Go vocabulary). */
function vocabulary(): string[] {
  if (vocabCache) return vocabCache;
  const set = new Set<string>();
  const add = (w: string) => {
    if (!w.includes(" ")) set.add(w);
  };
  for (const k of Object.keys(VendorAliases)) add(k);
  for (const [k, info] of Object.entries(ProcessorDatabase)) (add(k), info.families.forEach(add));
  for (const [k, info] of Object.entries(GPUDatabase)) (add(k), info.families.forEach(add));
  for (const k of Object.keys(GPUAliases)) add(k);
  for (const k of gpuAnyWords) add(k);
  for (const k of Object.keys(SizeCategories)) add(k);
  for (const k of Object.keys(NetworkAliases)) add(k);
  for (const k of qualitativeKeywords) add(k);
  for (const w of ["efa", "x86_64", "arm64", "cores", "vcpus", "gpus", "xlarge", "nano", "micro", "metal"]) add(w);
  vocabCache = [...set].sort();
  return vocabCache;
}

/** Levenshtein distance, or limit+1 once it is known to exceed limit (Go editDistance). */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > limit) return limit + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
