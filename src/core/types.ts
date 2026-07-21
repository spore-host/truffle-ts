// Core domain types for truffle-ts. These mirror the data model of the Go
// `truffle` tool (see ~/src/spore-host/truffle/pkg/aws/client.go —
// InstanceTypeResult / FilterOptions) so a query resolved here matches what the
// real CLI would return, minus the live-only fields (AZs, quotas, SageMaker)
// that a browser can't populate without AWS credentials.

/** CPU architecture of an instance type. */
export type Architecture = "x86_64" | "arm64";

/**
 * One EC2 instance type's capabilities. This is the shape of a bundled-catalog
 * entry and of a `Finder.search` result. Optional fields are omitted when zero/
 * unknown, matching the Go `omitempty` JSON tags. Prices are approximate static
 * estimates ("as of 2026-01"), never live.
 */
export interface InstanceType {
  /** e.g. "m6i.2xlarge". */
  instanceType: string;
  /** Family prefix, e.g. "m6i". */
  instanceFamily: string;
  vcpus: number;
  /** Physical CPU cores (vCPUs / threadsPerCore). */
  physicalCores?: number;
  /** Threads per physical core (1 for Graviton, 2 for most x86). */
  threadsPerCore?: number;
  /** Memory in MiB. */
  memoryMib: number;
  architecture: Architecture;
  /** Number of GPUs; omitted for non-GPU instances. */
  gpus?: number;
  /** Total GPU memory in MiB across all GPUs. */
  gpuMemoryMib?: number;
  /** GPU model name, e.g. "A100". */
  gpuModel?: string;
  /** GPU vendor, e.g. "nvidia". */
  gpuManufacturer?: string;
  /** On-demand $/hr. Live from the Pricing API when regenerated, else a static estimate. */
  onDemandPrice?: number;
  /**
   * True when this entry's specs/price are NOT live AWS data — carried over from
   * the hand seed because the type isn't offered in the generated region (legacy
   * families like g3/p2/p3, or brand-new ones). Absent = came from the live pull.
   */
  estimatedPrice?: boolean;
  /** True if the type supports nested virtualization (KVM/Hyper-V in-instance). */
  nestedVirt?: boolean;
}

/**
 * Numeric/categorical filters applied to instance types, a subset of the Go
 * `FilterOptions` (the live-only IncludeAZs/Verbose knobs are dropped). Any
 * zero/empty field disables that filter. Exact* flags switch a "minimum" filter
 * to an "equals" filter.
 */
export interface FilterOptions {
  architecture?: Architecture | "";
  minVcpus?: number;
  minMemoryGiB?: number;
  minPhysicalCores?: number;
  exactVcpus?: boolean;
  exactMemory?: boolean;
  exactCores?: boolean;
  /** Restrict to a family prefix, e.g. "m6i"; empty matches all. */
  instanceFamily?: string;
  nestedVirt?: boolean;
}

/** One ranked result: the matched instance plus human-readable match reasons. */
export interface FindResult {
  instance: InstanceType;
  /** Why this matched, e.g. ["GPU: H100 (80 GiB, training)", "vCPUs: 192 >= 8"]. */
  reasons: string[];
}
