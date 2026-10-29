// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { PricingClient } from "@aws-sdk/client-pricing";
import {
  parseOnDemandUsd,
  fetchOnDemandPrice,
  lookupOnDemandPrice,
  lookupOnDemandPrices,
  priceKey,
  PRICE_LOOKUP_CONCURRENCY,
} from "./pricing.js";

afterEach(() => vi.restoreAllMocks());

// A minimal Price List product with a nested on-demand USD/hr.
const product = JSON.stringify({
  terms: {
    OnDemand: {
      "ABC.JRTCKXETXF": {
        priceDimensions: {
          "ABC.JRTCKXETXF.6YS6EN2CT7": { pricePerUnit: { USD: "0.4032" } },
        },
      },
    },
  },
});

describe("parseOnDemandUsd", () => {
  it("extracts the on-demand USD/hr", () => {
    expect(parseOnDemandUsd(product)).toBe(0.4032);
  });
  it("returns undefined for malformed / price-less JSON", () => {
    expect(parseOnDemandUsd("{not json")).toBeUndefined();
    expect(parseOnDemandUsd("{}")).toBeUndefined();
    expect(parseOnDemandUsd(JSON.stringify({ terms: { OnDemand: {} } }))).toBeUndefined();
  });
});

describe("fetchOnDemandPrice", () => {
  it("sends a GetProducts with the right filters and parses the price", async () => {
    const sent: any[] = [];
    vi.spyOn(PricingClient.prototype, "send").mockImplementation(function (this: unknown, cmd: any) {
      sent.push(cmd);
      return Promise.resolve({ PriceList: [product] });
    } as any);
    const client = new PricingClient({ region: "us-east-1" });
    const price = await fetchOnDemandPrice(client, "m7i.2xlarge", "us-west-2");
    expect(price).toBe(0.4032);
    const filters = sent[0].input.Filters;
    const byField = Object.fromEntries(filters.map((f: any) => [f.Field, f.Value]));
    expect(byField.instanceType).toBe("m7i.2xlarge");
    expect(byField.regionCode).toBe("us-west-2"); // the queried region, not the client region
    expect(byField.operatingSystem).toBe("Linux");
  });

  it("returns undefined when there's no matching price row", async () => {
    vi.spyOn(PricingClient.prototype, "send").mockResolvedValue({ PriceList: [] } as never);
    const client = new PricingClient({ region: "us-east-1" });
    expect(await fetchOnDemandPrice(client, "zz.unknown", "us-east-1")).toBeUndefined();
  });
});

// ── #42 on the LIVE path: the CapacityBlock row ──────────────────────────────
// gen-catalog fixed this for the bundled catalog, but the runtime fetch kept the
// old shape — MaxResults: 1, no marketoption filter, first item only — so a live
// lookup of p5.4xlarge could take the CapacityBlock row ($0.00) and report a
// free H100. Go's fetchOnDemandPrice filters on marketoption=OnDemand, reads
// every item and skips non-positive rates (parseOnDemandFromPriceItem).
const row = (usd: string) =>
  JSON.stringify({ terms: { OnDemand: { a: { priceDimensions: { b: { pricePerUnit: { USD: usd } } } } } } });

describe("live pricing never reports $0 (#42, Go parseOnDemandFromPriceItem)", () => {
  it("skips a $0.00 dimension and keeps looking", () => {
    const doc = JSON.stringify({
      terms: {
        OnDemand: {
          a: { priceDimensions: { z: { pricePerUnit: { USD: "0.0000000000" } } } },
          b: { priceDimensions: { y: { pricePerUnit: { USD: "6.88" } } } },
        },
      },
    });
    expect(parseOnDemandUsd(doc)).toBe(6.88);
    expect(parseOnDemandUsd(row("0.00"))).toBeUndefined();
    expect(parseOnDemandUsd(row("-1"))).toBeUndefined();
    expect(parseOnDemandUsd(row("n/a"))).toBeUndefined();
  });

  it("reads past a $0 first item to the real rate", async () => {
    vi.spyOn(PricingClient.prototype, "send").mockResolvedValue({ PriceList: [row("0.00"), row("6.88")] } as never);
    const client = new PricingClient({ region: "us-east-1" });
    expect(await fetchOnDemandPrice(client, "p5.4xlarge", "us-east-1")).toBe(6.88);
  });

  it("asks for the OnDemand market only, and does not cap the result to one row", async () => {
    const sent: any[] = [];
    vi.spyOn(PricingClient.prototype, "send").mockImplementation(function (this: unknown, cmd: any) {
      sent.push(cmd);
      return Promise.resolve({ PriceList: [] });
    } as any);
    await fetchOnDemandPrice(new PricingClient({ region: "us-east-1" }), "p5.4xlarge", "us-east-1");
    const input = sent[0].input;
    expect(input.MaxResults).toBeUndefined();
    expect(Object.fromEntries(input.Filters.map((f: any) => [f.Field, f.Value]))).toEqual({
      instanceType: "p5.4xlarge",
      regionCode: "us-east-1",
      operatingSystem: "Linux",
      tenancy: "Shared",
      preInstalledSw: "NA",
      capacitystatus: "Used",
      marketoption: "OnDemand",
    });
  });
});

describe("lookupOnDemandPrice / lookupOnDemandPrices", () => {
  it("returns a live quote when the Price List answers", async () => {
    vi.spyOn(PricingClient.prototype, "send").mockResolvedValue({ PriceList: [row("0.4032")] } as never);
    const q = await lookupOnDemandPrice(new PricingClient({ region: "us-east-1" }), "m7i.2xlarge", "us-west-2");
    expect(q).toEqual({ instanceType: "m7i.2xlarge", region: "us-west-2", price: 0.4032, origin: { source: "live" } });
  });

  it("says the live API had no row when it falls back for that reason", async () => {
    vi.spyOn(PricingClient.prototype, "send").mockResolvedValue({ PriceList: [] } as never);
    const q = await lookupOnDemandPrice(new PricingClient({ region: "us-east-1" }), "t3.micro", "us-east-1");
    expect(q.price).toBe(0.0104);
    expect(q.origin.reason).toBe("live Price List has no on-demand price for t3.micro in us-east-1");
  });

  it("looks each distinct key up once, with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    vi.spyOn(PricingClient.prototype, "send").mockImplementation((async (cmd: any) => {
      const f = Object.fromEntries(cmd.input.Filters.map((x: any) => [x.Field, x.Value]));
      seen.push(`${f.instanceType}@${f.regionCode}`);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { PriceList: [row("1.0")] };
    }) as any);
    const keys = Array.from({ length: 10 }, (_, i) => ({ instanceType: `m7i.${i}xlarge`, region: "us-east-1" }));
    const out = await lookupOnDemandPrices(new PricingClient({ region: "us-east-1" }), [...keys, ...keys]);
    expect(out.size).toBe(10);
    expect(seen).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(PRICE_LOOKUP_CONCURRENCY);
    expect(out.get(priceKey("m7i.3xlarge", "us-east-1"))?.price).toBe(1);
  });
});
