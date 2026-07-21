// Query resolution — port of the ParsedQuery methods in Go pkg/find/parser.go
// (ResolveInstanceFamilies/ResolveGpuInstances/DeriveArchitecture/
// BuildSizePattern) plus pkg/find/resolve.go (ResolveCard / CardInstanceTypes +
// ErrNoMatch). These turn a ParsedQuery's constraints into families, exact
// instance types, an architecture, and size patterns for criteria.ts.

import {
  ProcessorDatabase,
  GPUDatabase,
  GPUAliases,
  getFamiliesByVendor,
  getFamiliesByEFA,
  getFamiliesByNetworkSpeed,
  getSizesForCategory,
  lookupApp,
} from "../metadata/index.js";
import type { Architecture } from "./types.js";
import { parseQuery, type ParsedQuery } from "./parser.js";

/** Thrown by resolveCard/cardInstanceTypes when a card resolves to nothing —
 * an explicit failure rather than the search pipeline's match-all fallback. */
export class ErrNoMatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrNoMatch";
  }
}

/** Escape a string for literal use inside a RegExp (JS equivalent of regexp.QuoteMeta). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All instance families matching the query (vendors, processors, GPUs, network,
 * EFA), intersected with app-catalog families when both are present. */
export function resolveInstanceFamilies(pq: ParsedQuery): string[] {
  const queryFamilies = new Set<string>();

  for (const proc of pq.processors) {
    const info = ProcessorDatabase[proc];
    if (info) for (const f of info.families) queryFamilies.add(f);
  }
  for (const vendor of pq.vendors) {
    for (const f of getFamiliesByVendor(vendor)) queryFamilies.add(f);
  }
  for (const gpu of pq.gpus) {
    const info = GPUDatabase[gpu];
    if (info) for (const f of info.families) queryFamilies.add(f);
  }
  if (pq.requireEfa) for (const f of getFamiliesByEFA()) queryFamilies.add(f);
  if (pq.minNetworkGbps > 0) for (const f of getFamiliesByNetworkSpeed(pq.minNetworkGbps)) queryFamilies.add(f);

  const appFamilies = new Set<string>();
  for (const appName of pq.apps) {
    const entry = lookupApp(appName);
    if (entry) for (const f of entry.instanceFamilies) appFamilies.add(f);
  }

  // If both app and query families are present, intersect them.
  let result: Set<string>;
  if (appFamilies.size > 0 && queryFamilies.size > 0) {
    result = new Set([...appFamilies].filter((f) => queryFamilies.has(f)));
  } else if (appFamilies.size > 0) {
    result = appFamilies;
  } else {
    result = queryFamilies;
  }
  return [...result].sort();
}

/** Whether app families and query families are both set but disjoint (no instance
 * can satisfy both) — so the pattern should never-match rather than match-all. */
export function hasConflictingFamilyConstraints(pq: ParsedQuery): boolean {
  if (pq.apps.length === 0) return false;
  const hasQueryFamilies =
    pq.vendors.length > 0 || pq.processors.length > 0 || pq.gpus.length > 0 || pq.requireEfa || pq.minNetworkGbps > 0;
  if (!hasQueryFamilies) return false;
  return resolveInstanceFamilies(pq).length === 0;
}

/** Exact instance types for GPU queries (sorted). */
export function resolveGpuInstances(pq: ParsedQuery): string[] {
  const set = new Set<string>();
  for (const gpu of pq.gpus) {
    const info = GPUDatabase[gpu];
    if (info?.instanceTypes) for (const inst of info.instanceTypes) set.add(inst);
  }
  return [...set].sort();
}

/** The architecture implied by the query, or "" if unconstrained/ambiguous. */
export function deriveArchitecture(pq: ParsedQuery): Architecture | "" {
  if (pq.architecture !== "") return pq.architecture;
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
  if (archSet.size === 1) return [...archSet][0] as Architecture;
  return "";
}

/** A regex fragment matching the query's size suffixes, or ".*" if none. */
export function buildSizePattern(pq: ParsedQuery): string {
  const set = new Set<string>();
  for (const cat of pq.sizes) for (const s of getSizesForCategory(cat)) set.add(s);
  if (set.size === 0) return ".*";
  const sizes = [...set].sort().map(escapeRegex);
  return "(" + sizes.join("|") + ")";
}

/** Map a GPU card name to the exact instance types carrying it (strict — throws
 * ErrNoMatch on no match, never returns a match-all). Ports Go ResolveCard. */
export function resolveCard(card: string): string[] {
  let pq: ParsedQuery;
  try {
    pq = parseQuery(card);
  } catch (e) {
    throw new ErrNoMatch(`${(e as Error).message}`);
  }
  if (pq.gpus.length === 0) {
    throw new ErrNoMatch(`no GPU recognized in card: ${JSON.stringify(card)}`);
  }
  const instances = resolveGpuInstances(pq);
  if (instances.length === 0) {
    throw new ErrNoMatch(`no instance types for GPU ${pq.gpus.join(", ")} (card ${JSON.stringify(card)})`);
  }
  return instances;
}

/** Metadata-only card lookup: canonical GPU key + its instance types, no parser.
 * Throws ErrNoMatch if the card is unknown. Ports Go CardInstanceTypes. */
export function cardInstanceTypes(card: string): { canonical: string; instances: string[] } {
  let key = card.trim().toLowerCase();
  if (key === "") throw new ErrNoMatch("empty card");
  if (GPUAliases[key]) key = GPUAliases[key];
  const info = GPUDatabase[key];
  if (!info) throw new ErrNoMatch(`unknown card: ${JSON.stringify(card)}`);
  return { canonical: key, instances: [...(info.instanceTypes ?? [])].sort() };
}
