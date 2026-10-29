import { describe, it, expect } from "vitest";
import {
  looksLikePattern,
  looksLikeRegex,
  patternToRegex,
  wildcardToRegex,
  isBareFamily,
} from "./pattern.js";
import { find } from "./find.js";

describe("looksLikePattern", () => {
  // Explicit glob / regex → the pattern path.
  const wantPattern = [
    "m7*", "c7?.large", "*.metal", "c7.*",
    "c[6-8]i.large", "m7i|c7i", "(m7i|c7i).large", "p5\\d",
    // Exact types and bare families (Go LooksLikePattern, #263). These used to
    // take the natural-language path, where "r8g.2xlarge" was an unknown word
    // that constrained nothing and matched all 231 bundled types.
    "c6i", "m7i.large", "trn1.32xlarge", "r8g.2xlarge", "  r8g.2xlarge  ", "g5", "m7i-flex",
    "u-6tb1.112xlarge", "mac-m4.metal", "mac2.metal", "zz9q",
  ];
  for (const q of wantPattern) {
    it(`"${q}" → pattern path`, () => expect(looksLikePattern(q)).toBe(true));
  }

  // NL phrases, and single words the parser fully understands — checked
  // FIRST, as Go does, so a GPU name is never read as an instance-type name and
  // "b200+" isn't taken for a regex (Go #130).
  const wantNaturalLanguage = [
    "8 cpus 32gb", "gpu instances", "cheapest with 4 gpus", "trainium",
    "a100", "h100", "graviton", "H100", "A100-80GB", "a100-80gb", "B200+", "h100!", "r8g 2xlarge",
  ];
  for (const q of wantNaturalLanguage) {
    it(`"${q}" → NL path`, () => expect(looksLikePattern(q)).toBe(false));
  }
});

describe("looksLikeRegex", () => {
  it("detects regex metacharacters", () => {
    expect(looksLikeRegex("c[6-8]i")).toBe(true);
    expect(looksLikeRegex("m7i|c7i")).toBe(true);
    expect(looksLikeRegex("p5\\d")).toBe(true);
    expect(looksLikeRegex("m7i.large")).toBe(false);
    expect(looksLikeRegex("m7*")).toBe(false); // glob, not regex
  });
});

describe("wildcardToRegex", () => {
  const cases: Array<{ pattern: string; match: string[]; noMatch: string[] }> = [
    { pattern: "m5.large", match: ["m5.large"], noMatch: ["m5.xlarge", "m5large", "xm5.large"] },
    { pattern: "m7*", match: ["m7i.large", "m7g.2xlarge", "m7a.xlarge"], noMatch: ["c7i.large", "am7.large"] },
    { pattern: "c7?.large", match: ["c7i.large", "c7g.large", "c7a.large"], noMatch: ["c7.large", "c7in.large"] },
    { pattern: "*.metal", match: ["m6i.metal", "g4dn.metal"], noMatch: ["m6i.large"] },
    { pattern: "c7.*", match: ["c7i.large", "c7g.2xlarge"], noMatch: ["m7i.large"] },
  ];
  for (const c of cases) {
    it(`glob ${c.pattern}`, () => {
      const re = new RegExp(wildcardToRegex(c.pattern));
      for (const m of c.match) expect(re.test(m), `should match ${m}`).toBe(true);
      for (const nm of c.noMatch) expect(re.test(nm), `should not match ${nm}`).toBe(false);
    });
  }
});

describe("patternToRegex", () => {
  const cases: Array<{ pattern: string; match: string[]; noMatch: string[] }> = [
    // glob
    { pattern: "m7i*", match: ["m7i.large", "m7i.2xlarge"], noMatch: ["m7g.large"] },
    // regex character class
    { pattern: "c[6-8]i.large", match: ["c6i.large", "c7i.large", "c8i.large"], noMatch: ["c5i.large", "c6i.xlarge"] },
    // regex alternation
    { pattern: "(m7i|c7i).large", match: ["m7i.large", "c7i.large"], noMatch: ["r7i.large"] },
    // bare * inside a regex → treated as .*
    { pattern: "c[6-8]*", match: ["c6i.large", "c8g.2xlarge"], noMatch: ["m6i.large"] },
  ];
  for (const c of cases) {
    it(`pattern ${c.pattern}`, () => {
      const re = new RegExp(patternToRegex(c.pattern));
      for (const m of c.match) expect(re.test(m), `should match ${m}`).toBe(true);
      for (const nm of c.noMatch) expect(re.test(nm), `should not match ${nm}`).toBe(false);
    });
  }

  it("anchors regex patterns that aren't already anchored", () => {
    const p = patternToRegex("c[6-8]i.large");
    expect(p.startsWith("^")).toBe(true);
    expect(p.endsWith("$")).toBe(true);
  });
});

describe("exact types and bare families (Go #263 / #229)", () => {
  it("a bare family is the whole family", () => {
    const re = new RegExp(patternToRegex("g5"));
    for (const m of ["g5.xlarge", "g5.48xlarge"]) expect(re.test(m), m).toBe(true);
    for (const m of ["g5g.xlarge", "g6.xlarge"]) expect(re.test(m), m).toBe(false);
    expect(isBareFamily("m7i-flex")).toBe(true);
    expect(isBareFamily("g5.xlarge")).toBe(false);
    expect(isBareFamily("h100x")).toBe(true); // shape only; the NL check runs first
  });
  it("an exact type matches only itself (Go TestParseQuery_PatternQueries)", () => {
    const re = new RegExp(patternToRegex("r8g.2xlarge"));
    expect(re.test("r8g.2xlarge")).toBe(true);
    for (const m of ["r8g.4xlarge", "r8gd.2xlarge"]) expect(re.test(m), m).toBe(false);
  });
  it("find('r8g.2xlarge') returns that type, not the whole catalog", async () => {
    expect((await find("r8g.2xlarge")).map((r) => r.instance.instanceType)).toEqual(["r8g.2xlarge"]);
    expect((await find("trn1.32xlarge")).map((r) => r.instance.instanceType)).toEqual(["trn1.32xlarge"]);
  });
  it("find('g5') lists every g5 size and no g5g", async () => {
    const fams = new Set((await find("g5")).map((r) => r.instance.instanceFamily));
    expect([...fams]).toEqual(["g5"]);
  });
});
