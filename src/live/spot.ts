// Live Spot price history — the TS port of Go pkg/aws getRegionSpotPricing.
//
// Two modes, both driven by SpotOptions.lookbackHours:
//   <= 1 (default)  CURRENT price: the latest observation per AZ.
//   >  1            TREND: every history point in the window, unaggregated.
// The split exists because "what does this cost now" and "how has it moved" want
// different shapes, and collapsing the second into the first loses the series.

import {
  EC2Client,
  DescribeSpotPriceHistoryCommand,
  type SpotPrice,
} from "@aws-sdk/client-ec2";

import type { SpotPriceResult, SpotOptions } from "../core/finder.js";

/** The product description truffle prices against (matches the Go tool). */
export const SPOT_PRODUCT = "Linux/UNIX";

/**
 * Reduce raw SpotPrice history into results. PURE — the SDK call is the caller's
 * job, so every branch here is testable without transport (same split as
 * parseOnDemandUsd).
 *
 * `onDemandPrice` is passed in rather than fetched: it does not vary by AZ, so
 * the caller fetches it once per instance type and reuses it across that type's
 * AZs (Go does the same).
 */
export function reduceSpotHistory(
  history: SpotPrice[],
  instanceType: string,
  region: string,
  opts: SpotOptions,
  onDemandPrice?: number,
): SpotPriceResult[] {
  const trend = (opts.lookbackHours ?? 0) > 1;
  const usable = history.filter(
    (sp): sp is SpotPrice & { AvailabilityZone: string; SpotPrice: string } =>
      typeof sp.AvailabilityZone === "string" && typeof sp.SpotPrice === "string",
  );

  const build = (sp: SpotPrice & { AvailabilityZone: string; SpotPrice: string }): SpotPriceResult | undefined => {
    const spotPrice = Number(sp.SpotPrice);
    if (!Number.isFinite(spotPrice)) return undefined;
    // A maxPrice of 0/undefined means "no ceiling" — only a positive value filters.
    if (opts.maxPrice !== undefined && opts.maxPrice > 0 && spotPrice > opts.maxPrice) return undefined;
    const out: SpotPriceResult = {
      instanceType,
      region,
      availabilityZone: sp.AvailabilityZone,
      spotPrice,
    };
    if (sp.ProductDescription) out.productType = sp.ProductDescription;
    if (sp.Timestamp) out.timestamp = new Date(sp.Timestamp).toISOString();
    if (opts.showSavings && onDemandPrice !== undefined && onDemandPrice > 0) {
      out.onDemandPrice = onDemandPrice;
      // Guard spotPrice > 0: a zero/absent price would render as "100% savings",
      // which is a data artifact, not a deal.
      if (spotPrice > 0) out.savingsPercent = (1 - spotPrice / onDemandPrice) * 100;
    }
    return out;
  };

  if (trend) {
    return usable.map(build).filter((r): r is SpotPriceResult => r !== undefined);
  }

  // Current-price mode: keep the newest observation per AZ. An entry with no
  // Timestamp cannot be compared, so it only wins if the AZ has nothing yet.
  const latest = new Map<string, SpotPrice & { AvailabilityZone: string; SpotPrice: string }>();
  for (const sp of usable) {
    const prev = latest.get(sp.AvailabilityZone);
    if (!prev) {
      latest.set(sp.AvailabilityZone, sp);
      continue;
    }
    const a = sp.Timestamp ? new Date(sp.Timestamp).getTime() : -Infinity;
    const b = prev.Timestamp ? new Date(prev.Timestamp).getTime() : -Infinity;
    if (a > b) latest.set(sp.AvailabilityZone, sp);
  }
  return [...latest.values()]
    .map(build)
    .filter((r): r is SpotPriceResult => r !== undefined)
    .sort((x, y) => x.availabilityZone.localeCompare(y.availabilityZone));
}

/**
 * Fetch and reduce spot history for ONE instance type in ONE region.
 * `startTime` is passed in (not computed from a clock here) so tests are
 * deterministic and the caller anchors the whole batch to one instant.
 */
export async function fetchSpotPrices(
  client: EC2Client,
  instanceType: string,
  region: string,
  startTime: Date,
  opts: SpotOptions,
  onDemandPrice?: number,
): Promise<SpotPriceResult[]> {
  const res = await client.send(
    new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [instanceType as never],
      StartTime: startTime,
      ProductDescriptions: [SPOT_PRODUCT],
    }),
  );
  return reduceSpotHistory(res.SpotPriceHistory ?? [], instanceType, region, opts, onDemandPrice);
}
