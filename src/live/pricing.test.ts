// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { PricingClient } from "@aws-sdk/client-pricing";
import { parseOnDemandUsd, fetchOnDemandPrice } from "./pricing.js";

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
