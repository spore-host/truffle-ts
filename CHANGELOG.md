# Changelog

All notable changes to **truffle-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

### Added
- Repo scaffold + library packaging: Apache-2.0 license, contributor guide, ESM
  library build (`tsc` → `dist/` with `.d.ts` declarations) separate from the
  Vite demo build (→ `site/`), `package.json` `exports` map (`.` + `./metadata`),
  TypeDoc, and CI (typecheck + test + build) (issue #1).

[Unreleased]: https://github.com/spore-host/truffle-ts/commits/main
