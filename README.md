# truffle-ts

Browser-native **EC2 instance discovery** — a TypeScript port of the spore.host
[`truffle`](https://github.com/spore-host/truffle) tool.

Ask for instances in plain language — `"nvidia h100 8gpu efa"`,
`"cheapest graviton 8 cores 32gb"` — and get back the matching EC2 instance
types, ranked, with the reasons they matched. It runs **entirely in the browser
against a bundled catalog**: no AWS credentials, no network, no cost.

> **Library first.** truffle-ts is meant to be imported. It ships a standalone
> demo, but the deliverable is the API — another app (e.g. `spawn-ts`) can depend
> on it to power an instance picker and decide its own UI.

## Install

```bash
npm install @spore-host/truffle-ts
```

## Use

```ts
import { find } from "@spore-host/truffle-ts";

const results = await find("nvidia h100 8gpu efa");
// → [{ instance: { instanceType: "p5.48xlarge", gpus: 8, gpuModel: "H100", … },
//      reasons: ["GPU: H100 (80 GiB, training)", "GPUs: 8 >= 8", "EFA: supported"] }]
```

The `find` engine is a pipeline you can also drive piece by piece:

```
parseQuery(text) → ParsedQuery          # tokenize + classify
  → buildCriteria(pq) → { pattern, filters }
    → finder.search(pattern, filters)   # bundled catalog by default
      → sort + explainMatch             # rank + annotate
```

### As a dependency (e.g. an instance picker)

truffle-ts is meant to be embedded. A host app imports `find` and decides its own
UI — for example, turning a free-text instance-type field into a recommender:

```ts
import { find } from "@spore-host/truffle-ts";

// User types "nvidia h100 efa" into a picker; you show the matches and let them
// choose. The chosen record carries specs + an estimated $/hr you can reuse.
const [top] = await find(userQuery);
if (top) {
  launchForm.instanceType.value = top.instance.instanceType;   // e.g. "p5.48xlarge"
  launchForm.pricePerHour.value = String(top.instance.onDemandPrice ?? "");
}
```

Because `core/` and `metadata/` are pure (no DOM, no AWS SDK), you can import
them anywhere in your app. truffle-ts never reaches back into the host.

## How it works

| Layer | What it is |
|-------|-----------|
| `core/` | the pure find engine — parse, resolve, filter, sort, explain. No DOM, no AWS. |
| `metadata/` | static hardware catalogs (processors, GPUs, network tiers, sizes). |
| `data/` | the bundled instance catalog + a `Finder` over it + static pricing. |
| `Finder` seam | swap the bundled catalog for a live-AWS/substrate backend later. |

The bundled catalog is an **approximate snapshot ("as of 2026-01")**, not live
AWS data. Live specs, spot pricing, quotas, and capacity are roadmapped behind
the `Finder` seam (they need AWS credentials / a backend proxy, which a browser
can't provide directly).

## Status

**v0.1.0 — offline find foundation.** Natural-language search over a bundled
catalog, fully offline. Live-AWS data, spot pricing, and the `spawn-ts`
instance-picker integration are tracked on the roadmap.

## Documentation

- [Architecture](docs/architecture.md) — the pipeline, the `Finder` seam, layering.
- [Query language](docs/query-language.md) — what a `find` query understands.
- [Bundled catalog](docs/catalog.md) — the offline snapshot + pricing.
- [API reference](docs/api.md) — the public API (+ generated [TypeDoc](https://spore-host.github.io/truffle-ts/api/)).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 © Scott Friedman. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
