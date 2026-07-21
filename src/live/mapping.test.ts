// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mapInstanceType } from "./mapping.js";
import type { InstanceTypeInfo } from "@aws-sdk/client-ec2";

describe("mapInstanceType", () => {
  it("maps a Graviton CPU type (arm64, 1 thread/core, no GPU)", () => {
    const info: InstanceTypeInfo = {
      InstanceType: "c7g.2xlarge",
      VCpuInfo: { DefaultVCpus: 8, DefaultCores: 8, DefaultThreadsPerCore: 1 },
      MemoryInfo: { SizeInMiB: 16384 },
      ProcessorInfo: { SupportedArchitectures: ["arm64"] },
    } as InstanceTypeInfo;
    expect(mapInstanceType(info)).toEqual({
      instanceType: "c7g.2xlarge",
      instanceFamily: "c7g",
      vcpus: 8,
      physicalCores: 8,
      threadsPerCore: 1,
      memoryMib: 16384,
      architecture: "arm64",
      nestedVirt: false,
    });
  });

  it("maps a GPU type with total GPU memory + manufacturer lowercased", () => {
    const info: InstanceTypeInfo = {
      InstanceType: "p5.48xlarge",
      VCpuInfo: { DefaultVCpus: 192, DefaultCores: 96, DefaultThreadsPerCore: 2 },
      MemoryInfo: { SizeInMiB: 2097152 },
      ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
      GpuInfo: { Gpus: [{ Name: "H100", Manufacturer: "NVIDIA", Count: 8, MemoryInfo: { SizeInMiB: 81920 } }], TotalGpuMemoryInMiB: 655360 },
    } as InstanceTypeInfo;
    const out = mapInstanceType(info);
    expect(out).toMatchObject({ gpus: 8, gpuModel: "H100", gpuManufacturer: "nvidia", gpuMemoryMib: 655360, architecture: "x86_64" });
  });

  it("detects nested-virtualization support", () => {
    const info: InstanceTypeInfo = {
      InstanceType: "m5.metal",
      VCpuInfo: { DefaultVCpus: 96 },
      MemoryInfo: { SizeInMiB: 393216 },
      ProcessorInfo: { SupportedArchitectures: ["x86_64"], SupportedFeatures: ["nested-virtualization"] },
    } as InstanceTypeInfo;
    expect(mapInstanceType(info).nestedVirt).toBe(true);
  });

  it("computes total GPU memory from per-GPU size × count when total absent", () => {
    const info: InstanceTypeInfo = {
      InstanceType: "g5.xlarge",
      VCpuInfo: { DefaultVCpus: 4 },
      MemoryInfo: { SizeInMiB: 16384 },
      ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
      GpuInfo: { Gpus: [{ Name: "A10G", Manufacturer: "NVIDIA", Count: 1, MemoryInfo: { SizeInMiB: 24576 } }] },
    } as InstanceTypeInfo;
    expect(mapInstanceType(info).gpuMemoryMib).toBe(24576);
  });
});
