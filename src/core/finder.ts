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
  /**
   * The AZ this price was observed in, e.g. "us-east-1a". Spot prices vary PER
   * AZ, not per region, so without this several prices for one instance type in
   * one region are indistinguishable. Mirrors Go SpotPriceResult.AvailabilityZone.
   */
  availabilityZone: string;
  spotPrice: number;
  onDemandPrice?: number;
  savingsPercent?: number;
  /** The Spot product description, e.g. "Linux/UNIX". */
  productType?: string;
  /** Observation time, ISO-8601. Ordering is meaningful only in trend mode. */
  timestamp?: string;
}

/** Options for a spot-price query (live-only). */
export interface SpotOptions {
  /** Drop observations above this $/hr. Unset/0 = no ceiling. */
  maxPrice?: number;
  /** Also fetch the on-demand rate and compute savingsPercent. */
  showSavings?: boolean;
  /**
   * How far back to read price history, in hours. `> 1` switches to TREND mode:
   * every history point is returned (ordering matters). `<= 1`/unset returns only
   * the latest observation per AZ — the current spot price.
   */
  lookbackHours?: number;
}

/**
 * EC2 vCPU quota families. AWS meters On-Demand and Spot vCPUs per family, so a
 * "can I launch this?" answer needs the instance type's family, not its name.
 * `Standard` covers a/c/d/h/i/m/r/t/z; the rest are accelerator/memory families
 * with their own limits. VT shares the G quota (see quotaFamilyFor).
 */
export type QuotaFamily = "Standard" | "F" | "G" | "P" | "X" | "Inf" | "Trn" | "DL";

/** Quota limits and current usage for one region (live-only). */
export interface QuotaInfo {
  region: string;
  /** Max On-Demand vCPUs per family. Absent entry = not retrieved. */
  onDemand: Partial<Record<QuotaFamily, number>>;
  /** Max Spot vCPUs per family. */
  spot: Partial<Record<QuotaFamily, number>>;
  /** vCPUs currently in use (running + pending) per family. */
  usage: Partial<Record<QuotaFamily, number>>;
  /** Count of running+pending instances in the region. */
  runningInstances?: number;
  /** When this snapshot was taken, ISO-8601. */
  lastUpdated: string;
  /**
   * Families whose quota lookup failed. A partial snapshot must not read as
   * "quota is 0" — that would turn a permissions error into a false "cannot
   * launch". Callers should treat a listed family as unknown, not exhausted.
   */
  incomplete?: QuotaFamily[];
}

/** Whether a launch fits within quota, and why not when it doesn't. */
export interface QuotaVerdict {
  canLaunch: boolean;
  reason: string;
  family: QuotaFamily;
  /** vCPUs the launch would add. */
  requestedVcpus: number;
  /** Headroom before the limit, when known. */
  availableVcpus?: number;
}

/** Options for a quota query (live-only). */
export interface QuotaOptions {
  /** Region to inspect. Defaults to the finder's primary region. */
  region?: string;
  /** Skip the DescribeInstances usage pass (quota limits only — one less call). */
  skipUsage?: boolean;
}

/**
 * A live backend that also answers region/spot queries. Methods beyond `search`
 * are OPTIONAL extensions so the v0.1.0 Finder contract stays satisfiable by the
 * bundled catalog. Capacity/quota/SageMaker methods land here later.
 */
export interface LiveFinder extends Finder {
  getEnabledRegions(): Promise<string[]>;
  getSpotPricing(instances: InstanceType[], opts: SpotOptions): Promise<SpotPriceResult[]>;
  /** Quota limits + usage for a region. Requires servicequotas:GetServiceQuota. */
  getQuotas(opts?: QuotaOptions): Promise<QuotaInfo>;
  /**
   * Whether `instance` fits in remaining quota, per a snapshot from getQuotas.
   * Pure given the snapshot — no API calls — so callers can re-check many types
   * against one fetch.
   */
  canLaunch(instance: InstanceType, quotas: QuotaInfo, spot?: boolean): QuotaVerdict;
}
