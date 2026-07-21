// Barrel for the static hardware catalogs — a direct port of the Go tool's
// pkg/metadata (+ a seed of libs/catalog). A standalone entry point so consumers
// can import just the catalogs via the package's "./metadata" subpath export
// without pulling in the find engine.

export type {
  ProcessorInfo,
  GPUInfo,
  NetworkCapability,
  SizeCategory,
} from "./types.js";

export {
  ProcessorDatabase,
  VendorAliases,
  getProcessorsByVendor,
  getFamiliesByVendor,
} from "./processors.js";

export {
  GPUDatabase,
  GPUAliases,
  getGPUsByVendor,
  getGPUsByUseCase,
} from "./gpus.js";

export {
  EFACapableFamilies,
  NetworkBandwidthTiers,
  NetworkAliases,
  getFamiliesByNetworkSpeed,
  getFamiliesByEFA,
  isEFASupported,
} from "./network.js";

export { SizeCategories, getSizesForCategory } from "./sizes.js";

export { AppCatalog, lookupApp } from "./apps.js";
export type { AppEntry } from "./apps.js";
