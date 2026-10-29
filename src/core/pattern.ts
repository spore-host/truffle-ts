// Glob / regex pattern search — a port of the pattern path in the Go tool
// (cmd/find.go looksLikePattern + cmd/search.go patternToRegex/wildcardToRegex).
// `find` auto-detects when a query is an instance-type *pattern* ("m7i*",
// "c[6-8]i\.large", "trn1.32xlarge", "g5") rather than a natural-language phrase, and
// matches it directly against instance-type names instead of running the parser.
//
// Pure string logic, no I/O.

import { escapeRegex } from "./resolve.js";
import { isRecognizedTerm } from "./parser.js";

/**
 * Does this query look like an instance-type *pattern* — an exact type
 * ("r8g.2xlarge"), a bare family ("g5", "trn1"), a glob ("m7i*") or a regex
 * ("c[6-8]i.large") — rather than a natural-language phrase? Ports Go
 * find.LooksLikePattern (v0.62, #263), in Go's order:
 *
 *   1. A single word the parser fully understands ("a100", "h100", "graviton3",
 *      "a100-80gb", "b200+") is natural language — checked FIRST, since "+" is
 *      also a regex indicator.
 *   2. A glob wildcard or a regex metacharacter makes it a pattern.
 *   3. A single word shaped like a family (letters then a generation digit:
 *      "c6i", "trn1", "m7i.large") is a pattern.
 *   4. So is a single dotted word whose family starts with a hyphenated word
 *      ("u-6tb1.112xlarge", "mac-m4.metal").
 *
 * Before this, truffle-ts kept every bare word on the natural-language path, so
 * an exact type such as "r8g.2xlarge" was an unknown word that constrained
 * nothing and matched all 231 bundled types. Go's own vocabulary-first check
 * (v0.51) removed the "a100 is not an instance name" collision that the old
 * divergence existed to avoid.
 */
export function looksLikePattern(query: string): boolean {
  const q = query.trim();
  const single = q !== "" && !/\s/.test(q);
  if (single && isRecognizedTerm(q)) return false;
  if (q.includes("*") || q.includes("?")) return true;
  if (looksLikeRegex(q)) return true;
  if (!single) return false;
  if (/^[a-z]+\d/i.test(q)) return true;
  return /^[a-z]+(?:-[a-z0-9]+)+\.[a-z0-9-]+$/i.test(q);
}

/**
 * Whether a word is a bare family name — family-shaped and without a size:
 * "g5", "m7i-flex", "trn1n". Stands in for Go's IsInstanceFamily snapshot
 * (metadata.InstanceFamilies + the Nitro table), which truffle-ts does not
 * carry: an unknown family-shaped word ("zz9q") is then searched as a family
 * and matches nothing, which is also Go's result for it.
 */
export function isBareFamily(word: string): boolean {
  return /^[a-z]+\d[a-z0-9-]*$/.test(word.toLowerCase()) || /^[a-z]+-[a-z0-9]+$/.test(word.toLowerCase());
}

/** Does the pattern contain regex metacharacters? Mirrors Go looksLikeRegex. */
export function looksLikeRegex(pattern: string): boolean {
  for (const indicator of ["[", "]", "(", ")", "+", "\\d", "\\w", "\\s", "|"]) {
    if (pattern.includes(indicator)) return true;
  }
  return false;
}

/**
 * Convert a pattern (glob or regex) into an anchored regex string over
 * instance-type names. Mirrors Go patternToRegex: regex-looking patterns are
 * lightly fixed up (bare `*` -> `.*`, literal dots escaped) and anchored; plain
 * globs go through wildcardToRegex.
 */
export function patternToRegex(pattern: string): string {
  // A bare family means the whole family: "g5" → every g5 size. It used to
  // become ^g5$, which no instance type matches (Go #229).
  const lower = pattern.toLowerCase();
  if (!looksLikeRegex(pattern) && !/[*?.]/.test(pattern) && isBareFamily(lower)) {
    return "^(" + escapeRegex(lower) + ")\\..*$";
  }
  if (looksLikeRegex(pattern)) {
    let p = fixGlobStarsInRegex(pattern);
    p = escapeLiteralDots(p);
    if (!p.startsWith("^")) p = "^" + p;
    if (!p.endsWith("$")) p = p + "$";
    return p;
  }
  return wildcardToRegex(pattern);
}

/**
 * Replace a bare `*` (glob wildcard) with `.*` in a regex-ish pattern — one not
 * already preceded by `.` or `\`. Mirrors Go fixGlobStarsInRegex.
 */
export function fixGlobStarsInRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && (i === 0 || (pattern[i - 1] !== "." && pattern[i - 1] !== "\\"))) {
      out += ".*";
    } else {
      out += pattern[i];
    }
  }
  return out;
}

/**
 * Escape dots that are literal separators in instance-type names ("c7i.xlarge"),
 * leaving dots that are part of `.*`/`.+` or already escaped. Mirrors Go
 * escapeLiteralDots.
 */
export function escapeLiteralDots(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === ".") {
      if (i + 1 < pattern.length && (pattern[i + 1] === "*" || pattern[i + 1] === "+")) {
        out += ".";
      } else if (i > 0 && pattern[i - 1] === "\\") {
        out += ".";
      } else {
        out += "\\.";
      }
    } else {
      out += pattern[i];
    }
  }
  return out;
}

/**
 * Convert a pure glob pattern to an anchored regex. `*` -> `.*`, `?` -> `.`,
 * everything else escaped; a user-written `.*` is preserved. Mirrors Go
 * wildcardToRegex, using a sentinel to protect ".*" across the escape step.
 */
export function wildcardToRegex(pattern: string): string {
  const sentinel = "\x00DOTSTAR\x00";
  let p = pattern.split(".*").join(sentinel);
  p = escapeRegex(p);
  p = p.split("\\*").join(".*");
  p = p.split("\\?").join(".");
  p = p.split(sentinel).join(".*");
  return "^" + p + "$";
}
