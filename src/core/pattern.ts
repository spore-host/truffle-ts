// Glob / regex pattern search — a port of the pattern path in the Go tool
// (cmd/find.go looksLikePattern + cmd/search.go patternToRegex/wildcardToRegex).
// `find` auto-detects when a query is an instance-type *pattern* ("m7i*",
// "c[6-8]i\.large", "trn1.32xlarge") rather than a natural-language phrase, and
// matches it directly against instance-type names instead of running the parser.
//
// Pure string logic, no I/O.

import { escapeRegex } from "./resolve.js";

/**
 * Does this query look like an instance-type *pattern* (glob or regex) rather
 * than a natural-language phrase? True when it contains a glob wildcard (`*`/`?`)
 * or a regex metacharacter (see looksLikeRegex).
 *
 * DELIBERATE DIVERGENCE from the Go tool: Go also routes a bare single word
 * matching `^[a-z]+\d` (e.g. "a100", "c6i", "m7i.large") to the pattern path.
 * That collides with GPU model names — Go's `find a100` searches instance-type
 * *names* for `^a100$` and finds nothing, since no instance is literally named
 * "a100". truffle-ts instead sends bare words through the natural-language
 * parser, which resolves "a100" → the A100 instance types and "graviton" → its
 * families. To force a name pattern, use an explicit glob: `a100*`, `m7i*`,
 * `c6i.*`. (This is why parse still guards the no-constraint case, so a stray
 * unknown bare word can't fall through to a match-everything ".*".)
 */
export function looksLikePattern(query: string): boolean {
  if (query.includes("*") || query.includes("?")) return true;
  if (looksLikeRegex(query)) return true;
  return false;
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
