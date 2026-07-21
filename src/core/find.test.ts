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
