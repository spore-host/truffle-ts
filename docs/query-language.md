# Query language

A `find` query is free text. It's lowercased, split on whitespace, and each token
is classified against the metadata catalogs — **longest phrase first**, so
multi-word names resolve as single tokens. Order mostly doesn't matter; combine
any of the below.

Words the parser can't classify don't fail a query that has other, recognised
terms, but they aren't swallowed either: they land in `ParsedQuery.ignored` so a
consumer can say *"didn't understand: training"*. A query made **only** of
unknown words throws `UnrecognizedQueryError`, which names each word and the
closest known word where there is one (`"gravitn" (did you mean "graviton"?)`).
It used to match every instance type, as Go's did before #229. That matters because a query is more dangerous when it
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
| `N gb` / `N gib` | min memory, or per-GPU memory in a GPU query | `32gb` → memory ≥ 32 GiB; `gpu 24gb` → each GPU ≥ 24 GB |
| `N gb ram` / `memory` / `mem` / `host memory` | min **host** memory | `a10g 64gb ram` → host memory ≥ 64 GiB |
| `N gpus` / `N gpu` / `Ngpu` | min GPU count | `8 gpus`, `8gpu` → GPUs ≥ 8 |
| bare `gpu` / `accelerator` | any GPU | `gpu` → GPU instances only, no model pinned |
| `N gb vram` / `hbm` / `gpu memory` / `per gpu` | min VRAM **per GPU** | `80gb vram` → each card ≥ 80 GB/GiB, as sold |
| a hyphenated spec string | split like its spaced form | `a100-80gb`, `rtx-pro-6000`, `h100!`, `b200+` |
| `arm64` / `x86_64` (+ aliases) | architecture | `arm64`, `aarch64`, `amd64` |
| `Ngbps` / `Ng` / tier alias | min network | `100gbps`, `100g`, `ultranet` |
| `efa` / `lowlatency` | EFA required | `efa` → EFA-capable families only |
| `nested-virt` | nested virtualization | requires in-instance KVM/Hyper-V |
| an **app** name or alias | app | `paraview` / `pv`, `fiji` / `imagej`, `chimerax` / `chimera`, `jupyter` → recommended families + min vCPU/mem (the libs app catalog) |
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
- **A bare memory figure in a GPU query** is read as memory **per GPU**, as Go does
  since #236. A GPU query names a card, says `gpu`, or gives a GPU count. So
  `gpu with 80gb` and `a100 80gb` both mean an 80 GB part, and `a100 80gb` is
  p4de only. Write `80gb ram` for host memory. An explicit marker on one size
  decides the other: in `a10g 24gb 64gb ram` the bare `24gb` is per-GPU.
  `memoryReadingNote(pq)` returns the one-line note Go prints for this reading.
- **GPU memory is compared as the GPU is sold** (Go `MatchesGPUMemory`, #236/#244).
  EC2 reports the A10G and L4 as 22888 MiB, which is 22.35 GiB, but they are 24 GB
  parts, so `gpu 24gb` keeps them. The H100's 81920 MiB is 80 GiB. Match reasons
  use the same unit: `GPU memory: 24 GB >= 24`.
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

With no qualitative word, a query with size terms (`16 cores 64gb`) ranks
**closest fit first**. Each specified dimension adds `|log2(actual/requested)|`,
so an exact match ranks first and doubling either dimension costs the same. Ties
go cheapest first, then newest generation (Go #187). A query with no size terms
ranks newest generation first, then cheapest. Rows of one type stay together,
cheapest region first. `minimumSpecHint()` returns the note Go prints under the
table. Unknown prices sort last for price-based orderings, and an estimated price
never beats a real one (#39).

## Conflicts

A query that mixes architectures — e.g. `intel graviton` (x86_64 + arm64) —
throws a "conflicting architectures" error rather than returning a nonsensical
mix.

## Glob / regex patterns

`find` treats a query as an **instance-type name pattern**, and matches it
directly against type names without the natural-language parser, when it is
(Go `LooksLikePattern`, v0.62, #263):

1. **not** a single word the parser fully understands (`a100`, `h100`,
   `graviton3`, `a100-80gb`, `b200+` always take the natural-language path,
   checked first);
2. a glob wildcard (`*`, `?`) or a regex metacharacter (`[`, `]`, `(`, `)`, `+`,
   `|`, `\d`, `\w`, `\s`);
3. a single family-shaped word: an exact type (`r8g.2xlarge`, `trn1.32xlarge`)
   or a bare family (`g5`, `m7i-flex`), where a bare family means every size of
   that family;
4. a single dotted word whose family starts with a hyphenated word
   (`u-6tb1.112xlarge`, `mac-m4.metal`).

| Query | Matches |
|-------|---------|
| `m7i*` | every `m7i.*` size |
| `c[6-8]i.large` | `c6i.large`, `c7i.large`, `c8i.large` (the dot is literal) |
| `(m7i\|c7i).large` | `m7i.large`, `c7i.large` |
| `*.metal` | every `.metal` type |

| `r8g.2xlarge` | exactly `r8g.2xlarge` |
| `g5` | every `g5.*` size (not `g5g`) |

Before this, every bare word took the natural-language path. An exact type such
as `r8g.2xlarge` was an unknown word that constrained nothing, so it matched all
231 bundled types. The old divergence from Go avoided reading `a100` as an
instance name. Go has checked vocabulary first since v0.51, so the two now agree.

## Card resolution (strict)

Separately from free-text search, `resolveCard(name)` / `cardInstanceTypes(name)`
map a single GPU card to its instance types and **throw `ErrNoMatch`** if the
card is unknown — never the match-all fallback the search pipeline uses. Use
these when you have a clean card name and want a definite answer.
