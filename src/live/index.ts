// Public entry for the LIVE (Node-only) finder — imported as
// "@spore-host/truffle-ts/live". The AWS SDK is reachable ONLY through this
// subpath, never from the default "." offline import, so browser consumers of
// `find` never pull the SDK into their bundle. Requires the optional
// @aws-sdk/* dependencies (installed by default for Node; skipped under
// --omit=optional or by browser bundlers that never resolve this path).

export { AwsLiveFinder, createLiveFinder, exactTypeName } from "./live-finder.js";
export type { LiveFinderOptions, AZSearchOptions } from "./live-finder.js";
export {
  fetchOnDemandPrice,
  parseOnDemandUsd,
  onDemandFilters,
  lookupOnDemandPrice,
  lookupOnDemandPrices,
  priceKey,
  PRICE_LOOKUP_CONCURRENCY,
} from "./pricing.js";
export type { PricingRegion, PriceKey } from "./pricing.js";
export { mapInstanceType } from "./mapping.js";
export { fetchSpotPrices, reduceSpotHistory, sortSpotResults, SPOT_PRODUCT } from "./spot.js";
export {
  canLaunch,
  fetchQuotas,
  fetchUsage,
  letterPrefix,
  quotaFamilyFor,
  quotaIncreaseCommand,
  vcpusForSize,
  QUOTA_CODES,
  QUOTA_FAMILIES,
} from "./quotas.js";

// Capacity reservations, owned blocks and purchasable offerings (Go `capacity`,
// `capacity --blocks`, `capacity-blocks`; #33).
export {
  fanOutRegions,
  fetchCapacityReservations,
  fetchCapacityBlocks,
  fetchCapacityBlockOfferings,
  sortCapacityReservations,
  sortCapacityBlocks,
  sortOfferings,
  filterGPUReservations,
  summarizeCapacity,
  roundCapacityBlockDuration,
  humanizeHours,
  parseFee,
  offeringWindow,
  noOfferingsMessage,
  isCapacityBlockIneligible,
  CAPACITY_BLOCK_INELIGIBLE,
  MAX_CAPACITY_BLOCK_HOURS,
} from "./capacity.js";
export type {
  RegionError,
  RegionalResult,
  CapacityReservationResult,
  CapacityReservationOptions,
  CapacityBlockResult,
  CapacityBlockOptions,
  CapacityBlockOfferingResult,
  CapacityBlockOfferingOptions,
  CapacitySummary,
} from "./capacity.js";

// Availability zones and the AZ-first view (Go `az`; #33).
export {
  fetchAvailabilityZones,
  fetchZoneInfos,
  azsByInstanceType,
  isExtendedZone,
  zoneLabel,
  extendedZoneNames,
  extractRegionsFromAZs,
  filterByAZs,
  filterByMinAZCount,
  filterToLocalZones,
  sortAZResults,
  summarizeAZRegions,
  summarizeAZs,
  AZ_BATCH_SIZE,
} from "./az.js";
export type { ZoneInfo, ZoneType, AZRegionSummary, AZSummary } from "./az.js";

// Obtainability (Go `available`; #32).
export {
  obtainability,
  fetchSpotPlacementScores,
  sortSpotPlacements,
  bestSpotPlacement,
  instanceHeadroom,
  obtainabilityVerdict,
  OBTAINABILITY_CAPACITY_BLOCK_HOURS,
} from "./obtainability.js";
export type { Obtainability, SpotPlacement, ObtainabilityClients, ObtainabilityVerdict } from "./obtainability.js";
