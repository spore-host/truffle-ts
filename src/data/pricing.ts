// Static on-demand pricing, with provenance.
//
// Two static sources, both real Price List rates collected on a known date:
//
//   1. STATIC_EC2_PRICES — generated from the Go suite's spore-host/libs
//      pricing.EC2Pricing (8 regions, collected STATIC_PRICES_AS_OF). This is
//      the table Go truffle falls back to when the Price List API is unavailable.
//   2. The bundled catalog (instances.json) — us-east-1 only, collected
//      CATALOG_AS_OF by scripts/gen-catalog.mjs.
//
// Lookup is by EXACT (region, instance type). There is no estimate. Go truffle
// removed its family × size estimator after truffle#114, where it priced
// hpc7a.96xlarge at $0.20/hr against a real $7.20; truffle-ts's
// estimatePriceByFamily returned the same $0.20 for it (#29). A price we don't
// have is reported as absent, never as a plausible-looking number.
//
// Every static price carries an origin that says (1) that it is static, (2) why
// the live Price List was not used, and (3) when the static data was collected
// (the owner's rule, truffle#184). Use describePrice() to render one, so the
// wording is the same everywhere.

import { loadBundledCatalog, CATALOG_AS_OF, CATALOG_REGION } from "./catalog.js";
import {
  STATIC_EC2_PRICES,
  STATIC_PRICES_AS_OF,
  STATIC_PRICES_SOURCE,
} from "./static-prices.generated.js";

import { OFFLINE_REASON, type PriceQuote } from "../core/price.js";

export { STATIC_EC2_PRICES, STATIC_PRICES_AS_OF, STATIC_PRICES_SOURCE };

/**
 * @deprecated Use `STATIC_EC2_PRICES` (region-keyed) or `staticOnDemandPrice`.
 * The us-east-1 slice of the libs table, kept so existing imports compile. It
 * was a hand-kept flat table until #29; it is now the generated libs copy.
 */
export const EC2Pricing: Readonly<Record<string, number>> = STATIC_EC2_PRICES["us-east-1"] ?? {};

let catalogPrices: Map<string, number> | undefined;
function bundledCatalogPrice(instanceType: string): number | undefined {
  catalogPrices ??= new Map(
    loadBundledCatalog()
      .filter((it) => it.onDemandPrice != null && it.onDemandPrice > 0 && it.estimatedPrice !== true)
      .map((it) => [it.instanceType, it.onDemandPrice!]),
  );
  return catalogPrices.get(instanceType);
}

/**
 * The static on-demand price for an exact (instance type, region), with its
 * origin. Never estimates: a miss is `{ price: undefined, origin.source:
 * "unknown" }` with a reason naming what was missing.
 *
 * Tries the libs table first (newer, 8 regions), then the bundled catalog,
 * which only knows `CATALOG_REGION` (us-east-1). `reason` is recorded as the
 * static price's reason — pass the live error when this is a fallback.
 */
export function staticOnDemandPrice(
  instanceType: string,
  region = "us-east-1",
  reason: string = OFFLINE_REASON,
): PriceQuote {
  const type = instanceType.trim().toLowerCase();
  const reg = region.trim().toLowerCase();

  const libs = STATIC_EC2_PRICES[reg]?.[type];
  if (libs !== undefined && libs > 0) {
    return {
      instanceType,
      region,
      price: libs,
      origin: { source: "static", table: "libs", collectedOn: STATIC_PRICES_AS_OF, reason },
    };
  }
  if (reg === CATALOG_REGION) {
    const cat = bundledCatalogPrice(type);
    if (cat !== undefined) {
      return {
        instanceType,
        region,
        price: cat,
        origin: { source: "static", table: "bundled-catalog", collectedOn: CATALOG_AS_OF, reason },
      };
    }
  }

  const why =
    STATIC_EC2_PRICES[reg] === undefined && reg !== CATALOG_REGION
      ? `no static price table for region ${region}`
      : `no static price for ${instanceType} in ${region}`;
  return {
    instanceType,
    region,
    origin: { source: "unknown", reason: reason === OFFLINE_REASON ? why : `${reason}; ${why}` },
  };
}

/**
 * On-demand $/hr from the static tables — `staticOnDemandPrice(...).price`.
 *
 * `undefined` means "no price available", which callers must render as unknown
 * (the portal shows `—`), never as 0. It no longer estimates (#29): before,
 * `onDemandPrice("hpc7a.96xlarge")` was $0.20/hr against a real $7.20. Use
 * `staticOnDemandPrice` when you show the number: it carries the origin a
 * static price must be labelled with.
 */
export function onDemandPrice(instanceType: string, region = "us-east-1"): number | undefined {
  return staticOnDemandPrice(instanceType, region).price;
}
