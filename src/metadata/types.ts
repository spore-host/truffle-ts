// Shared types for the static hardware catalogs. Ported from the struct
// definitions in the Go tool's pkg/metadata.

import type { Architecture } from "../core/types.js";

/** A CPU processor used in EC2 instances (Go metadata.ProcessorInfo). */
export interface ProcessorInfo {
  /** Marketing code name, e.g. "Sapphire Rapids". */
  codeName: string;
  vendor: "intel" | "amd" | "aws";
  architecture: Architecture;
  /** e.g. "3rd gen", "4th gen", "legacy". */
  generation: string;
  /** Instance families using this processor, e.g. ["m6i", "c6i", "r6i"]. */
  families: string[];
}

/** A GPU / accelerator used in EC2 instances (Go metadata.GPUInfo). */
export interface GPUInfo {
  /** Display name, e.g. "A100", "H100". */
  name: string;
  vendor: "nvidia" | "amd" | "aws";
  /** GPU memory per GPU, in GB. */
  memoryGB: number;
  /** "training" | "inference" | "graphics" | "legacy" | "any". */
  useCase: string;
  /** Instance families carrying this GPU (fuzzy matching). */
  families: string[];
  /** Exact instance types carrying this GPU (precise matching). */
  instanceTypes?: string[];
}

/** Networking capability of a set of instance families (Go metadata.NetworkCapability). */
export interface NetworkCapability {
  /** Maximum network bandwidth in Gbps. */
  maxBandwidthGbps: number;
  /** Instance families with this capability. */
  families: string[];
}

/** A named category of instance sizes (Go metadata.SizeCategory). */
export interface SizeCategory {
  name: string;
  /** Instance size suffixes, e.g. ["2xlarge", "4xlarge"]. */
  sizes: string[];
}
