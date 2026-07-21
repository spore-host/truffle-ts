// Criteria building — port of Go pkg/find/executor.go (BuildCriteria +
// buildInstanceTypePattern). Compiles a ParsedQuery into a RegExp over instance-
// type names plus the numeric/categorical FilterOptions that filter.ts applies.

import { lookupApp } from "../metadata/index.js";
import type { FilterOptions } from "./types.js";
import type { ParsedQuery } from "./parser.js";
import {
  resolveGpuInstances,
  resolveInstanceFamilies,
  deriveArchitecture,
  buildSizePattern,
  hasConflictingFamilyConstraints,
  escapeRegex,
} from "./resolve.js";

/** Compiled, ready-to-execute form of a ParsedQuery. */
export interface SearchCriteria {
  /** RegExp matching eligible EC2 instance-type strings. */
  pattern: RegExp;
  /** Numeric + categorical filters. */
  filters: FilterOptions;
}

/** Convert a ParsedQuery into a SearchCriteria for execution. */
export function buildCriteria(pq: ParsedQuery): SearchCriteria {
  const filters: FilterOptions = {
    minVcpus: pq.minVcpu,
    minMemoryGiB: pq.minMemory,
    minPhysicalCores: pq.minPhysCores,
    exactVcpus: pq.exactMatch,
    exactMemory: pq.exactMatch,
    exactCores: pq.exactMatch,
    architecture: deriveArchitecture(pq),
    nestedVirt: pq.requireNestedV,
  };

  // Apply app-catalog hardware minimums only when the user gave no explicit ones.
  for (const appName of pq.apps) {
    const entry = lookupApp(appName);
    if (!entry) continue;
    if ((filters.minVcpus ?? 0) === 0 && entry.minVcpus > 0) filters.minVcpus = entry.minVcpus;
    if ((filters.minMemoryGiB ?? 0) === 0 && entry.minMemoryGiB > 0) filters.minMemoryGiB = entry.minMemoryGiB;
  }

  return { pattern: new RegExp(buildInstanceTypePattern(pq)), filters };
}

/** Build the instance-type-name regex string for a query. */
export function buildInstanceTypePattern(pq: ParsedQuery): string {
  // GPU queries with exact instance types → match those exactly.
  if (pq.gpus.length > 0) {
    const instances = resolveGpuInstances(pq);
    if (instances.length > 0) {
      return "^(" + instances.map(escapeRegex).join("|") + ")$";
    }
  }

  const families = resolveInstanceFamilies(pq);
  if (families.length === 0) {
    // Disjoint app+query family constraints → never match; else match all.
    return hasConflictingFamilyConstraints(pq) ? "^$" : ".*";
  }

  const familyPattern = "(" + families.map(escapeRegex).join("|") + ")";
  if (pq.sizes.length > 0) {
    return "^" + familyPattern + "\\." + buildSizePattern(pq) + "$";
  }
  return "^" + familyPattern + "\\..*$";
}
