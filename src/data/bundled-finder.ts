// BundledFinder — the default Finder, backed by the bundled catalog snapshot.
// It runs a query as a single in-memory pass (matcher + matchesFilters),
// replacing the Go tool's per-region DescribeInstanceTypes fan-out. Offline,
// non-billable, zero-creds — the cost-safe default.

import type { Finder } from "../core/finder.js";
import type { InstanceType, FilterOptions } from "../core/types.js";
import { matchesFilters } from "../core/filter.js";
import { loadBundledCatalog } from "./catalog.js";

export class BundledFinder implements Finder {
  readonly label = "bundled";
  readonly isLive = false;
  private readonly catalog: InstanceType[];

  constructor(catalog: InstanceType[] = loadBundledCatalog()) {
    this.catalog = catalog;
  }

  async search(matcher: RegExp, filters: FilterOptions): Promise<InstanceType[]> {
    return this.catalog.filter((it) => matcher.test(it.instanceType) && matchesFilters(it, filters));
  }
}
