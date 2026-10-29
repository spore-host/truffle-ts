// Pure derivations about instance data that Go truffle computes inside its
// terminal printer (pkg/output/printer.go) and command files (cmd/*.go), pulled
// out so a browser consumer gets the same answer the CLI prints (#34). Each one
// is a judgement about the data, not presentation: which rows go first, what a
// GPU's memory "is", whether a family is an accelerator family. Colour, column
// widths and the table/CSV writers are deliberately NOT here — a browser renders
// its own DOM.
//
// Go references are given per function. No DOM, no AWS, no I/O.

import type { FilterOptions, InstanceType } from "./types.js";
import type { SortPreference } from "./parser.js";

// ── GPU memory "as sold" (Go pkg/aws/accelerator_memory.go, #236/#240/#242/#244) ──

/** Units of a nominal GPU memory size. */
export type MemoryUnit = "GiB" | "GB";

/**
 * Per-GPU MiB a model reports where the generic reading lands off the size AWS
 * documents it as, keyed by that exact MiB (Go nominalGBOverride, #242).
 */
const NOMINAL_GB_OVERRIDE: Record<number, number> = {
  183359: 179, // NVIDIA B200, p6-b200 (EC2 reads 179.06 GiB)
  275040: 268, // NVIDIA B300, p6-b300 (EC2 reads 268.59 GiB)
};

/**
 * The size a device's reported memory is SOLD as, and its unit. EC2 reports
 * some GPUs in binary units (H100 81920 MiB = 80 GiB) and others as a decimal
 * size converted to MiB (A10G / L4 22888 MiB = 24 GB, L40S 45776 MiB = 48 GB),
 * so: a whole number of GiB (within 0.5%) reads as GiB; a whole number of
 * thousands of MiB reads as that many GB (dl2q's AI100, 16000 MiB = 16 GB);
 * anything else as decimal GB to 0.1. Ports Go nominalGPUMemory.
 * `undefined` when `mib` is not positive.
 */
export function nominalGpuMemory(mib: number): { size: number; unit: MemoryUnit } | undefined {
  if (!(mib > 0)) return undefined;
  const override = NOMINAL_GB_OVERRIDE[mib];
  if (override !== undefined) return { size: override, unit: "GiB" };
  const gib = mib / 1024;
  const r = Math.round(gib);
  if (r > 0 && Math.abs(gib - r) / r <= 0.005) return { size: gib, unit: "GiB" };
  if (mib % 1000 === 0) return { size: mib / 1000, unit: "GB" };
  return { size: Math.round((mib * 2 ** 20) / 1e8) / 10, unit: "GB" };
}

/** The nominal size alone (Go NominalGPUMemoryGB); 0 when unknown. */
export function nominalGpuMemoryGB(mib: number): number {
  return nominalGpuMemory(mib)?.size ?? 0;
}

/** A memory size to at most one decimal, never "24.0" (Go FormatSize). */
export function formatSize(size: number): string {
  return String(Math.round(size * 10) / 10);
}

/** "80 GiB", "24 GB", "179 GiB"; "" when unknown (Go FormatGPUMemory). */
export function formatGpuMemory(mib: number): string {
  const n = nominalGpuMemory(mib);
  return n ? `${formatSize(n.size)} ${n.unit}` : "";
}

/** Absorbs rounding in the nominal size; far below the gap between GPU sizes. */
const GPU_MEMORY_TOLERANCE = 0.05;

/**
 * Whether a device of `mib` MiB satisfies a per-GPU memory request of `wantGB`,
 * compared as sold: `gpu 24gb` matches the 22888 MiB A10G and L4, which a plain
 * GiB comparison (22.35) would miss. `exact` = within half a GB. Ports Go
 * MatchesGPUMemory.
 */
export function matchesGpuMemory(mib: number, wantGB: number, exact = false): boolean {
  const got = nominalGpuMemoryGB(mib);
  if (got === 0) return false;
  if (exact) return Math.abs(got - wantGB) < 0.5;
  return got >= wantGB - GPU_MEMORY_TOLERANCE;
}

/** Memory of ONE GPU in MiB (`gpuMemoryMib` is the aggregate); 0 when unknown. */
export function perGpuMemoryMib(it: InstanceType): number {
  const gpus = it.gpus ?? 0;
  if (gpus < 1 || !it.gpuMemoryMib) return 0;
  return Math.round(it.gpuMemoryMib / gpus);
}

// ── Ranking (Go cmd/find.go sortFindResults / fitDistance / minimumSpecHint, #187) ──

/**
 * How far an instance overshoots the requested minimums. Each specified
 * dimension (vCPU, memory, physical cores, per-GPU memory as sold) adds
 * |log2(actual/requested)|, so an exact match is 0 and doubling any one
 * dimension costs the same 1.0. Unspecified dimensions add nothing. Ports Go
 * fitDistance.
 */
export function fitDistance(it: InstanceType, f: FilterOptions): number {
  let d = 0;
  const add = (actual: number, want: number | undefined) => {
    if (want && want > 0 && actual > 0) d += Math.abs(Math.log2(actual / want));
  };
  add(it.vcpus, f.minVcpus);
  add(it.memoryMib / 1024, f.minMemoryGiB);
  add(it.physicalCores ?? 0, f.minPhysicalCores);
  add(nominalGpuMemoryGB(perGpuMemoryMib(it)), f.minGpuMemoryGiB);
  return d;
}

/** Whether the query constrained vCPU, memory, cores or per-GPU memory (Go hasSizeSpec). */
export function hasSizeSpec(f: FilterOptions): boolean {
  return (f.minVcpus ?? 0) > 0 || (f.minMemoryGiB ?? 0) > 0 || (f.minPhysicalCores ?? 0) > 0 || (f.minGpuMemoryGiB ?? 0) > 0;
}

/** Generation number of an instance type — the first run of digits. Ports instanceGeneration. */
export function instanceGeneration(instanceType: string): number {
  const m = instanceType.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

/**
 * A price's rank key: tier 0 = a real price, 1 = an estimate, 2 = none (#39).
 * An estimate must never win a price-ranked query, and an unknown price (or a
 * 0, which is never real) always sorts last.
 */
function priceTier(it: InstanceType): 0 | 1 | 2 {
  const p = it.onDemandPrice;
  if (p == null || !(p > 0)) return 2;
  return it.estimatedPrice === true ? 1 : 0;
}

interface PriceKey {
  tier: 0 | 1 | 2;
  value: number;
}

/** Ascending (or descending) by price within tier; tier always ascending. */
function cmpPriceKey(a: PriceKey, b: PriceKey, desc: boolean): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.tier === 2 || a.value === b.value) return 0;
  return desc ? b.value - a.value : a.value - b.value;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Order find results. Rows of one instance type stay together (types are
 * ranked as a unit, whatever their region), and inside a type rows go cheapest
 * region first (dearest first for "expensive"), unknown prices last, then by
 * region name.
 *
 * Between types: with size terms, closest fit first, then cheapest, then newest
 * generation; with none, newest generation first, then cheapest. "cheapest" /
 * "expensive" / "performant" / "newest" override the primary key. Ports Go
 * sortFindResults (truffle#187), with truffle-ts's #39 rule kept: a real price
 * outranks an estimate, which outranks no price, whatever the magnitudes.
 */
export function sortFindResults(
  results: readonly InstanceType[],
  f: FilterOptions,
  pref: SortPreference,
): InstanceType[] {
  interface TypeKey {
    fit: number;
    gen: number;
    vcpus: number;
    min: PriceKey;
    max: PriceKey;
  }
  const keys = new Map<string, TypeKey>();
  for (const r of results) {
    let k = keys.get(r.instanceType);
    if (!k) {
      k = {
        fit: fitDistance(r, f),
        gen: instanceGeneration(r.instanceType),
        vcpus: r.vcpus,
        min: { tier: 2, value: 0 },
        max: { tier: 2, value: 0 },
      };
      keys.set(r.instanceType, k);
    }
    const t = priceTier(r);
    if (t < 2) {
      const p = r.onDemandPrice!;
      if (t < k.min.tier || (t === k.min.tier && p < k.min.value)) k.min = { tier: t, value: p };
      if (t < k.max.tier || (t === k.max.tier && p > k.max.value)) k.max = { tier: t, value: p };
    }
  }

  const EPS = 1e-9;
  const cmpFit = (a: TypeKey, b: TypeKey) => (a.fit < b.fit - EPS ? -1 : a.fit > b.fit + EPS ? 1 : 0);
  const cmpGen = (a: TypeKey, b: TypeKey) => b.gen - a.gen;
  const sizeSpec = hasSizeSpec(f);

  const out = [...results];
  out.sort((ri, rj) => {
    if (ri.instanceType !== rj.instanceType) {
      const a = keys.get(ri.instanceType)!;
      const b = keys.get(rj.instanceType)!;
      let order: number[];
      switch (pref) {
        case "cheapest":
          order = [cmpPriceKey(a.min, b.min, false), cmpFit(a, b), cmpGen(a, b)];
          break;
        case "expensive":
          order = [cmpPriceKey(a.max, b.max, true), cmpFit(a, b), cmpGen(a, b)];
          break;
        case "performant":
          order = [b.vcpus - a.vcpus, cmpPriceKey(a.min, b.min, false), cmpGen(a, b)];
          break;
        case "newest":
          order = [cmpGen(a, b), cmpFit(a, b), cmpPriceKey(a.min, b.min, false)];
          break;
        default:
          order = sizeSpec
            ? [cmpFit(a, b), cmpPriceKey(a.min, b.min, false), cmpGen(a, b)]
            : [cmpGen(a, b), cmpPriceKey(a.min, b.min, false)];
      }
      for (const c of order) if (c !== 0) return c;
      return cmpStr(ri.instanceType, rj.instanceType);
    }
    const c = cmpPriceKey(
      { tier: priceTier(ri), value: ri.onDemandPrice ?? 0 },
      { tier: priceTier(rj), value: rj.onDemandPrice ?? 0 },
      pref === "expensive",
    );
    if (c !== 0) return c;
    return cmpStr(ri.region ?? "", rj.region ?? "");
  });
  return out;
}

/**
 * The one-line note explaining that size terms are minimums, e.g. "Showing 28
 * types with ≥16 vCPU and ≥64 GiB memory, closest fit first; use --exact for an
 * exact match". Empty with no size terms or with exact matching. Ports Go
 * minimumSpecHint verbatim, `--exact` included: it names the CLI flag, and a
 * library caller's equivalent is an exact query ("exactly 16 cores").
 */
export function minimumSpecHint(results: readonly InstanceType[], f: FilterOptions, pref: SortPreference): string {
  if (!hasSizeSpec(f) || f.exactVcpus || f.exactMemory || f.exactCores) return "";
  const types = new Set(results.map((r) => r.instanceType)).size;
  const terms: string[] = [];
  if ((f.minVcpus ?? 0) > 0) terms.push(`≥${f.minVcpus} vCPU`);
  if ((f.minPhysicalCores ?? 0) > 0) terms.push(`≥${f.minPhysicalCores} physical cores`);
  if ((f.minMemoryGiB ?? 0) > 0) terms.push(`≥${f.minMemoryGiB} GiB memory`);
  if ((f.minGpuMemoryGiB ?? 0) > 0) terms.push(`≥${f.minGpuMemoryGiB} GB/GiB per GPU`);
  const order = pref === "default" ? ", closest fit first" : "";
  return `Showing ${types} ${types === 1 ? "type" : "types"} with ${terms.join(" and ")}${order}; use --exact for an exact match`;
}

/**
 * Keep the rows whose instance type is among the first `n` distinct types, in
 * order, so every region row of a kept type stays together; `n <= 0` keeps all.
 * Returns the kept rows and the number of distinct types before the cut. Ports
 * Go limitByKey (`--limit`, #250).
 */
export function limitTypes<T extends { instanceType: string }>(
  items: readonly T[],
  n: number,
): { kept: T[]; totalTypes: number } {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const it of items) if (!seen.has(it.instanceType)) (seen.add(it.instanceType), order.push(it.instanceType));
  if (n <= 0 || order.length <= n) return { kept: [...items], totalTypes: order.length };
  const allow = new Set(order.slice(0, n));
  return { kept: items.filter((it) => allow.has(it.instanceType)), totalTypes: order.length };
}

/** "Listed the first 3 of 28 types" when a limit cut something; "" otherwise (Go writeLimitNote). */
export function limitNote(shown: number, total: number, noun = "types"): string {
  return shown >= total ? "" : `Listed the first ${shown} of ${total} ${noun}`;
}

// ── Families and zones ────────────────────────────────────────────────────────

/**
 * Family PREFIXES counted as GPU/ML for `capacity --gpu-only` (Go
 * gpuFamilyPrefixes, cmd/capacity.go). Prefix match, so p4 covers p4d/p4de and
 * trn1 covers trn1n (truffle#8).
 */
export const GPU_FAMILY_PREFIXES: readonly string[] = [
  "p3", "p4", "p5", "g4", "g5", "g6", "inf1", "inf2", "trn1", "trn2", "vt1",
];

/** Whether a family is a GPU/ML family by prefix (Go isGPUFamily). */
export function isGPUFamily(family: string): boolean {
  return GPU_FAMILY_PREFIXES.some((p) => family.startsWith(p));
}

/**
 * Zone order: a region's standard AZs first (us-west-2a, …), then its Local and
 * Wavelength Zones (us-west-2-lax-1a, …), each alphabetically — fewer hyphens
 * first. A plain sort would lead with an edge zone. Ports Go zoneNameLess (#217).
 */
export function compareZoneNames(a: string, b: string): number {
  const ha = a.split("-").length;
  const hb = b.split("-").length;
  return ha !== hb ? ha - hb : cmpStr(a, b);
}

/** A new array in zone order (Go SortZoneNames). */
export function sortZoneNames(zones: readonly string[]): string[] {
  return [...zones].sort(compareZoneNames);
}

/** Whether `zones` is already in zone order (Go ZoneNamesSorted). */
export function zoneNamesSorted(zones: readonly string[]): boolean {
  for (let i = 1; i < zones.length; i++) if (compareZoneNames(zones[i - 1], zones[i]) > 0) return false;
  return true;
}

/** Distinct values, sorted (Go uniqueSorted). */
export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(cmpStr);
}

/** How many distinct regions a result set spans (Go countUniqueRegions). */
export function countUniqueRegions(results: readonly { region?: string }[]): number {
  return new Set(results.map((r) => r.region ?? "")).size;
}

// ── Prices ────────────────────────────────────────────────────────────────────

/** The unit a price is displayed per (`--price-unit`, #138). */
export type PriceUnit = "hour" | "minute" | "second";

/** "$/hr", "$/min", "$/sec" (Go priceHeaderFor). */
export function priceHeaderFor(unit: PriceUnit = "hour"): string {
  return unit === "minute" ? "$/min" : unit === "second" ? "$/sec" : "$/hr";
}

/**
 * An hourly rate in the display unit. The rate itself always stays $/hr; this
 * is display-time only. Precision widens at finer units so a cheap type doesn't
 * round to zero ($0.01/hr is $0.0000028/sec). Ports Go formatPrice.
 */
export function formatPrice(hourlyRate: number, unit: PriceUnit = "hour"): string {
  if (unit === "minute") return `$${(hourlyRate / 60).toFixed(6)}`;
  if (unit === "second") return `$${(hourlyRate / 3600).toFixed(8)}`;
  return `$${hourlyRate.toFixed(4)}`;
}

/**
 * Spot savings vs On-Demand, in percent; undefined when either price is
 * missing or non-positive — a zero spot price would read as "100% savings",
 * which is a data artifact, not a deal.
 */
export function savingsPercent(spotPrice: number, onDemandPrice: number | undefined): number | undefined {
  if (!(onDemandPrice && onDemandPrice > 0) || !(spotPrice > 0)) return undefined;
  return (1 - spotPrice / onDemandPrice) * 100;
}

// ── Per-GPU and per-core ratios (#51, #137) ───────────────────────────────────

/**
 * vCPUs and GiB of RAM per GPU (`--show-gpu-ratios`, #51). For a CPU/IO-bound
 * ML workload this decides whether a bigger box helps: g5.4xlarge feeds its one
 * GPU 16 vCPUs, g5.12xlarge feeds each of its four only 12. Undefined with no
 * whole GPU to divide by (a fractional GPU's ratio is a number nobody asked
 * for). Ports Go gpuRatioDisplay; `ramPerGpuGiB` is undefined with no memory.
 */
export function gpuRatios(it: InstanceType): { vcpuPerGpu: number; ramPerGpuGiB?: number } | undefined {
  const n = it.gpus ?? 0;
  if (n <= 0) return undefined;
  const out: { vcpuPerGpu: number; ramPerGpuGiB?: number } = { vcpuPerGpu: it.vcpus / n };
  if (it.memoryMib > 0) out.ramPerGpuGiB = it.memoryMib / 1024 / n;
  return out;
}

/**
 * GiB of memory per PHYSICAL core (`--show-mem-per-cpu`, #137) — physical, not
 * vCPU, so Graviton (1 thread/core) and x86 (2) compare fairly. Undefined when
 * the core count is unknown.
 */
export function memPerPhysicalCoreGiB(it: InstanceType): number | undefined {
  const cores = it.physicalCores ?? 0;
  return cores > 0 ? it.memoryMib / 1024 / cores : undefined;
}

// ── Small text policies Go applies to data, classified explicitly ─────────────
// These two are presentation, not judgement. They're here because Go applies
// them to identifiers a UI also shows, and a portal that truncates differently
// from the CLI shows a different ID prefix. A DOM may ignore them.

/**
 * Truncate to `maxLen` characters with "...", preferring to break at a ", "
 * within 10 characters of the limit. Ports Go truncateWithEllipsis.
 */
export function truncateWithEllipsis(s: string, maxLen: number): string {
  const runes = [...s];
  if (runes.length <= maxLen) return s;
  const max = maxLen - 3;
  if (max > 0 && max < runes.length) {
    for (let i = max; i > max - 10 && i > 0; i--) {
      if (i < runes.length - 1 && runes[i] === "," && runes[i + 1] === " ") return runes.slice(0, i).join("") + "...";
    }
    return runes.slice(0, max).join("") + "...";
  }
  return s;
}

/** First 10 characters of a reservation ID plus "..." (Go shortenReservationID). */
export function shortenReservationID(id: string): string {
  return id.length > 10 ? id.slice(0, 10) + "..." : id;
}

/**
 * Whether spot rows carry more than one distinct timestamp — i.e. a trend, so a
 * timestamp column is worth showing (Go hasDistinctTimestamps).
 */
export function hasDistinctTimestamps(results: readonly { timestamp?: string }[]): boolean {
  if (results.length < 2) return false;
  return results.some((r) => r.timestamp !== results[0].timestamp);
}

// ── `truffle list` (Go cmd/list.go extractFamilies / extractSizes, #33) ───────

/** The distinct families of `types` ("m5.large" → "m5"), sorted. */
export function instanceFamilies(types: readonly string[]): string[] {
  return uniqueSorted(types.map((t) => t.split(".")[0]).filter(Boolean));
}

/** The distinct sizes of `types` ("m5.large" → "large"), sorted. Types without a size are skipped. */
export function instanceSizes(types: readonly string[]): string[] {
  return uniqueSorted(types.map((t) => t.split(".")[1]).filter((s): s is string => !!s));
}
