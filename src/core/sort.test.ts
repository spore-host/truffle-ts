import { describe, it, expect } from "vitest";
import { sortResults, instanceGeneration } from "./sort.js";
import type { InstanceType } from "./types.js";

const mk = (
  instanceType: string,
  vcpus: number,
  price?: number,
  estimatedPrice?: boolean,
): InstanceType => ({
  instanceType,
  instanceFamily: instanceType.split(".")[0],
  vcpus,
  memoryMib: vcpus * 4096,
  architecture: "x86_64",
  onDemandPrice: price,
  ...(estimatedPrice ? { estimatedPrice } : {}),
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

  // ── #39: an estimate must never win a price-ranked query ─────────────────────
  // This is the behaviour that made a fabricated $0.20/hr on a 72xB200 rack the
  // top result for `cheapest 64gb`. Ranking is the one place an under-estimate
  // does maximum damage: it doesn't just misreport a number, it actively
  // recommends the instance we have the worst data for. A "* estimated" footnote
  // on row 1 of a price-ordered list does not undo the ordering.
  describe("estimated prices never outrank real ones", () => {
    it("sinks a cheap estimate below every real price in cheapest", () => {
      const results = [
        mk("real-expensive.large", 2, 100.0),
        mk("fake-cheap.large", 2, 0.2, true), // the p6e-gb200 shape of the bug
        mk("real-cheap.large", 2, 0.096),
      ];
      const sorted = sortResults(results, "cheapest");
      expect(sorted.map((i) => i.instanceType)).toEqual([
        "real-cheap.large",
        "real-expensive.large",
        "fake-cheap.large",
      ]);
    });

    it("also sinks an estimate in expensive, so it can't win either end", () => {
      // An over-estimate topping "most expensive" is the mirror defect: it buries
      // the real answer under a number nobody vouched for.
      const results = [mk("fake-dear.large", 2, 999, true), mk("real-dear.large", 2, 50)];
      expect(sortResults(results, "expensive")[0].instanceType).toBe("real-dear.large");
    });

    it("still orders estimates among themselves", () => {
      // Ordered last, not dropped — a user searching for a brand-new accelerator
      // should still find it, just not be told it's the cheap option.
      const results = [mk("est-b.large", 2, 5, true), mk("est-a.large", 2, 1, true)];
      expect(sortResults(results, "cheapest").map((i) => i.instanceType)).toEqual([
        "est-a.large",
        "est-b.large",
      ]);
    });

    it("ranks an estimate above a wholly unknown price", () => {
      // An estimate is weak evidence; no price at all is none. Both go after real
      // prices, in that order.
      const results = [mk("none.large", 2), mk("est.large", 2, 3, true), mk("real.large", 2, 9)];
      expect(sortResults(results, "cheapest").map((i) => i.instanceType)).toEqual([
        "real.large",
        "est.large",
        "none.large",
      ]);
    });
  });
});
