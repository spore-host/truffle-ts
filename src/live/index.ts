// Public entry for the LIVE (Node-only) finder — imported as
// "@spore-host/truffle-ts/live". The AWS SDK is reachable ONLY through this
// subpath, never from the default "." offline import, so browser consumers of
// `find` never pull the SDK into their bundle. Requires the optional
// @aws-sdk/* dependencies (installed by default for Node; skipped under
// --omit=optional or by browser bundlers that never resolve this path).

export { AwsLiveFinder, createLiveFinder, exactTypeName } from "./live-finder.js";
export type { LiveFinderOptions } from "./live-finder.js";
export { fetchOnDemandPrice, parseOnDemandUsd } from "./pricing.js";
export type { PricingRegion } from "./pricing.js";
export { mapInstanceType } from "./mapping.js";
