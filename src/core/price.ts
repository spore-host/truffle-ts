// Price provenance — the types every price in truffle-ts carries, and the one
// renderer for them. Pure (no data, no AWS), so the core InstanceType can refer
// to it and every consumer renders the same words.
//
// The rule (owner, truffle#184): a static or fallback price must say that it is
// static, WHY the live Price List was not used, and WHEN the static data was
// collected. A price nobody can attribute is the #114 failure with a slower fuse.

/**
 * Where a price came from. Mirrors Go aws.PriceSource ("live" / "static"), plus
 * "unknown" for "no price could be determined" (Go's PriceSourceUnknown, "").
 */
export type PriceSource = "live" | "static" | "unknown";

/** The static table a static price came from. */
export type StaticPriceTable = "libs" | "bundled-catalog";

/**
 * A price's provenance — the shape truffle#184 proposes for Go
 * (`PriceOrigin{Source, FellBackBecause, CollectedOn}`). For a static price,
 * `reason` and `collectedOn` are always set.
 */
export interface PriceOrigin {
  source: PriceSource;
  /** For "static": which static table. */
  table?: StaticPriceTable;
  /** For "static": when that table's rates were collected (YYYY-MM-DD or YYYY-MM). */
  collectedOn?: string;
  /**
   * For "static": why the live Price List was not used (not consulted, or the
   * error it returned). For "unknown": why there is no price.
   */
  reason?: string;
}

/** A price plus its origin. `price` is undefined exactly when `origin.source` is "unknown". */
export interface PriceQuote {
  instanceType: string;
  region: string;
  /** On-demand $/hr; undefined = no price. Never 0. */
  price?: number;
  origin: PriceOrigin;
}

/** The default reason for a static price when nobody tried the live API. */
export const OFFLINE_REASON = "live Price List not consulted (offline lookup)";

/**
 * The one-line label for a price's origin, e.g.
 *   "live"
 *   "static, collected 2026-10-07 (live Price List not consulted (offline lookup))"
 *   "unavailable (no static price for p5e.48xlarge in us-east-1)"
 * Every static label names the collection date and the reason, so a stale rate
 * can't pass for a current one.
 */
export function describePriceOrigin(origin: PriceOrigin): string {
  switch (origin.source) {
    case "live":
      return "live";
    case "static":
      return `static, collected ${origin.collectedOn ?? "on an unknown date"} (${origin.reason ?? "reason unknown"})`;
    default:
      return origin.reason ? `unavailable (${origin.reason})` : "unavailable";
  }
}

/** `$0.0832/hr on-demand (static, collected 2026-10-07 (…))`, or `unavailable (…)`. */
export function describePrice(q: Pick<PriceQuote, "price" | "origin">): string {
  if (q.price === undefined || !(q.price > 0)) return describePriceOrigin({ ...q.origin, source: "unknown" });
  return `$${q.price.toFixed(4)}/hr on-demand (${describePriceOrigin(q.origin)})`;
}
