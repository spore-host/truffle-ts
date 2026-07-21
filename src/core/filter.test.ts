import { describe, it, expect } from "vitest";
import { matchesFilters, extractFamily } from "./filter.js";
import type { InstanceType } from "./types.js";

const m7g: InstanceType = { instanceType: "m7g.2xlarge", instanceFamily: "m7g", vcpus: 8, memoryMib: 32768, architecture: "arm64", threadsPerCore: 1 };
const c7i: InstanceType = { instanceType: "c7i.4xlarge", instanceFamily: "c7i", vcpus: 16, memoryMib: 32768, architecture: "x86_64", threadsPerCore: 2 };
const p5: InstanceType = { instanceType: "p5.48xlarge", instanceFamily: "p5", vcpus: 192, memoryMib: 2097152, architecture: "x86_64", gpus: 8, nestedVirt: false };

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
});
