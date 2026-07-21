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

> ⚠️ **It is an approximate snapshot, "as of 2026-01" — not live AWS data.**
> Specs and prices drift; treat prices as estimates. The demo shows a
> "bundled catalog · as of 2026-01" badge to make this explicit.

## Pricing

`src/data/pricing.ts` is a port of `spore-host/libs/pricing`:

- `EC2Pricing` — an exact us-east-1 on-demand `$/hr` table for common types.
- `estimatePriceByFamily(type)` — a fallback: the family's "large" base price ×
  a size multiplier, for anything not in the table.
- `onDemandPrice(type)` — the exact table if present, else the estimate.

Live pricing (the AWS Price List **Query** API) needs IAM credentials + SigV4 and
isn't browser-feasible; it belongs behind a live `Finder`. The unauthenticated
bulk offer files are too large / CORS-uncertain for a direct browser fetch.

## Why there's a seed generator (not a `truffle dump`)

The Go tool has **no** catalog-dump command — it reads specs live from
`DescribeInstanceTypes`. Until a live generator lands (roadmap), the snapshot is
produced by `scripts/seed-catalog.mjs`, a one-shot Node script with hand-curated
family/size specs. Regenerate it with:

```bash
node scripts/seed-catalog.mjs   # rewrites src/data/instances.json
```

The GPU section is derived from the same instance-type lists as the metadata
`GPUDatabase`, and a **drift-invariant test** (`src/data/catalog.test.ts`)
asserts every `GPUDatabase` instance type exists in the catalog — so a GPU query
can never resolve to a type that's missing from the snapshot.

## Roadmap: a live catalog

`scripts/gen-catalog.ts` (deferred) will regenerate `instances.json` from real
`DescribeInstanceTypes` output (with credentials, run out-of-band), replacing the
hand seed. At that point a live `Finder` can also serve specs/pricing directly
for consumers that have a backend.
