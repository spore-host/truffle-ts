import { describe, it, expect } from "vitest";
import {
  nominalGpuMemory,
  nominalGpuMemoryGB,
  formatGpuMemory,
  matchesGpuMemory,
  fitDistance,
  sortFindResults,
  minimumSpecHint,
  limitTypes,
  limitNote,
  isGPUFamily,
  sortZoneNames,
  zoneNamesSorted,
  uniqueSorted,
  formatPrice,
  priceHeaderFor,
  savingsPercent,
  gpuRatios,
  memPerPhysicalCoreGiB,
  truncateWithEllipsis,
  shortenReservationID,
  hasDistinctTimestamps,
  countUniqueRegions,
} from "./derive.js";
import { matchesFilters } from "./filter.js";
import { find } from "./find.js";
import type { InstanceType } from "./types.js";

// Go fixtures (pkg/aws/accelerator_memory_test.go).
const mibT4 = 16384;
const mibA10G = 22888;
const mibH100 = 81920;
const mibB200 = 183359;
const mibB300 = 275040;
const mibInf1 = 8192;
const mibNeuronInf = 32768;

describe("nominal GPU memory (Go accelerator_nominal_test.go)", () => {
  it("TestNominalGPUMemoryGB_AWSDocumented", () => {
    const cases: [string, number, number][] = [
      ["B200", mibB200, 1432 / 8],
      ["B300", mibB300, 2144 / 8],
      ["A10G", mibA10G, 24],
      ["L4", 22888, 24],
      ["H100", mibH100, 80],
      ["AI100 (dl2q)", 16000, 16],
      ["T4", mibT4, 16],
      ["Inferentia", mibInf1, 8],
      ["Inferentia2 / Trainium", mibNeuronInf, 32],
    ];
    for (const [name, mib, want] of cases) expect(nominalGpuMemoryGB(mib), name).toBe(want);
  });

  it("TestNominalGPUMemoryUnit", () => {
    const cases: [string, string | undefined, string, number][] = [
      ["B200", "GiB", "179 GiB", mibB200],
      ["B300", "GiB", "268 GiB", mibB300],
      ["H100", "GiB", "80 GiB", mibH100],
      ["T4", "GiB", "16 GiB", mibT4],
      ["Trainium2", "GiB", "96 GiB", 96 * 1024],
      ["A10G", "GB", "24 GB", mibA10G],
      ["L40S", "GB", "48 GB", 45776],
      ["AI100 (dl2q)", "GB", "16 GB", 16000],
      ["none", undefined, "", 0],
    ];
    for (const [name, unit, label, mib] of cases) {
      expect(nominalGpuMemory(mib)?.unit, name).toBe(unit);
      expect(formatGpuMemory(mib), name).toBe(label);
    }
  });

  it("matches as sold, with Go's tolerance and exact semantics (TestMatchesFilters_AcceleratorNominal)", () => {
    expect(matchesGpuMemory(mibB200, 179)).toBe(true);
    expect(matchesGpuMemory(mibB200, 179, true)).toBe(true);
    expect(matchesGpuMemory(mibB300, 268, true)).toBe(true);
    expect(matchesGpuMemory(mibB300, 269)).toBe(false);
    expect(matchesGpuMemory(96 * 1024, 96)).toBe(true);
    expect(matchesGpuMemory(96 * 1024, 256)).toBe(false);
    expect(matchesGpuMemory(0, 1)).toBe(false);
  });
});

// ── #236 in the filter: "gpu 24gb" keeps the A10G and L4 ─────────────────────
describe("the per-GPU memory filter compares as sold (Go #236)", () => {
  const g5: InstanceType = {
    instanceType: "g5.xlarge", instanceFamily: "g5", vcpus: 4, memoryMib: 16384,
    architecture: "x86_64", gpus: 1, gpuMemoryMib: mibA10G, gpuModel: "A10G",
  };
  it("a 22888 MiB A10G satisfies a 24 GB per-GPU minimum", () => {
    // 22888 MiB is 22.35 GiB; the old GiB comparison dropped every A10G and L4.
    expect(matchesFilters(g5, { minGpuMemoryGiB: 24 })).toBe(true);
    expect(matchesFilters(g5, { minGpuMemoryGiB: 25 })).toBe(false);
    expect(matchesFilters(g5, { minGpuMemoryGiB: 24, exactGpuMemory: true })).toBe(true);
    expect(matchesFilters(g5, { minGpuMemoryGiB: 16, exactGpuMemory: true })).toBe(false);
  });
  it("find('gpu 24gb') returns the A10G and L4 hosts, closest fit first", async () => {
    const results = await find("gpu 24gb");
    const models = new Set(results.map((r) => r.instance.gpuModel));
    expect(models.has("A10G")).toBe(true);
    expect(models.has("L4")).toBe(true);
    // Closest fit: the first row is a 24 GB part, not an 80 GiB H100.
    expect(["A10G", "L4"]).toContain(results[0].instance.gpuModel);
    expect(results[0].reasons).toContain("GPU memory: 24 GB >= 24");
  });
});

// ── #187 closest-fit ranking (Go cmd/find_sort_test.go, ported verbatim) ─────
const mk = (instanceType: string, region: string, vcpus: number, memGiB: number, price: number): InstanceType => ({
  instanceType,
  instanceFamily: instanceType.split(".")[0],
  region,
  vcpus,
  memoryMib: memGiB * 1024,
  architecture: "x86_64",
  onDemandPrice: price,
});
const turinResults = (): InstanceType[] => [
  mk("r8a.48xlarge", "us-west-2", 192, 1536, 15.337),
  mk("m8a.48xlarge", "us-west-2", 192, 768, 11.6851),
  mk("m8a.8xlarge", "us-west-2", 32, 128, 1.9475),
  mk("c8a.8xlarge", "us-west-2", 32, 64, 1.7243),
  mk("m8a.4xlarge", "us-east-1", 16, 64, 1.01),
  mk("r8a.4xlarge", "us-west-2", 16, 128, 1.2781),
  mk("m8a.4xlarge", "us-west-2", 16, 64, 0.9738),
  mk("r8a.48xlarge", "us-east-1", 192, 1536, 15.337),
];
const keys = (rs: InstanceType[]) => rs.map((r) => `${r.instanceType}@${r.region}`);

describe("sortFindResults (Go #187)", () => {
  it("TestSortFindResults_ClosestFitFirst", () => {
    expect(keys(sortFindResults(turinResults(), { minVcpus: 16, minMemoryGiB: 64 }, "default"))).toEqual([
      "m8a.4xlarge@us-west-2",
      "m8a.4xlarge@us-east-1",
      "r8a.4xlarge@us-west-2",
      "c8a.8xlarge@us-west-2",
      "m8a.8xlarge@us-west-2",
      "m8a.48xlarge@us-west-2",
      "r8a.48xlarge@us-east-1",
      "r8a.48xlarge@us-west-2",
    ]);
  });

  it("TestSortFindResults_NoSizeSpecNewestFirst", () => {
    const rs = [mk("m6a.large", "us-west-2", 2, 8, 0.08), mk("m8a.large", "us-west-2", 2, 8, 0.12)];
    expect(sortFindResults(rs, {}, "default")[0].instanceType).toBe("m8a.large");
  });

  it("TestSortFindResults_QualitativeOverrides", () => {
    const f = { minVcpus: 16, minMemoryGiB: 64 };
    expect(sortFindResults(turinResults(), f, "expensive")[0].instanceType).toBe("r8a.48xlarge");
    expect(keys(sortFindResults(turinResults(), f, "cheapest")).slice(0, 2)).toEqual([
      "m8a.4xlarge@us-west-2",
      "m8a.4xlarge@us-east-1",
    ]);
  });

  it("TestFitDistance", () => {
    const f = { minVcpus: 16, minMemoryGiB: 64 };
    const r = (vcpus: number, memGiB: number) => mk("x.large", "r", vcpus, memGiB, 1);
    expect(fitDistance(r(16, 64), f)).toBe(0);
    expect(fitDistance(r(16, 128), f)).toBe(1);
    expect(fitDistance(r(32, 64), f)).toBe(1);
    expect(fitDistance(r(192, 1536), f)).toBeGreaterThan(fitDistance(r(32, 64), f));
    expect(fitDistance(r(192, 1536), {})).toBe(0);
  });

  it("TestMinimumSpecHint", () => {
    const rs = turinResults();
    expect(minimumSpecHint(rs, { minVcpus: 16, minMemoryGiB: 64 }, "default")).toBe(
      "Showing 6 types with ≥16 vCPU and ≥64 GiB memory, closest fit first; use --exact for an exact match",
    );
    expect(minimumSpecHint(rs, { minMemoryGiB: 0.5 }, "cheapest")).toBe(
      "Showing 6 types with ≥0.5 GiB memory; use --exact for an exact match",
    );
    expect(minimumSpecHint(rs, { minVcpus: 16, exactVcpus: true }, "default")).toBe("");
    expect(minimumSpecHint(rs, {}, "default")).toBe("");
  });

  it("TestSortFindResults_TurinDemoClosestFitFirst", () => {
    const rs = [
      mk("x8aedz.6xlarge", "us-west-2", 24, 768, 6.9036),
      mk("r8a.4xlarge", "us-west-2", 16, 128, 1.2781),
      mk("m8a.4xlarge", "us-west-2", 16, 64, 0.9738),
      mk("c8a.8xlarge", "us-west-2", 32, 64, 1.7243),
      mk("m8azn.6xlarge", "us-west-2", 24, 96, 2.4775),
    ];
    const got = keys(sortFindResults(rs, { minVcpus: 16, minMemoryGiB: 64 }, "default"));
    expect(got[0]).toBe("m8a.4xlarge@us-west-2");
    expect(got[got.length - 1]).toBe("x8aedz.6xlarge@us-west-2");
  });

  it("TestSortFindResults_GPUMemoryClosestFit", () => {
    const g = (it: string, accelMiB: number, price: number): InstanceType => ({
      ...mk(it, "us-east-1", 4, 16, price),
      gpus: 1,
      gpuMemoryMib: accelMiB,
    });
    const rs = [
      g("p5.4xlarge", 81920, 6.88),
      g("g6e.xlarge", 45776, 1.861),
      g("g7.2xlarge", 32768, 2.52),
      g("g5.xlarge", 22888, 1.006),
      g("g6.xlarge", 22888, 0.8048),
    ];
    const f = { minGpuMemoryGiB: 24 };
    const sorted = sortFindResults(rs, f, "default");
    expect(keys(sorted).join(",")).toBe(
      "g6.xlarge@us-east-1,g5.xlarge@us-east-1,g7.2xlarge@us-east-1,g6e.xlarge@us-east-1,p5.4xlarge@us-east-1",
    );
    expect(fitDistance(sorted[0], f)).toBe(0);
    expect(minimumSpecHint(rs, f, "default")).toBe(
      "Showing 5 types with ≥24 GB/GiB per GPU, closest fit first; use --exact for an exact match",
    );
  });

  it("keeps truffle-ts's #39 rule: an estimate never beats a real price", () => {
    const real = mk("m7i.large", "us-east-1", 2, 8, 0.1);
    const est = { ...mk("zz9.large", "us-east-1", 2, 8, 0.01), estimatedPrice: true };
    const none = { ...mk("yy9.large", "us-east-1", 2, 8, 0), onDemandPrice: undefined };
    expect(sortFindResults([none, est, real], {}, "cheapest").map((r) => r.instanceType)).toEqual([
      "m7i.large",
      "zz9.large",
      "yy9.large",
    ]);
    expect(sortFindResults([none, est, real], {}, "expensive")[0].instanceType).toBe("m7i.large");
  });

  it("find() ranks a size query closest fit first (wired, not just exported)", async () => {
    const [top] = await find("graviton 8 cores 32gb");
    expect(top.instance.vcpus).toBe(8);
    expect(top.instance.memoryMib / 1024).toBe(32);
  });
});

describe("limitTypes (Go cmd/limit_test.go)", () => {
  const rows = [
    { instanceType: "m8a.4xlarge", region: "us-east-1" },
    { instanceType: "m8a.4xlarge", region: "us-west-2" },
    { instanceType: "c8a.4xlarge", region: "us-east-1" },
    { instanceType: "r8a.4xlarge", region: "us-east-1" },
    { instanceType: "c8a.4xlarge", region: "us-west-2" },
  ];
  it("TestLimitByKeyKeepsWholeTypesInOrder", () => {
    const { kept, totalTypes } = limitTypes(rows, 2);
    expect(totalTypes).toBe(3);
    expect(kept.map((r) => `${r.instanceType}/${r.region}`).join(" ")).toBe(
      "m8a.4xlarge/us-east-1 m8a.4xlarge/us-west-2 c8a.4xlarge/us-east-1 c8a.4xlarge/us-west-2",
    );
    for (const n of [0, -1, 3, 10]) expect(limitTypes(rows, n).kept).toHaveLength(rows.length);
  });
  it("TestWriteLimitNote", () => {
    expect(limitNote(5, 33)).toBe("Listed the first 5 of 33 types");
    expect(limitNote(33, 33)).toBe("");
  });
});

describe("isGPUFamily (Go cmd/helpers_test.go TestIsGPUFamily)", () => {
  it("prefix-matches the GPU/ML families", () => {
    for (const f of ["p3", "p4d", "p5en", "g4dn", "g5", "g6e", "inf2", "trn1n", "trn2", "vt1"]) expect(isGPUFamily(f), f).toBe(true);
    for (const f of ["m5", "c6i", "r7g", "t3", "i4i", "x2gd"]) expect(isGPUFamily(f), f).toBe(false);
  });
});

describe("zone order (Go #217)", () => {
  it("standard AZs first, then Local/Wavelength zones, each alphabetically", () => {
    const want = ["us-west-2a", "us-west-2b", "us-west-2c", "us-west-2d", "us-west-2-lax-1a"];
    expect(sortZoneNames(["us-west-2-lax-1a", "us-west-2d", "us-west-2a", "us-west-2c", "us-west-2b"])).toEqual(want);
    expect(zoneNamesSorted(want)).toBe(true);
    expect(zoneNamesSorted(["us-west-2-lax-1a", "us-west-2a"])).toBe(false);
    expect(uniqueSorted(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("price display (Go printer formatPrice / priceHeaderFor, #138)", () => {
  it("renders per hour, minute and second with widening precision", () => {
    expect(formatPrice(0.0832)).toBe("$0.0832");
    expect(formatPrice(0.6, "minute")).toBe("$0.010000");
    expect(formatPrice(0.01, "second")).toBe("$0.00000278");
    expect([priceHeaderFor(), priceHeaderFor("minute"), priceHeaderFor("second")]).toEqual(["$/hr", "$/min", "$/sec"]);
  });
  it("savingsPercent refuses a zero or missing basis", () => {
    expect(savingsPercent(0.03, 0.1)).toBeCloseTo(70, 10);
    expect(savingsPercent(0, 0.1)).toBeUndefined();
    expect(savingsPercent(0.03, undefined)).toBeUndefined();
    expect(savingsPercent(0.03, 0)).toBeUndefined();
  });
});

describe("gpuRatios (Go TestGPURatioDisplay, #51)", () => {
  const r = (vcpus: number, memoryMib: number, gpus: number): InstanceType => ({
    instanceType: "g5.x", instanceFamily: "g5", vcpus, memoryMib, architecture: "x86_64", gpus,
  });
  it("divides by whole GPUs only", () => {
    expect(gpuRatios(r(16, 65536, 1))).toEqual({ vcpuPerGpu: 16, ramPerGpuGiB: 64 });
    expect(gpuRatios(r(48, 196608, 4))).toEqual({ vcpuPerGpu: 12, ramPerGpuGiB: 48 });
    expect(gpuRatios(r(4, 8192, 0))).toBeUndefined();
    expect(gpuRatios(r(8, 0, 1))).toEqual({ vcpuPerGpu: 8 });
  });
  it("memPerPhysicalCoreGiB divides by physical cores, not vCPUs (#137)", () => {
    expect(memPerPhysicalCoreGiB({ ...r(96, 384 * 1024, 0), physicalCores: 48 })).toBe(8);
    expect(memPerPhysicalCoreGiB(r(96, 384 * 1024, 0))).toBeUndefined();
  });
});

describe("text policies (Go TestTruncateWithEllipsis)", () => {
  it("truncates on a comma boundary when it can", () => {
    expect(truncateWithEllipsis("short", 40)).toBe("short");
    expect(truncateWithEllipsis("1234567890", 10)).toBe("1234567890");
    expect(truncateWithEllipsis("us-east-1a, us-east-1b, us-east-1c, us-east-1d", 30)).toBe("us-east-1a, us-east-1b...");
    expect(truncateWithEllipsis("a".repeat(40), 20)).toBe("a".repeat(17) + "...");
  });
  it("shortens reservation IDs and detects trends", () => {
    expect(shortenReservationID("cr-0123456789abcdef")).toBe("cr-0123456...");
    expect(shortenReservationID("cr-short")).toBe("cr-short");
    expect(hasDistinctTimestamps([{ timestamp: "a" }, { timestamp: "a" }])).toBe(false);
    expect(hasDistinctTimestamps([{ timestamp: "a" }, { timestamp: "b" }])).toBe(true);
    expect(hasDistinctTimestamps([{ timestamp: "a" }])).toBe(false);
    expect(countUniqueRegions([{ region: "a" }, { region: "b" }, { region: "a" }])).toBe(2);
  });
});
