// Result ranking — now a thin wrapper over derive.ts sortFindResults, the port
// of Go cmd/find.go sortFindResults (truffle#187): types ranked as a unit,
// closest fit first when the query has size terms, then cheapest, then newest;
// rows of a type cheapest region first, then by region. truffle-ts's #39 rule
// is kept inside it: a real price outranks an estimate outranks no price.

import type { FilterOptions, InstanceType } from "./types.js";
import type { SortPreference } from "./parser.js";
import { sortFindResults, instanceGeneration } from "./derive.js";

export { instanceGeneration };

/**
 * Return a new array of results ranked by preference. Pass the query's
 * `filters` so size terms rank closest fit first, as Go's find does; without
 * them the default is newest generation first, then cheapest.
 */
export function sortResults(
  results: InstanceType[],
  pref: SortPreference,
  filters: FilterOptions = {},
): InstanceType[] {
  return sortFindResults(results, filters, pref);
}
