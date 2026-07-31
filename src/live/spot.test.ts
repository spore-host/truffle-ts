// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { EC2Client, DescribeSpotPriceHistoryCommand, type SpotPrice } from "@aws-sdk/client-ec2";
import { fetchSpotPrices, reduceSpotHistory, SPOT_PRODUCT } from "./spot.js";

afterEach(() => vi.restoreAllMocks());

/** One SpotPriceHistory entry, AWS shape. */
const sp = (az: string, price: string, ts?: string, product = SPOT_PRODUCT): SpotPrice => ({
  AvailabilityZone: az,
  SpotPrice: price,
  ProductDescription: product as never,
  ...(ts ? { Timestamp: new Date(ts) } : {}),
});

const T1 = "2026-07-30T10:00:00.000Z";
const T2 = "2026-07-30T11:00:00.000Z";
const T3 = "2026-07-30T12:00:00.000Z";

describe("reduceSpotHistory — current-price mode", () => {
  it("keeps the NEWEST observation per AZ", () => {
    const out = reduceSpotHistory(
      [sp("us-east-1a", "0.10", T1), sp("us-east-1a", "0.20", T3), sp("us-east-1a", "0.15", T2)],
      "m7i.large",
      "us-east-1",
      {},
    );
    expect(out).toHaveLength(1);
    expect(out[0].spotPrice).toBe(0.2);
    expect(out[0].timestamp).toBe(T3);
  });

  it("returns one row per AZ, sorted by AZ", () => {
    // Prices vary per AZ, not per region — without availabilityZone these rows
    // would be indistinguishable duplicates.
    const out = reduceSpotHistory(
      [sp("us-east-1c", "0.30", T1), sp("us-east-1a", "0.10", T1), sp("us-east-1b", "0.20", T1)],
      "m7i.large",
      "us-east-1",
      {},
    );
    expect(out.map((r) => r.availabilityZone)).toEqual(["us-east-1a", "us-east-1b", "us-east-1c"]);
    expect(out.map((r) => r.spotPrice)).toEqual([0.1, 0.2, 0.3]);
  });

  it("does not let an undated entry displace a dated one", () => {
    const out = reduceSpotHistory(
      [sp("us-east-1a", "0.10", T1), sp("us-east-1a", "0.99")],
      "m7i.large",
      "us-east-1",
      {},
    );
    expect(out[0].spotPrice).toBe(0.1); // the dated observation won
  });

  it("still yields a row when NO entry has a timestamp", () => {
    const out = reduceSpotHistory([sp("us-east-1a", "0.42")], "m7i.large", "us-east-1", {});
    expect(out).toHaveLength(1);
    expect(out[0].spotPrice).toBe(0.42);
    expect(out[0].timestamp).toBeUndefined();
  });

  it("carries instanceType, region and productType through", () => {
    const out = reduceSpotHistory([sp("eu-west-1a", "0.05", T1)], "c7g.large", "eu-west-1", {});
    expect(out[0]).toMatchObject({
      instanceType: "c7g.large",
      region: "eu-west-1",
      availabilityZone: "eu-west-1a",
      productType: SPOT_PRODUCT,
    });
  });

  it("treats lookbackHours <= 1 as current mode", () => {
    const hist = [sp("us-east-1a", "0.10", T1), sp("us-east-1a", "0.20", T2)];
    expect(reduceSpotHistory(hist, "m7i.large", "us-east-1", { lookbackHours: 1 })).toHaveLength(1);
    expect(reduceSpotHistory(hist, "m7i.large", "us-east-1", { lookbackHours: 0 })).toHaveLength(1);
  });
});

describe("reduceSpotHistory — trend mode", () => {
  it("returns EVERY history point when lookbackHours > 1", () => {
    const out = reduceSpotHistory(
      [sp("us-east-1a", "0.10", T1), sp("us-east-1a", "0.20", T2), sp("us-east-1b", "0.15", T2)],
      "m7i.large",
      "us-east-1",
      { lookbackHours: 6 },
    );
    expect(out).toHaveLength(3);
  });

  it("preserves the input ordering (the series is the point)", () => {
    const out = reduceSpotHistory(
      [sp("us-east-1a", "0.30", T3), sp("us-east-1a", "0.10", T1), sp("us-east-1a", "0.20", T2)],
      "m7i.large",
      "us-east-1",
      { lookbackHours: 24 },
    );
    expect(out.map((r) => r.spotPrice)).toEqual([0.3, 0.1, 0.2]);
  });
});

describe("reduceSpotHistory — filtering and savings", () => {
  it("drops entries above a positive maxPrice", () => {
    const out = reduceSpotHistory(
      [sp("us-east-1a", "0.10", T1), sp("us-east-1b", "0.90", T1)],
      "m7i.large",
      "us-east-1",
      { maxPrice: 0.5 },
    );
    expect(out.map((r) => r.availabilityZone)).toEqual(["us-east-1a"]);
  });

  it("treats maxPrice 0 / undefined as NO ceiling", () => {
    // 0 is the zero value, not "free only" — filtering on it would return nothing.
    const hist = [sp("us-east-1a", "0.90", T1)];
    expect(reduceSpotHistory(hist, "m7i.large", "us-east-1", { maxPrice: 0 })).toHaveLength(1);
    expect(reduceSpotHistory(hist, "m7i.large", "us-east-1", {})).toHaveLength(1);
  });

  it("computes savings against the passed on-demand price only when asked", () => {
    const hist = [sp("us-east-1a", "0.25", T1)];
    const off = reduceSpotHistory(hist, "m7i.large", "us-east-1", {}, 1.0);
    expect(off[0].onDemandPrice).toBeUndefined();
    expect(off[0].savingsPercent).toBeUndefined();

    const on = reduceSpotHistory(hist, "m7i.large", "us-east-1", { showSavings: true }, 1.0);
    expect(on[0].onDemandPrice).toBe(1.0);
    expect(on[0].savingsPercent).toBeCloseTo(75, 6);
  });

  it("omits savings when the on-demand price is missing or zero", () => {
    const hist = [sp("us-east-1a", "0.25", T1)];
    for (const od of [undefined, 0]) {
      const out = reduceSpotHistory(hist, "m7i.large", "us-east-1", { showSavings: true }, od);
      expect(out[0].savingsPercent).toBeUndefined();
      expect(out[0].onDemandPrice).toBeUndefined();
    }
  });

  it("does not report 100% savings for a zero spot price", () => {
    // A 0.0 price is a data artifact; rendering it as a 100%-off deal would be
    // actively misleading.
    const out = reduceSpotHistory(
      [sp("us-east-1a", "0.0", T1)],
      "m7i.large",
      "us-east-1",
      { showSavings: true },
      1.0,
    );
    expect(out[0].spotPrice).toBe(0);
    expect(out[0].savingsPercent).toBeUndefined();
  });

  it("skips entries with a non-numeric price or a missing AZ", () => {
    const out = reduceSpotHistory(
      [
        { AvailabilityZone: "us-east-1a", SpotPrice: "n/a" } as SpotPrice,
        { SpotPrice: "0.10" } as SpotPrice,
        { AvailabilityZone: "us-east-1b" } as SpotPrice,
        sp("us-east-1c", "0.10", T1),
      ],
      "m7i.large",
      "us-east-1",
      {},
    );
    expect(out.map((r) => r.availabilityZone)).toEqual(["us-east-1c"]);
  });

  it("returns an empty array for empty history", () => {
    expect(reduceSpotHistory([], "m7i.large", "us-east-1", {})).toEqual([]);
  });
});

describe("fetchSpotPrices", () => {
  it("queries the one type against the given window and product", async () => {
    const sent: any[] = [];
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: unknown, cmd: any) {
      sent.push(cmd);
      return Promise.resolve({ SpotPriceHistory: [sp("us-east-1a", "0.11", T1)] });
    } as any);

    const start = new Date(T1);
    const out = await fetchSpotPrices(
      new EC2Client({ region: "us-east-1" }),
      "m7i.large",
      "us-east-1",
      start,
      {},
    );
    expect(out).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DescribeSpotPriceHistoryCommand);
    expect(sent[0].input).toMatchObject({
      InstanceTypes: ["m7i.large"],
      StartTime: start,
      ProductDescriptions: [SPOT_PRODUCT],
    });
  });

  it("returns an empty array when the API reports no history", async () => {
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(() => Promise.resolve({}) as any);
    const out = await fetchSpotPrices(
      new EC2Client({ region: "us-east-1" }),
      "m7i.large",
      "us-east-1",
      new Date(T1),
      {},
    );
    expect(out).toEqual([]);
  });

  it("propagates an API error so the caller can count the failure", async () => {
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(() => Promise.reject(new Error("spot boom")) as any);
    await expect(
      fetchSpotPrices(new EC2Client({ region: "us-east-1" }), "m7i.large", "us-east-1", new Date(T1), {}),
    ).rejects.toThrow(/spot boom/);
  });
});
