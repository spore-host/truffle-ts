# Query language

A `find` query is free text. It's lowercased, split on whitespace, and each token
is classified against the metadata catalogs — **longest phrase first**, so
multi-word names resolve as single tokens. Order mostly doesn't matter; combine
any of the below.

Words the parser can't classify don't fail the query, but they aren't swallowed
either: they land in `ParsedQuery.ignored` so a consumer can say *"didn't
understand: training"*. That matters because a query is more dangerous when it
looks understood than when it errors — `gpu with 80gb for training` used to return
CPU-only Graviton types with nothing to suggest a constraint had been dropped
(#37). Grammatical filler (`with`, `for`, `a`, `the`, `need`, …) is excluded from
`ignored`: a notice that fires on every query is one users learn to skip.

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
| `N gpus` / `N gpu` / `Ngpu` | min GPU count | `8 gpus`, `8gpu` → GPUs ≥ 8 |
| bare `gpu` / `accelerator` | any GPU | `gpu` → GPU instances only, no model pinned |
| `N gb vram` / `N gb hbm` | min VRAM **per GPU** | `80gb vram` → each card ≥ 80 GiB |
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
- **A bare `gpu`** names no card, so there is nothing to resolve to — it becomes a
  post-filter (`gpus ≥ 1`) instead. GPU *count* and *VRAM* are post-filters for the
  same reason, and VRAM is compared **per card** (`gpuMemoryMib / gpus`): 4 × 16 GiB
  of T4 is 64 GiB in aggregate and must not satisfy `80gb vram`.
- **A bare memory figure alongside a bare `gpu`** is read as **VRAM**, not system
  RAM — `gpu with 80gb` means an 80 GiB card. When a card *is* named (`a100 80gb`)
  the figure stays system RAM, since the card already pins the instance types and a
  second constraint is the more likely reading.
- An instance whose VRAM isn't recorded **fails** a VRAM floor rather than passing
  it. It can't be shown to clear the bar, and presenting an unverified type as a
  confirmed match is the worse error.
- **Vendor / processor / network / EFA** resolve to *families*; a **size**
  narrows the family pattern to those size suffixes.
- **App names** contribute recommended families and minimum vCPU/memory. When an
  app is combined with hardware constraints, the families are **intersected**
  (`paraview nvidia` → only the GPU families paraview recommends). If that
  intersection is empty (`igv nvidia` — a CPU app + GPU vendor), the query
  matches nothing rather than everything.
- **vCPU / memory / cores / architecture / nested-virt / GPU count / VRAM** apply
  as post-filters.

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

## Glob / regex patterns

If a query contains a glob wildcard (`*`, `?`) or a regex metacharacter
(`[`, `]`, `(`, `)`, `+`, `|`, `\d`, `\w`, `\s`), `find` treats it as an
**instance-type name pattern** and matches it directly against type names —
skipping the natural-language parser entirely:

| Query | Matches |
|-------|---------|
| `m7i*` | every `m7i.*` size |
| `c[6-8]i.large` | `c6i.large`, `c7i.large`, `c8i.large` (the dot is literal) |
| `(m7i\|c7i).large` | `m7i.large`, `c7i.large` |
| `*.metal` | every `.metal` type |

A **bare word** like `a100`, `c6i`, or `m7i.large` (no wildcard/regex char) is
*not* treated as a pattern — it goes through the natural-language parser, so
`a100` resolves to the A100 instance types and `c6i` to the c6i family. To match
by name instead, add a glob: `a100*`, `c6i*`. (This is a deliberate divergence
from the Go tool, whose bare-word pattern routing collides with GPU model names.)

## Card resolution (strict)

Separately from free-text search, `resolveCard(name)` / `cardInstanceTypes(name)`
map a single GPU card to its instance types and **throw `ErrNoMatch`** if the
card is unknown — never the match-all fallback the search pipeline uses. Use
these when you have a clean card name and want a definite answer.
