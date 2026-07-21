# Architecture

truffle-ts answers one question — *"which EC2 instance types match what I asked
for?"* — as a five-stage pipeline over a pluggable data source. It's a
browser-native port of the Go [`truffle`](https://github.com/spore-host/truffle)
tool's `find` command.

## The pipeline

```
"nvidia h100 8gpu efa"
   │
   ▼  parseQuery            (core/parser.ts)
ParsedQuery { gpus:[h100], gpuCount:8, requireEfa:true, … }
   │
   ▼  buildCriteria         (core/criteria.ts + core/resolve.ts)
{ pattern: /^(p5\.48xlarge)$/, filters: { … } }
   │
   ▼  finder.search         (core/finder.ts → data/bundled-finder.ts)
InstanceType[]              (matcher + matchesFilters over the catalog)
   │
   ▼  sortResults           (core/sort.ts)
   ▼  explainMatch          (core/explain.ts)
FindResult[] { instance, reasons }
```

`find(query)` runs the whole chain; each stage is also exported so a consumer can
drive it directly (parse once, reuse criteria, supply its own finder, etc.).

1. **Parse** — tokenize the free text and classify each token against the
   metadata catalogs, longest-phrase-first (so `sapphire rapids` and
   `rtx pro 6000` resolve as single tokens). Produces a structured `ParsedQuery`.
2. **Resolve + build criteria** — turn the query into a RegExp over instance-type
   names (GPU queries → exact types; otherwise families, optionally narrowed by
   size) plus numeric `FilterOptions`. App-catalog entries contribute minimum
   vCPU/memory and are intersected with hardware constraints.
3. **Search** — the `Finder` returns instance types matching the pattern that
   pass the filters.
4. **Sort** — rank by the query's qualitative preference (cheapest / most vCPUs /
   newest generation), else newest-first.
5. **Explain** — annotate each result with the human-readable reasons it matched.

## The `Finder` seam

`Finder` (`core/finder.ts`) is the one boundary between the pure find engine and
the data behind it — the same role `Provider` plays in spawn-ts.

```ts
interface Finder {
  readonly label: string;    // "bundled", "aws:us-east-1", "substrate"
  readonly isLive: boolean;  // true = billable AWS
  search(matcher: RegExp, filters: FilterOptions): Promise<InstanceType[]>;
}
```

- **`BundledFinder`** (the default) runs `search` as a single in-memory pass over
  the [bundled catalog](catalog.md) — offline, no credentials, no cost.
- A future **live** finder (DescribeInstanceTypes / spot / quotas, behind a
  backend proxy) implements the `LiveFinder` sub-interface, which adds those
  methods as extensions so the core `Finder` contract never breaks. `search`
  is `async` from day one precisely so this swap needs no signature change.

## Layering (the pure-core rule)

| Layer | Depends on | Notes |
|-------|-----------|-------|
| `src/metadata/` | nothing | static catalogs (processors, GPUs, network, sizes, apps) |
| `src/core/` | metadata | the pure engine — **no DOM, no AWS, no network** |
| `src/data/` | core + metadata | bundled catalog snapshot + `BundledFinder` + pricing |
| `src/ui/` | the public API | the standalone demo — the **only** DOM code |
| `src/index.ts` | all of the above | the published barrel |

Because `core/` and `metadata/` are pure, a consumer (e.g. spawn-ts) can import
`find`/`parseQuery` anywhere — including its own pure core — without pulling in a
DOM or the AWS SDK.
