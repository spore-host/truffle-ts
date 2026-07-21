# Query language

A `find` query is free text. It's lowercased, split on whitespace, and each token
is classified against the metadata catalogs — **longest phrase first**, so
multi-word names resolve as single tokens. Unknown words are ignored (they don't
fail the query). Order mostly doesn't matter; combine any of the below.

## Token types

| You type | Classified as | Example → effect |
|----------|---------------|------------------|
| a **vendor** | vendor | `intel`, `amd`, `graviton`/`arm`/`amazon` → its families |
| a **processor** code name | processor | `sapphire rapids`, `milan`, `genoa`, `graviton3` → its families + arch |
| a **GPU** model | gpu | `h100`, `a100`, `l40s`, `trainium`, `rtx pro 6000` → exact instance types |
| a **size** category | size | `tiny`/`small`/`medium`/`large`/`huge` → size suffixes |
| `N cores` / `N vcpus` / `N cpu` | min vCPU | `16 cores` → vCPUs ≥ 16 |
| `N physical cores` | min physical cores | `8 physical cores` → cores ≥ 8 |
| `N gb` / `N gib` | min memory | `32gb` → memory ≥ 32 GiB |
| `N gpus` / `N gpu` | min GPU count | `8 gpus` |
| `arm64` / `x86_64` (+ aliases) | architecture | `arm64`, `aarch64`, `amd64` |
| `Ngbps` / `Ng` / tier alias | min network | `100gbps`, `100g`, `ultranet` |
| `efa` / `lowlatency` | EFA required | `efa` → EFA-capable families only |
| `nested-virt` | nested virtualization | requires in-instance KVM/Hyper-V |
| an **app** name | app | `paraview`, `igv`, `qgis` → recommended families + min vCPU/mem |
| a **qualitative** word | sort hint | `cheapest`, `fastest`, `newest` (see below) |

Aliases resolve to canonical forms — `inf`→`inferentia`, `a10`→`a10g`,
`gb200`→`b200`, `rtx pro 6000`→`rtx pro server 6000`, `100g`→`100gbps`, etc.

## How constraints combine

- **GPU queries** resolve to that GPU's *exact instance types* (e.g. `h100` →
  `p5.48xlarge`), not a family glob.
- **Vendor / processor / network / EFA** resolve to *families*; a **size**
  narrows the family pattern to those size suffixes.
- **App names** contribute recommended families and minimum vCPU/memory. When an
  app is combined with hardware constraints, the families are **intersected**
  (`paraview nvidia` → only the GPU families paraview recommends). If that
  intersection is empty (`igv nvidia` — a CPU app + GPU vendor), the query
  matches nothing rather than everything.
- **vCPU / memory / cores / architecture / nested-virt** apply as post-filters.

## Qualitative sort words

A word like `cheapest` sets the result ordering (it doesn't filter):

| Words | Sort |
|-------|------|
| `cheap`, `cheapest`, `affordable`, `budget` | on-demand price ascending |
| `expensive`, `premium` | on-demand price descending |
| `fast`, `fastest`, `powerful`, `performant` | most vCPUs first |
| `new`, `newest`, `latest` | newest generation first |

No qualitative word → newest generation first (the default). Unknown prices sort
last for price-based orderings.

## Conflicts

A query that mixes architectures — e.g. `intel graviton` (x86_64 + arm64) —
throws a "conflicting architectures" error rather than returning a nonsensical
mix.

## Card resolution (strict)

Separately from free-text search, `resolveCard(name)` / `cardInstanceTypes(name)`
map a single GPU card to its instance types and **throw `ErrNoMatch`** if the
card is unknown — never the match-all fallback the search pipeline uses. Use
these when you have a clean card name and want a definite answer.
