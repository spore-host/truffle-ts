// Availability-zone lookups and the AZ-first view — the port of Go truffle's
// `az` command (cmd/az.go), its zone classifier (pkg/aws/zones.go,
// cmd/localzones.go) and the batched offering lookup
// (pkg/aws/client.go getAvailabilityZonesBatch / azsByInstanceType), #33.
//
// The two AWS calls (DescribeInstanceTypeOfferings, DescribeAvailabilityZones)
// are plain EC2 SigV4, browser-reachable with STS credentials. The filters and
// summaries are pure.

import {
  EC2Client,
  DescribeInstanceTypeOfferingsCommand,
  DescribeAvailabilityZonesCommand,
  type InstanceTypeOffering,
} from "@aws-sdk/client-ec2";

import type { InstanceType } from "../core/types.js";
import { sortZoneNames, uniqueSorted } from "../core/derive.js";

/** Types per DescribeInstanceTypeOfferings call (Go azBatchSize). */
export const AZ_BATCH_SIZE = 100;

/**
 * Group offerings by instance type; each list deduplicated and in zone order,
 * whatever order AWS returned them in (Go azsByInstanceType, #217).
 */
export function azsByInstanceType(offerings: readonly InstanceTypeOffering[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const o of offerings) {
    if (!o.Location || !o.InstanceType) continue;
    const t = String(o.InstanceType);
    grouped.set(t, [...(grouped.get(t) ?? []), o.Location]);
  }
  for (const [t, azs] of grouped) grouped.set(t, sortZoneNames(uniqueSorted(azs)));
  return grouped;
}

/**
 * The AZs each of `instanceTypes` is offered in, in one region: one paginated
 * DescribeInstanceTypeOfferings per AZ_BATCH_SIZE types. A failed batch is
 * absent from the map, so those types read as "AZs unknown" — as Go's
 * best-effort search use — and is listed in `failedTypes` so the gap is
 * visible rather than silent.
 */
export async function fetchAvailabilityZones(
  client: EC2Client,
  instanceTypes: readonly string[],
): Promise<{ azs: Map<string, string[]>; failedTypes: string[]; errors: string[] }> {
  const azs = new Map<string, string[]>();
  const failedTypes: string[] = [];
  const errors: string[] = [];
  for (let start = 0; start < instanceTypes.length; start += AZ_BATCH_SIZE) {
    const chunk = instanceTypes.slice(start, start + AZ_BATCH_SIZE);
    const offerings: InstanceTypeOffering[] = [];
    let token: string | undefined;
    try {
      do {
        const res = await client.send(
          new DescribeInstanceTypeOfferingsCommand({
            LocationType: "availability-zone",
            Filters: [{ Name: "instance-type", Values: [...chunk] }],
            NextToken: token,
          }),
        );
        offerings.push(...(res.InstanceTypeOfferings ?? []));
        token = res.NextToken;
      } while (token);
    } catch (e) {
      failedTypes.push(...chunk);
      errors.push((e as Error)?.message ?? String(e));
      continue;
    }
    for (const [t, list] of azsByInstanceType(offerings)) azs.set(t, list);
  }
  return { azs, failedTypes, errors };
}

/** EC2 zone types (Go ZoneType* constants). */
export type ZoneType = "availability-zone" | "local-zone" | "wavelength-zone";

/** One zone's identity (Go ZoneInfo). */
export interface ZoneInfo {
  zoneName: string;
  /** Account-specific ID, e.g. "use1-az1". */
  zoneId?: string;
  zoneType: string;
  optInStatus?: string;
  /** For a Local/Wavelength zone: the in-region AZ it attaches to. */
  parentZoneName?: string;
  /** Network border group. */
  groupName?: string;
  region: string;
}

/** Whether a zone is a Local or Wavelength Zone (Go ZoneInfo.IsExtended). */
export function isExtendedZone(z: Pick<ZoneInfo, "zoneType">): boolean {
  return z.zoneType === "local-zone" || z.zoneType === "wavelength-zone";
}

/** "Local Zone", "Wavelength", or "" (Go ZoneInfo.Label). */
export function zoneLabel(z: Pick<ZoneInfo, "zoneType">): string {
  return z.zoneType === "local-zone" ? "Local Zone" : z.zoneType === "wavelength-zone" ? "Wavelength" : "";
}

/**
 * Every zone in a region, by name, including Local/Wavelength zones the account
 * hasn't opted into (`AllAvailabilityZones=true`). Ports Go Client.ZoneInfos.
 */
export async function fetchZoneInfos(client: EC2Client, region: string): Promise<Map<string, ZoneInfo>> {
  const res = await client.send(new DescribeAvailabilityZonesCommand({ AllAvailabilityZones: true }));
  const zones = new Map<string, ZoneInfo>();
  for (const az of res.AvailabilityZones ?? []) {
    if (!az.ZoneName) continue;
    const z: ZoneInfo = { zoneName: az.ZoneName, zoneType: az.ZoneType ?? "", region };
    if (az.ZoneId) z.zoneId = az.ZoneId;
    if (az.OptInStatus) z.optInStatus = String(az.OptInStatus);
    if (az.ParentZoneName) z.parentZoneName = az.ParentZoneName;
    if (az.GroupName) z.groupName = az.GroupName;
    zones.set(z.zoneName, z);
  }
  return zones;
}

/** The names of the Local/Wavelength zones among `zones`. */
export function extendedZoneNames(zones: Iterable<ZoneInfo>): Set<string> {
  const out = new Set<string>();
  for (const z of zones) if (isExtendedZone(z)) out.add(z.zoneName);
  return out;
}

// ── The pure `az` filters (Go cmd/az.go) ──────────────────────────────────────

/**
 * The regions named by AZs ("us-east-1a" → "us-east-1"), sorted. Ports Go
 * extractRegionsFromAZs, which drops the last character; that turns a Local
 * Zone ("us-west-2-lax-1a") into the non-region "us-west-2-lax-1", so a
 * region-shaped prefix is taken when there is one, and Go's rule otherwise.
 */
export function extractRegionsFromAZs(azs: readonly string[]): string[] {
  const region = (az: string) => /^[a-z]{2}(?:-gov)?-[a-z]+-\d+/.exec(az)?.[0] ?? az.slice(0, -1);
  return uniqueSorted(azs.filter((az) => az.length > 1).map(region));
}

/**
 * Keep rows offered in any of `azFilter`, REWRITING each row's `availableAZs`
 * down to the matched set — the row then shows only the AZs you asked about.
 * Ports Go filterByAZs.
 */
export function filterByAZs(results: readonly InstanceType[], azFilter: readonly string[]): InstanceType[] {
  const want = new Set(azFilter);
  const out: InstanceType[] = [];
  for (const r of results) {
    const matched = (r.availableAZs ?? []).filter((az) => want.has(az));
    if (matched.length > 0) out.push({ ...r, availableAZs: matched });
  }
  return out;
}

/** Keep rows offered in at least `minCount` AZs (Go filterByMinAZCount). */
export function filterByMinAZCount(results: readonly InstanceType[], minCount: number): InstanceType[] {
  return results.filter((r) => (r.availableAZs?.length ?? 0) >= minCount);
}

/**
 * Keep only Local/Wavelength zones in each row, dropping rows with none
 * (`--local-zones`, #164; Go filterToLocalZones).
 */
export function filterToLocalZones(results: readonly InstanceType[], localZones: ReadonlySet<string>): InstanceType[] {
  const out: InstanceType[] = [];
  for (const r of results) {
    const kept = (r.availableAZs ?? []).filter((az) => localZones.has(az));
    if (kept.length > 0) out.push({ ...r, availableAZs: kept });
  }
  return out;
}

/** Most AZs first, then type, then region (the `az` command's order). */
export function sortAZResults(results: readonly InstanceType[]): InstanceType[] {
  return [...results].sort(
    (a, b) =>
      (b.availableAZs?.length ?? 0) - (a.availableAZs?.length ?? 0) ||
      cmp(a.instanceType, b.instanceType) ||
      cmp(a.region ?? "", b.region ?? ""),
  );
}

/** One region's row in `az --regions-only` (Go azRegionSummary, #199). */
export interface AZRegionSummary {
  region: string;
  azCount: number;
  availabilityZones: string[];
  instanceTypes: string[];
}

/**
 * Collapse rows to one per region: its AZs (zone order) and the matching types
 * (sorted), most AZs first, then region. Go `az --regions-only` was dead code
 * until v0.59.0 (#199); it is ported as fixed. Ports Go summarizeAZRegions.
 */
export function summarizeAZRegions(results: readonly InstanceType[]): AZRegionSummary[] {
  const azs = new Map<string, Set<string>>();
  const types = new Map<string, Set<string>>();
  for (const r of results) {
    const region = r.region ?? "";
    if (!azs.has(region)) (azs.set(region, new Set()), types.set(region, new Set()));
    for (const az of r.availableAZs ?? []) azs.get(region)!.add(az);
    types.get(region)!.add(r.instanceType);
  }
  return [...azs.keys()]
    .map((region) => {
      const availabilityZones = sortZoneNames(uniqueSorted([...azs.get(region)!]));
      return {
        region,
        azCount: availabilityZones.length,
        availabilityZones,
        instanceTypes: uniqueSorted([...types.get(region)!]),
      };
    })
    .sort((a, b) => b.azCount - a.azCount || cmp(a.region, b.region));
}

/** The numbers Go's `az` table summary prints (Go printAZSummary). */
export interface AZSummary {
  instanceTypes: number;
  regionResults: number;
  /** Fewest AZs of any row with at least one; 0 when none. */
  minAZs: number;
  maxAZs: number;
  averageAZs: number;
}

export function summarizeAZs(results: readonly InstanceType[]): AZSummary {
  const counts = results.map((r) => r.availableAZs?.length ?? 0);
  const positive = counts.filter((c) => c > 0);
  return {
    instanceTypes: new Set(results.map((r) => r.instanceType)).size,
    regionResults: results.length,
    minAZs: positive.length ? Math.min(...positive) : 0,
    maxAZs: counts.length ? Math.max(0, ...counts) : 0,
    averageAZs: results.length ? counts.reduce((a, b) => a + b, 0) / results.length : 0,
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
