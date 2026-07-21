// AwsLiveFinder — a Node-only Finder that answers queries from LIVE AWS
// (DescribeInstanceTypes) instead of the bundled offline snapshot. It plugs into
// the exact same `find()` seam as BundledFinder; the only difference is the
// source of truth. Reserved for CLI/server/Node consumers: a browser can't hold
// AWS credentials safely or reach these endpoints (CORS), so this lives behind
// the "@spore-host/truffle-ts/live" subpath and the AWS SDK is an optional dep —
// the default offline `.` import never pulls it in.
//
// Ports the Go tool's searchInRegion / extractSpecificTypes / GetEnabledRegions
// (pkg/aws/client.go): fetch per region, map to InstanceType, filter in-memory
// with the SAME matchesFilters the bundled path uses.

import {
  EC2Client,
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
  type InstanceTypeInfo,
} from "@aws-sdk/client-ec2";
import { PricingClient } from "@aws-sdk/client-pricing";
import type { AwsCredentialIdentity } from "@aws-sdk/types";

import type { InstanceType, FilterOptions } from "../core/types.js";
import type { Finder, LiveFinder, SpotPriceResult, SpotOptions } from "../core/finder.js";
import { matchesFilters } from "../core/filter.js";
import { mapInstanceType } from "./mapping.js";
import { fetchOnDemandPrice, type PricingRegion } from "./pricing.js";

export interface LiveFinderOptions {
  /**
   * Region(s) to query. Required — no implicit default, since a live call is
   * billable/latency-bearing and silently defaulting to us-east-1 is a footgun.
   * Multiple regions fan out concurrently and dedupe by instance type.
   */
  regions: string | string[];
  /** Explicit SDK credentials. Omit to use the default Node provider chain. */
  credentials?: AwsCredentialIdentity;
  /**
   * On-demand pricing for results. "off" (default) leaves onDemandPrice unset —
   * callers can fill it from the bundled static pricing. "lazy" fetches real
   * prices from the Pricing API for the (small) post-filter result set only.
   */
  pricing?: "off" | "lazy";
  /** Pricing API endpoint region (it's only served from these two). Default us-east-1. */
  pricingRegion?: PricingRegion;
  /** Test seams: inject pre-built clients so tests never construct real transport. */
  ec2ClientFor?: (region: string) => EC2Client;
  pricingClient?: PricingClient;
}

/** Regex metacharacters whose presence means "not an exact instance-type name". */
const WILDCARD = /[*+?[\]()|.]/;

export class AwsLiveFinder implements LiveFinder {
  readonly isLive = true;
  readonly label: string;
  private readonly regions: string[];
  private readonly pricingMode: "off" | "lazy";
  private readonly pricingRegion: PricingRegion;
  private readonly ec2For: (region: string) => EC2Client;
  private pricing?: PricingClient;
  private readonly opts: LiveFinderOptions;

  constructor(opts: LiveFinderOptions) {
    this.regions = (Array.isArray(opts.regions) ? opts.regions : [opts.regions]).filter(Boolean);
    if (this.regions.length === 0) throw new Error("AwsLiveFinder: at least one region is required");
    this.pricingMode = opts.pricing ?? "off";
    this.pricingRegion = opts.pricingRegion ?? "us-east-1";
    this.opts = opts;
    this.ec2For =
      opts.ec2ClientFor ??
      ((region) => new EC2Client({ region, credentials: opts.credentials }));
    this.label =
      this.regions.length === 1
        ? `aws:${this.regions[0]}`
        : `aws:${this.regions[0]}+${this.regions.length - 1} more`;
  }

  /**
   * Query the configured regions for instance types matching `matcher` +
   * `filters`. Per region: if the matcher is an exact instance-type name, push
   * it into the request server-side (avoids paginating ~800 types); otherwise
   * fetch all and filter in-memory. Fans out across regions, dedupes by type,
   * and returns partial results if some regions fail (throws only if all do).
   */
  async search(matcher: RegExp, filters: FilterOptions): Promise<InstanceType[]> {
    const exact = exactTypeName(matcher);
    const settled = await Promise.allSettled(
      this.regions.map((region) => this.searchRegion(region, exact, matcher, filters)),
    );
    const ok = settled.filter((s): s is PromiseFulfilledResult<InstanceType[]> => s.status === "fulfilled");
    if (ok.length === 0) {
      const first = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
      throw new Error(`live search failed in all regions: ${first?.reason}`);
    }

    // Dedupe by instance type (a type appears in many regions; the catalog shape
    // is region-agnostic). Keep first occurrence, in region order.
    const byType = new Map<string, InstanceType>();
    for (const r of ok) for (const it of r.value) if (!byType.has(it.instanceType)) byType.set(it.instanceType, it);
    const results = [...byType.values()];

    if (this.pricingMode === "lazy") await this.fillPrices(results);
    return results;
  }

  private async searchRegion(
    region: string,
    exact: string | null,
    matcher: RegExp,
    filters: FilterOptions,
  ): Promise<InstanceType[]> {
    const client = this.ec2For(region);
    const collected: InstanceTypeInfo[] = [];
    let token: string | undefined;
    try {
      do {
        const res = await client.send(
          new DescribeInstanceTypesCommand({
            InstanceTypes: exact ? [exact as never] : undefined,
            NextToken: token,
            MaxResults: exact ? undefined : 100,
          }),
        );
        collected.push(...(res.InstanceTypes ?? []));
        token = res.NextToken;
      } while (token);
    } catch (e) {
      // "not offered in this region" is a zero-result, not a failure (mirrors
      // the Go isInstanceTypeNotOffered handling for the exact-type path).
      if (exact && isNotOffered(e)) return [];
      throw e;
    }
    return collected
      .map(mapInstanceType)
      .filter((it) => matcher.test(it.instanceType) && matchesFilters(it, filters));
  }

  private async fillPrices(results: InstanceType[]): Promise<void> {
    this.pricing ??= this.opts.pricingClient ?? new PricingClient({ region: this.pricingRegion, credentials: this.opts.credentials });
    const region = this.regions[0]; // price against the primary queried region
    await Promise.all(
      results.map(async (it) => {
        try {
          const usd = await fetchOnDemandPrice(this.pricing!, it.instanceType, region);
          if (usd !== undefined) it.onDemandPrice = usd;
        } catch {
          // leave price unset on lookup failure
        }
      }),
    );
  }

  /** Account-enabled regions, via DescribeRegions (region-agnostic call). */
  async getEnabledRegions(): Promise<string[]> {
    const res = await this.ec2For(this.regions[0]).send(new DescribeRegionsCommand({ AllRegions: false }));
    return (res.Regions ?? []).map((r) => r.RegionName!).filter(Boolean).sort();
  }

  /** Spot pricing is deferred to #18; the method exists so LiveFinder is satisfied. */
  async getSpotPricing(_instances: InstanceType[], _opts: SpotOptions): Promise<SpotPriceResult[]> {
    void _instances;
    void _opts;
    throw new Error("getSpotPricing is not implemented yet (truffle-ts#18)");
  }
}

/** Convenience factory — same as `new AwsLiveFinder(opts)`, returned as a Finder. */
export function createLiveFinder(opts: LiveFinderOptions): Finder {
  return new AwsLiveFinder(opts);
}

/**
 * If `matcher` matches exactly one literal instance-type name (no wildcards),
 * return that name so it can be pushed into the DescribeInstanceTypes request
 * server-side; else null (fetch all + filter). Ports Go extractSpecificTypes.
 */
export function exactTypeName(matcher: RegExp): string | null {
  const src = matcher.source;
  // An exact name is fully anchored — a prefix pattern like `^m7i\.` (no `$`)
  // is NOT exact, it's "starts with", so require both anchors.
  if (!src.startsWith("^") || !src.endsWith("$")) return null;
  const body = src.slice(1, -1);
  // The only regex metacharacter allowed in a literal instance-type name is the
  // escaped dot (\.); anything else means it's a real pattern.
  if (WILDCARD.test(body.replace(/\\\./g, ""))) return null;
  const unescaped = body.replace(/\\\./g, ".");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(unescaped)) return null;
  return unescaped;
}

/** Whether an EC2 error means the exact instance type isn't offered in-region. */
function isNotOffered(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as { message?: string })?.message ?? "";
  return /InvalidInstanceType|InvalidParameterValue/.test(name) || /not.*(offered|support)/i.test(msg);
}
