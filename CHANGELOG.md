# Changelog

All notable changes to **truffle-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

### Added
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

[Unreleased]: https://github.com/spore-host/truffle-ts/commits/main
