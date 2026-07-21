// Result ranking — port of the sort.Slice comparator in Go cmd/find.go. Ranks
// instance types by the query's SortPreference, with a stable tiebreak
// (instance type, then — upstream — region; we sort by instance type alone
// since the bundled catalog is region-agnostic).

import type { InstanceType } from "./types.js";
import type { SortPreference } from "./parser.js";

/** Generation number of an instance type — the first run of digits, e.g.
 * "m6i.large" → 6, "trn1.32xlarge" → 1, "a1.medium" → 1. Ports instanceGeneration. */
export function instanceGeneration(instanceType: string): number {
  const m = instanceType.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

/** Compare on-demand price, pushing unknown (0/undefined) prices to the end.
 * Returns <0 if a should come before b, 0 if equal, >0 otherwise. */
function comparePrice(a: number, b: number, ascending: boolean): number {
  const pa = a || 0;
  const pb = b || 0;
  if (pa === 0 && pb !== 0) return 1; // unknown → end
  if (pa !== 0 && pb === 0) return -1;
  if (pa === pb) return 0;
  return ascending ? pa - pb : pb - pa;
}

/** Return a new array of results ranked by preference (default = newest gen first). */
export function sortResults(results: InstanceType[], pref: SortPreference): InstanceType[] {
  const sorted = [...results];
  sorted.sort((a, b) => {
    switch (pref) {
      case "cheapest": {
        const c = comparePrice(a.onDemandPrice ?? 0, b.onDemandPrice ?? 0, true);
        if (c !== 0) return c;
        break;
      }
      case "expensive": {
        const c = comparePrice(a.onDemandPrice ?? 0, b.onDemandPrice ?? 0, false);
        if (c !== 0) return c;
        break;
      }
      case "performant":
        if (a.vcpus !== b.vcpus) return b.vcpus - a.vcpus;
        break;
      case "newest":
      case "default": {
        const g = instanceGeneration(b.instanceType) - instanceGeneration(a.instanceType);
        if (g !== 0) return g;
        break;
      }
    }
    // Stable tiebreak.
    if (a.instanceType !== b.instanceType) return a.instanceType < b.instanceType ? -1 : 1;
    return 0;
  });
  return sorted;
}
