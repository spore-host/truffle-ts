// Capacity reservations, owned Capacity Blocks, and purchasable Capacity Block
// offerings — the port of Go truffle's `capacity`, `capacity --blocks` and
// `capacity-blocks` commands (cmd/capacity.go, cmd/capacity_blocks.go,
// pkg/aws/client.go GetCapacityReservations / GetCapacityBlocks /
// GetCapacityBlockOfferings), #33.
//
// The AWS calls are plain EC2 Describe* over SigV4, so they run in a browser
// tab holding STS credentials as well as in Node. Everything else here is pure.
//
// The contract all three share (Go #63/#109/#110): "nothing found" is a common,
// legitimate answer, which is exactly why a FAILED query must not produce it. A
// total failure throws; a partial one returns what it has plus `regionErrors`,
// so a degraded answer is never silent. Go prints that warning to stderr; a
// library returns it.

import {
  EC2Client,
  DescribeCapacityReservationsCommand,
  DescribeCapacityBlockOfferingsCommand,
  type CapacityReservation,
  type Filter,
} from "@aws-sdk/client-ec2";

import { extractFamily } from "../core/filter.js";
import { isGPUFamily } from "../core/derive.js";

/** One region's failure in a multi-region query. */
export interface RegionError {
  region: string;
  error: string;
}

/** A multi-region answer: the rows, and which regions failed (never silent). */
export interface RegionalResult<T> {
  results: T[];
  regionErrors: RegionError[];
}

function errText(e: unknown): string {
  const name = (e as { name?: string })?.name;
  const msg = (e as { message?: string })?.message ?? String(e);
  return name && name !== "Error" && !msg.startsWith(name) ? `${name}: ${msg}` : msg;
}

/**
 * Run `fn` per region (at most 10 at once, as Go's semaphore). Throws when
 * EVERY region fails; otherwise returns the rows and the per-region errors.
 */
export async function fanOutRegions<T>(
  regions: readonly string[],
  fn: (region: string) => Promise<T[]>,
  what: string,
  classify?: (e: unknown) => string | undefined,
): Promise<RegionalResult<T>> {
  const results: T[] = [];
  const regionErrors: RegionError[] = [];
  const raw: unknown[] = [];
  const queue = [...regions];
  const worker = async () => {
    for (let r = queue.shift(); r !== undefined; r = queue.shift()) {
      try {
        results.push(...(await fn(r)));
      } catch (e) {
        raw.push(e);
        regionErrors.push({ region: r, error: errText(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(10, regions.length)) }, worker));
  if (regions.length > 0 && regionErrors.length === regions.length) {
    const special = classify ? raw.map(classify) : [];
    const detail = regionErrors.map((e) => `region ${e.region}: ${e.error}`).join("; ");
    if (special.length > 0 && special.every((s) => s !== undefined && s === special[0])) {
      throw new Error(`${special[0]} in all ${regions.length} queried region(s): ${detail}`);
    }
    throw new Error(`all ${regions.length} ${what} region queries failed: ${detail}`);
  }
  regionErrors.sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  return { results, regionErrors };
}

const iso = (d: Date | undefined) => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z") : "");
const tagsOf = (cr: CapacityReservation) =>
  (cr.Tags ?? []).filter((t) => t.Key != null && t.Value != null).map((t) => `${t.Key}=${t.Value}`);

// ── On-Demand Capacity Reservations (`truffle capacity`) ──────────────────────

/** One reservation (Go CapacityReservationResult). */
export interface CapacityReservationResult {
  reservationId: string;
  instanceType: string;
  region: string;
  availabilityZone: string;
  totalCapacity: number;
  availableCapacity: number;
  usedCapacity: number;
  state: string;
  tenancy: string;
  ebsOptimized: boolean;
  endDate?: string;
  platform: string;
  tags?: string[];
}

/** Go CapacityReservationOptions. */
export interface CapacityReservationOptions {
  instanceTypes?: string[];
  /** Only reservations with available capacity. */
  onlyAvailable?: boolean;
  /** Only `active` reservations (a server-side `state` filter). Go's CLI default is true. */
  onlyActive?: boolean;
  /** Keep expired / cancelled reservations (dropped by default). */
  includeExpired?: boolean;
  /** Minimum available capacity. */
  minCapacity?: number;
}

/** Reservations in one region. Ports Go getRegionCapacityReservations. */
export async function fetchCapacityReservations(
  client: EC2Client,
  region: string,
  opts: CapacityReservationOptions = {},
): Promise<CapacityReservationResult[]> {
  const filters: Filter[] = [];
  if (opts.instanceTypes?.length) filters.push({ Name: "instance-type", Values: opts.instanceTypes });
  if (opts.onlyActive) filters.push({ Name: "state", Values: ["active"] });
  const out: CapacityReservationResult[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new DescribeCapacityReservationsCommand({ Filters: filters, NextToken: token }));
    for (const cr of res.CapacityReservations ?? []) {
      const available = cr.AvailableInstanceCount ?? 0;
      if (opts.onlyAvailable && available === 0) continue;
      if (opts.minCapacity && opts.minCapacity > 0 && available < opts.minCapacity) continue;
      const state = String(cr.State ?? "");
      if (!opts.includeExpired && (state === "expired" || state === "cancelled")) continue;
      const total = cr.TotalInstanceCount ?? 0;
      const r: CapacityReservationResult = {
        reservationId: cr.CapacityReservationId ?? "",
        instanceType: cr.InstanceType ?? "",
        region,
        availabilityZone: cr.AvailabilityZone ?? "",
        totalCapacity: total,
        availableCapacity: available,
        usedCapacity: total - available,
        state,
        tenancy: String(cr.Tenancy ?? ""),
        ebsOptimized: cr.EbsOptimized ?? false,
        platform: String(cr.InstancePlatform ?? ""),
      };
      if (cr.EndDate) r.endDate = iso(cr.EndDate);
      const tags = tagsOf(cr);
      if (tags.length) r.tags = tags;
      out.push(r);
    }
    token = res.NextToken;
  } while (token);
  return out;
}

/** Most-available first, then type, region, AZ, ID — deterministic (Go sortCapacityReservations, #217). */
export function sortCapacityReservations(rs: readonly CapacityReservationResult[]): CapacityReservationResult[] {
  return [...rs].sort(
    (a, b) =>
      b.availableCapacity - a.availableCapacity ||
      cmp(a.instanceType, b.instanceType) ||
      cmp(a.region, b.region) ||
      cmp(a.availabilityZone, b.availabilityZone) ||
      cmp(a.reservationId, b.reservationId),
  );
}

/** Keep GPU/ML families only (`--gpu-only`; Go filterGPUInstances). */
export function filterGPUReservations<T extends { instanceType: string }>(rs: readonly T[]): T[] {
  return rs.filter((r) => isGPUFamily(extractFamily(r.instanceType)));
}

/** The numbers Go's `capacity` summary prints (Go printCapacitySummary). */
export interface CapacitySummary {
  totalReservations: number;
  activeReservations: number;
  instanceTypes: number;
  regions: number;
  availabilityZones: number;
  totalCapacity: number;
  availableCapacity: number;
  usedCapacity: number;
  /** used / total × 100; 0 with no capacity. */
  utilizationPercent: number;
}

export function summarizeCapacity(rs: readonly CapacityReservationResult[]): CapacitySummary {
  const total = rs.reduce((n, r) => n + r.totalCapacity, 0);
  const used = rs.reduce((n, r) => n + r.usedCapacity, 0);
  return {
    totalReservations: rs.length,
    activeReservations: rs.filter((r) => r.state === "active").length,
    instanceTypes: new Set(rs.map((r) => r.instanceType)).size,
    regions: new Set(rs.map((r) => r.region)).size,
    availabilityZones: new Set(rs.map((r) => r.availabilityZone)).size,
    totalCapacity: total,
    availableCapacity: rs.reduce((n, r) => n + r.availableCapacity, 0),
    usedCapacity: used,
    utilizationPercent: total > 0 ? (used / total) * 100 : 0,
  };
}

// ── Capacity Blocks you own (`truffle capacity --blocks`) ─────────────────────

/** An owned Capacity Block for ML (Go CapacityBlockResult). */
export interface CapacityBlockResult {
  capacityBlockId: string;
  instanceType: string;
  instanceCount: number;
  availabilityZone: string;
  region: string;
  startDate: string;
  endDate: string;
  durationHours: number;
  state: string;
  /** Capacity Blocks are always placed in UltraClusters. */
  ultraClusterPlacement: true;
  tags?: string[];
}

/** Go CapacityBlockOptions. */
export interface CapacityBlockOptions {
  instanceTypes?: string[];
  minDurationHours?: number;
  maxDurationHours?: number;
  /** Only `active` / `scheduled` blocks. */
  onlyActive?: boolean;
}

/**
 * Owned blocks in one region: capacity reservations with
 * `capacity-reservation-type=capacity-block`. Ports Go getRegionCapacityBlocks.
 */
export async function fetchCapacityBlocks(
  client: EC2Client,
  region: string,
  opts: CapacityBlockOptions = {},
): Promise<CapacityBlockResult[]> {
  const filters: Filter[] = [];
  if (opts.instanceTypes?.length) filters.push({ Name: "instance-type", Values: opts.instanceTypes });
  filters.push({ Name: "capacity-reservation-type", Values: ["capacity-block"] });
  if (opts.onlyActive) filters.push({ Name: "state", Values: ["active", "scheduled"] });
  const out: CapacityBlockResult[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new DescribeCapacityReservationsCommand({ Filters: filters, NextToken: token }));
    for (const cr of res.CapacityReservations ?? []) {
      let durationHours = 0;
      if (cr.EndDate && cr.StartDate) {
        durationHours = Math.trunc((new Date(cr.EndDate).getTime() - new Date(cr.StartDate).getTime()) / 3_600_000);
      }
      if (opts.minDurationHours && opts.minDurationHours > 0 && durationHours < opts.minDurationHours) continue;
      if (opts.maxDurationHours && opts.maxDurationHours > 0 && durationHours > opts.maxDurationHours) continue;
      const r: CapacityBlockResult = {
        capacityBlockId: cr.CapacityReservationId ?? "",
        instanceType: cr.InstanceType ?? "",
        instanceCount: cr.TotalInstanceCount ?? 0,
        availabilityZone: cr.AvailabilityZone ?? "",
        region,
        startDate: iso(cr.StartDate),
        endDate: iso(cr.EndDate),
        durationHours,
        state: String(cr.State ?? ""),
        ultraClusterPlacement: true,
      };
      const tags = tagsOf(cr);
      if (tags.length) r.tags = tags;
      out.push(r);
    }
    token = res.NextToken;
  } while (token);
  return out;
}

/** Soonest first, then type, AZ, ID (Go sortCapacityBlocks, #217). */
export function sortCapacityBlocks(rs: readonly CapacityBlockResult[]): CapacityBlockResult[] {
  return [...rs].sort(
    (a, b) =>
      cmp(a.startDate, b.startDate) ||
      cmp(a.instanceType, b.instanceType) ||
      cmp(a.availabilityZone, b.availabilityZone) ||
      cmp(a.capacityBlockId, b.capacityBlockId),
  );
}

// ── Purchasable Capacity Block offerings (`truffle capacity-blocks`) ──────────

/** A purchasable offering (Go CapacityBlockOfferingResult). */
export interface CapacityBlockOfferingResult {
  /** What `spawn capacity-block purchase` reserves. */
  offeringId: string;
  instanceType: string;
  instanceCount: number;
  availabilityZone: string;
  region: string;
  startDate: string;
  endDate: string;
  durationHours: number;
  /** Total up-front price, as AWS's string. */
  upfrontFee: string;
  currencyCode: string;
  tenancy?: string;
}

/** Go CapacityBlockOfferingOptions. */
export interface CapacityBlockOfferingOptions {
  instanceType: string;
  /** Defaults to 1. A larger count silently gates offerings (#109). */
  instanceCount?: number;
  /** Required by AWS. Normalise with roundCapacityBlockDuration first. */
  durationHours: number;
  /** Earliest block START (ISO-8601) → StartDateRange. */
  startAfter?: string;
  /** Latest block END (ISO-8601) → EndDateRange — not "starts before". */
  endBy?: string;
}

/** The AWS message for an instance type that is not a Capacity Block type. */
const INELIGIBLE = "not supported for Capacity Blocks";

/**
 * Whether an error means the type is not a Capacity Block type at all — a
 * definitive answer, not a failed query (Go isCapacityBlockIneligible, #110).
 */
export function isCapacityBlockIneligible(e: unknown): boolean {
  const name = (e as { name?: string; Code?: string })?.name ?? (e as { Code?: string })?.Code;
  const msg = (e as { message?: string })?.message ?? "";
  return name === "InvalidParameterValue" && msg.includes(INELIGIBLE);
}

/** The error-message prefix when every region says "not eligible" (Go ErrCapacityBlockIneligible). */
export const CAPACITY_BLOCK_INELIGIBLE = "instance type not eligible for Capacity Blocks";

/** Offerings in one region. Ports Go getRegionCapacityBlockOfferings. */
export async function fetchCapacityBlockOfferings(
  client: EC2Client,
  region: string,
  opts: CapacityBlockOfferingOptions,
): Promise<CapacityBlockOfferingResult[]> {
  const count = opts.instanceCount && opts.instanceCount > 0 ? opts.instanceCount : 1;
  const parse = (s?: string) => {
    if (!s) return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const out: CapacityBlockOfferingResult[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new DescribeCapacityBlockOfferingsCommand({
        CapacityDurationHours: opts.durationHours,
        InstanceType: opts.instanceType,
        InstanceCount: count,
        StartDateRange: parse(opts.startAfter),
        EndDateRange: parse(opts.endBy),
        NextToken: token,
      }),
    );
    for (const o of res.CapacityBlockOfferings ?? []) {
      const r: CapacityBlockOfferingResult = {
        offeringId: o.CapacityBlockOfferingId ?? "",
        instanceType: o.InstanceType ?? "",
        instanceCount: o.InstanceCount ?? 0,
        availabilityZone: o.AvailabilityZone ?? "",
        region,
        startDate: iso(o.StartDate),
        endDate: iso(o.EndDate),
        durationHours: o.CapacityBlockDurationHours ?? 0,
        upfrontFee: o.UpfrontFee ?? "",
        currencyCode: o.CurrencyCode ?? "",
      };
      if (o.Tenancy) r.tenancy = String(o.Tenancy);
      out.push(r);
    }
    token = res.NextToken;
  } while (token);
  return out;
}

/** The AWS ceiling for a CB-for-ML reservation: 182 days. */
export const MAX_CAPACITY_BLOCK_HOURS = 182 * 24;

/**
 * Round an hour count UP to a valid CB-for-ML duration: 1-day steps to 14
 * days, then 7-day steps to 182. Throws for a non-positive or over-182-day
 * value. Ports Go roundCapacityBlockDuration (#69).
 */
export function roundCapacityBlockDuration(hours: number): number {
  if (!(hours > 0)) throw new Error("duration must be positive");
  if (hours > MAX_CAPACITY_BLOCK_HOURS) {
    throw new Error(`duration ${hours}h exceeds the Capacity Block maximum of 182 days (${MAX_CAPACITY_BLOCK_HOURS}h)`);
  }
  const day = 24;
  const week = 7 * day;
  const fourteen = 14 * day;
  if (hours <= fourteen) return Math.ceil(hours / day) * day;
  return fourteen + Math.ceil((hours - fourteen) / week) * week;
}

/** 48 → "2 days", 504 → "3 weeks" (Go humanizeHours). */
export function humanizeHours(hours: number): string {
  if (hours % (7 * 24) === 0) {
    const w = hours / (7 * 24);
    return w === 1 ? "1 week" : `${w} weeks`;
  }
  const d = Math.trunc(hours / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

/** An up-front fee as a number; unparseable → +Infinity so it sorts last (Go parseFee). */
export function parseFee(s: string): number {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Infinity;
  return Number(t);
}

/**
 * Order offerings. "price" (default): cheapest first, then start, then ID.
 * "start": soonest first, then fee, then ID. Ports Go sortOfferings.
 */
export function sortOfferings(
  rs: readonly CapacityBlockOfferingResult[],
  by: "price" | "start" = "price",
): CapacityBlockOfferingResult[] {
  const fee = (r: CapacityBlockOfferingResult) => parseFee(r.upfrontFee);
  const byFee = (a: CapacityBlockOfferingResult, b: CapacityBlockOfferingResult) => {
    const fa = fee(a);
    const fb = fee(b);
    return fa === fb ? 0 : fa < fb ? -1 : 1;
  };
  return [...rs].sort((a, b) =>
    by === "start"
      ? cmp(a.startDate, b.startDate) || byFee(a, b) || cmp(a.offeringId, b.offeringId)
      : byFee(a, b) || cmp(a.startDate, b.startDate) || cmp(a.offeringId, b.offeringId),
  );
}

/**
 * The default search window: from `now` to the soonest a block of that
 * duration could end, plus a 1-day cushion (all blocks end 11:30 UTC). With a
 * `startDate` (YYYY-MM-DD, UTC) the window is that day to day + duration + 1d.
 * Explicit `startAfter` / `endBy` win. Ports the window logic in Go
 * runCapacityBlocksOfferings (#69).
 */
export function offeringWindow(
  durationHours: number,
  opts: { startDate?: string; startAfter?: string; endBy?: string; now?: Date } = {},
): { startAfter: string; endBy: string } {
  const span = (durationHours + 24) * 3_600_000;
  let { startAfter, endBy } = opts;
  if (opts.startDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.startDate)) {
      throw new Error(`startDate must be YYYY-MM-DD (got "${opts.startDate}")`);
    }
    const day = new Date(`${opts.startDate}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) throw new Error(`startDate must be YYYY-MM-DD (got "${opts.startDate}")`);
    startAfter ??= iso(day);
    endBy ??= iso(new Date(day.getTime() + span));
  }
  const now = opts.now ?? new Date();
  startAfter ??= iso(now);
  endBy ??= iso(new Date(now.getTime() + span));
  return { startAfter, endBy };
}

/**
 * Why an offering list is empty, naming the instance COUNT first — the count
 * silently gates offerings, so "none for 8" often means "not 8 at once", not
 * "none" (verified 2026-07-27, #109). Regions are named when there are at most
 * three. Ports Go noOfferingsMessage; Go's `--count 1` is a CLI flag, so the
 * retry is stated as a count.
 */
export function noOfferingsMessage(
  instanceType: string,
  count: number,
  durationHours: number,
  regions: readonly string[],
): string {
  let where = "any enabled region";
  if (regions.length > 0 && regions.length <= 3) where = regions.join(", ");
  else if (regions.length > 3) where = `${regions.length} regions`;
  let msg = `No capacity block offerings for ${count} × ${instanceType} in ${where} (${durationHours}h).\n`;
  if (count > 1) msg += "Offerings can exist for smaller counts — retry with a count of 1 to check.\n";
  return msg;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
