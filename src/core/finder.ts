// The Finder seam — the read-only query interface for instance discovery,
// mirroring Go pkg/aws.Finder and spawn-ts's Provider pattern. This is the seam
// that lets the offline bundled catalog (the v0.1.0 default) be swapped for a
// live-AWS/substrate backend later WITHOUT changing the find pipeline or any
// consumer.
//
// v0.1.0 ships exactly one method (`search`) + the default BundledFinder. Live
// impls add spot/capacity/quota methods via the LiveFinder sub-interface, so
// this core contract never has to break. `search` is async even though the
// bundled impl is synchronous internally — a network impl slots in with zero
// signature change.

import type { InstanceType, FilterOptions } from "./types.js";

export interface Finder {
  /** Human label for the active source: "bundled", "aws:us-east-1", "substrate". */
  readonly label: string;
  /** Whether this hits real, billable AWS APIs — drives UI staleness warnings. */
  readonly isLive: boolean;
  /**
   * Return instance types whose name matches `matcher` and that pass `filters`.
   * The bundled impl runs this in-memory over the snapshot; a live impl fans out
   * DescribeInstanceTypes across regions (as Go SearchInstanceTypes does).
   */
  search(matcher: RegExp, filters: FilterOptions): Promise<InstanceType[]>;
}

/** Current Spot price observation for an instance type (live-only). */
export interface SpotPriceResult {
  instanceType: string;
  region: string;
  spotPrice: number;
  onDemandPrice?: number;
  savingsPercent?: number;
}

/** Options for a spot-price query (live-only). */
export interface SpotOptions {
  maxPrice?: number;
  showSavings?: boolean;
  lookbackHours?: number;
}

/**
 * A live backend that also answers region/spot queries. Methods beyond `search`
 * are OPTIONAL extensions so the v0.1.0 Finder contract stays satisfiable by the
 * bundled catalog. Capacity/quota/SageMaker methods land here later.
 */
export interface LiveFinder extends Finder {
  getEnabledRegions(): Promise<string[]>;
  getSpotPricing(instances: InstanceType[], opts: SpotOptions): Promise<SpotPriceResult[]>;
}
