# The bundled catalog

`find` runs offline because truffle-ts ships a **bundled snapshot** of instance
specs and prices. This page explains what that snapshot is, its shape, and how to
regenerate it.

## What it is

`src/data/instances.json` is a committed array of `InstanceType` records —
~150 types covering **every GPU family** the metadata references (p2–p6, g3–g7e,
inf/trn) plus representative graviton, Intel, and AMD CPU families across sizes.
`BundledFinder` (the default `Finder`) queries it with a single in-memory pass.

```jsonc
{
  "instanceType": "p5.48xlarge",
  "instanceFamily": "p5",
  "vcpus": 192,
  "memoryMib": 2097152,
  "architecture": "x86_64",
  "threadsPerCore": 2,
  "nestedVirt": false,
  "onDemandPrice": 55.04,
  "gpus": 8,
  "gpuModel": "H100",
  "gpuManufacturer": "nvidia",
  "gpuMemoryMib": 655360
}
```

> ⚠️ **It is a point-in-time snapshot ("as of 2026-07") — not a live query.**
> Since 0.3.0 the snapshot is generated from real AWS data (see below), but
> specs and prices still drift after the pull; treat prices as indicative. The
> demo shows a "bundled catalog · as of 2026-07" badge to make this explicit. A
> few legacy/brand-new GPU types not offered in the generated region are carried
> from the earlier hand seed and flagged `estimatedPrice: true`.
>
> **A price is either real or absent — never guessed.** `onDemandPrice` is only
> present when it came from a real Price List pull. A type we have no price for
> omits the field, so it reads as unknown rather than cheap. Two invariants the
> tests enforce: no entry ever carries a non-positive price (a `0` sorts *first*,
> so it recommends the instance we know least about), and no priced GPU entry
> comes in under $0.05 per GPU-hour.

## Pricing

A price is either real or absent. truffle-ts doesn't estimate prices (#29). Go
truffle removed its family × size estimator after truffle#114, where it priced
`hpc7a.96xlarge` at $0.20/hr against a real $7.20. truffle-ts's
`estimatePriceByFamily` returned the same $0.20, so it's gone too.

`staticOnDemandPrice(type, region = "us-east-1")` looks up an exact
(region, instance type) pair in two static tables. Both hold real Price List
rates, collected on a known date:

| table | regions | collected | source |
|---|---|---|---|
| `STATIC_EC2_PRICES` | 8 | `STATIC_PRICES_AS_OF` (2026-10-07) | generated from `spore-host/libs` `pricing.EC2Pricing`, the table Go truffle falls back to |
| the bundled catalog | us-east-1 only | `CATALOG_AS_OF` (2026-07) | `scripts/gen-catalog.mjs` |

The result is a `PriceQuote`: `{ price?, origin }`. On a miss, `price` is
`undefined` and `origin` is `{ source: "unknown", reason }`. The reason says
what was missing, for example `no static price table for region sa-east-1`.

Every static price says that it's static, why the live Price List wasn't used,
and when the static data was collected (truffle#184). `origin` carries all three
(`source: "static"`, `reason`, `collectedOn`), and `describePrice(quote)` renders
them in one fixed form, so the wording can't drift between consumers:

```
$0.0832/hr on-demand (static, collected 2026-10-07 (live Price List not consulted (offline lookup)))
```

Bundled-catalog entries carry the same `priceOrigin`. The demo prints it under
the results table.

`onDemandPrice(type, region?)` is `staticOnDemandPrice(...).price`, kept for
existing callers. It returns `undefined` more often than before, because it no
longer guesses. Render `undefined` as unknown, never as `0`.

The two static tables are asserted to agree within 10% wherever both have a type.
Two price tables in one package drift (#39). The one disagreement found when the
libs table was adopted was `p4d.24xlarge`: libs has 32.77, while the live rate is
21.9576. That libs entry is stale (spore-host/libs#67), so the generator drops it
(`KNOWN_STALE` in `scripts/gen-upstream.mjs`) and the lookup falls through to the
catalog's live-pulled rate.

### Regenerating the libs-derived data (`gen-upstream`)

`src/data/static-prices.generated.ts` and `src/metadata/apps.generated.ts` are
generated from a libs checkout or module-cache directory:

```bash
npm run gen:upstream -- --libs "$(go env GOMODCACHE)/github.com/spore-host/libs@v0.51.2"
```

To check the committed files are current, set `TRUFFLE_LIBS_DIR` to the same
directory and run `npm test`. That runs the drift test in
`src/data/pricing.test.ts`; without the variable the test is skipped, since CI
has no Go module cache.

Live pricing (the AWS Price List **Query** API) needs IAM credentials + SigV4, so
it belongs behind a live `Finder` rather than in the default offline path — but it
*is* browser-feasible: `api.pricing.us-east-1.amazonaws.com` answers a preflight
from `https://spore.host` with `access-control-allow-origin: *`, and SigV4 over
short-lived STS credentials works in a tab. The unauthenticated bulk offer files
are a different matter: they're hundreds of MB, which rules them out for a browser
fetch on size alone.

## Regenerating from live AWS (`gen-catalog`)

`scripts/gen-catalog.mjs` regenerates `instances.json` from **real AWS data** —
EC2 `DescribeInstanceTypes` for specs and the Pricing API for on-demand `$/hr` —
for the curated family set (the families already in the catalog). It's read-only
(describe + pricing, never a launch) and run out-of-band, since it needs
credentials a browser can't have:

```bash
AWS_PROFILE=<profile> node scripts/gen-catalog.mjs --region us-east-1
# then bump CATALOG_AS_OF in src/data/catalog.ts and commit the JSON
```

Types in the curated families that a region doesn't offer (legacy g3/p2/p3, or
brand-new p5e/p6e-gb200) are **carried over** from the previous catalog and
flagged `estimatedPrice: true`, so GPU-name resolution still works offline and a
**drift-invariant test** (`src/data/catalog.test.ts`) — every `GPUDatabase`
instance type must exist in the catalog — keeps passing.

A carried entry keeps its **specs** but only keeps a **price** that came from a
real pull; otherwise the field is dropped. The generator also refuses to write a
catalog containing a non-positive price at all, and filters price rows by
`marketoption=OnDemand` rather than taking the API's first row — `p5.4xlarge`
returns a `CapacityBlock` row at `$0.00/hr` *before* its real `$6.88` on-demand
row, which is how a 1xH100 machine came to be listed as free.

The older `scripts/seed-catalog.mjs` (hand-curated specs) remains as the
bootstrap fallback for when AWS isn't reachable.

## Live data: the `./live` finder

Since 0.4.0 there's an opt-in **live** finder that queries real AWS at runtime
instead of the bundled snapshot — for CLI, server, and **browser** consumers
alike:

```ts
import { find } from "@spore-host/truffle-ts";
import { AwsLiveFinder } from "@spore-host/truffle-ts/live";

const finder = new AwsLiveFinder({ regions: "us-east-1" });      // creds via the default AWS chain
const results = await find("cheapest graviton 8 cores 32gb", { finder });
```

- It implements the same `Finder` seam, so `find()` takes it with no other
  change; `BundledFinder` stays the **default** and offline.
- `search` runs `DescribeInstanceTypes` per region, maps to `InstanceType` (same
  shape as the snapshot), and filters in-memory with the same `matchesFilters`.
  It returns **one row per (type, region)**, and each row carries its `region`,
  as Go's results do (#31). A type offered in two regions is two rows.
- Pricing is `"off"` by default (fast, no `pricing:GetProducts` needed). Pass
  `pricing: "lazy"` to price the result set, each row in its own region: live
  from the Price List, else the static table with the live failure as its
  `priceOrigin.reason`, as Go's fallback pricer does. The live lookup filters on
  `marketoption=OnDemand` and skips `$0.00` rows, so a CapacityBlock row can't
  report a free H100 (#42).
- The AWS SDK is an **optional dependency** reached only through the `./live`
  subpath, so the default `.` import never pulls it into a browser bundle.

### Spot prices

`getSpotPricing(instances, opts)` reads `DescribeSpotPriceHistory` for the given
types across the configured regions:

```ts
const prices = await finder.getSpotPricing(results.map((r) => r.instance), {
  showSavings: true,      // annotate onDemandPrice + savingsPercent
  maxPrice: 0.5,          // $/hr ceiling; 0/unset means no ceiling
});
```

- Every row carries an **`availabilityZone`**, because spot prices vary per AZ,
  not per region. Without it, several prices for one type in one region are
  indistinguishable.
- `lookbackHours > 1` switches to **trend** mode and returns every history point
  in the window (ordering is meaningful). `<= 1`/unset returns just the newest
  observation per AZ — the current price.
- `showSavings` needs `pricing:GetProducts`. If the on-demand lookup fails you
  still get the spot price, just without the savings annotation.
- Partial failures degrade: one region or one instance type failing doesn't lose
  the others. Only a failure in **every** region throws — a total failure must
  not be indistinguishable from "no spot data".

### Quotas

`getQuotas(opts)` returns the per-family On-Demand + Spot vCPU limits and current
usage for one region; `canLaunch` is a pure check against that snapshot:

```ts
const quotas = await finder.getQuotas();               // servicequotas:GetServiceQuota
                                                        // + ec2:DescribeInstances
const verdict = finder.canLaunch(results[0].instance, quotas);
if (!verdict.canLaunch) console.log(verdict.reason);    // names the family + headroom
```

- Families: `Standard`, `F`, `G` (shared with VT), `P`, `X`, `Inf`, `Trn`, `DL`.
- Pass `skipUsage: true` to skip the `DescribeInstances` pass (limits only).
- A family whose lookup failed is listed in **`incomplete`**, and an unknown
  limit yields `canLaunch: true` with a reason saying so — a missing quota must
  not read as "limit 0". A false "you cannot launch this" is the worse error,
  because it blocks a launch that would have succeeded.
- If the *usage* read fails, every family is marked `incomplete`: 0 used
  overstates headroom, so it must not present as a clean slate.

- Usage is split by lifecycle, as in Go #132: `usage` is On-Demand vCPUs and
  `spotUsage` is Spot vCPUs, read from each instance's `InstanceLifecycle`. A
  Spot check is made against Spot usage. Before, an account whose Spot quota was
  already full was told a launch would fit.

### Obtainability (`truffle available`)

`getObtainability(type, region?)` answers "can I actually get this right now?"
(#32, Go `Obtainability`). It collects five signals at once, and each one is
best-effort:

| signal | from |
|---|---|
| `spotPlacements` (1-10 per AZ, best first) | `GetSpotPlacementScores`, with `SingleAvailabilityZone`, `RegionNames`, `TargetCapacity: 1`, `TargetCapacityUnitType: "units"` |
| `offeredAZs` / `totalAZs` | `DescribeInstanceTypeOfferings` + `DescribeAvailabilityZones` |
| `onDemandQuotaHeadroom`, `quotaCode` | `GetServiceQuota` + `DescribeInstances` |
| `vcpusPerInstance` | `DescribeInstanceTypes` (not parsed from the name) |
| `capacityBlockOfferings` (24h, count 1) | `DescribeCapacityBlockOfferings` |

The on-demand price is attached with its `onDemandPriceOrigin`.
`obtainabilityVerdict(o)` gives Go's concerns (`spot`, `azs`, `quota`) and the
one-line summary.

A signal that fails becomes a line in `warnings` and is left undefined. Only an
empty type or region throws. `GetSpotPlacementScores` is commonly denied by SCP,
and a denied call must never read as "capacity looks fine". Two signals go
further than Go and report an unknown as unknown:

- A quota that can't be read is a warning, not "headroom 0". Go's `available`
  reports it as "quota is 0" (spore-host/truffle#271).
- A failed AZ lookup leaves `offeredAZs` undefined, not empty, so it doesn't
  read as "not offered in this region".

`RunInstances` with `DryRun` is deliberately not used. It checks permissions,
not capacity or quota, and says "would have succeeded" for types that can't be
launched.

### Availability zones (`truffle az`)

`searchAZs(matcher, filters, { azs?, minAZCount?, localZonesOnly? })` is the
AZ-first view. Each row gets `availableAZs` from one batched
`DescribeInstanceTypeOfferings` per region, and rows are ordered most AZs first.
`azs` rewrites each row down to the matched AZs and also chooses the regions, as
Go's `--az` does. `localZones` lists the Local and Wavelength zones seen, which
come from `DescribeAvailabilityZones` with `AllAvailabilityZones: true`.
`summarizeAZRegions()` is `--regions-only`, `summarizeAZs()` the summary block.
Set `includeAZs: true` on the finder to fill `availableAZs` on every `search`.
AZ lists are always in zone order: standard AZs, then edge zones.

### Capacity (`truffle capacity`, `capacity --blocks`, `capacity-blocks`)

- `getCapacityReservations(opts)`: On-Demand Capacity Reservations, most
  available first. `onlyActive`, `onlyAvailable`, `minCapacity`,
  `includeExpired`. `summarizeCapacity()` gives utilization.
- `getCapacityBlocks(opts)`: Capacity Blocks for ML you already own, soonest
  first.
- `getCapacityBlockOfferings({ instanceType, durationHours, instanceCount?,
  startDate?, startAfter?, endBy?, sort? })`: purchasable offerings, cheapest
  first. The duration is rounded **up** to a valid one (1-day steps to 14 days,
  then 7-day steps to 182), and `durationRoundedFrom` says when it was. The
  window defaults to now through duration + 1 day.
  `noOfferingsMessage()` names the instance count first, because a count above 1
  silently gates offerings (#109).

All three are multi-region and return `{ results, regionErrors }`. A failed
region is listed; it's never folded into "nothing found". If every region fails
they throw. When every region answers that the type isn't a Capacity Block type,
the error says so instead (#110).

### Listing types (`truffle list`)

`listInstanceTypes(finder?)` lists the bundled catalog offline, and
`AwsLiveFinder.listInstanceTypes(region?)` lists one live region. Both are
sorted. `instanceFamilies()` and `instanceSizes()` are `--family` and `--sizes`.

### Running the live finder in a browser

No proxy is needed, and the earlier claim that one was is wrong on both of its
premises:

- **The endpoints are CORS-open.** Preflighted from `Origin: https://spore.host`,
  `ec2`, `api.pricing`, and `servicequotas` in `us-east-1` each return
  `access-control-allow-origin: *`, `access-control-allow-methods: POST`, and
  `access-control-allow-headers: content-type,x-amz-target,authorization`.
- **A browser can hold usable credentials** — not a long-lived access key, but a
  short-lived STS session. spawn-ts's `credsFromIdToken` exchanges a Globus OIDC
  `id_token` for `AssumeRoleWithWebIdentity` credentials that live in the tab and
  expire on their own; pass them straight to `AwsLiveFinder`.

```ts
import { AwsLiveFinder } from "@spore-host/truffle-ts/live";
const finder = new AwsLiveFinder({ regions: "us-east-1", credentials });
```

What still argues for `BundledFinder` as the default is cost and latency, not
reachability: the live path spends API calls, wants `pricing:GetProducts` for
savings annotations, and pulls the AWS SDK into the bundle (which is why it sits
behind the `./live` subpath).
