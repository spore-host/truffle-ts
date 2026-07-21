// Public API surface for truffle-ts as a library. Consumers (the bundled demo,
// or another app such as spawn-ts) import from here:
//
//   import { find } from "@spore-host/truffle-ts";
//   const results = await find("nvidia h100 8gpu efa");
//
// truffle-ts is a browser-native port of the spore.host `truffle` tool. The find
// engine (parse → resolve → filter → sort → explain) is pure and provider-
// agnostic; live AWS data (when wired) sits behind the Finder seam. The demo in
// src/ui is just one consumer — nothing in core/ or metadata/ depends on the DOM.

/** Library version, matching package.json. */
export const VERSION = "0.1.0";

// Core domain types (the shape of a catalog entry / result / filter).
export type {
  InstanceType,
  FilterOptions,
  FindResult,
  Architecture,
} from "./core/types.js";

// Static hardware catalogs (also available via the "./metadata" subpath export).
export {
  ProcessorDatabase,
  GPUDatabase,
  GPUAliases,
  VendorAliases,
  EFACapableFamilies,
  NetworkBandwidthTiers,
  SizeCategories,
  AppCatalog,
  lookupApp,
} from "./metadata/index.js";
export type {
  ProcessorInfo,
  GPUInfo,
  NetworkCapability,
  SizeCategory,
  AppEntry,
} from "./metadata/index.js";

// The find pipeline — parser (#3) → resolve/criteria/filter/explain/sort (#4).
// The Finder seam + bundled catalog + the find() convenience follow in #5.
export { parseQuery, sortPreference, qualitativeTokens } from "./core/parser.js";
export type { ParsedQuery, Token, TokenType, SortPreference } from "./core/parser.js";
export {
  resolveInstanceFamilies,
  resolveGpuInstances,
  deriveArchitecture,
  buildSizePattern,
  resolveCard,
  cardInstanceTypes,
  ErrNoMatch,
} from "./core/resolve.js";
export { buildCriteria, buildInstanceTypePattern } from "./core/criteria.js";
export type { SearchCriteria } from "./core/criteria.js";
export { matchesFilters, extractFamily } from "./core/filter.js";
export { explainMatch } from "./core/explain.js";
export { sortResults, instanceGeneration } from "./core/sort.js";
