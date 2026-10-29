// Obtainability — "can I actually GET this instance type right now?", as
// distinct from "does it exist and what does it cost?". The port of Go truffle
// `available` (cmd/available.go) and pkg/aws/obtainability.go, #32.
//
// Five signals, collected concurrently and each best-effort, because they fail
// independently and call for different remedies:
//
//   spot placement   GetSpotPlacementScores, a 1-10 likelihood per AZ
//   offered AZs      DescribeInstanceTypeOfferings, with the region's AZ count
//   quota headroom   GetServiceQuota + DescribeInstances (quotas.ts)
//   vCPUs            DescribeInstanceTypes, so headroom converts to instances
//   capacity blocks  DescribeCapacityBlockOfferings, 24h window, count 1
//
// A failed signal becomes a warning and stays undefined; only a missing type or
// region is an error. GetSpotPlacementScores in particular is commonly denied
// by SCP, and an absent signal must never read as a good one (#63).
//
// Deliberately NOT used: RunInstances with DryRun. It validates permissions and
// parameters only, checks neither capacity nor quota, and reports "would have
// succeeded" for types that cannot be launched at all (verified by Go
// 2026-07-27 against p6-b200.48xlarge, p5.4xlarge and g7e.4xlarge). Don't
// "simplify" this into a dry run.

import {
  EC2Client,
  GetSpotPlacementScoresCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInstanceTypesCommand,
} from "@aws-sdk/client-ec2";
import type { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import type { PricingClient } from "@aws-sdk/client-pricing";

import type { QuotaFamily } from "../core/finder.js";
import type { PriceOrigin } from "../core/price.js";
import { sortZoneNames, uniqueSorted } from "../core/derive.js";
import { fetchAvailabilityZones } from "./az.js";
import { fetchCapacityBlockOfferings, fanOutRegions, CAPACITY_BLOCK_INELIGIBLE, isCapacityBlockIneligible } from "./capacity.js";
import { fetchQuotas, fetchUsage, quotaFamilyFor, QUOTA_CODES } from "./quotas.js";
import { lookupOnDemandPrice } from "./pricing.js";

/** One AZ's spot placement score (Go SpotPlacement). */
export interface SpotPlacement {
  /** AZ name (us-east-1a), or the ID when it could not be named. */
  az: string;
  /** The account-specific zone ID AWS returned (use1-az2): stable across accounts. */
  azId?: string;
  /** 1–10, higher = more likely to be fulfilled. Relative, not a percentage. */
  score: number;
}

/** The obtainability report for one type in one region (Go Obtainability). */
export interface Obtainability {
  instanceType: string;
  region: string;
  /** Per-AZ spot placement scores, best first. Empty when unavailable. */
  spotPlacements: SpotPlacement[];
  /**
   * AZs the type is offered in at all, in zone order — a hard constraint.
   * Undefined when the lookup FAILED (see warnings): Go reports a failed lookup
   * as an empty list, which then reads as "not offered in this region".
   */
  offeredAZs?: string[];
  /** How many AZs the region has, the denominator for `offeredAZs`. */
  totalAZs?: number;
  /** vCPUs left under the On-Demand quota (limit − usage, floor 0). Undefined = unknown. */
  onDemandQuotaHeadroom?: number;
  quotaFamily: QuotaFamily;
  /** The Service Quotas code to file an increase against. */
  quotaCode: string;
  vcpusPerInstance?: number;
  /** Purchasable Capacity Block offerings in the window. Undefined = query failed. */
  capacityBlockOfferings?: number;
  capacityBlockWindowHours?: number;
  /** On-demand $/hr in this region, when it could be priced. */
  onDemandPrice?: number;
  /** Where `onDemandPrice` came from: live, or static with why and when (truffle#184). */
  onDemandPriceOrigin?: PriceOrigin;
  /** Signals that could not be collected. Never silent. */
  warnings: string[];
}

/** The Capacity Block window probed: 24h, the most generous honest ask (Go). */
export const OBTAINABILITY_CAPACITY_BLOCK_HOURS = 24;

/** Clients the obtainability check needs. */
export interface ObtainabilityClients {
  ec2: EC2Client;
  serviceQuotas: ServiceQuotasClient;
  /** Optional: price the type too, as `truffle available` does (#159). */
  pricing?: PricingClient;
}

function errText(e: unknown): string {
  const name = (e as { name?: string })?.name;
  const msg = (e as { message?: string })?.message ?? String(e);
  return name && name !== "Error" && !msg.startsWith(name) ? `${name}: ${msg}` : msg;
}

/** AZ ID → name for a region (Go azIDToName). */
async function azIdToName(client: EC2Client): Promise<Map<string, string>> {
  const res = await client.send(new DescribeAvailabilityZonesCommand({}));
  const m = new Map<string, string>();
  for (const az of res.AvailabilityZones ?? []) if (az.ZoneId && az.ZoneName) m.set(az.ZoneId, az.ZoneName);
  return m;
}

/**
 * Spot placement scores per AZ. `SingleAvailabilityZone: true` (else AWS scores
 * the region as a whole), `RegionNames`, `TargetCapacity: 1` and
 * `TargetCapacityUnitType: "units"` are all required. AZ IDs are mapped to
 * names; a failed mapping keeps the ID rather than dropping the score. Ports Go
 * spotPlacementScores.
 */
export async function fetchSpotPlacementScores(
  client: EC2Client,
  instanceType: string,
  region: string,
): Promise<SpotPlacement[]> {
  const res = await client.send(
    new GetSpotPlacementScoresCommand({
      InstanceTypes: [instanceType],
      RegionNames: [region],
      SingleAvailabilityZone: true,
      TargetCapacity: 1,
      TargetCapacityUnitType: "units",
    }),
  );
  const names = await azIdToName(client).catch(() => new Map<string, string>());
  const out: SpotPlacement[] = [];
  for (const s of res.SpotPlacementScores ?? []) {
    if (s.Score == null || !s.AvailabilityZoneId) continue;
    out.push({ az: names.get(s.AvailabilityZoneId) ?? s.AvailabilityZoneId, azId: s.AvailabilityZoneId, score: s.Score });
  }
  return sortSpotPlacements(out);
}

/** Best score first, then AZ name (AWS guarantees no order). Go sortSpotPlacements. */
export function sortSpotPlacements(ps: readonly SpotPlacement[]): SpotPlacement[] {
  return [...ps].sort((a, b) => b.score - a.score || (a.az < b.az ? -1 : a.az > b.az ? 1 : 0));
}

/**
 * Gather every signal for one type in one region. Throws only when the type or
 * region is empty; every other failure is a warning. Ports Go
 * Client.Obtainability, plus the on-demand price `available` adds (#159).
 *
 * Deliberate divergence (filed as spore-host/truffle#271): Go reads the quota
 * map with a single-value lookup, so a family whose quota couldn't be READ
 * reports "headroom 0 / quota is 0". Here an unreadable quota is a warning and
 * the headroom stays unknown — the #167 rule. And the quota code comes from
 * the full 8-family table, where Go's `available` knows only P, G and Standard.
 */
export async function obtainability(
  clients: ObtainabilityClients,
  instanceType: string,
  region: string,
): Promise<Obtainability> {
  if (!instanceType.trim()) throw new Error("obtainability: instanceType is required");
  if (!region.trim()) throw new Error("obtainability: region is required");

  const family = quotaFamilyFor(instanceType);
  const out: Obtainability = {
    instanceType,
    region,
    spotPlacements: [],
    quotaFamily: family,
    quotaCode: QUOTA_CODES[family].onDemand,
    warnings: [],
  };
  const warn = (s: string) => out.warnings.push(s);

  await Promise.all([
    // 1. Spot placement scores — the only forward-looking signal AWS exposes.
    (async () => {
      try {
        out.spotPlacements = await fetchSpotPlacementScores(clients.ec2, instanceType, region);
      } catch (e) {
        warn(`spot placement scores unavailable: ${errText(e)}`);
      }
    })(),

    // 2. Offered-AZ footprint, deduplicated before it's counted against the
    //    region's AZs (a duplicate row would print "24 of 3").
    (async () => {
      const { azs, errors } = await fetchAvailabilityZones(clients.ec2, [instanceType]);
      if (errors.length > 0) {
        warn(`offered AZs unavailable: ${errors[0]}`);
        return;
      }
      out.offeredAZs = sortZoneNames(uniqueSorted(azs.get(instanceType) ?? []));
      try {
        out.totalAZs = (await azIdToName(clients.ec2)).size;
      } catch (e) {
        warn(`region AZ count unavailable: ${errText(e)}`);
      }
    })(),

    // 3. On-Demand quota headroom — the gate that blocks most new accounts.
    (async () => {
      try {
        const limits = await fetchQuotas(clients.serviceQuotas, region);
        const limit = limits.onDemand[family];
        if (limit === undefined) {
          warn(`quota headroom unavailable: the On-Demand ${family} vCPU quota (${out.quotaCode}) could not be read — limit unknown, not zero`);
          return;
        }
        const { usage } = await fetchUsage(clients.ec2);
        out.onDemandQuotaHeadroom = Math.max(0, limit - (usage[family] ?? 0));
      } catch (e) {
        warn(`quota headroom unavailable: ${errText(e)}`);
      }
    })(),

    // 4. vCPUs from DescribeInstanceTypes, not parsed from the name: guessing
    //    misreports headroom for non-linear sizes (p6-b200.48xlarge, metal).
    (async () => {
      try {
        const res = await clients.ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as never] }));
        const v = res.InstanceTypes?.find((t) => t.VCpuInfo?.DefaultVCpus)?.VCpuInfo?.DefaultVCpus;
        if (v === undefined) throw new Error(`no vCPU info for ${instanceType}`);
        out.vcpusPerInstance = v;
      } catch (e) {
        warn(`vCPU count unavailable: ${errText(e)}`);
      }
    })(),

    // 5. Capacity Block offerings at count 1 — a larger count silently gates
    //    results (#109).
    (async () => {
      try {
        const { results } = await fanOutRegions(
          [region],
          () =>
            fetchCapacityBlockOfferings(clients.ec2, region, {
              instanceType,
              instanceCount: 1,
              // No date range, as Go: AWS's own default window.
              durationHours: OBTAINABILITY_CAPACITY_BLOCK_HOURS,
            }),
          "capacity block",
          (e) => (isCapacityBlockIneligible(e) ? CAPACITY_BLOCK_INELIGIBLE : undefined),
        );
        out.capacityBlockOfferings = results.length;
        out.capacityBlockWindowHours = OBTAINABILITY_CAPACITY_BLOCK_HOURS;
      } catch (e) {
        warn(`capacity block offerings unavailable: ${errText(e)}`);
      }
    })(),

    // 6. The on-demand price, labelled with where it came from (#159, #184).
    (async () => {
      if (!clients.pricing) return;
      const q = await lookupOnDemandPrice(clients.pricing, instanceType, region);
      if (q.price !== undefined) out.onDemandPrice = q.price;
      out.onDemandPriceOrigin = q.origin;
    })(),
  ]);

  out.warnings.sort();
  return out;
}

/** The best (first) spot placement, if any (Go BestSpotPlacement). */
export function bestSpotPlacement(o: Pick<Obtainability, "spotPlacements">): SpotPlacement | undefined {
  return o.spotPlacements[0];
}

/** Headroom as a whole number of instances; undefined when either input is unknown (Go InstanceHeadroom). */
export function instanceHeadroom(o: Pick<Obtainability, "onDemandQuotaHeadroom" | "vcpusPerInstance">): number | undefined {
  if (o.onDemandQuotaHeadroom === undefined || !o.vcpusPerInstance || o.vcpusPerInstance <= 0) return undefined;
  return Math.floor(o.onDemandQuotaHeadroom / o.vcpusPerInstance);
}

/** Which signals argue against obtaining the type, and the one-line verdict. */
export interface ObtainabilityVerdict {
  /** In Go's order: "spot", "azs", "quota". */
  concerns: ("spot" | "azs" | "quota")[];
  /** e.g. "low obtainability (spot, quota); consider `lagotto watch p5.48xlarge`". */
  summary: string;
}

/**
 * The concerns → verdict derivation from Go printObtainability: a best spot
 * score of 3 or less; no offered AZ, or a single-AZ footprint in a multi-AZ
 * region; zero quota headroom, or headroom for zero whole instances. An
 * UNKNOWN signal is not a concern — the warnings say it is missing. (Go counts
 * a failed AZ lookup as "not offered"; here it is unknown, not bad.)
 */
export function obtainabilityVerdict(o: Obtainability): ObtainabilityVerdict {
  const concerns: ObtainabilityVerdict["concerns"] = [];
  const best = bestSpotPlacement(o);
  if (best && best.score <= 3) concerns.push("spot");
  const azs = o.offeredAZs;
  if (azs && (azs.length === 0 || (azs.length === 1 && (o.totalAZs ?? 0) > 1))) concerns.push("azs");
  if (o.onDemandQuotaHeadroom !== undefined) {
    if (o.onDemandQuotaHeadroom === 0 || instanceHeadroom(o) === 0) concerns.push("quota");
  }
  const summary = concerns.length
    ? `low obtainability (${concerns.join(", ")}); consider \`lagotto watch ${o.instanceType}\``
    : "no blocking signals found";
  return { concerns, summary };
}
