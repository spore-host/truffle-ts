# API reference

Everything below is exported from the package root (`@spore-host/truffle-ts`).
The full generated reference lives at the
[TypeDoc site](https://spore-host.github.io/truffle-ts/api/); this page is the
orientation.

## One call

```ts
import { find } from "@spore-host/truffle-ts";

const results = await find("nvidia h100 8gpu efa");
for (const { instance, reasons } of results) {
  console.log(instance.instanceType, instance.onDemandPrice, reasons);
}
```

- **`find(query: string, opts?: FindOptions): Promise<FindResult[]>`** — parse →
  resolve → search → sort → explain, over the bundled catalog by default.
  `FindOptions` = `{ sort?: SortPreference; finder?: Finder }`.
- **`findInstances(finder, parsed, opts?)`** — the lower-level entry when you've
  already `parseQuery`'d and want to reuse it or supply a specific finder.

## The pipeline pieces

For consumers that want control over a stage:

- **`parseQuery(text): ParsedQuery`** — tokenize + classify (throws on empty /
  conflicting-architecture input). Plus `sortPreference(pq)` and
  `qualitativeTokens(pq)`.
- **`buildCriteria(pq): SearchCriteria`** — `{ pattern: RegExp, filters:
  FilterOptions }`. Plus `buildInstanceTypePattern(pq)`.
- **`matchesFilters(instance, filters): boolean`** — the in-memory filter.
  Plus `extractFamily(type)` and `perGpuMemoryGiB(instance)` (VRAM **per card** —
  `gpuMemoryMib` is the aggregate across all of them).
- **`explainMatch(instance, pq): string[]`** — human match reasons.
- **`sortResults(instances, pref): InstanceType[]`** — ranking.
  Plus `instanceGeneration(type)`.
- **`resolveCard(name)` / `cardInstanceTypes(name)` / `ErrNoMatch`** — strict
  card → instance-types resolution.

## The data source (Finder seam)

- **`Finder`** — `{ label, isLive, search(matcher, filters) }`. Implement this to
  back `find` with something other than the bundled catalog.
- **`BundledFinder`** — the default, offline, over `instances.json`.
- **`LiveFinder`** — the extension a live-AWS backend implements:
  `getEnabledRegions()`, `getSpotPricing(instances, opts)`, `getQuotas(opts)`,
  `canLaunch(instance, quotas, spot?)`. Implemented by `AwsLiveFinder` on the
  [`./live` subpath](catalog.md#live-data-the-live-finder).
- **`loadBundledCatalog()`**, **`CATALOG_AS_OF`**, **`CATALOG_REGION`**: the raw
  snapshot, its date and the region its prices are for.
- **`staticOnDemandPrice(type, region?)`**: a `PriceQuote` (`{ price?, origin }`)
  from the static tables. Exact match only, never an estimate. See
  [Pricing](catalog.md#pricing).
- **`describePrice(quote)`**, **`describePriceOrigin(origin)`**: the one label for
  a price's provenance. A static price always names its collection date and the
  reason it's static (truffle#184).
- **`onDemandPrice(type, region?)`**: `staticOnDemandPrice(...).price`, which is
  `number | undefined`. `undefined` means no price is available and must render as
  unknown, never as `0`.
- **`STATIC_EC2_PRICES`**, **`STATIC_PRICES_AS_OF`**, **`STATIC_PRICES_SOURCE`**:
  the libs-generated region-keyed table, its collection date and its source.
  `EC2Pricing` is deprecated and kept as that table's us-east-1 slice.
- **`lookupApp(nameOrAlias)`**, **`listApps()`**, **`AppCatalog`**: the app
  catalog, generated from libs `catalog.yaml`. `lookupApp("imagej")` is fiji.

## Types

`InstanceType` (with `region?` on live rows, and `priceOrigin?`), `PriceSource`,
`PriceOrigin`, `PriceQuote`, `FilterOptions`, `FindResult`, `Architecture`, `ParsedQuery`,
`Token`, `TokenType`, `SortPreference`, `SearchCriteria`, the live-finder types
(`SpotPriceResult`, `SpotOptions`, `QuotaFamily`, `QuotaInfo`, `QuotaOptions`,
`QuotaVerdict`), and the metadata types (`ProcessorInfo`, `GPUInfo`,
`NetworkCapability`, `SizeCategory`, `AppEntry`).

## Metadata subpath

The static catalogs are also importable on their own, without the engine:

```ts
import { GPUDatabase, ProcessorDatabase } from "@spore-host/truffle-ts/metadata";
```
