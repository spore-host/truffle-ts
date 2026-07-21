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
  Plus `extractFamily(type)`.
- **`explainMatch(instance, pq): string[]`** — human match reasons.
- **`sortResults(instances, pref): InstanceType[]`** — ranking.
  Plus `instanceGeneration(type)`.
- **`resolveCard(name)` / `cardInstanceTypes(name)` / `ErrNoMatch`** — strict
  card → instance-types resolution.

## The data source (Finder seam)

- **`Finder`** — `{ label, isLive, search(matcher, filters) }`. Implement this to
  back `find` with something other than the bundled catalog.
- **`BundledFinder`** — the default, offline, over `instances.json`.
- **`LiveFinder`** — the extension a future live-AWS backend implements
  (`getEnabledRegions`, `getSpotPricing`, …).
- **`loadBundledCatalog()`**, **`CATALOG_AS_OF`** — the raw snapshot + its date.
- **`onDemandPrice(type)`**, **`estimatePriceByFamily(type)`**, **`EC2Pricing`** —
  static pricing.

## Types

`InstanceType`, `FilterOptions`, `FindResult`, `Architecture`, `ParsedQuery`,
`Token`, `TokenType`, `SortPreference`, `SearchCriteria`, and the metadata types
(`ProcessorInfo`, `GPUInfo`, `NetworkCapability`, `SizeCategory`, `AppEntry`).

## Metadata subpath

The static catalogs are also importable on their own, without the engine:

```ts
import { GPUDatabase, ProcessorDatabase } from "@spore-host/truffle-ts/metadata";
```
