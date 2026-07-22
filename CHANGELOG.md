# Changelog

All notable changes to **truffle-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

## [0.4.0] — 2026-07-22

### Added
- **Live Finder** (`@spore-host/truffle-ts/live`, #17) — `AwsLiveFinder`
  implements the `LiveFinder` seam to query real AWS at runtime
  (`DescribeInstanceTypes` per region → mapped + filtered with the same
  `matchesFilters` as the offline path), for Node/CLI/server consumers. Optional
  on-demand pricing via the Pricing API (`pricing: "lazy"`). `find(query, {
  finder })` takes it with no core change; `BundledFinder` stays the default.
  The AWS SDK is an **optional dependency** reachable only through the `./live`
  subpath — the default `.` import stays SDK-free (guarded by an isolation test),
  so browser bundles are unaffected. `getEnabledRegions` included; spot/quota
  (`getSpotPricing`) deferred to #18.

## [0.3.0] — 2026-07-21

### Added
- **Live catalog generator** (`scripts/gen-catalog.mjs`) — regenerates
  `src/data/instances.json` from **real AWS data**: EC2 `DescribeInstanceTypes`
  for specs (vCPU/cores/threads-per-core/memory/arch/GPU/nested-virt) and the
  Pricing API for on-demand `$/hr`, over the curated family set. Read-only AWS,
  run out-of-band with credentials. `InstanceType` gains an optional
  `estimatedPrice` flag.

### Changed
- **The bundled catalog is now real AWS data** ("as of 2026-07"): 231 types,
  219 live-priced. Prices reflect current us-east-1 on-demand rates (e.g.
  `p5.48xlarge` $55.04, not the old $98.32 estimate); specs are exact (e.g.
  `t4g.micro` is 2 vCPU / 1 GiB). 12 legacy/brand-new GPU types not offered in
  us-east-1 (g3/p2/p3, p5e, p6e-gb200) are carried from the seed and marked
  `estimatedPrice`, so GPU-name resolution and the drift-invariant still hold.
  `CATALOG_AS_OF` → `2026-07`.

## [0.2.0] — 2026-07-20

### Added
- **Glob / regex pattern search** (`src/core/pattern.ts`) — `find` now
  auto-detects when a query is an instance-type *pattern* (`m7i*`, `c[6-8]i.large`,
  `(m7i|c7i).large`) and matches it directly against instance-type names,
  bypassing the natural-language parser. Ports the Go `looksLikePattern` /
  `patternToRegex` / `wildcardToRegex` helpers, exported alongside a new
  `findByPattern`.
  - **Deliberate divergence from Go**: a bare word like `a100` / `c6i` stays on
    the NL path (→ the A100 instance types / the c6i family) instead of being
    matched as a literal name, which in Go finds nothing. Use an explicit glob
    (`a100*`, `m7i*`) to force a name pattern.

## [0.1.1] — 2026-07-20

### Added
- **`prepare` script** — builds the library (`build:lib`) on install, so the
  package can be consumed as a git dependency (e.g. `spore-host/truffle-ts#v0.1.1`)
  without the prebuilt `dist/` being committed. No API change.

## [0.1.0] — 2026-07-20

Initial release — the offline find foundation.

### Added
- **Documentation** (`docs/`) — architecture (the pipeline + `Finder` seam +
  layering), query-language (every token type + qualitative sort + conflicts +
  strict card resolution), catalog (the offline snapshot, pricing, why there's a
  seed generator), and an API guide, with a docs index. README gains an
  instance-picker consumer example and doc links; TypeDoc is published to
  `/api/` (issue #7).
- **Standalone demo** (`src/ui/search.ts`) — a search box over the library: type
  a natural-language query, pick a sort, and see matching instance types with
  the reasons they matched, an estimated $/hr, and a "bundled catalog · as of
  2026-01" staleness badge. Example-query chips. DOM lives only here; the library
  stays pure. happy-dom tests drive the widget end-to-end (issue #6).
- **Finder seam + bundled catalog + `find()`** — the keystone that makes the
  library usable offline. `find(query)` runs the whole pipeline (parse →
  criteria → search → sort → explain) and returns ranked, explained results with
  zero setup. The `Finder` seam (`src/core/finder.ts`) mirrors the Go
  `pkg/aws.Finder` + spawn-ts's Provider pattern: v0.1.0 ships one async `search`
  method + the default `BundledFinder` over a committed 154-type catalog snapshot
  (`src/data/instances.json`, "as of 2026-01"), with a `LiveFinder` sub-interface
  reserved for a future live-AWS backend. Static pricing (`src/data/pricing.ts`)
  ports `libs/pricing` (exact table + family estimate). A drift-invariant test
  asserts every `GPUDatabase` instance type exists in the catalog (issue #5).
- **Resolve + criteria + filter + explain + sort** (`src/core/`) — the rest of
  the find pipeline, ported from Go `pkg/find` (`resolve.go`/`executor.go`/
  `result.go`) and `matchesFilters` (`client.go`): `resolveInstanceFamilies`/
  `resolveGpuInstances`/`deriveArchitecture`/`buildSizePattern`, `resolveCard`/
  `cardInstanceTypes` + `ErrNoMatch` (strict, never match-all); `buildCriteria`
  → `{ pattern, filters }`; `matchesFilters` as an in-memory pass; `explainMatch`
  (human match reasons); `sortResults` (cheapest/expensive/performant/newest,
  unknown prices last). Families are emitted in sorted order for deterministic
  patterns. Go test tables ported by behavior (issue #4).
- **Query parser** (`src/core/parser.ts`) — a faithful port of the Go
  `pkg/find/parser.go`: `parseQuery` tokenizes a free-text query and classifies
  each token (vendor/processor/GPU/size/vCPU/memory/GPU-count/arch/network/EFA/
  nested-virt/app/qualitative) with longest-phrase-first matching against the
  catalogs, resolving multi-word names and marketing spellings. Includes
  `sortPreference` (cheapest/fastest/newest from qualitative keywords) and
  conflicting-architecture validation. The Go `parser_test.go` table is ported
  1:1 (issue #3).
- **Metadata catalogs** (`src/metadata/`) — a direct port of the Go tool's
  `pkg/metadata`: processors (code names → vendor/arch/generation/families +
  vendor aliases), GPUs (H100/A100/L40S/Trainium… → memory/use-case/families/
  exact instance types + aliases), network (EFA-capable families, bandwidth
  tiers, aliases), and size categories. Plus a seed of the app catalog
  (`spore-host/libs/catalog`). Exported via the `./metadata` subpath and the
  main barrel (issue #2).
- Repo scaffold + library packaging: Apache-2.0 license, contributor guide, ESM
  library build (`tsc` → `dist/` with `.d.ts` declarations) separate from the
  Vite demo build (→ `site/`), `package.json` `exports` map (`.` + `./metadata`),
  TypeDoc, and CI (typecheck + test + build) (issue #1).

[Unreleased]: https://github.com/spore-host/truffle-ts/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/spore-host/truffle-ts/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/spore-host/truffle-ts/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/spore-host/truffle-ts/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/spore-host/truffle-ts/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/spore-host/truffle-ts/releases/tag/v0.1.0
