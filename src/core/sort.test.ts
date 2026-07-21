import { describe, it, expect } from "vitest";
import { sortResults, instanceGeneration } from "./sort.js";
import type { InstanceType } from "./types.js";

const mk = (instanceType: string, vcpus: number, price?: number): InstanceType => ({
  instanceType,
  instanceFamily: instanceType.split(".")[0],
  vcpus,
  memoryMib: vcpus * 4096,
  architecture: "x86_64",
  onDemandPrice: price,
});

describe("instanceGeneration", () => {
  it("reads the first digit run", () => {
    expect(instanceGeneration("m6i.large")).toBe(6);
    expect(instanceGeneration("trn1.32xlarge")).toBe(1);
    expect(instanceGeneration("c7gn.16xlarge")).toBe(7);
    expect(instanceGeneration("metal")).toBe(0);
  });
});

describe("sortResults", () => {
  const items = [mk("m5.large", 2, 0.096), mk("m7i.large", 2, 0.1008), mk("m6i.large", 2, 0.096)];

  it("cheapest → ascending price, unknown prices last", () => {
    const withUnknown = [...items, mk("x8g.large", 2 /* no price */)];
    const sorted = sortResults(withUnknown, "cheapest");
    expect(sorted[0].onDemandPrice).toBe(0.096);
    expect(sorted.at(-1)!.instanceType).toBe("x8g.large"); // unknown pushed to end
  });

  it("expensive → descending price", () => {
    expect(sortResults(items, "expensive")[0].onDemandPrice).toBe(0.1008);
  });

  it("performant → most vCPUs first", () => {
    const perf = [mk("a.large", 2), mk("b.large", 16), mk("c.large", 8)];
    expect(sortResults(perf, "performant").map((i) => i.vcpus)).toEqual([16, 8, 2]);
  });

  it("newest/default → highest generation first", () => {
    expect(sortResults(items, "newest")[0].instanceType).toBe("m7i.large");
    expect(sortResults(items, "default")[0].instanceType).toBe("m7i.large");
  });

  it("is stable on ties (by instance type) and does not mutate input", () => {
    const input = [mk("m6i.large", 2, 0.5), mk("m6a.large", 2, 0.5)];
    const sorted = sortResults(input, "cheapest");
    expect(sorted.map((i) => i.instanceType)).toEqual(["m6a.large", "m6i.large"]);
    expect(input[0].instanceType).toBe("m6i.large"); // original order intact
  });
});
