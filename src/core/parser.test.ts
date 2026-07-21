import { describe, it, expect } from "vitest";
import {
  parseQuery,
  sortPreference,
  qualitativeTokens,
  parseMemory,
  parseNetworkSpeed,
  type ParsedQuery,
} from "./parser.js";

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
