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
  /** Application names (resolved to hardware in buildCriteria). */
  apps: string[];
}

/** Qualitative sort derived from keywords like "cheapest", "fastest". */
export type SortPreference = "default" | "cheapest" | "expensive" | "newest" | "performant";

const numberRegex = /^\d+$/;
const memoryRegex = /^(\d+(?:\.\d+)?)\s*(gb|gib|g)$/;
const networkSpeedRegex = /^(\d+)\s*(gbps|g)$/;

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
    architecture: "", minNetworkGbps: 0,
    requireEfa: false, requireNestedV: false, exactMatch: false,
    rawTokens: tokens, apps: [],
  };

  for (const token of tokens) {
    switch (token.type) {
      case "vendor": pq.vendors.push(token.value); break;
      case "processor": pq.processors.push(token.value); break;
      case "gpu": pq.gpus.push(token.value); break;
      case "size": pq.sizes.push(token.value); break;
      case "vcpu": { const v = parseInt(token.value, 10); if (!Number.isNaN(v)) pq.minVcpu = v; break; }
      case "physicalCores": { const v = parseInt(token.value, 10); if (!Number.isNaN(v)) pq.minPhysCores = v; break; }
      case "memory": { const v = parseMemory(token.value); if (v !== null) pq.minMemory = v; break; }
      case "gpuCount": { const v = parseInt(token.value, 10); if (!Number.isNaN(v)) pq.gpuCount = v; break; }
      case "architecture": pq.architecture = token.value as Architecture; break;
      case "networkSpeed": { const v = parseNetworkSpeed(token.value); if (v !== null) pq.minNetworkGbps = v; break; }
      case "efa": pq.requireEfa = true; break;
      case "nestedVirt": pq.requireNestedV = true; break;
      case "app": pq.apps.push(token.value); break;
    }
  }

  validate(pq);
  return pq;
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
        tokens.push({ type: "memory", value: word + next, raw: word + next });
        i++;
      } else {
        tokens.push({ type: "unknown", value: word, raw: word });
      }
    } else if (memoryRegex.test(word)) {
      tokens.push({ type: "memory", value: word, raw: word });
    } else if (qualitativeKeywords.has(word)) {
      tokens.push({ type: "qualitative", value: word, raw: word });
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
