import { describe, it, expect } from "vitest";
import { parseQuery } from "./parser.js";
import {
  resolveInstanceFamilies,
  resolveGpuInstances,
  deriveArchitecture,
  buildSizePattern,
  resolveCard,
  cardInstanceTypes,
  ErrNoMatch,
  escapeRegex,
} from "./resolve.js";

describe("resolveInstanceFamilies", () => {
  it("resolves a vendor to its families (sorted, deduped)", () => {
    const fams = resolveInstanceFamilies(parseQuery("graviton"));
    expect(fams).toContain("c7g");
    expect(fams).toContain("r8g");
    expect([...fams]).toEqual([...fams].sort());
  });

  it("intersects app families with query families", () => {
    // paraview → [g6,g5,g4dn]; nvidia → many g/p families. Intersection is the g's.
    const fams = resolveInstanceFamilies(parseQuery("paraview nvidia"));
    expect(fams).toContain("g5");
    expect(fams).toContain("g6");
    expect(fams).not.toContain("p5");
  });

  it("returns nothing for a query with no family constraints", () => {
    expect(resolveInstanceFamilies(parseQuery("16 cores"))).toEqual([]);
  });
});

describe("resolveGpuInstances", () => {
  it("returns the exact instance types for a GPU", () => {
    expect(resolveGpuInstances(parseQuery("a100"))).toEqual(["p4d.24xlarge", "p4de.24xlarge"]);
    expect(resolveGpuInstances(parseQuery("h100"))).toEqual(["p5.48xlarge"]);
  });
});

describe("deriveArchitecture", () => {
  it("derives arm64 for graviton, x86_64 for amd, empty when ambiguous", () => {
    expect(deriveArchitecture(parseQuery("graviton"))).toBe("arm64");
    expect(deriveArchitecture(parseQuery("amd"))).toBe("x86_64");
    expect(deriveArchitecture(parseQuery("h100"))).toBe(""); // GPU only, no CPU vendor
  });
  it("honors an explicit architecture token", () => {
    expect(deriveArchitecture(parseQuery("arm64"))).toBe("arm64");
  });
});

describe("buildSizePattern", () => {
  it("maps size categories to a suffix alternation, or .* if none", () => {
    expect(buildSizePattern(parseQuery("graviton large"))).toBe("(2xlarge|4xlarge)");
    expect(buildSizePattern(parseQuery("graviton"))).toBe(".*");
  });
});

describe("resolveCard / cardInstanceTypes (strict)", () => {
  it("resolves a card name to its instance types", () => {
    expect(resolveCard("h100")).toEqual(["p5.48xlarge"]);
    expect(resolveCard("rtx pro 6000")).toContain("g7e.2xlarge");
  });
  it("throws ErrNoMatch when a card has no GPU / is unknown", () => {
    expect(() => resolveCard("graviton")).toThrow(ErrNoMatch);
    expect(() => cardInstanceTypes("nope")).toThrow(ErrNoMatch);
    expect(() => cardInstanceTypes("")).toThrow(ErrNoMatch);
  });
  it("cardInstanceTypes resolves aliases to a canonical key", () => {
    const { canonical, instances } = cardInstanceTypes("gb200");
    expect(canonical).toBe("b200");
    expect(instances).toContain("p6-b200.48xlarge");
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("m6i.large")).toBe("m6i\\.large");
  });
});
