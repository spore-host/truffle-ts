import { describe, it, expect } from "vitest";
import { matchesFilters, extractFamily, perGpuMemoryGiB } from "./filter.js";
import type { InstanceType } from "./types.js";

const m7g: InstanceType = { instanceType: "m7g.2xlarge", instanceFamily: "m7g", vcpus: 8, memoryMib: 32768, architecture: "arm64", threadsPerCore: 1 };
const c7i: InstanceType = { instanceType: "c7i.4xlarge", instanceFamily: "c7i", vcpus: 16, memoryMib: 32768, architecture: "x86_64", threadsPerCore: 2 };
const p5: InstanceType = { instanceType: "p5.48xlarge", instanceFamily: "p5", vcpus: 192, memoryMib: 2097152, architecture: "x86_64", gpus: 8, gpuMemoryMib: 655360, gpuModel: "H100", nestedVirt: false };
// 4 × 16 GiB T4 = 64 GiB aggregate — the case that makes per-GPU comparison matter.
const g4dn12: InstanceType = { instanceType: "g4dn.12xlarge", instanceFamily: "g4dn", vcpus: 48, memoryMib: 196608, architecture: "x86_64", gpus: 4, gpuMemoryMib: 65536, gpuModel: "T4" };
// A GPU instance with no VRAM figure recorded — under-specified, not "0 GiB".
const gpuNoVram: InstanceType = { instanceType: "g3.4xlarge", instanceFamily: "g3", vcpus: 16, memoryMib: 124928, architecture: "x86_64", gpus: 1 };

describe("extractFamily", () => {
  it("takes the prefix before the dot", () => {
    expect(extractFamily("m6i.2xlarge")).toBe("m6i");
    expect(extractFamily("trn1.32xlarge")).toBe("trn1");
    expect(extractFamily("nodot")).toBe("nodot");
  });
});

describe("matchesFilters", () => {
  it("architecture filter", () => {
    expect(matchesFilters(m7g, { architecture: "arm64" })).toBe(true);
    expect(matchesFilters(m7g, { architecture: "x86_64" })).toBe(false);
    expect(matchesFilters(m7g, {})).toBe(true); // no filter
  });

  it("min vs exact vCPU", () => {
    expect(matchesFilters(c7i, { minVcpus: 8 })).toBe(true);
    expect(matchesFilters(c7i, { minVcpus: 32 })).toBe(false);
    expect(matchesFilters(c7i, { minVcpus: 16, exactVcpus: true })).toBe(true);
    expect(matchesFilters(c7i, { minVcpus: 8, exactVcpus: true })).toBe(false);
  });

  it("memory filter converts MiB → GiB (with exact tolerance)", () => {
    expect(matchesFilters(c7i, { minMemoryGiB: 32 })).toBe(true); // 32768 MiB = 32 GiB
    expect(matchesFilters(c7i, { minMemoryGiB: 64 })).toBe(false);
    expect(matchesFilters(c7i, { minMemoryGiB: 32, exactMemory: true })).toBe(true);
    expect(matchesFilters(c7i, { minMemoryGiB: 48, exactMemory: true })).toBe(false);
  });

  it("physical cores: explicit, and estimated from threads-per-core", () => {
    // c7i: 16 vCPU / 2 tpc = 8 physical cores.
    expect(matchesFilters(c7i, { minPhysicalCores: 8 })).toBe(true);
    expect(matchesFilters(c7i, { minPhysicalCores: 9 })).toBe(false);
    // m7g: 8 vCPU / 1 tpc = 8 cores (Graviton).
    expect(matchesFilters(m7g, { minPhysicalCores: 8 })).toBe(true);
  });

  it("instance family + nested-virt filters", () => {
    expect(matchesFilters(c7i, { instanceFamily: "c7i" })).toBe(true);
    expect(matchesFilters(c7i, { instanceFamily: "m7g" })).toBe(false);
    expect(matchesFilters(p5, { nestedVirt: true })).toBe(false); // p5 doesn't support it
  });

  // #37: without requireGpu, "gpu with 80gb" resolved to no card, so it filtered
  // nothing and returned CPU-only Graviton types.
  it("requireGpu excludes CPU-only instances", () => {
    expect(matchesFilters(p5, { requireGpu: true })).toBe(true);
    expect(matchesFilters(m7g, { requireGpu: true })).toBe(false);
    expect(matchesFilters(c7i, { requireGpu: true })).toBe(false);
  });

  // #38: gpuCount was parsed and then never reached a filter.
  it("minGpus filters on GPU count", () => {
    expect(matchesFilters(p5, { minGpus: 8 })).toBe(true);
    expect(matchesFilters(p5, { minGpus: 16 })).toBe(false);
    expect(matchesFilters(g4dn12, { minGpus: 8 })).toBe(false);
    expect(matchesFilters(m7g, { minGpus: 1 })).toBe(false);
  });

  it("minGpuMemoryGiB compares per-GPU, not aggregate", () => {
    expect(matchesFilters(p5, { minGpuMemoryGiB: 80 })).toBe(true);   // 640/8 = 80
    expect(matchesFilters(p5, { minGpuMemoryGiB: 81 })).toBe(false);
    // 64 GiB of aggregate VRAM must not satisfy an 80 GiB *card* request.
    expect(matchesFilters(g4dn12, { minGpuMemoryGiB: 80 })).toBe(false);
    expect(matchesFilters(g4dn12, { minGpuMemoryGiB: 16 })).toBe(true);
  });

  it("an instance with no recorded VRAM fails a VRAM floor rather than passing it", () => {
    // Excluding the under-specified entry is the safe direction: the alternative
    // presents an unverified type as a confirmed match.
    expect(matchesFilters(gpuNoVram, { minGpuMemoryGiB: 8 })).toBe(false);
    expect(matchesFilters(gpuNoVram, { requireGpu: true })).toBe(true);
  });
});

describe("perGpuMemoryGiB", () => {
  it("divides aggregate VRAM by GPU count", () => {
    expect(perGpuMemoryGiB(p5)).toBe(80);
    expect(perGpuMemoryGiB(g4dn12)).toBe(16);
  });

  it("returns 0 — not NaN or Infinity — when there is nothing to divide", () => {
    expect(perGpuMemoryGiB(m7g)).toBe(0);      // no GPUs
    expect(perGpuMemoryGiB(gpuNoVram)).toBe(0); // GPUs but no VRAM figure
  });
});
