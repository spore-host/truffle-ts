// gen-catalog — regenerate src/data/instances.json from LIVE AWS data.
//
// Unlike scripts/seed-catalog.mjs (hand-curated specs), this pulls real specs
// from EC2 DescribeInstanceTypes and real on-demand $/hr from the Pricing API,
// for a CURATED set of instance-type families (every GPU family + common
// graviton/Intel/AMD). Read-only AWS: describe + pricing, never a launch.
//
// Usage:  AWS_PROFILE=<profile> node scripts/gen-catalog.mjs [--region us-east-1]
//
// Requires the AWS CLI on PATH and credentials for describe + pricing. Run
// out-of-band (it needs creds a browser can't have); commit the resulting JSON.
// The bundled catalog stays an approximate snapshot — record the date you ran it.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const region = (() => {
  const i = process.argv.indexOf("--region");
  return i >= 0 ? process.argv[i + 1] : "us-east-1";
})();

// The curated family set: derived from the families already in the committed
// catalog, so regeneration keeps the same coverage (every GPU family + common
// CPU families) without ballooning to all ~800 us-east-1 types.
const catalogPath = fileURLToPath(new URL("../src/data/instances.json", import.meta.url));
const existing = JSON.parse(readFileSync(catalogPath, "utf8"));
const families = [...new Set(existing.map((e) => e.instanceFamily))].sort();

function aws(args) {
  const out = execFileSync("aws", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

// 1. Enumerate the instance types in our families that actually exist in-region.
console.error(`Enumerating instance types for ${families.length} families in ${region}…`);
const describe = aws([
  "ec2", "describe-instance-types", "--region", region,
  "--filters", `Name=instance-type,Values=${families.map((f) => `${f}.*`).join(",")}`,
  "--output", "json",
]);

const toEntry = (it) => {
  const gpu = it.GpuInfo?.Gpus?.[0];
  const gpuCount = (it.GpuInfo?.Gpus ?? []).reduce((n, g) => n + (g.Count ?? 0), 0);
  const nested = (it.ProcessorInfo?.SupportedFeatures ?? []).includes("nested-virtualization");
  const e = {
    instanceType: it.InstanceType,
    instanceFamily: it.InstanceType.split(".")[0],
    vcpus: it.VCpuInfo.DefaultVCpus,
    physicalCores: it.VCpuInfo.DefaultCores,
    threadsPerCore: it.VCpuInfo.DefaultThreadsPerCore,
    memoryMib: it.MemoryInfo.SizeInMiB,
    architecture: it.ProcessorInfo.SupportedArchitectures.includes("arm64") ? "arm64" : "x86_64",
    nestedVirt: nested,
    // Deliberately absent, not 0 — see the price loop below. An unfilled price
    // must read as "we don't know", and 0 is a claim (and the worst one, since it
    // sorts first in any cheapest ranking).
  };
  if (gpu && gpuCount > 0) {
    e.gpus = gpuCount;
    e.gpuModel = gpu.Name;
    e.gpuManufacturer = (gpu.Manufacturer ?? "").toLowerCase() || undefined;
    e.gpuMemoryMib = (it.GpuInfo.TotalGpuMemoryInMiB ?? (gpu.MemoryInfo?.SizeInMiB ?? 0) * gpuCount) || undefined;
  }
  return e;
};

const entries = describe.InstanceTypes.map(toEntry);
console.error(`  got ${entries.length} instance types`);

// 2. Fetch real on-demand $/hr per type from the Pricing API (us-east-1 endpoint,
//    Linux/Shared/Used). A type with no usable row is left WITHOUT onDemandPrice,
//    so it reads as unknown. Pricing is served only from us-east-1 / ap-south-1.
//
// --max-results is 20, not 1, and the rows are filtered rather than taken
// positionally. This is the p5.4xlarge bug (#42): that type returns TWO rows —
//
//   marketoption=CapacityBlock  $0.0000  "per Capacity Block … Instance Hour"
//   marketoption=OnDemand       $6.8800  "per On Demand … Instance Hour"
//
// — and with --max-results 1 the API handed back the Capacity Block row first, so
// the catalog claimed a 1×H100 machine cost nothing. The zero was never missing
// data; it was a real price for a different purchasing model. Capacity Block
// hours are pre-paid in a block, so the hourly dimension genuinely is $0 — a
// number that is correct in its own context and catastrophic in ours.
console.error(`Fetching on-demand prices…`);
let priced = 0;
const unpriced = [];
for (const e of entries) {
  try {
    const res = aws([
      "pricing", "get-products", "--region", "us-east-1", "--service-code", "AmazonEC2",
      "--filters",
      `Type=TERM_MATCH,Field=instanceType,Value=${e.instanceType}`,
      `Type=TERM_MATCH,Field=regionCode,Value=${region}`,
      `Type=TERM_MATCH,Field=operatingSystem,Value=Linux`,
      `Type=TERM_MATCH,Field=tenancy,Value=Shared`,
      `Type=TERM_MATCH,Field=capacitystatus,Value=Used`,
      `Type=TERM_MATCH,Field=preInstalledSw,Value=NA`,
      "--max-results", "20", "--output", "json",
    ]);
    const usd = pickOnDemandUsd(res.PriceList ?? [], e.instanceType);
    if (usd != null) {
      e.onDemandPrice = Number(usd.toFixed(4));
      priced++;
    } else {
      unpriced.push(e.instanceType);
    }
  } catch (err) {
    console.error(`  price lookup failed for ${e.instanceType}: ${err.message}`);
    unpriced.push(e.instanceType);
  }
}
console.error(`  priced ${priced}/${entries.length}`);
// Name them. A silent gap here is how a whole family ends up priceless without
// anyone noticing until a user asks what it costs.
if (unpriced.length) {
  console.error(`  NO on-demand price (left absent): ${unpriced.join(", ")}`);
}

/**
 * The on-demand USD from a PriceList, or null.
 *
 * Rejects any row that isn't marketoption=OnDemand, and rejects a zero outright:
 * no EC2 instance type costs nothing per hour, so a 0 here can only be a
 * different purchasing model or a data artifact. Returning null makes that read
 * as "unknown" downstream instead of "free".
 */
function pickOnDemandUsd(priceList, instanceType) {
  const candidates = [];
  for (const raw of priceList) {
    let prod;
    try {
      prod = JSON.parse(raw);
    } catch {
      continue;
    }
    const market = prod.product?.attributes?.marketoption;
    // Absent marketoption is treated as on-demand: older rows predate the
    // attribute, and rejecting them would drop real prices.
    if (market != null && market !== "OnDemand") continue;
    for (const term of Object.values(prod.terms?.OnDemand ?? {})) {
      for (const dim of Object.values(term.priceDimensions ?? {})) {
        const usd = Number(dim.pricePerUnit?.USD);
        if (Number.isFinite(usd) && usd > 0) candidates.push(usd);
      }
    }
  }
  if (candidates.length === 0) return null;
  // More than one surviving on-demand row for one type is unexpected; take the
  // lowest and say so rather than picking silently by position.
  if (candidates.length > 1) {
    console.error(`  ${instanceType}: ${candidates.length} on-demand rows (${candidates.join(", ")}) — taking lowest`);
  }
  return Math.min(...candidates);
}

// 3. Preserve GPU instance types the live query didn't return (legacy families
//    like g3/p2/p3 or brand-new ones like p5e/p6e-gb200 not offered in this
//    region/account). The drift-invariant test requires every GPUDatabase type
//    to exist in the catalog, and dropping them would break GPU-name resolution
//    offline. Carry the prior entry forward, marked estimatedPrice so it's clear
//    it isn't live. Which types matter is read from src/metadata/gpus.ts.
//
// A carried entry keeps its SPECS but must not keep an unvouched-for price. This
// is the p6e-gb200.36xlarge bug (#39): the seed's price for it was
// estimatePriceByFamily's fallback — unknown family → $0.10 base × 2.0 →
// **$0.20/hr for a 72×B200 rack** whose real price is around $100/hr. Carried
// forward with estimatedPrice: true, it then won every `cheapest` ranking,
// presenting the single most expensive machine in the catalog as the budget
// option. The estimator is fine as a rough hint for a mid-range CPU box and
// worthless for an accelerator it has never heard of, and there is no way to tell
// those two cases apart from the number alone.
//
// So: carry a price only if it came from a real pull (a prior live price, or an
// exact hand-verified table hit). Otherwise drop the field. An accelerator with
// no price is a normal, honest state; a $0.20 B200 is not.
const gpusSrc = readFileSync(fileURLToPath(new URL("../src/metadata/gpus.ts", import.meta.url)), "utf8");
const gpuTypes = new Set([...gpusSrc.matchAll(/"([a-z0-9]+[0-9][a-z0-9-]*\.[0-9a-z]+)"/g)].map((m) => m[1]));
const live = new Set(entries.map((e) => e.instanceType));
const priorByType = new Map(existing.map((e) => [e.instanceType, e]));
let carried = 0;
let dropped = 0;
for (const t of gpuTypes) {
  if (live.has(t)) continue;
  const prior = priorByType.get(t);
  if (!prior) continue;
  const e = { ...prior, estimatedPrice: true };
  // A prior entry that was itself estimated carries no evidence of a real price,
  // so it can't launder one forward across regenerations.
  const priorWasEstimated = prior.estimatedPrice === true;
  const usable = typeof prior.onDemandPrice === "number" && prior.onDemandPrice > 0;
  if (!usable || priorWasEstimated) {
    delete e.onDemandPrice;
    dropped++;
  }
  entries.push(e);
  carried++;
}
if (carried) console.error(`  carried ${carried} GPU type(s) not offered in ${region} (marked estimatedPrice)`);
if (dropped) console.error(`  dropped the price on ${dropped} carried type(s) with no real prior price`);

// 4. Refuse to write a catalog containing a zero or negative price. Both bugs
//    this script grew guards for shipped as committed JSON, so the last line of
//    defence belongs here, before the write — a bad price that reaches
//    instances.json is a bad price in everyone's node_modules.
const bad = entries.filter((e) => e.onDemandPrice != null && !(e.onDemandPrice > 0));
if (bad.length) {
  console.error(
    `REFUSING TO WRITE: ${bad.length} entr${bad.length === 1 ? "y" : "ies"} with a non-positive price: ` +
      bad.map((e) => `${e.instanceType}=${e.onDemandPrice}`).join(", "),
  );
  console.error(`No EC2 type costs nothing per hour — omit the field instead.`);
  process.exit(1);
}

entries.sort((a, b) => (a.instanceType < b.instanceType ? -1 : 1));
writeFileSync(catalogPath, JSON.stringify(entries, null, 2) + "\n");
console.error(`Wrote ${entries.length} instance types → ${catalogPath}`);
console.error(`Remember to update CATALOG_AS_OF in src/data/catalog.ts to this month.`);
