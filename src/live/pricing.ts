// Live on-demand pricing via the AWS Price List Query API — the runtime twin of
// gen-catalog.mjs's pricing pass, and the port of Go truffle's default pricer
// (pkg/aws/pricing.go + pricing_batch.go): the live Price List in front, the
// static table behind it, and the reason for any fallback kept (truffle#184).
//
// NOTE: the Pricing API is served ONLY from us-east-1 and ap-south-1, regardless
// of which region you're pricing; the client region is fixed to one of those
// while `regionCode` in the filter is the region actually being priced.

import { PricingClient, GetProductsCommand } from "@aws-sdk/client-pricing";
import type { PriceQuote } from "../core/price.js";
import { staticOnDemandPrice } from "../data/pricing.js";

/** The two regions that host the Pricing API endpoint. */
export type PricingRegion = "us-east-1" | "ap-south-1";

/**
 * How many Price List requests a batch has in flight at once. Go
 * PriceLookupConcurrency: the API has a low rate limit (truffle#175).
 */
export const PRICE_LOOKUP_CONCURRENCY = 4;

/**
 * The Price List filters for the Linux / shared-tenancy On-Demand rate. Go
 * onDemandFilters. `marketoption=OnDemand` matters: without it p5.4xlarge
 * returns its CapacityBlock row too, priced $0.00 (#42).
 */
export function onDemandFilters(instanceType: string, regionCode: string) {
  const term = (Field: string, Value: string) => ({ Type: "TERM_MATCH" as const, Field, Value });
  return [
    term("instanceType", instanceType),
    term("regionCode", regionCode),
    term("operatingSystem", "Linux"),
    term("tenancy", "Shared"),
    term("preInstalledSw", "NA"),
    term("capacitystatus", "Used"),
    term("marketoption", "OnDemand"),
  ];
}

/**
 * Fetch the on-demand Linux/Shared $/hr for one instance type in one region.
 * Returns undefined when no price row has a positive USD rate (leave it unset
 * rather than guessing); throws on an API error. Ports Go fetchOnDemandPrice:
 * every returned item is examined, not just the first.
 */
export async function fetchOnDemandPrice(
  client: PricingClient,
  instanceType: string,
  regionCode: string,
): Promise<number | undefined> {
  const res = await client.send(
    new GetProductsCommand({
      ServiceCode: "AmazonEC2",
      FormatVersion: "aws_v1",
      Filters: onDemandFilters(instanceType, regionCode),
    }),
  );
  for (const raw of res.PriceList ?? []) {
    const usd = parseOnDemandUsd(typeof raw === "string" ? raw : JSON.stringify(raw));
    if (usd !== undefined) return usd;
  }
  return undefined;
}

/**
 * Extract the on-demand USD/hr from a Price List product JSON string. Pure, so
 * it's unit-testable without the SDK. Ports Go parseOnDemandFromPriceItem: it
 * walks every offer and price dimension and returns the first POSITIVE USD
 * rate, skipping the $0.00 placeholders AWS emits. Undefined if there is none.
 */
export function parseOnDemandUsd(productJson: string): number | undefined {
  let prod: unknown;
  try {
    prod = JSON.parse(productJson);
  } catch {
    return undefined;
  }
  const onDemand = (prod as { terms?: { OnDemand?: Record<string, unknown> } })?.terms?.OnDemand;
  for (const offer of Object.values(onDemand ?? {})) {
    const dims = (offer as { priceDimensions?: Record<string, unknown> })?.priceDimensions;
    for (const dim of Object.values(dims ?? {})) {
      const usd = (dim as { pricePerUnit?: { USD?: string } })?.pricePerUnit?.USD;
      if (usd === undefined) continue;
      const n = Number(usd);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function errText(e: unknown): string {
  const name = (e as { name?: string })?.name;
  const msg = (e as { message?: string })?.message ?? String(e);
  return name && name !== "Error" && !msg.startsWith(name) ? `${name}: ${msg}` : msg;
}

/**
 * The on-demand price for one (type, region): live first, then the static
 * table, with the origin of whichever answered. Ports Go fallbackPricer, plus
 * the part truffle#184 says Go still lacks: when the static table answers, the
 * live failure is KEPT as the price's reason, so it can be printed.
 */
export async function lookupOnDemandPrice(
  client: PricingClient,
  instanceType: string,
  region: string,
): Promise<PriceQuote> {
  let reason: string;
  try {
    const usd = await fetchOnDemandPrice(client, instanceType, region);
    if (usd !== undefined) return { instanceType, region, price: usd, origin: { source: "live" } };
    reason = `live Price List has no on-demand price for ${instanceType} in ${region}`;
  } catch (e) {
    reason = `live Price List failed: ${errText(e)}`;
  }
  return staticOnDemandPrice(instanceType, region, reason);
}

/** Key for one price lookup. */
export interface PriceKey {
  instanceType: string;
  region: string;
}

/**
 * Price many (type, region) pairs: each distinct key once, at most
 * PRICE_LOOKUP_CONCURRENCY in flight. Ports Go Client.OnDemandPrices (one
 * request per key; Go's one-request-per-type grouping is an optimisation not
 * ported). The map is keyed `${instanceType}\u0000${region}`.
 */
export async function lookupOnDemandPrices(
  client: PricingClient,
  keys: PriceKey[],
  concurrency = PRICE_LOOKUP_CONCURRENCY,
): Promise<Map<string, PriceQuote>> {
  const unique = new Map<string, PriceKey>();
  for (const k of keys) unique.set(priceKey(k.instanceType, k.region), k);
  const queue = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map<string, PriceQuote>();
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, k] = next;
      out.set(key, await lookupOnDemandPrice(client, k.instanceType, k.region));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return out;
}

/** The map key lookupOnDemandPrices uses. */
export function priceKey(instanceType: string, region: string): string {
  return `${instanceType}\u0000${region}`;
}
