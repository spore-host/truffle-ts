// Map an EC2 DescribeInstanceTypes record to truffle-ts's InstanceType. This is
// the runtime twin of scripts/gen-catalog.mjs's `toEntry` (which builds the
// offline snapshot) and of the Go tool's buildResultFromEC2 — kept in sync so a
// live result is indistinguishable in shape from a bundled one. Pure: no SDK
// calls, just a shape transform, so it's trivially testable.

import type { InstanceType } from "../core/types.js";
import type { InstanceTypeInfo } from "@aws-sdk/client-ec2";

/**
 * Convert one AWS `InstanceTypeInfo` into an `InstanceType`. Pricing is NOT set
 * here (DescribeInstanceTypes carries none) — the live finder fills it
 * separately (or leaves it undefined). Mirrors gen-catalog's `toEntry`.
 */
export function mapInstanceType(it: InstanceTypeInfo): InstanceType {
  const type = it.InstanceType ?? "";
  const gpus = it.GpuInfo?.Gpus ?? [];
  const gpuCount = gpus.reduce((n, g) => n + (g.Count ?? 0), 0);
  const firstGpu = gpus[0];
  const nested = (it.ProcessorInfo?.SupportedFeatures ?? []).includes("nested-virtualization");
  const archs = it.ProcessorInfo?.SupportedArchitectures ?? [];

  const out: InstanceType = {
    instanceType: type,
    instanceFamily: type.split(".")[0],
    vcpus: it.VCpuInfo?.DefaultVCpus ?? 0,
    memoryMib: Number(it.MemoryInfo?.SizeInMiB ?? 0),
    architecture: archs.includes("arm64") ? "arm64" : "x86_64",
    nestedVirt: nested,
  };
  if (it.VCpuInfo?.DefaultCores) out.physicalCores = it.VCpuInfo.DefaultCores;
  if (it.VCpuInfo?.DefaultThreadsPerCore) out.threadsPerCore = it.VCpuInfo.DefaultThreadsPerCore;

  if (firstGpu && gpuCount > 0) {
    out.gpus = gpuCount;
    if (firstGpu.Name) out.gpuModel = firstGpu.Name;
    if (firstGpu.Manufacturer) out.gpuManufacturer = firstGpu.Manufacturer.toLowerCase();
    const total = it.GpuInfo?.TotalGpuMemoryInMiB ?? (firstGpu.MemoryInfo?.SizeInMiB ?? 0) * gpuCount;
    if (total) out.gpuMemoryMib = total;
  }
  return out;
}
