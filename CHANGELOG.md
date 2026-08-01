# Changelog

All notable changes to **truffle-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

## [0.5.0] — 2026-07-31

Breaking, and MINOR because pre-1.0: `onDemandPrice()` and
`estimatePriceByFamily()` now return `number | undefined`, because the release's
central fix is that **a price is either real or absent — never guessed**. Render
`undefined` as unknown, never as `0`.

### Added
- **Spot pricing + quota surfacing on the live finder** (#18) — `AwsLiveFinder`
  completes the `LiveFinder` seam:
  - `getSpotPricing(instances, opts)` over `DescribeSpotPriceHistory`. Each
    result carries an **`availabilityZone`** (spot prices vary per AZ, not per
    region), plus optional `productType`/`timestamp`. `lookbackHours > 1`
    switches to **trend** mode (every history point, ordering meaningful); `<= 1`
    returns the newest observation per AZ. `showSavings` annotates
    `onDemandPrice`/`savingsPercent` from the Pricing API — fetched once per
    instance type, since on-demand doesn't vary by AZ. `maxPrice` filters only
    when positive (0 means "no ceiling", not "free only").
  - `getQuotas(opts)` over `servicequotas:GetServiceQuota` +
    `ec2:DescribeInstances`, returning per-family On-Demand/Spot vCPU limits and
    usage for the eight families (`Standard`, `F`, `G`+VT, `P`, `X`, `Inf`,
    `Trn`, `DL`); `skipUsage` drops the usage pass. `canLaunch(instance, quotas,
    spot?)` is a pure verdict against that snapshot.
  - New exported types: `QuotaFamily`, `QuotaInfo`, `QuotaOptions`,
    `QuotaVerdict`; `SpotPriceResult`/`SpotOptions` gained the fields above.
  - Ports Go `pkg/aws.GetSpotPricing` and `pkg/quotas`, preserving both of that
    code's hard-won fixes: partial failures degrade (one region/type/family
    failing keeps the rest) but a **total** failure throws rather than reading as
    "no data" (Go #63), and the quota family is derived from the leading
    letter-**run** so multi-letter families (`dl`, `vt`, `trn`, `inf`) aren't
    misfiled under a single-letter case (Go #64).
  - Diverges from Go deliberately, in four places: an unknown quota limit permits
    the launch with a reason saying so (a false "cannot launch" is the worse
    error); a failed usage read marks **every** family `incomplete`, since 0 used
    overstates headroom; the usage scan paginates (Go reads only the first page);
    and an unparseable size yields `undefined` rather than a silent guess of 2.
  - `@aws-sdk/client-service-quotas` joins the **optional** dependencies, still
    reachable only through the `./live` subpath — the default `.` import stays
    SDK-free (the isolation test covers the new modules).

### Fixed
- **A price is now either real or absent — never fabricated** (#39, #42). Three
  bad prices shipped in the bundled catalog, and each was wrong in a way that a
  footnote could not repair, because they were wrong *in the ranking*.
  - **`p6e-gb200.36xlarge` at `$0.2000/hr`** (#39) — a 72×B200 rack that really
    costs ~$100/hr. The number came from `estimatePriceByFamily`'s unknown-family
    fallback ($0.10 base × 2.0), and it **won `find("cheapest 64gb")`**, presenting
    the most expensive machine in the catalog as the budget option. The family ×
    size heuristic is sound for a CPU box, where price tracks size within a
    generation, and worthless for an accelerator, where the GPU dominates the price
    and the multiplier knows nothing about it — so `estimatePriceByFamily` now
    returns **`undefined`** for an accelerator family it has no base price for.
    15 of the catalog's 19 GPU families were falling through to that $0.10 default.
  - **`p5.4xlarge` at `$0.00`** (#42) — a 1×H100 machine the catalog claimed was
    free. This was never missing data: that type returns **two** Price List rows,
    and `gen-catalog.mjs`'s `--max-results 1` took the `CapacityBlock` row
    ($0.00/hr, correct in its own context) instead of the `OnDemand` row ($6.88).
    Zero is the most damaging possible wrong price because **zero sorts first**, so
    any cheapest-first UI recommends the instance with the worst data. The
    generator now filters rows by `marketoption`, rejects a non-positive price
    outright, and **refuses to write** a catalog containing one.
  - **`pricing.ts` disagreed with `instances.json`** on `p4d.24xlarge` and
    `p5.48xlarge` by 1.5–1.8× (#39). A live pull settled it in the catalog's
    favour ($21.96 and $55.04); the static table was corrected, and a test now
    asserts the two agree within 10% wherever they overlap. Two static price
    tables in one package drift, and while these did, the answer to "what does a
    `p5.48xlarge` cost" depended on whether you called `find()` or
    `onDemandPrice()`.
  - **Ranking is now three-tier**: a real price, then an estimate, then no price —
    so an estimate can never win `cheapest` *or* `expensive`. Provenance is the
    primary key; magnitude only breaks ties within a tier. Estimates are sunk
    rather than dropped, so a brand-new accelerator is still discoverable, just
    never advertised as cheap.
  - Real us-east-1 prices pulled for `g3`/`g3s`/`p2` (2026-08-01), where the
    estimator had been guessing 3.5–4.5× low — `p2.16xlarge` was $3.20 against a
    real $14.40.

  **Breaking:** `onDemandPrice(type)` and `estimatePriceByFamily(type)` now return
  `number | undefined`. Render `undefined` as unknown (the portal shows `—`), never
  as `0`.
- **GPU constraints now reach the results** (#37, #38). One seam leaked three
  defects: the parser held constraints that `buildCriteria` never forwarded, so the
  filter had nothing to apply.
  - A **bare `gpu`/`accelerator`** named no card, so it resolved to no instance
    types and was dropped in silence. `gpu with 80gb for training` — the query the
    portal itself suggested — returned CPU-only Graviton types. It now sets
    `requireGpu`, a post-filter, because a request naming no model has nothing to
    resolve *to*.
  - A **bare memory figure alongside a bare `gpu`** is now read as **VRAM**:
    `gpu with 80gb` means an 80 GiB card, not 80 GiB of DRAM. A named card
    (`a100 80gb`) keeps system-RAM semantics, since the card already pins the
    types. Explicit `80gb vram` / `141gb hbm` markers parse in either spacing.
  - **`gpuCount` was parsed and never filtered** (#38 — a faithful port of the same
    Go gap): `8 gpus` matched 1-GPU instances. New `minGpus` filter. The attached
    form `8gpu` now parses too; Go handles only the spaced form, so both projects'
    headline example, `nvidia h100 8gpu efa`, had always discarded its count.
  - VRAM compares **per card** (`gpuMemoryMib / gpus`), exported as
    `perGpuMemoryGiB`: 4 × 16 GiB of T4 is 64 GiB in aggregate and must not satisfy
    `80gb vram`. An instance with no VRAM recorded **fails** a VRAM floor rather
    than passing it — presenting an unverified type as a confirmed match is the
    worse error.
  - `ParsedQuery.ignored` collects the words the parser couldn't classify, and the
    demo renders them (*"didn't understand: training"*). Grammatical filler is
    excluded, since a notice that fires on every query is one users learn to skip.
    That's the general lesson of #37: **a dropped constraint must not be
    indistinguishable from a satisfied one.** Each new constraint also explains
    itself in `explainMatch` (`GPUs: 8 >= 8`, `GPU memory: 80 GiB/GPU >= 80 GiB`) —
    the absent reason line is exactly how #38 stayed invisible.
  - New `FilterOptions` fields `requireGpu`/`minGpus`/`minGpuMemoryGiB`; new
    `ParsedQuery` fields `requireGpu`/`minGpuMemory`/`ignored`.
- The live-finder test stub compared `EC2Client.config.region` — a resolver
  *function*, not a string — so per-region branches never matched and the
  "partial results when one region fails" test was vacuously green. The stub now
  awaits the resolver.

## [0.4.2] — 2026-07-22

### Changed
- First release published via **npm Trusted Publishing** (GitHub OIDC, no stored
  token). No functional change from 0.4.0 — validates the token-free publish
  pipeline (#28). (0.4.1 was tagged but never published; its publish job failed
  on a Node-version issue in the workflow, fixed here.)

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

[Unreleased]: https://github.com/spore-host/truffle-ts/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/spore-host/truffle-ts/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/spore-host/truffle-ts/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/spore-host/truffle-ts/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/spore-host/truffle-ts/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/spore-host/truffle-ts/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/spore-host/truffle-ts/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/spore-host/truffle-ts/releases/tag/v0.1.0
