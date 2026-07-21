import { describe, it, expect } from "vitest";
import { parseQuery } from "./parser.js";
import { buildCriteria, buildInstanceTypePattern } from "./criteria.js";

// Ported from Go executor_test.go — asserted by matching behavior rather than
// exact pattern strings, since the TS port sorts families deterministically
// (the Go test itself notes the pattern "may vary in family order").
describe("buildInstanceTypePattern", () => {
  it("graviton query → matches graviton family sizes, not x86", () => {
    const re = new RegExp(buildInstanceTypePattern(parseQuery("graviton")));
    expect(re.test("c7g.2xlarge")).toBe(true);
    expect(re.test("r8g.large")).toBe(true);
    expect(re.test("m7i.large")).toBe(false);
  });

  it("a100 → exact GPU instance types only", () => {
    const re = new RegExp(buildInstanceTypePattern(parseQuery("a100")));
    expect(re.test("p4d.24xlarge")).toBe(true);
    expect(re.test("p4de.24xlarge")).toBe(true);
    expect(re.test("p4d.12xlarge")).toBe(false);
  });

  it("graviton large → only 2xlarge/4xlarge of graviton families", () => {
    const re = new RegExp(buildInstanceTypePattern(parseQuery("graviton large")));
    expect(re.test("c7g.2xlarge")).toBe(true);
    expect(re.test("c7g.4xlarge")).toBe(true);
    expect(re.test("c7g.xlarge")).toBe(false);
    expect(re.test("c7g.8xlarge")).toBe(false);
  });

  it("no constraints → match-all", () => {
    expect(buildInstanceTypePattern(parseQuery("16 cores"))).toBe(".*");
  });

  it("disjoint app+query families → never-match", () => {
    // igv → c7i/m7i/c6i (CPU); nvidia → g/p GPU families. Disjoint → ^$.
    expect(buildInstanceTypePattern(parseQuery("igv nvidia"))).toBe("^$");
  });
});

describe("buildCriteria", () => {
  it("carries vCPU/memory/arch filters through", () => {
    const c = buildCriteria(parseQuery("amd 16 cores"));
    expect(c.filters.minVcpus).toBe(16);
    expect(c.filters.architecture).toBe("x86_64");
  });

  it("graviton 32gb → arm64 + 32 GiB minimum", () => {
    const c = buildCriteria(parseQuery("graviton 32gb"));
    expect(c.filters.architecture).toBe("arm64");
    expect(c.filters.minMemoryGiB).toBe(32);
  });

  it("applies app-catalog minimums only when unset", () => {
    // paraview: minVcpus 4, minMemoryGiB 16 — applied since none specified.
    const c = buildCriteria(parseQuery("paraview"));
    expect(c.filters.minVcpus).toBe(4);
    expect(c.filters.minMemoryGiB).toBe(16);
    // Explicit vCPU wins over the app minimum.
    const c2 = buildCriteria(parseQuery("paraview 32 cores"));
    expect(c2.filters.minVcpus).toBe(32);
  });
});
