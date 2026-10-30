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
export const VERSION = "0.6.0";

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
  listApps,
  APP_CATALOG_SOURCE,
} from "./metadata/index.js";
export type {
  ProcessorInfo,
  GPUInfo,
  NetworkCapability,
  SizeCategory,
  AppEntry,
  AppKind,
} from "./metadata/index.js";

// The one-call convenience: query string → ranked, explained results (offline).
export { find, findInstances, findByPattern, listInstanceTypes } from "./core/find.js";
export type { FindOptions } from "./core/find.js";

// Glob/regex pattern detection + conversion (find auto-routes to these).
export {
  looksLikePattern,
  looksLikeRegex,
  isBareFamily,
  patternToRegex,
  wildcardToRegex,
} from "./core/pattern.js";

// The Finder seam + the default bundled-catalog implementation + its data.
export type {
  Finder,
  LiveFinder,
  SpotPriceResult,
  SpotOptions,
  QuotaFamily,
  QuotaInfo,
  QuotaOptions,
  QuotaVerdict,
} from "./core/finder.js";
export { BundledFinder } from "./data/bundled-finder.js";
export { loadBundledCatalog, CATALOG_AS_OF, CATALOG_REGION } from "./data/catalog.js";
export {
  onDemandPrice,
  staticOnDemandPrice,
  EC2Pricing,
  STATIC_EC2_PRICES,
  STATIC_PRICES_AS_OF,
  STATIC_PRICES_SOURCE,
} from "./data/pricing.js";

// Price provenance (truffle#184): every price says where it came from.
export { describePrice, describePriceOrigin, OFFLINE_REASON } from "./core/price.js";
export type { PriceSource, PriceOrigin, PriceQuote, StaticPriceTable } from "./core/price.js";

// The find pipeline pieces (for consumers that want control over a step).
export {
  parseQuery,
  sortPreference,
  qualitativeTokens,
  hasConstraints,
  isRecognizedTerm,
  memoryReadingNote,
  suggestTerms,
  editDistance,
  UnrecognizedQueryError,
} from "./core/parser.js";
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
export { matchesFilters, extractFamily, perGpuMemoryGiB } from "./core/filter.js";
export { explainMatch } from "./core/explain.js";
export { sortResults, instanceGeneration } from "./core/sort.js";

// Pure derivations Go computes in its printer and commands (#34): ranking,
// GPU memory "as sold", limits, families, zones, price units, ratios.
export {
  sortFindResults,
  fitDistance,
  hasSizeSpec,
  minimumSpecHint,
  limitTypes,
  limitNote,
  nominalGpuMemory,
  nominalGpuMemoryGB,
  formatGpuMemory,
  formatSize,
  matchesGpuMemory,
  perGpuMemoryMib,
  isGPUFamily,
  GPU_FAMILY_PREFIXES,
  compareZoneNames,
  sortZoneNames,
  zoneNamesSorted,
  uniqueSorted,
  countUniqueRegions,
  formatPrice,
  priceHeaderFor,
  savingsPercent,
  gpuRatios,
  memPerPhysicalCoreGiB,
  truncateWithEllipsis,
  shortenReservationID,
  hasDistinctTimestamps,
  instanceFamilies,
  instanceSizes,
} from "./core/derive.js";
export type { MemoryUnit, PriceUnit } from "./core/derive.js";
