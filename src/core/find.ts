// The one-call convenience: a query string → ranked, explained results. Wires
// the whole pipeline (parse → buildCriteria → finder.search → sort → explain)
// over a Finder — the BundledFinder by default, so `find("nvidia h100")` works
// offline with no setup. Consumers wanting control can drive the pieces directly
// (parseQuery/buildCriteria/…) or pass their own Finder.

import { parseQuery, sortPreference, type ParsedQuery, type SortPreference } from "./parser.js";
import { buildCriteria } from "./criteria.js";
import { explainMatch } from "./explain.js";
import { sortResults } from "./sort.js";
import type { Finder } from "./finder.js";
import type { FindResult } from "./types.js";
import { BundledFinder } from "../data/bundled-finder.js";

/** The default offline finder (bundled catalog). Shared across find() calls. */
const defaultFinder: Finder = new BundledFinder();

export interface FindOptions {
  /** Override the sort (defaults to the query's qualitative preference). */
  sort?: SortPreference;
  /** Override the data source (defaults to the bundled catalog). */
  finder?: Finder;
}

/**
 * Find instance types matching a natural-language query, ranked + explained.
 * Uses the bundled offline catalog unless a `finder` is supplied. Throws if the
 * query is empty or has conflicting constraints (from parseQuery).
 */
export async function find(query: string, opts: FindOptions = {}): Promise<FindResult[]> {
  const parsed = parseQuery(query);
  return findInstances(opts.finder ?? defaultFinder, parsed, { sort: opts.sort });
}

/** Lower-level entry: run an already-parsed query through a specific finder. */
export async function findInstances(
  finder: Finder,
  parsed: ParsedQuery,
  opts: { sort?: SortPreference } = {},
): Promise<FindResult[]> {
  const { pattern, filters } = buildCriteria(parsed);
  const hits = await finder.search(pattern, filters);
  const ranked = sortResults(hits, opts.sort ?? sortPreference(parsed));
  return ranked.map((instance) => ({ instance, reasons: explainMatch(instance, parsed) }));
}
