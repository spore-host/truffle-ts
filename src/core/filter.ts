// In-memory instance filter — port of Go pkg/aws/client.go matchesFilters. The
// Go version runs over the AWS SDK's InstanceTypeInfo per region; here it runs
// over a plain InstanceType (from the bundled catalog or a Finder), so the whole
// filter is a single pass with no network.

import type { InstanceType, FilterOptions } from "./types.js";

/** The family prefix of an instance type, e.g. "m6i.2xlarge" → "m6i". */
export function extractFamily(instanceType: string): string {
  const dot = instanceType.indexOf(".");
  return dot === -1 ? instanceType : instanceType.slice(0, dot);
}

/** Physical cores for an instance — explicit if present, else estimated from
 * vCPUs / threads-per-core (default 2, matching the Go fallback). */
function physicalCores(it: InstanceType): number {
  if (it.physicalCores && it.physicalCores > 0) return it.physicalCores;
  const tpc = it.threadsPerCore && it.threadsPerCore > 0 ? it.threadsPerCore : 2;
  return Math.floor(it.vcpus / tpc);
}

/** Whether an instance type passes all the given filters. */
export function matchesFilters(it: InstanceType, opts: FilterOptions): boolean {
  if (opts.architecture) {
    if (it.architecture !== opts.architecture) return false;
  }

  if (opts.minVcpus && opts.minVcpus > 0) {
    if (opts.exactVcpus) {
      if (it.vcpus !== opts.minVcpus) return false;
    } else if (it.vcpus < opts.minVcpus) {
      return false;
    }
  }

  if (opts.minPhysicalCores && opts.minPhysicalCores > 0) {
    const cores = physicalCores(it);
    if (opts.exactCores) {
      if (cores !== opts.minPhysicalCores) return false;
    } else if (cores < opts.minPhysicalCores) {
      return false;
    }
  }

  if (opts.minMemoryGiB && opts.minMemoryGiB > 0) {
    const memGiB = it.memoryMib / 1024;
    if (opts.exactMemory) {
      // 0.01 GiB tolerance for float comparison, matching Go.
      if (memGiB < opts.minMemoryGiB - 0.01 || memGiB > opts.minMemoryGiB + 0.01) return false;
    } else if (memGiB < opts.minMemoryGiB) {
      return false;
    }
  }

  if (opts.instanceFamily) {
    if (extractFamily(it.instanceType) !== opts.instanceFamily) return false;
  }

  if (opts.nestedVirt && !it.nestedVirt) return false;

  return true;
}
