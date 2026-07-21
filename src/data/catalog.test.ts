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

  it("flags carried-over (non-live) types with estimatedPrice", () => {
    // Legacy/brand-new GPU families not offered in the generated region are
    // carried from the seed and marked, so they're clearly not live data.
    const p3 = catalog.find((it) => it.instanceType === "p3.2xlarge");
    if (p3) expect(p3.estimatedPrice).toBe(true);
    // Live types never carry the flag.
    expect(catalog.find((it) => it.instanceType === "c7g.2xlarge")!.estimatedPrice).toBeUndefined();
  });
});

describe("pricing", () => {
  it("uses the exact table when present", () => {
    expect(onDemandPrice("m7i.large")).toBe(EC2Pricing["m7i.large"]);
    expect(onDemandPrice("p5.48xlarge")).toBe(98.32);
  });

  it("estimates by family × size when not in the table", () => {
    // c7i base (large) 0.0893 × 8 (4xlarge) — c7i.4xlarge IS in table, so pick an
    // untabled size to exercise the estimator.
    expect(estimatePriceByFamily("c7i.8xlarge")).toBeCloseTo(0.0893 * 16, 4);
    // Unknown family → 0.10 base.
    expect(estimatePriceByFamily("zzz.large")).toBeCloseTo(0.1, 4);
    // Malformed → 0.10.
    expect(estimatePriceByFamily("nodot")).toBe(0.1);
  });
});
