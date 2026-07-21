import { describe, it, expect } from "vitest";
import {
  looksLikePattern,
  looksLikeRegex,
  patternToRegex,
  wildcardToRegex,
} from "./pattern.js";

describe("looksLikePattern", () => {
  // Explicit glob / regex → the pattern path.
  const wantPattern = [
    "m7*", "c7?.large", "*.metal", "c7.*",
    "c[6-8]i.large", "m7i|c7i", "(m7i|c7i).large", "p5\\d",
  ];
  for (const q of wantPattern) {
    it(`"${q}" → pattern path`, () => expect(looksLikePattern(q)).toBe(true));
  }

  // NL phrases AND bare types/names — the deliberate divergence from Go: bare
  // words go through the parser (so "a100"→A100 types, "c6i"→c6i family) rather
  // than a name-pattern that would collide with GPU model names.
  const wantNaturalLanguage = [
    "8 cpus 32gb", "gpu instances", "cheapest with 4 gpus", "trainium",
    "a100", "h100", "c6i", "m7i.large", "trn1.32xlarge", "graviton",
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
