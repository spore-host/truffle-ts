import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBundledCatalog, CATALOG_AS_OF } from "./catalog.js";
import {
  onDemandPrice,
  staticOnDemandPrice,
  EC2Pricing,
  STATIC_EC2_PRICES,
  STATIC_PRICES_AS_OF,
  STATIC_PRICES_SOURCE,
} from "./pricing.js";
import { describePrice, describePriceOrigin, OFFLINE_REASON } from "../core/price.js";

const catalog = loadBundledCatalog();

// ── #29: a miss is "no price", never an estimate ──────────────────────────────
describe("staticOnDemandPrice never fabricates (#29, Go truffle#114 / libs#29)", () => {
  it("returns no price for hpc7a.96xlarge — the 36x case", () => {
    // truffle#114: the family estimator priced hpc7a.96xlarge at $0.20/hr
    // (unknown family 0.10 x unknown size 2.0) against a real $7.20. truffle-ts's
    // estimatePriceByFamily returned the same $0.20 for it.
    const q = staticOnDemandPrice("hpc7a.96xlarge");
    expect(q.price).toBeUndefined();
    expect(q.origin.source).toBe("unknown");
    expect(q.origin.reason).toBe("no static price for hpc7a.96xlarge in us-east-1");
    expect(onDemandPrice("hpc7a.96xlarge")).toBeUndefined();
  });

  // Ported verbatim from libs pricing_test.go TestGetEC2HourlyRateErrorsRatherThanGuessing.
  // Go's static pricer consults only the libs table, so every case errors there.
  // truffle-ts also consults the bundled catalog (live-pulled, us-east-1), so a
  // case may instead return a REAL price — the one Go's comment documents — but
  // never the old fabricated value.
  const cases: {
    name: string;
    region: string;
    type: string;
    oldFabricated: number;
    real?: number; // the catalog's real us-east-1 rate, where it has one
  }[] = [
    { name: "g7e.4xlarge", region: "us-east-1", type: "g7e.4xlarge", oldFabricated: 0.8, real: 3.9982 },
    { name: "p5.4xlarge", region: "us-east-1", type: "p5.4xlarge", oldFabricated: 0.8, real: 6.88 },
    { name: "g6e.12xlarge", region: "us-east-1", type: "g6e.12xlarge", oldFabricated: 2.4, real: 10.4926 },
    { name: "p6-b200.48xlarge", region: "us-east-1", type: "p6-b200.48xlarge", oldFabricated: 9.6, real: 113.9328 },
    { name: "p5e.48xlarge", region: "us-east-1", type: "p5e.48xlarge", oldFabricated: 9.6 },
    { name: "unknown family", region: "us-east-1", type: "bogus.xlarge", oldFabricated: 0.2 },
    { name: "unknown size", region: "us-east-1", type: "t3.unknown", oldFabricated: 0.1664 },
    { name: "region absent from table", region: "sa-east-1", type: "c5.xlarge", oldFabricated: 0.17 },
    // Real m7i.12xlarge happens to equal the old estimate (0.1008 x 24), so this
    // case asserts provenance instead: the number must come from a table.
    { name: "region present, type absent", region: "us-east-1", type: "m7i.12xlarge", oldFabricated: 2.4192, real: 2.4192 },
    { name: "no dot in type", region: "us-east-1", type: "invalid", oldFabricated: 0.1 },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const q = staticOnDemandPrice(c.type, c.region);
      if (c.real === undefined) {
        expect(q.price, `${c.type} must have no price`).toBeUndefined();
        expect(q.origin.source).toBe("unknown");
        expect(q.origin.reason).toMatch(/^no static price/);
      } else {
        expect(q.price).toBe(c.real);
        expect(q.origin).toMatchObject({ source: "static", table: "bundled-catalog", collectedOn: CATALOG_AS_OF });
      }
      if (c.real !== c.oldFabricated) expect(q.price).not.toBe(c.oldFabricated);
    });
  }

  it("names a region with no table at all", () => {
    expect(staticOnDemandPrice("c5.xlarge", "sa-east-1").origin.reason).toBe(
      "no static price table for region sa-east-1",
    );
  });

  it("never returns a non-positive price from any table", () => {
    for (const [region, prices] of Object.entries(STATIC_EC2_PRICES)) {
      for (const [type, p] of Object.entries(prices)) expect(p, `${region} ${type}`).toBeGreaterThan(0);
    }
  });
});

describe("static prices are region-keyed (#29)", () => {
  it("carries the libs table's eight regions", () => {
    expect(Object.keys(STATIC_EC2_PRICES).sort()).toEqual(
      [
        "ap-northeast-1",
        "ap-southeast-1",
        "eu-central-1",
        "eu-west-1",
        "us-east-1",
        "us-east-2",
        "us-west-1",
        "us-west-2",
      ].sort(),
    );
  });

  it("prices a eu-west-1 query with eu-west-1's rate, not us-east-1's", () => {
    // The old flat table answered every region with us-east-1's number.
    const eu = staticOnDemandPrice("c5.xlarge", "eu-west-1");
    const us = staticOnDemandPrice("c5.xlarge", "us-east-1");
    expect(eu.price).toBeDefined();
    expect(eu.price).not.toBe(us.price);
    expect(eu.origin.table).toBe("libs");
  });

  it("does not borrow the bundled catalog (us-east-1) for another region", () => {
    // p5.4xlarge is in the catalog (us-east-1) but in no libs region.
    expect(staticOnDemandPrice("p5.4xlarge", "us-east-1").price).toBe(6.88);
    expect(staticOnDemandPrice("p5.4xlarge", "us-west-2").price).toBeUndefined();
  });

  it("is case- and whitespace-insensitive, as Go's lookup", () => {
    expect(staticOnDemandPrice(" T3.Micro ", "US-EAST-1").price).toBe(0.0104);
  });

  it("keeps EC2Pricing as the us-east-1 slice for old imports", () => {
    expect(EC2Pricing).toBe(STATIC_EC2_PRICES["us-east-1"]);
  });
});

describe("every static price is labelled static, why, and when (truffle#184)", () => {
  it("labels a libs-table price with the libs collection date and the reason", () => {
    const q = staticOnDemandPrice("t3.micro");
    expect(q.origin).toEqual({
      source: "static",
      table: "libs",
      collectedOn: STATIC_PRICES_AS_OF,
      reason: OFFLINE_REASON,
    });
    expect(describePrice(q)).toBe(
      `$0.0104/hr on-demand (static, collected ${STATIC_PRICES_AS_OF} (live Price List not consulted (offline lookup)))`,
    );
  });

  it("carries the live failure as the reason when it is a fallback", () => {
    const q = staticOnDemandPrice("t3.micro", "us-east-1", "live Price List failed: ThrottlingException");
    expect(describePriceOrigin(q.origin)).toBe(
      `static, collected ${STATIC_PRICES_AS_OF} (live Price List failed: ThrottlingException)`,
    );
  });

  it("keeps the live failure in the reason for a miss too", () => {
    const q = staticOnDemandPrice("bogus.xlarge", "us-east-1", "live Price List failed: AccessDenied");
    expect(describePrice(q)).toBe(
      "unavailable (live Price List failed: AccessDenied; no static price for bogus.xlarge in us-east-1)",
    );
  });

  it("labels every priced bundled-catalog entry", () => {
    for (const it of catalog.filter((e) => e.onDemandPrice !== undefined)) {
      expect(it.priceOrigin, it.instanceType).toEqual({
        source: "static",
        table: "bundled-catalog",
        collectedOn: CATALOG_AS_OF,
        reason: OFFLINE_REASON,
      });
    }
  });

  it("records a machine-readable collection date for the libs table", () => {
    expect(STATIC_PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STATIC_PRICES_SOURCE).toMatch(/^spore-host\/libs v\d+\.\d+\.\d+/);
  });

  it("renders live and unknown origins", () => {
    expect(describePrice({ price: 1.5, origin: { source: "live" } })).toBe("$1.5000/hr on-demand (live)");
    expect(describePrice({ price: undefined, origin: { source: "unknown" } })).toBe("unavailable");
  });
});

describe("the two static tables agree (#39)", () => {
  it("libs us-east-1 and the bundled catalog agree within 10% wherever both price a type", () => {
    // Two static tables in one package drift (#39's third defect). The one
    // disagreement found when the libs table was adopted, p4d.24xlarge, is a
    // stale libs entry (spore-host/libs#67) and is excluded by the generator.
    const byType = new Map(catalog.map((it) => [it.instanceType, it]));
    const off: string[] = [];
    for (const [type, tablePrice] of Object.entries(STATIC_EC2_PRICES["us-east-1"])) {
      const entry = byType.get(type);
      if (!entry?.onDemandPrice) continue;
      const ratio = entry.onDemandPrice / tablePrice;
      if (ratio < 0.9 || ratio > 1.1) off.push(`${type}: catalog=${entry.onDemandPrice} libs=${tablePrice}`);
    }
    expect(off).toEqual([]);
  });

  it("drops the known-stale libs p4d.24xlarge and falls through to the catalog's live-pulled rate", () => {
    expect(STATIC_EC2_PRICES["us-east-1"]["p4d.24xlarge"]).toBeUndefined();
    expect(staticOnDemandPrice("p4d.24xlarge")).toMatchObject({
      price: 21.9576,
      origin: { source: "static", table: "bundled-catalog" },
    });
  });
});

// ── drift gate against libs (networkless; needs a libs checkout) ──────────────
// Set TRUFFLE_LIBS_DIR to a libs directory (e.g. the module cache's
// libs@vX.Y.Z) to check the generated files are current. Skipped otherwise,
// since CI has no Go module cache.
const libsDir = process.env.TRUFFLE_LIBS_DIR;
describe.skipIf(!libsDir || !existsSync(libsDir))("generated upstream data is current", () => {
  it("matches scripts/gen-upstream.mjs output for TRUFFLE_LIBS_DIR", () => {
    const script = fileURLToPath(new URL("../../scripts/gen-upstream.mjs", import.meta.url));
    expect(() =>
      execFileSync(process.execPath, [script, "--check", "--libs", libsDir!], { encoding: "utf8" }),
    ).not.toThrow();
  });
});
