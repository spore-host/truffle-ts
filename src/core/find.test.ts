import { describe, it, expect } from "vitest";
import { find } from "./find.js";
import { BundledFinder } from "../data/bundled-finder.js";

// End-to-end over the bundled catalog — the offline integration test.
describe("find (offline, bundled catalog)", () => {
  it("nvidia h100 8gpu efa → includes p5.48xlarge with a GPU + EFA reason", async () => {
    const results = await find("nvidia h100 8gpu efa");
    const types = results.map((r) => r.instance.instanceType);
    expect(types).toContain("p5.48xlarge");
    const p5 = results.find((r) => r.instance.instanceType === "p5.48xlarge")!;
    // "nvidia" precedes "h100" in the query, so the first GPU reason is the
    // vendor family match (faithful to the Go break-on-first-match), plus EFA.
    expect(p5.reasons.some((r) => r.includes("GPU"))).toBe(true);
    expect(p5.reasons).toContain("Network: EFA supported");
  });

  it("h100 efa (no vendor token) → the exact H100 GPU reason", async () => {
    const p5 = (await find("h100 efa")).find((r) => r.instance.instanceType === "p5.48xlarge")!;
    expect(p5.reasons).toContain("GPU: H100 (80 GB, training)");
  });

  it("cheapest graviton 8 cores 32gb → arm64, sorted price-ascending", async () => {
    const results = await find("cheapest graviton 8 cores 32gb");
    expect(results.length).toBeGreaterThan(0);
    // All arm64, all meet the minimums.
    for (const r of results) {
      expect(r.instance.architecture).toBe("arm64");
      expect(r.instance.vcpus).toBeGreaterThanOrEqual(8);
      expect(r.instance.memoryMib / 1024).toBeGreaterThanOrEqual(32);
    }
    // First result is the cheapest priced one.
    const priced = results.map((r) => r.instance.onDemandPrice ?? 0).filter((p) => p > 0);
    expect(results[0].instance.onDemandPrice).toBe(Math.min(...priced));
  });

  it("fastest → most vCPUs first", async () => {
    const results = await find("fastest graviton");
    expect(results[0].instance.vcpus).toBe(Math.max(...results.map((r) => r.instance.vcpus)));
  });

  it("a100 → exactly the A100 instance types", async () => {
    const types = (await find("a100")).map((r) => r.instance.instanceType).sort();
    expect(types).toEqual(["p4d.24xlarge", "p4de.24xlarge"]);
  });

  it("an unmatchable-but-valid query returns an empty list (not an error)", async () => {
    // igv (CPU families) + nvidia (GPU families) → disjoint → never-match pattern.
    expect(await find("igv nvidia")).toEqual([]);
  });

  it("throws on an empty query", async () => {
    await expect(find("")).rejects.toThrow(/empty query/);
  });

  it("accepts an explicit finder", async () => {
    const results = await find("h100", { finder: new BundledFinder() });
    expect(results.some((r) => r.instance.instanceType === "p5.48xlarge")).toBe(true);
  });
});

// The two bugs the portal surfaced: a query the demo itself suggested returned
// CPU-only Graviton instances, because "gpu" resolved to no card and so vanished
// while "80gb" was read as system RAM (#37); and a parsed GPU count never reached
// a filter (#38).
describe("find — GPU constraints reach the results (#37, #38)", () => {
  it("gpu with 80gb for training → only GPUs, all with >= 80 GiB per card", async () => {
    const results = await find("gpu with 80gb for training");
    expect(results.length).toBeGreaterThan(0);
    for (const { instance } of results) {
      expect(instance.gpus ?? 0).toBeGreaterThanOrEqual(1);
      expect(instance.gpuMemoryMib! / instance.gpus! / 1024).toBeGreaterThanOrEqual(80);
    }
    // The specific regression: this query used to return Graviton CPU types.
    expect(results.some((r) => r.instance.instanceType.startsWith("m7g."))).toBe(false);
  });

  it("a bare gpu query returns nothing but GPU instances", async () => {
    const results = await find("gpu");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => (r.instance.gpus ?? 0) >= 1)).toBe(true);
  });

  it("8 gpus excludes 1/2/4-GPU types, and says why it matched", async () => {
    const results = await find("8 gpus");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => (r.instance.gpus ?? 0) >= 8)).toBe(true);
    expect(results[0].reasons).toContain(`GPUs: ${results[0].instance.gpus} >= 8`);
  });

  it("a count beyond anything in the catalog returns empty, not everything", async () => {
    // The failure mode of an unapplied filter is a *full* result set, so the
    // empty case is the one worth asserting.
    expect(await find("512 gpus")).toEqual([]);
  });

  it("nvidia h100 8gpu efa (the README example) explains its GPU count", async () => {
    const p5 = (await find("nvidia h100 8gpu efa")).find((r) => r.instance.instanceType === "p5.48xlarge")!;
    expect(p5).toBeDefined();
    expect(p5.reasons).toContain("GPUs: 8 >= 8");
  });
});

describe("find — glob/regex pattern routing", () => {
  it("a glob (m7g*) matches instance-type names directly, not the NL parser", async () => {
    const results = await find("m7g*");
    const types = results.map((r) => r.instance.instanceType);
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => t.startsWith("m7g."))).toBe(true);
    expect(results[0].reasons[0]).toContain("matched pattern");
  });

  it("a regex character class (c[67]g.large) matches the right families", async () => {
    const types = (await find("c[67]g.large")).map((r) => r.instance.instanceType);
    // Only c6g/c7g .large (the dot is a literal separator, not any-char).
    expect(types).toContain("c7g.large");
    expect(types.every((t) => /^c[67]g\.large$/.test(t))).toBe(true);
  });

  it("an explicit family glob (p5*) matches by name", async () => {
    const types = (await find("p5*")).map((r) => r.instance.instanceType);
    expect(types).toContain("p5.48xlarge");
    expect(types.every((t) => t.startsWith("p5"))).toBe(true);
  });

  it("respects an explicit sort on the pattern path", async () => {
    const results = await find("c7g*", { sort: "cheapest" });
    const priced = results.map((r) => r.instance.onDemandPrice ?? 0).filter((p) => p > 0);
    expect(results[0].instance.onDemandPrice).toBe(Math.min(...priced));
  });
});
