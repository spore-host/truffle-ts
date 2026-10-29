// Loader for the bundled instance catalog — the committed snapshot in
// instances.json (regenerated from live AWS by scripts/gen-catalog.mjs). Imported
// as JSON so it's inlined by the bundler and needs no runtime fetch.

import type { InstanceType } from "../core/types.js";
import { OFFLINE_REASON } from "../core/price.js";
import instances from "./instances.json" with { type: "json" };

/** Date the bundled snapshot reflects, for UI staleness labels. Set when the
 * catalog is regenerated from live AWS (scripts/gen-catalog.mjs). */
export const CATALOG_AS_OF = "2026-07";

/** The region the bundled catalog's prices were pulled for. Specs are region-
 * agnostic; prices are not, so a price from this catalog is a us-east-1 price. */
export const CATALOG_REGION = "us-east-1";

/**
 * The bundled instance catalog (a copy each call, safe for callers to mutate).
 * Every priced entry carries a static `priceOrigin` (bundled catalog, collected
 * CATALOG_AS_OF, live Price List not consulted), so a consumer can label it as
 * truffle#184 requires. Entries carry no `region`: the catalog is not a
 * statement about where a type is offered.
 */
export function loadBundledCatalog(): InstanceType[] {
  return (instances as InstanceType[]).map((it) => {
    const copy: InstanceType = { ...it };
    if (copy.onDemandPrice != null && copy.onDemandPrice > 0) {
      copy.priceOrigin = {
        source: "static",
        table: "bundled-catalog",
        collectedOn: CATALOG_AS_OF,
        reason: OFFLINE_REASON,
      };
    }
    return copy;
  });
}
