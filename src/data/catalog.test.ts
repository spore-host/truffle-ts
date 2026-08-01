import { describe, it, expect } from "vitest";
import { loadBundledCatalog } from "./catalog.js";
import { onDemandPrice, estimatePriceByFamily, EC2Pricing } from "./pricing.js";
import { GPUDatabase } from "../metadata/index.js";
import { extractFamily } from "../core/filter.js";

const catalog = loadBundledCatalog();
const types = new Set(catalog.map((it) => it.instanceType));

describe("bundled catalog integrity", () => {
  it("is non-trivial and well-formed", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(50);
    for (const it of catalog) {
      // family.size — size may carry a hyphen for metal variants (e.g.
      // "c7a.metal-48xl", "mac2.metal") seen in real AWS data.
      expect(it.instanceType).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
      expect(it.instanceFamily).toBe(extractFamily(it.instanceType));
      expect(it.vcpus).toBeGreaterThan(0);
      expect(it.memoryMib).toBeGreaterThan(0);
      expect(["x86_64", "arm64"]).toContain(it.architecture);
    }
  });

  it("has no duplicate instance types", () => {
    expect(types.size).toBe(catalog.length);
  });

  // The drift-invariant test: every exact GPU instance type the metadata claims
  // must exist in the catalog, so GPU queries never resolve to a missing type.
  it("contains every GPUDatabase.instanceTypes entry", () => {
    const missing: string[] = [];
    for (const gpu of Object.values(GPUDatabase)) {
      for (const it of gpu.instanceTypes ?? []) {
        if (!types.has(it)) missing.push(`${gpu.name}: ${it}`);
      }
    }
    expect(missing, `missing from catalog: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives GPU instances GPU metadata and a positive price", () => {
    const p5 = catalog.find((it) => it.instanceType === "p5.48xlarge")!;
    expect(p5.gpus).toBe(8);
    expect(p5.gpuModel).toBe("H100");
    expect(p5.onDemandPrice).toBeGreaterThan(0);
  });

  it("carries real specs from the live pull (physical cores populated)", () => {
    // Live DescribeInstanceTypes fills physicalCores; the old hand seed derived
    // it. A Graviton (1 thread/core) and an x86 (2/core) sanity-check the source.
    const c7g = catalog.find((it) => it.instanceType === "c7g.2xlarge")!;
    expect(c7g.physicalCores).toBe(8);
    expect(c7g.threadsPerCore).toBe(1);
    const t4gMicro = catalog.find((it) => it.instanceType === "t4g.micro")!;
    expect(t4gMicro.memoryMib).toBe(1024); // real: 1 GiB (the seed guessed 0.5)
  });

  it("flags types with no real price as estimatedPrice, and gives them no number", () => {
    // p5e/p6e-gb200 have no on-demand price row at all (Capacity Block only), so
    // the flag marks the ENTRY as non-live and the price is ABSENT rather than
    // guessed. Carrying a family-estimated number here is #39.
    for (const t of ["p5e.48xlarge", "p6e-gb200.36xlarge"]) {
      const e = catalog.find((it) => it.instanceType === t);
      if (!e) continue;
      expect(e.estimatedPrice, t).toBe(true);
      expect(e.onDemandPrice, `${t} must have no price, not a guessed one`).toBeUndefined();
    }
    // A type with a real pulled price doesn't carry the flag, even a legacy one
    // not offered in the generated region: the specs are carried, the price is
    // real, and flagging it would misreport the price's provenance.
    expect(catalog.find((it) => it.instanceType === "p3.2xlarge")!.estimatedPrice).toBeUndefined();
    expect(catalog.find((it) => it.instanceType === "c7g.2xlarge")!.estimatedPrice).toBeUndefined();
  });

  // ── #42: no zero prices, ever ────────────────────────────────────────────────
  // p5.4xlarge shipped as onDemandPrice: 0 — a 1×H100 machine the catalog claimed
  // was free. The cause was NOT missing data: that type has two Price List rows,
  // and gen-catalog's `--max-results 1` took the CapacityBlock row ($0.00/hr,
  // correct in its own context) instead of the OnDemand row ($6.88). A zero is the
  // most damaging possible wrong price because zero sorts FIRST, so any
  // cheapest-first UI recommends the instance it has the worst data for.
  it("never carries a non-positive price", () => {
    const bad = catalog.filter((it) => it.onDemandPrice != null && !(it.onDemandPrice > 0));
    expect(
      bad.map((it) => `${it.instanceType}=${it.onDemandPrice}`),
      "no EC2 type costs nothing per hour — omit the field instead of writing 0",
    ).toEqual([]);
  });

  it("prices p5.4xlarge from its OnDemand row, not its CapacityBlock row", () => {
    const p5 = catalog.find((it) => it.instanceType === "p5.4xlarge");
    if (!p5) return;
    expect(p5.onDemandPrice).toBe(6.88);
  });

  // ── #39: an accelerator is never absurdly cheap ──────────────────────────────
  // p6e-gb200.36xlarge shipped at $0.2000/hr — estimatePriceByFamily's unknown-
  // family fallback ($0.10 × 2.0) applied to a 72×B200 rack that really costs
  // ~$100/hr. It then won `cheapest 64gb`, ranking the most expensive machine in
  // the catalog as the budget pick. A per-vCPU floor can't catch this (t4g.nano is
  // legitimately $0.0021/vCPU vs the bad B200's $0.00139), so the assertion is
  // per-GPU: no real accelerator is under $0.05 per GPU-hour.
  it("gives every priced GPU instance a plausible per-GPU price", () => {
    const absurd = catalog
      .filter((it) => it.gpus && it.gpus > 0 && it.onDemandPrice != null)
      .filter((it) => it.onDemandPrice! / it.gpus! < 0.05)
      .map((it) => `${it.instanceType}=$${it.onDemandPrice}/${it.gpus}gpu`);
    expect(absurd, "a GPU-hour under 5c is a fabricated price, not a bargain").toEqual([]);
  });
});

describe("pricing", () => {
  it("uses the exact table when present", () => {
    expect(onDemandPrice("m7i.large")).toBe(EC2Pricing["m7i.large"]);
    // 55.04, corrected from 98.32 against the live Price List API (2026-08-01).
    expect(onDemandPrice("p5.48xlarge")).toBe(55.04);
  });

  it("estimates by family × size when not in the table", () => {
    // c7i base (large) 0.0893 × 8 (4xlarge) — c7i.4xlarge IS in table, so pick an
    // untabled size to exercise the estimator.
    expect(estimatePriceByFamily("c7i.8xlarge")).toBeCloseTo(0.0893 * 16, 4);
    // Unknown CPU family → 0.10 base. Being wrong here costs cents.
    expect(estimatePriceByFamily("zzz.large")).toBeCloseTo(0.1, 4);
    // Malformed → 0.10.
    expect(estimatePriceByFamily("nodot")).toBe(0.1);
  });

  it("refuses to estimate an accelerator family it has no base price for", () => {
    // The mechanism behind #39. The family × size heuristic is fine for a CPU box,
    // where price tracks size within a generation, and worthless for a GPU box,
    // where the accelerator dominates and the multiplier knows nothing about it.
    // Returning undefined makes "we don't know" expressible; the old $0.20 was
    // indistinguishable in form from a real price.
    expect(estimatePriceByFamily("p6e-gb200.36xlarge")).toBeUndefined();
    expect(estimatePriceByFamily("p9.99xlarge")).toBeUndefined(); // a future family
    expect(onDemandPrice("p6e-gb200.36xlarge")).toBeUndefined();
    // Families WITH a real base price still estimate.
    expect(estimatePriceByFamily("g5.16xlarge")).toBeCloseTo(0.503 * 32, 4);
    // And a table hit always wins, accelerator or not.
    expect(onDemandPrice("p5.4xlarge")).toBe(6.88);
  });

  it("agrees with the bundled catalog wherever both have a price", () => {
    // Two static tables in one package WILL drift — this is #39's third defect,
    // where p4d/p5 disagreed by 1.5-1.8x and the answer to "what does a
    // p5.48xlarge cost" depended on whether you called find() or onDemandPrice().
    const byType = new Map(catalog.map((it) => [it.instanceType, it]));
    const off: string[] = [];
    for (const [type, tablePrice] of Object.entries(EC2Pricing)) {
      const entry = byType.get(type);
      if (!entry?.onDemandPrice) continue;
      const ratio = entry.onDemandPrice / tablePrice;
      if (ratio < 0.9 || ratio > 1.1) {
        off.push(`${type}: catalog=${entry.onDemandPrice} table=${tablePrice} (${ratio.toFixed(2)}x)`);
      }
    }
    expect(off, "pricing.ts and instances.json disagree — pick one source of truth").toEqual([]);
  });
});
