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
  "onDemandPrice": 98.32,
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

## Pricing

`src/data/pricing.ts` is a port of `spore-host/libs/pricing`:

- `EC2Pricing` — an exact us-east-1 on-demand `$/hr` table for common types.
- `estimatePriceByFamily(type)` — a fallback: the family's "large" base price ×
  a size multiplier, for anything not in the table.
- `onDemandPrice(type)` — the exact table if present, else the estimate.

Live pricing (the AWS Price List **Query** API) needs IAM credentials + SigV4 and
isn't browser-feasible; it belongs behind a live `Finder`. The unauthenticated
bulk offer files are too large / CORS-uncertain for a direct browser fetch.

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

The older `scripts/seed-catalog.mjs` (hand-curated specs) remains as the
bootstrap fallback for when AWS isn't reachable.

## Roadmap: a live Finder

A live `Finder` (implementing the `LiveFinder` interface) could serve specs/
pricing directly for consumers that have a backend/substrate proxy — as opposed
to the offline bundled snapshot. Not yet built.
