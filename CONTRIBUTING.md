# Contributing to truffle-ts

Thanks for your interest in truffle-ts — a browser-native reimplementation of the
spore.host `truffle` EC2 instance-discovery model.

## Development

```bash
npm install
npm run dev         # Vite dev server (the standalone demo)
npm test            # vitest — unit + end-to-end
npm run test:cov    # with coverage
npm run typecheck   # tsc --noEmit
npm run build       # library (dist/) + demo (site/) + docs (site/api/)
```

Node 20+ is required.

## Project layout

truffle-ts is a **library first**. The published package is the code under
`src/core/` and `src/metadata/`; the demo in `src/ui/` is just one consumer.

- `src/core/` — the pure find engine (parse → resolve → filter → sort → explain).
  **No DOM, no AWS SDK, no network.** Deterministic and unit-tested.
- `src/metadata/` — static hardware catalogs (processors, GPUs, network, sizes),
  a direct port of the Go tool's `pkg/metadata`.
- `src/data/` — the bundled instance catalog (`instances.json`), its `Finder`
  implementation (`BundledFinder`), and the static pricing seed.
- `src/ui/` — the standalone demo. DOM lives only here.
- `src/index.ts` — the public API barrel. Everything a consumer imports is here.

## Conventions

- **`core/` and `metadata/` stay pure** — no DOM, no I/O. Live AWS data belongs
  behind the `Finder` seam (`src/core/finder.ts`), never inlined into the engine.
- TypeScript strict mode; relative imports carry explicit `.js` extensions.
- Tests are co-located as `*.test.ts`. The bar is ~91% coverage.
- Where logic is ported from Go `truffle`, port its `*_test.go` cases too.
- The bundled catalog is an approximate snapshot; see [docs/catalog.md](docs/catalog.md).

## Pull requests

Work on a branch, open a PR against `main`, keep CI green (typecheck + test +
build), and update `CHANGELOG.md` under `[Unreleased]`. Pre-1.0, breaking changes
bump the MINOR version.
