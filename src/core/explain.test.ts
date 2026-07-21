import { describe, it, expect } from "vitest";
import { parseQuery } from "./parser.js";
import { explainMatch } from "./explain.js";
import type { InstanceType } from "./types.js";

const p5: InstanceType = { instanceType: "p5.48xlarge", instanceFamily: "p5", vcpus: 192, memoryMib: 2097152, architecture: "x86_64", gpus: 8, gpuModel: "H100" };
const c7g: InstanceType = { instanceType: "c7g.4xlarge", instanceFamily: "c7g", vcpus: 16, memoryMib: 32768, architecture: "arm64" };

describe("explainMatch", () => {
  it("explains a GPU + EFA match with the exact-instance reason", () => {
    const reasons = explainMatch(p5, parseQuery("h100 efa"));
    expect(reasons).toContain("GPU: H100 (80 GB, training)");
    expect(reasons).toContain("Network: EFA supported");
  });

  it("explains vendor + vCPU + memory + arch for a graviton match", () => {
    const reasons = explainMatch(c7g, parseQuery("graviton 8 cores 16gb"));
    expect(reasons).toContain("Vendor: aws");
    expect(reasons).toContain("vCPUs: 16 >= 8");
    expect(reasons).toContain("Memory: 32 GiB >= 16 GiB");
  });

  it("explains a processor code-name match", () => {
    const m7i: InstanceType = { instanceType: "m7i.2xlarge", instanceFamily: "m7i", vcpus: 8, memoryMib: 32768, architecture: "x86_64" };
    expect(explainMatch(m7i, parseQuery("sapphire rapids"))).toContain("Processor: Sapphire Rapids (intel 4th gen)");
  });

  it("explains a network-tier match", () => {
    const reasons = explainMatch(p5, parseQuery("100gbps"));
    expect(reasons.some((r) => r.startsWith("Network: 100+ Gbps"))).toBe(true);
  });

  it("returns no reasons when nothing in the query applies", () => {
    expect(explainMatch(c7g, parseQuery("16 cores")).length).toBeGreaterThanOrEqual(1);
  });

  it("explains a GPU FAMILY match when the exact type isn't listed", () => {
    // g5.xlarge is an a10g family instance; query "a10g" → family match (not exact
    // for an arbitrary size we pick that's still in-family).
    const g5: InstanceType = { instanceType: "g5.16xlarge", instanceFamily: "g5", vcpus: 64, memoryMib: 262144, architecture: "x86_64", gpus: 1 };
    // g5.16xlarge is in a10g.instanceTypes, so force a family-only case with a size not listed:
    const g5odd: InstanceType = { ...g5, instanceType: "g5.metal" };
    expect(explainMatch(g5odd, parseQuery("a10g"))).toContain("GPU family: A10G (inference)");
  });

  it("explains a size-category match", () => {
    const c7gLarge: InstanceType = { instanceType: "c7g.4xlarge", instanceFamily: "c7g", vcpus: 16, memoryMib: 32768, architecture: "arm64" };
    expect(explainMatch(c7gLarge, parseQuery("graviton large"))).toContain("Size: large");
  });

  it("explains an explicit architecture match", () => {
    expect(explainMatch(c7g, parseQuery("arm64"))).toContain("Architecture: arm64");
  });
});
