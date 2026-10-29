import { describe, it, expect } from "vitest";
import {
  parseQuery,
  sortPreference,
  qualitativeTokens,
  parseMemory,
  parseNetworkSpeed,
  memoryReadingNote,
  suggestTerms,
  editDistance,
  isRecognizedTerm,
  UnrecognizedQueryError,
  type ParsedQuery,
} from "./parser.js";
import { buildCriteria } from "./criteria.js";
import { find } from "./find.js";

// Ported 1:1 from the Go pkg/find/parser_test.go table.
interface Case {
  name: string;
  query: string;
  vendors?: string[];
  procs?: string[];
  gpus?: string[];
  sizes?: string[];
  vcpu?: number;
  memory?: number;
  arch?: string;
  networkGbps?: number;
  efa?: boolean;
}

const cases: Case[] = [
  { name: "single vendor", query: "intel", vendors: ["intel"] },
  { name: "single vendor - graviton", query: "graviton", vendors: ["aws"] },
  { name: "processor code name", query: "ice lake", procs: ["ice lake"] },
  { name: "processor code name - milan", query: "milan", procs: ["milan"] },
  { name: "multi-word processor", query: "sapphire rapids", procs: ["sapphire rapids"] },
  { name: "gpu type", query: "a100", gpus: ["a100"] },
  { name: "gpu alias", query: "inf", gpus: ["inferentia"] },
  { name: "size category", query: "large", sizes: ["large"] },
  { name: "vendor with vcpu", query: "amd 16 cores", vendors: ["amd"], vcpu: 16 },
  { name: "vendor with memory", query: "graviton 32gb", vendors: ["aws"], memory: 32 },
  { name: "combined specs", query: "amd 16 cores 64gb", vendors: ["amd"], vcpu: 16, memory: 64 },
  { name: "vendor and size", query: "graviton large", vendors: ["aws"], sizes: ["large"] },
  { name: "processor with specs", query: "milan 64 cores", procs: ["milan"], vcpu: 64 },
  { name: "architecture", query: "arm64", arch: "arm64" },
  { name: "x86_64 architecture", query: "x86_64", arch: "x86_64" },
  { name: "multi-word gpu", query: "radeon pro v520", gpus: ["radeon pro v520"] },
  { name: "vcpu with different unit", query: "8 vcpus", vcpu: 8 },
  { name: "memory with gib", query: "32gib", memory: 32 },
  { name: "efa network", query: "efa", efa: true },
  { name: "100gbps network", query: "100gbps", networkGbps: 100 },
  { name: "efa with graviton", query: "efa graviton", vendors: ["aws"], efa: true },
  { name: "h100 with efa", query: "h100 efa", gpus: ["h100"], efa: true },
  { name: "100g alias", query: "100g", networkGbps: 100 },
];

describe("parseQuery (ported Go table)", () => {
  for (const c of cases) {
    it(c.name, () => {
      const pq = parseQuery(c.query);
      expect(pq.vendors).toEqual(c.vendors ?? []);
      expect(pq.processors).toEqual(c.procs ?? []);
      expect(pq.gpus).toEqual(c.gpus ?? []);
      expect(pq.sizes).toEqual(c.sizes ?? []);
      expect(pq.minVcpu).toBe(c.vcpu ?? 0);
      expect(pq.minMemory).toBe(c.memory ?? 0);
      expect(pq.architecture).toBe(c.arch ?? "");
      expect(pq.minNetworkGbps).toBe(c.networkGbps ?? 0);
      expect(pq.requireEfa).toBe(c.efa ?? false);
    });
  }

  it("throws on an empty query", () => {
    expect(() => parseQuery("")).toThrow(/empty query/);
    expect(() => parseQuery("   ")).toThrow(/empty query/);
  });
});

describe("parseQuery extras", () => {
  it("classifies GPU count, physical cores, and nested-virt", () => {
    const pq = parseQuery("8 gpus 8 physical cores nested-virt");
    expect(pq.gpuCount).toBe(8);
    expect(pq.minPhysCores).toBe(8);
    expect(pq.requireNestedV).toBe(true);
  });

  it("classifies an app name (app takes priority over hardware)", () => {
    const pq = parseQuery("paraview");
    expect(pq.apps).toEqual(["paraview"]);
  });

  it("resolves a multi-word GPU marketing spelling via alias", () => {
    const pq = parseQuery("rtx pro 6000");
    expect(pq.gpus).toEqual(["rtx pro server 6000"]);
  });

  it("throws on conflicting architectures", () => {
    // intel (x86_64) + graviton (arm64) in one query.
    expect(() => parseQuery("intel graviton")).toThrow(/conflicting architectures/);
  });

  it("keeps unknown words as unknown tokens without failing", () => {
    const pq = parseQuery("intel wibble");
    expect(pq.vendors).toEqual(["intel"]);
    expect(pq.rawTokens.some((t) => t.type === "unknown" && t.raw === "wibble")).toBe(true);
  });
});

// #37: a bare "gpu" named no card, so it resolved to nothing and was dropped
// silently; "80gb" was read as system RAM. Together they returned CPU-only
// Graviton instances for "gpu with 80gb for training".
describe("parseQuery — bare GPU requests (#37)", () => {
  it("a bare gpu word sets requireGpu", () => {
    for (const q of ["gpu", "gpus", "accelerator", "i need a gpu"]) {
      expect(parseQuery(q).requireGpu).toBe(true);
    }
  });

  it("reinterprets a bare memory figure as VRAM when a GPU was asked for", () => {
    const pq = parseQuery("gpu with 80gb for training");
    expect(pq.requireGpu).toBe(true);
    expect(pq.minGpuMemory).toBe(80);
    // The figure moves to VRAM rather than being counted twice — 80 GiB of DRAM
    // was never the ask, and leaving it set would over-constrain the search.
    expect(pq.minMemory).toBe(0);
  });

  it("reads a named card's bare size as per-GPU memory, as Go does since #236", () => {
    // truffle-ts used to keep this as host memory, so "a100 80gb" matched p4d's
    // 40 GB A100s by their 1152 GiB of RAM. Go reads it as the 80 GB part.
    const pq = parseQuery("a100 80gb");
    expect(pq.minGpuMemory).toBe(80);
    expect(pq.minMemory).toBe(0);
    // An explicit marker says host memory.
    expect(parseQuery("a100 80gb ram").minMemory).toBe(80);
  });

  it("an explicit vram marker parses as VRAM in both spacings", () => {
    expect(parseQuery("gpu 80gb vram").minGpuMemory).toBe(80);
    expect(parseQuery("gpu 80 gb vram").minGpuMemory).toBe(80);
    expect(parseQuery("gpu 141gb hbm").minGpuMemory).toBe(141);
    // …and does not also constrain system RAM.
    expect(parseQuery("gpu 80gb vram").minMemory).toBe(0);
  });

  it("a VRAM or count constraint implies requireGpu", () => {
    expect(parseQuery("80gb vram").requireGpu).toBe(true);
    expect(parseQuery("4 gpus").requireGpu).toBe(true);
  });

  it("reports unclassified words in `ignored` but not grammatical filler", () => {
    const pq = parseQuery("gpu with 80gb for training");
    // "training" was understood by nobody; say so rather than dropping it.
    expect(pq.ignored).toEqual(["training"]);
    // "with"/"for" carry no constraint — listing them would train users to
    // ignore the notice, which defeats its purpose.
    expect(pq.ignored).not.toContain("with");
    expect(pq.ignored).not.toContain("for");
  });

  it("the attached count form parses (Go drops it)", () => {
    // "nvidia h100 8gpu efa" is both READMEs' headline example, and its count has
    // always been discarded — Go's parser only handles the spaced form.
    const pq = parseQuery("nvidia h100 8gpu efa");
    expect(pq.gpuCount).toBe(8);
    expect(pq.ignored).toEqual([]);
    expect(parseQuery("2gpus").gpuCount).toBe(2);
    // A bare "8x" is not a GPU count — it multiplies anything.
    expect(parseQuery("gpu 8x").gpuCount).toBe(0);
  });
});

describe("sortPreference", () => {
  const table: Array<[string, string]> = [
    ["cheapest graviton", "cheapest"],
    ["budget intel", "cheapest"],
    ["fastest gpu", "performant"],
    ["newest amd", "newest"],
    ["premium h100", "expensive"],
    ["graviton 32gb", "default"],
  ];
  for (const [query, want] of table) {
    it(`${query} → ${want}`, () => {
      expect(sortPreference(parseQuery(query))).toBe(want);
    });
  }

  it("exposes raw qualitative tokens", () => {
    expect(qualitativeTokens(parseQuery("cheapest fast graviton"))).toEqual(["cheapest", "fast"]);
  });
});

describe("unit parsers", () => {
  it("parseMemory handles gb/gib/g and rejects junk", () => {
    expect(parseMemory("32gb")).toBe(32);
    expect(parseMemory("1.5gib")).toBe(1.5);
    expect(parseMemory("nonsense")).toBeNull();
  });
  it("parseNetworkSpeed handles gbps/g aliases and rejects junk", () => {
    expect(parseNetworkSpeed("100gbps")).toBe(100);
    expect(parseNetworkSpeed("25g")).toBe(25);
    expect(parseNetworkSpeed("fast")).toBeNull();
  });
});

// Type-only touch so ParsedQuery stays exported/used.
const _shape: ParsedQuery = parseQuery("intel");
void _shape;

// ── Ported from Go pkg/find/gpu_memory_test.go TestMemoryReading (#236) ──────
// Rows Go has that truffle-ts can't parse yet are left out and named: "g5 24gb"
// (family words) and "inference 24gb" (use-case words) — see the follow-up issue.
describe("bare memory: host or per-GPU (Go TestMemoryReading)", () => {
  const cases: [string, number, number, boolean][] = [
    ["gpu 24gb", 0, 24, true],
    ["gpu 24 gb", 0, 24, true],
    ["gpus 24gb", 0, 24, true],
    ["h100 80gb", 0, 80, true],
    ["a100-80gb", 0, 80, true],
    ["2 gpus 24gb", 0, 24, true],
    ["a10g 64gb ram", 64, 0, false],
    ["a10g 64gb memory", 64, 0, false],
    ["a10g 64 gb ram", 64, 0, false],
    ["a10g 64gb host memory", 64, 0, false],
    ["24gb vram", 0, 24, false],
    ["24gb gpu memory", 0, 24, false],
    ["gpu 24gb per gpu", 0, 24, false],
    ["a10g 24gb 64gb ram", 64, 24, true],
    ["a10g 24gb vram 64gb", 64, 24, false],
    ["amd turin 16 cores 64gb", 64, 0, false],
    ["amd 16 cores 64gb memory", 64, 0, false],
    ["graviton 32gb", 32, 0, false],
  ];
  for (const [q, host, gpu, note] of cases) {
    it(q, () => {
      const pq = parseQuery(q);
      expect(pq.minMemory, "host").toBe(host);
      expect(pq.minGpuMemory, "per GPU").toBe(gpu);
      expect(pq.ignored).toEqual([]);
      expect(memoryReadingNote(pq) !== "", "note").toBe(note);
      const { filters } = buildCriteria(pq);
      expect([filters.minGpuMemoryGiB, filters.minMemoryGiB]).toEqual([gpu, host]);
    });
  }
  it("TestMemoryReadingNote", () => {
    const got = memoryReadingNote(parseQuery("gpu 24gb"));
    expect(got).toBe('Note: reading "24gb" as memory per GPU (at least 24 GB/GiB, as the GPU is sold); write "24gb ram" for host memory');
  });
});

// ── Ported from Go pkg/find/unrecognized_test.go (#229) ──────────────────────
describe("a query of only unknown words is refused, not run against everything", () => {
  it("TestUnrecognizedQueryError", () => {
    let err: unknown;
    try {
      parseQuery("gravitn zzqx");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnrecognizedQueryError);
    const uq = err as UnrecognizedQueryError;
    expect(uq.terms).toEqual(["gravitn", "zzqx"]);
    expect(uq.suggestions.gravitn).toBe("graviton");
    expect(uq.suggestions.zzqx).toBeUndefined();
    expect(uq.message).toMatch(/^no recognised search terms; unknown terms: "gravitn" \(did you mean "graviton"\?\), "zzqx"/);
  });
  it("TestSuggestTerms (the rows truffle-ts's vocabulary covers)", () => {
    const got = suggestTerms(["xlrage", "h10", "zz9q", "turn", "qqqqqqqq"]);
    expect(got).toEqual({ xlrage: "xlarge", h10: "h100", zz9q: "zz9q.*", turn: "turin" });
  });
  it("TestEditDistance", () => {
    expect(editDistance("kitten", "sitting", 3)).toBe(3);
    expect(editDistance("abc", "abc", 2)).toBe(0);
    expect(editDistance("abc", "abcdef", 2)).toBe(3);
    expect(editDistance("aaaa", "bbbb", 2)).toBe(3);
  });
  it("a recognised word alongside an unknown one still runs, and reports the unknown one", () => {
    expect(parseQuery("graviton zzqx").ignored).toEqual(["zzqx"]);
  });
  it("find('zzqx') rejects instead of returning all 231 bundled types", async () => {
    await expect(find("zzqx")).rejects.toBeInstanceOf(UnrecognizedQueryError);
  });
});

// ── Ported from Go pkg/find/hyphenated_test.go (#130) ─────────────────────────
describe("hyphenated / suffixed GPU spec strings", () => {
  it("re-tokenize like their spaced form (TestNormalizeHyphenatedToken)", () => {
    expect(parseQuery("a100-80gb").gpus).toEqual(["a100"]);
    expect(parseQuery("h100!").gpus).toEqual(["h100"]);
    expect(parseQuery("b200+").gpus).toEqual(["b200"]);
    expect(parseQuery("rtx-pro-6000").gpus).toEqual(parseQuery("rtx pro 6000").gpus);
  });
  it("terminates on a hyphenated word whose parts mean nothing", () => {
    expect(() => parseQuery("foo-bar-baz")).toThrow(UnrecognizedQueryError);
    expect(parseQuery("graviton foo-bar-baz").ignored).toEqual(["foo", "bar", "baz"]);
  });
  it("TestIsRecognizedTerm (the rows truffle-ts's vocabulary covers)", () => {
    const cases: [string, boolean][] = [
      ["H100", true], ["h100", true], ["A100-80GB", true], ["a100-80gb", true], ["RTX-PRO-6000", true],
      ["B200+", true], ["h100!", true], ["m7i", false], ["foo-bar", false], ["unknownword", false],
      ["", false], ["   ", false], ["8", false],
    ];
    for (const [w, want] of cases) expect(isRecognizedTerm(w), w).toBe(want);
  });
  it("find('A100-80GB') is the 80 GB A100 only (Go #245)", async () => {
    expect((await find("A100-80GB")).map((r) => r.instance.instanceType)).toEqual(["p4de.24xlarge"]);
  });
});
