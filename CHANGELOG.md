# Changelog

All notable changes to **truffle-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**truffle-ts stays on `0.x.y` indefinitely.** There is no planned 1.0.0, so
breaking changes bump the MINOR version — permanently, not as a pre-release
convention. Read a MINOR bump as "may break you" for the life of the project.

Its version line is **its own**, and deliberately not the Go tool's: at time of
writing truffle-ts is 0.5.x against Go `truffle` v0.48.x, and matching those
numbers would assert a feature correspondence that does not exist. Parity with Go
is a **behavioural** claim with documented divergences, tracked in
[#36](https://github.com/spore-host/truffle-ts/issues/36) — never a claim that two
version strings agree.

## [Unreleased]

## [0.6.0] — 2026-10-30

Breaking, and MINOR because pre-1.0 (see the 0.x policy above). Upgrading from
0.5.x, these change what existing calls return:

- **Changed (breaking), from #82:**
  - `onDemandPrice()` no longer estimates: an unknown type returns `undefined`
    instead of a family guess, so it misses more often. It takes an optional
    `region` (default us-east-1).
  - `estimatePriceByFamily()` is removed, with no replacement.
  - `EC2Pricing` (deprecated) is now the libs us-east-1 table: more CPU types,
    fewer GPU types than the old hand table.
  - The live finder returns one row per (type, region), not one per type, and
    `sortResults` breaks ties on region. Callers that relied on one row per type
    must dedupe themselves.
  - The app catalog is generated from libs, so `jupyter`, `vscode`, `desktop`,
    `openrefine` and their aliases now parse as app words.
- **Changed (breaking), from #84:**
  - `find` ranks size queries closest fit first, not newest generation first.
    `sortResults` takes the query's filters as an optional third argument.
  - A bare size in a GPU query (`a100 80gb`) is per-GPU memory, not host RAM.
  - Per-GPU memory is compared as the GPU is sold, and the match reason text
    changed (`GPU memory: 24 GB >= 24`).
  - An exact type or bare family (`r8g.2xlarge`, `g5`) matches that type or
    family instead of all 231 bundled types.
  - A query made only of unknown words throws `UnrecognizedQueryError` instead of
    returning every type.
  - Spot quota checks count Spot usage only: `canLaunch(..., spot = true)` can
    now refuse a launch that 0.5.x said would fit.

### Added

- **Price provenance on every price** (#29, truffle#184). The new
  `staticOnDemandPrice(type, region?)` returns a `PriceQuote`: `{ price?, origin }`,
  where `origin` is `{ source: "live" | "static" | "unknown", table?,
  collectedOn?, reason? }`. A static price always has a `reason` (why the live
  Price List wasn't used) and a `collectedOn` date. `describePrice()` and
  `describePriceOrigin()` render that in one fixed form, so every consumer uses
  the same words. `InstanceType.priceOrigin` carries it on results:
  bundled-catalog entries are labelled static (collected `CATALOG_AS_OF`), and
  live rows say whether they were priced live or fell back. Before this, a static
  2026-01 estimate couldn't be told apart from a live price, so the staleness
  warning Go prints for a static price couldn't be represented. The demo prints
  the label under its results table.
- **Region-keyed static prices from libs** (#29). `STATIC_EC2_PRICES` (8 regions,
  528 rates), `STATIC_PRICES_AS_OF` (2026-10-07) and `STATIC_PRICES_SOURCE` are
  generated from `spore-host/libs` v0.51.2 `pricing.EC2Pricing`, the table Go
  truffle falls back to. A eu-west-1 lookup now gets eu-west-1's rate. The old
  flat table gave every region us-east-1's price.
- **`InstanceType.region`** (#31). The live finder sets it on every row.
- **`scripts/gen-upstream.mjs`** (`npm run gen:upstream -- --libs <dir>`)
  generates the app catalog and the static price table from a libs directory,
  and `--check` reports drift. Set `TRUFFLE_LIBS_DIR` and `npm test` runs the
  same check. `p4d.24xlarge` (us-east-1) is excluded as known-stale: libs has
  32.77, the live rate is 21.9576 (spore-host/libs#67).
- Live pricing helpers on `./live`: `lookupOnDemandPrice` (live, then static,
  keeping the live failure as the static price's reason, as Go's
  `fallbackPricer` does), `lookupOnDemandPrices` (each distinct (type, region)
  once, at most `PRICE_LOOKUP_CONCURRENCY` = 4 in flight, as Go
  `Client.OnDemandPrices`), `onDemandFilters`, `priceKey`.
  `SpotPriceResult.onDemandPriceOrigin` labels a savings basis that came from
  the static table.
- App catalog fields `kind`, `minVramGiB`, `aliases` and `license`, plus
  `listApps()` (sorted, as Go `catalog.List`) and `APP_CATALOG_SOURCE` (#30).
- **Go truffle's `available`, `az`, `capacity`, `capacity-blocks` and `list`
  commands, on the live finder** (#32, #33). `AwsLiveFinder` gains
  `getObtainability`, `searchAZs`, `getZoneInfos`, `getCapacityReservations`,
  `getCapacityBlocks`, `getCapacityBlockOfferings` and `listInstanceTypes`. Each
  is plain EC2/Service Quotas SigV4, so it runs in a browser tab with STS
  credentials. The pure parts are exported from `./live`: duration rounding,
  default windows, sort orders, the no-offerings message, the AZ filters and
  region summaries, the zone classifier and the obtainability verdict.
  - A failed region is listed in `regionErrors` and never folded into "nothing
    found". A total failure throws, and "not a Capacity Block type in any
    region" is its own error (Go #63/#109/#110).
  - Obtainability reports two cases as unknown where Go reports them as bad: an
    unreadable quota (Go prints "quota is 0", filed as spore-host/truffle#271)
    and a failed AZ lookup (Go prints "not offered"). Its quota code comes from
    the full 8-family table; Go's `available` maps only P, G and Standard.
  - `RunInstances` with `DryRun` is deliberately not used, as in Go. It checks
    permissions, not capacity.
- **The pure derivations Go keeps inside its printer** (#34), exported from the
  main entry: closest-fit ranking (`sortFindResults`, `fitDistance`,
  `minimumSpecHint`), GPU memory as sold (`nominalGpuMemory`,
  `matchesGpuMemory`, `formatGpuMemory`), `limitTypes`, `isGPUFamily`, zone
  order, `formatPrice` per hour/minute/second, `savingsPercent`, `gpuRatios`,
  `memPerPhysicalCoreGiB`, `truncateWithEllipsis` and friends. Go's test tables
  are ported verbatim.
- `listInstanceTypes(finder?)`, `instanceFamilies`, `instanceSizes` (Go `list`).
- `isRecognizedTerm`, `hasConstraints`, `memoryReadingNote`, `suggestTerms`,
  `UnrecognizedQueryError`, `isBareFamily`; `ParsedQuery.gpuMemoryRead`; the
  `hostMemory` token; `FilterOptions.exactGpuMemory`; `InstanceType.availableAZs`;
  `QuotaInfo.spotUsage`; `sortSpotResults`.

### Changed

- **`onDemandPrice()` no longer estimates** (#29). It was
  `EC2Pricing[type] ?? estimatePriceByFamily(type)`, so it never missed. An
  unknown CPU family got $0.10 × a size multiplier: `hpc7a.96xlarge` came back
  as **$0.20/hr against a real $7.20**, 36× low. That's the same number Go
  truffle#114 removed its estimator over. It now does an exact lookup and returns
  `undefined` on a miss. It also takes an optional `region` (default
  us-east-1). The signature is unchanged, but it returns `undefined` more often.
  Breaking in behaviour, so it ships in a MINOR release.
- **The app catalog is generated from libs `catalog/catalog.yaml`**, not hand
  copied (#30). It now has all ten upstream apps, so `jupyter`, `vscode`,
  `desktop`, `openrefine` and their aliases are app words, as in Go.
- **The live finder returns one row per (type, region)** (#31). It deduped on
  the instance type alone, so `regions: ["us-east-1", "eu-west-1"]` returned a
  type offered in both as **one** row, with no way to tell which region it was
  from. Go appends every region's rows and dedupes on `{instanceType, region}`.
  `sortResults` now breaks ties on region after instance type, as Go does.
  Callers that relied on one row per type should dedupe themselves.
- **vitest 5** (from 4.1): `vitest` and `@vitest/coverage-v8` moved together
  to ^5.0.5. Dependabot had proposed them as separate PRs (#71, #72), and each failed
  `npm ci`, because the coverage plugin must match vitest's exact version. A
  Dependabot `vitest` group now keeps `vitest` and `@vitest/*` in one PR,
  majors included.
- Dependabot no longer proposes **TypeScript major** upgrades. The 7.0.2 bump
  (#54) failed `typecheck`, `test` and `build`, so it sat open and red rather than
  landing — TypeScript 7 needs a deliberate migration, not a version bump. The
  toolchain is capped at 5.x until that happens, so CI stops being red on an
  upgrade nobody scheduled.
- **`find` ranks size queries closest fit first** (Go #187). `16 cores 64gb` used
  to open with the newest generation. It now leads with the type nearest the
  request, ties going cheapest first. Rows of a type stay together, cheapest
  region first. With no size terms, the order is still newest generation first,
  now with price as the next key. `sortResults` takes the query's filters as an
  optional third argument. An estimate still never beats a real price (#39).
- **A bare size in a GPU query is per-GPU memory, named card included** (Go #236).
  `a100 80gb` is the 80 GB part (p4de) and no longer p4d's 40 GB A100s, which
  used to match on their 1152 GiB of host RAM. `ram`, `memory`, `mem`,
  `host memory` and `host ram` after a size mark host memory, and `gpu memory`
  and `per gpu` mark per-GPU memory.
- **Per-GPU memory is compared as the GPU is sold** (Go #236/#244), so `gpu 24gb`
  keeps the 22888 MiB A10G and L4. The match reason reads `GPU memory: 24 GB >= 24`
  instead of `24 GiB/GPU >= 24 GiB`.
- **Exact types and bare families take the pattern path** (Go #263), ending the
  deliberate divergence of 0.2.0. Go has checked vocabulary first since v0.51,
  so `a100` still means the GPU while `r8g.2xlarge` means that type and `g5`
  means every g5 size.

### Deprecated

- `EC2Pricing` is now the us-east-1 slice of `STATIC_EC2_PRICES`, kept so
  existing imports compile. Its contents changed: it's the libs table, which has
  more CPU types and fewer GPU types than the old hand table. GPU prices that
  were only in the old table are still found through the bundled catalog.

### Removed

- **`estimatePriceByFamily()`** (#29). It made up a price for any type it didn't
  know. Go removed the same function from libs (libs#29). There's no
  replacement, by design: a price we don't have is reported as absent.

### Fixed

- **`find("r8g.2xlarge")`, `find("trn1.32xlarge")`, `find("zzqx")` and
  `find("A100-80GB")` each returned all 231 bundled types.** All four parsed as
  unknown words, which constrain nothing. An exact type now matches itself. A
  query of only unknown words throws `UnrecognizedQueryError`, naming the words
  and suggesting the closest known one (Go #229). A hyphenated or suffixed GPU
  spec string (`a100-80gb`, `h100!`, `b200+`, `rtx-pro-6000`) is read like its
  spaced form (Go #130), so `A100-80GB` is p4de.
- **Spot quota checks counted On-Demand usage** (Go #132). Usage is now split
  by `InstanceLifecycle`, and `canLaunch(..., spot = true)` subtracts Spot
  usage. An account with a full Spot quota was told a launch would fit, and
  On-Demand headroom was understated by every running Spot instance.
- **The live Price List lookup could report a free H100** (#42, on the live
  path). gen-catalog was fixed, but the runtime `fetchOnDemandPrice` still sent
  `MaxResults: 1` with no `marketoption` filter and read only the first item.
  For `p5.4xlarge`, that item can be the CapacityBlock row at $0.00. Ported from
  Go: it filters on `marketoption=OnDemand`, reads every item, and
  `parseOnDemandUsd` skips non-positive rates, as `parseOnDemandFromPriceItem`
  does.
- **Lazy live pricing priced every row against the first region** (#31). Each
  row is now priced in its own region. A failed lookup falls back to the static
  table, labelled with why, instead of leaving the price silently unset. A row
  neither source can price gets a `priceOrigin` that says why.
- **`find("imagej")`, `find("pv")` and `find("chimera")` resolve** (#30). The
  hand-copied catalog had dropped every alias. Every description now matches
  upstream, chimerax has its `g6e` high-VRAM family back, and `min_vram_gib` and
  `license` are carried.
- **A pin's version comment can no longer silently misstate what CI runs.**
  `src/ci-hygiene.test.ts` required only that *some* `# vN` comment be present,
  never that it was true. A wrong label is worse than a missing one: it makes a
  major-version jump read as a routine same-line bump. Not hypothetical —
  Dependabot bumped nf-spawn's `checkout` pin to a **v7.0.1** SHA while leaving the
  comment reading `# v6`, and the identical pattern passed it. Two complementary
  halves now, because neither alone suffices: the test requires an exact `vX.Y.Z`
  (offline, hermetic — catches vague labels), and a new `scripts/verify-pins.sh`
  resolves each SHA against the tag its comment claims and fails if they disagree
  (needs the network, so it runs as its own CI step — catches exact-but-false
  labels the offline half cannot see). This repo's pins were already exact and
  true, so nothing needed relabelling; the gate is what changed.

### Security

- **Every GitHub Actions ref is now pinned to a commit SHA, with Dependabot to
  bump the pins** ([#46](https://github.com/spore-host/truffle-ts/issues/46)). All 10 `uses:` refs were floating tags
  (`@v4`, `@v5`, `@v3`), and a tag is mutable — `@v4` means "whatever `v4` points at when the
  job runs." `actions/checkout@v6` genuinely moved (`df4cb1c` → `d23441a`) with no
  signal to consumers, so this is not hypothetical.
  - It matters most in `publish.yml`, which uses **npm Trusted Publishing**:
    `id-token: write` + OIDC authorizes publishing `@spore-host/truffle-ts`, so whatever runs in
    that job can publish as us — and unlike a leaked `NPM_TOKEN` there is nothing
    to rotate afterward. Nothing in this repo sat between an upstream tag being
    repointed and code executing with that authority.
    `pages.yml` also holds `id-token: write`.
  - A SHA alone would trade a mutable-tag hole for a staleness one — pins never
    move, including past a security fix — so a new `.github/dependabot.yml` bumps
    them weekly with a 7-day cooldown (a freshly published tag is exactly when a
    compromised one is still unnoticed) and covers `npm` dependencies too. Its
    group pattern is `*`, not `actions/*`, so the first action from outside
    `actions/` can't silently fall outside the group.
  - `src/ci-hygiene.test.ts` makes both halves regressions rather than
    conventions — reverting a pin or dropping the Dependabot entry now fails
    `npm test`. `yaml` becomes a dev dependency for it; `"files": ["dist"]` and the
    `tsconfig.build.json` test exclusion keep it out of the published package.
  No runtime change — CI wiring and tests only.

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

[Unreleased]: https://github.com/spore-host/truffle-ts/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/spore-host/truffle-ts/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/spore-host/truffle-ts/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/spore-host/truffle-ts/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/spore-host/truffle-ts/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/spore-host/truffle-ts/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/spore-host/truffle-ts/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/spore-host/truffle-ts/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/spore-host/truffle-ts/releases/tag/v0.1.0
