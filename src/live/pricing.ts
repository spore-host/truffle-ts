// Live on-demand pricing via the AWS Price List Query API — the runtime twin of
// gen-catalog.mjs's pricing pass. Only used by the live finder's "lazy" pricing
// mode, over the small post-filter result set. NOTE: the Pricing API is served
// ONLY from us-east-1 and ap-south-1, regardless of which region you're pricing;
// the client region is fixed to one of those while `regionCode` in the filter is
// the region actually being priced.

import { PricingClient, GetProductsCommand } from "@aws-sdk/client-pricing";

/** The two regions that host the Pricing API endpoint. */
export type PricingRegion = "us-east-1" | "ap-south-1";

/**
 * Fetch the on-demand Linux/Shared $/hr for one instance type in one region.
 * Returns undefined when there's no matching price row (leave it unset rather
 * than guessing). Same TERM_MATCH filter set as gen-catalog.
 */
export async function fetchOnDemandPrice(
  client: PricingClient,
  instanceType: string,
  regionCode: string,
): Promise<number | undefined> {
  const res = await client.send(
    new GetProductsCommand({
      ServiceCode: "AmazonEC2",
      MaxResults: 1,
      Filters: [
        { Type: "TERM_MATCH", Field: "instanceType", Value: instanceType },
        { Type: "TERM_MATCH", Field: "regionCode", Value: regionCode },
        { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
        { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
        { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
        { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
      ],
    }),
  );
  const raw = res.PriceList?.[0];
  if (!raw) return undefined;
  return parseOnDemandUsd(typeof raw === "string" ? raw : JSON.stringify(raw));
}

/**
 * Extract the on-demand USD/hr from a Price List product JSON string. Exposed
 * (and pure) so it's unit-testable without the SDK. Returns undefined if the
 * structure doesn't contain a price.
 */
export function parseOnDemandUsd(productJson: string): number | undefined {
  let prod: unknown;
  try {
    prod = JSON.parse(productJson);
  } catch {
    return undefined;
  }
  const onDemand = (prod as { terms?: { OnDemand?: Record<string, unknown> } })?.terms?.OnDemand;
  const firstTerm = onDemand ? Object.values(onDemand)[0] : undefined;
  const dims = (firstTerm as { priceDimensions?: Record<string, unknown> })?.priceDimensions;
  const firstDim = dims ? Object.values(dims)[0] : undefined;
  const usd = (firstDim as { pricePerUnit?: { USD?: string } })?.pricePerUnit?.USD;
  if (usd === undefined) return undefined;
  const n = Number(usd);
  return Number.isFinite(n) ? n : undefined;
}
