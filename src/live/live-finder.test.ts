// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EC2Client,
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
} from "@aws-sdk/client-ec2";
import { PricingClient } from "@aws-sdk/client-pricing";
import { AwsLiveFinder, exactTypeName } from "./live-finder.js";

afterEach(() => vi.restoreAllMocks());

// Canned DescribeInstanceTypes records (AWS shape).
const M7I_LARGE = { InstanceType: "m7i.large", VCpuInfo: { DefaultVCpus: 2, DefaultCores: 1, DefaultThreadsPerCore: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ["x86_64"] } };
const M7I_4XL = { InstanceType: "m7i.4xlarge", VCpuInfo: { DefaultVCpus: 16, DefaultCores: 8, DefaultThreadsPerCore: 2 }, MemoryInfo: { SizeInMiB: 65536 }, ProcessorInfo: { SupportedArchitectures: ["x86_64"] } };
const C7G_LARGE = { InstanceType: "c7g.large", VCpuInfo: { DefaultVCpus: 2, DefaultCores: 2, DefaultThreadsPerCore: 1 }, MemoryInfo: { SizeInMiB: 4096 }, ProcessorInfo: { SupportedArchitectures: ["arm64"] } };

/** Stub EC2Client.send; `handler(cmd, region)` returns the canned response. */
function stubEc2(handler: (cmd: any, region: string) => any) {
  const sent: any[] = [];
  vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: any, cmd: any) {
    const region = this.config.region;
    sent.push({ cmd, region: typeof region === "function" ? undefined : region });
    return Promise.resolve(handler(cmd, region));
  } as any);
  return sent;
}

describe("exactTypeName", () => {
  it("returns the literal name for an anchored exact matcher", () => {
    expect(exactTypeName(/^m7i\.4xlarge$/)).toBe("m7i.4xlarge");
    expect(exactTypeName(/^trn1\.32xlarge$/)).toBe("trn1.32xlarge");
  });
  it("returns null for wildcard/regex matchers", () => {
    expect(exactTypeName(/^m7i\..*$/)).toBeNull();
    expect(exactTypeName(/^(m7i|c7i)\.large$/)).toBeNull();
    expect(exactTypeName(/^c[67]g\.large$/)).toBeNull();
  });
});

describe("AwsLiveFinder", () => {
  it("requires at least one region", () => {
    expect(() => new AwsLiveFinder({ regions: [] })).toThrow(/at least one region/);
  });

  it("labels single and multi region", () => {
    expect(new AwsLiveFinder({ regions: "us-east-1" }).label).toBe("aws:us-east-1");
    expect(new AwsLiveFinder({ regions: ["us-east-1", "us-west-2"] }).label).toBe("aws:us-east-1+1 more");
    expect(new AwsLiveFinder({ regions: "us-east-1" }).isLive).toBe(true);
  });

  it("pushes an exact type name server-side (no pagination) for a non-wildcard matcher", async () => {
    const sent = stubEc2(() => ({ InstanceTypes: [M7I_4XL] }));
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    const out = await f.search(/^m7i\.4xlarge$/, {});
    expect(out.map((i) => i.instanceType)).toEqual(["m7i.4xlarge"]);
    const desc = sent.find((s) => s.cmd instanceof DescribeInstanceTypesCommand)!;
    expect(desc.cmd.input.InstanceTypes).toEqual(["m7i.4xlarge"]);
  });

  it("paginates + filters in-memory for a wildcard matcher", async () => {
    let page = 0;
    stubEc2((cmd) => {
      if (!(cmd instanceof DescribeInstanceTypesCommand)) return {};
      expect(cmd.input.InstanceTypes).toBeUndefined(); // wildcard → fetch all
      page++;
      return page === 1
        ? { InstanceTypes: [M7I_LARGE, C7G_LARGE], NextToken: "t2" }
        : { InstanceTypes: [M7I_4XL] };
    });
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    const out = await f.search(/^m7i\./, {});
    expect(out.map((i) => i.instanceType).sort()).toEqual(["m7i.4xlarge", "m7i.large"]);
    expect(page).toBe(2); // followed NextToken
  });

  it("applies FilterOptions with the same matchesFilters as the bundled path", async () => {
    stubEc2(() => ({ InstanceTypes: [M7I_LARGE, M7I_4XL] }));
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    const out = await f.search(/^m7i\./, { minVcpus: 8 });
    expect(out.map((i) => i.instanceType)).toEqual(["m7i.4xlarge"]); // only the 16-vCPU one
  });

  it("fans out across regions and dedupes by instance type", async () => {
    stubEc2(() => ({ InstanceTypes: [M7I_4XL] })); // both regions return the same type
    const f = new AwsLiveFinder({ regions: ["us-east-1", "us-west-2"] });
    const out = await f.search(/^m7i\.4xlarge$/, {});
    expect(out).toHaveLength(1);
  });

  it("returns partial results when one region fails but another succeeds", async () => {
    stubEc2((_cmd, region) => {
      if (region === "eu-west-1") throw new Error("region boom");
      return { InstanceTypes: [M7I_4XL] };
    });
    const f = new AwsLiveFinder({ regions: ["us-east-1", "eu-west-1"] });
    const out = await f.search(/^m7i\.4xlarge$/, {});
    expect(out.map((i) => i.instanceType)).toEqual(["m7i.4xlarge"]);
  });

  it("throws only when every region fails", async () => {
    stubEc2(() => { throw new Error("all boom"); });
    const f = new AwsLiveFinder({ regions: ["us-east-1", "eu-west-1"] });
    await expect(f.search(/^m7i\./, {})).rejects.toThrow(/all regions/);
  });

  it("treats a not-offered exact type as zero results, not an error", async () => {
    stubEc2((): never => { const e: any = new Error("The instance type 'p9.mega' is not supported"); e.name = "InvalidParameterValue"; throw e; });
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    expect(await f.search(/^p9\.mega$/, {})).toEqual([]);
  });

  it("getEnabledRegions returns sorted region names", async () => {
    stubEc2((cmd) => {
      if (cmd instanceof DescribeRegionsCommand) return { Regions: [{ RegionName: "us-west-2" }, { RegionName: "us-east-1" }] };
      return {};
    });
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    expect(await f.getEnabledRegions()).toEqual(["us-east-1", "us-west-2"]);
  });

  it("leaves onDemandPrice unset in the default 'off' pricing mode", async () => {
    stubEc2(() => ({ InstanceTypes: [M7I_4XL] }));
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    expect((await f.search(/^m7i\.4xlarge$/, {}))[0].onDemandPrice).toBeUndefined();
  });

  it("'lazy' pricing fills onDemandPrice from the Pricing API for the result set", async () => {
    stubEc2(() => ({ InstanceTypes: [M7I_4XL] }));
    const priceProduct = JSON.stringify({
      terms: { OnDemand: { a: { priceDimensions: { b: { pricePerUnit: { USD: "0.8064" } } } } } },
    });
    const pricingSent: any[] = [];
    vi.spyOn(PricingClient.prototype, "send").mockImplementation(function (this: unknown, cmd: any) {
      pricingSent.push(cmd);
      return Promise.resolve({ PriceList: [priceProduct] });
    } as any);
    const f = new AwsLiveFinder({ regions: "us-east-1", pricing: "lazy" });
    const out = await f.search(/^m7i\.4xlarge$/, {});
    expect(out[0].onDemandPrice).toBe(0.8064);
    // Priced only the one result, against the queried region.
    expect(pricingSent).toHaveLength(1);
  });

  it("getSpotPricing throws a clear deferred-to-#18 error", async () => {
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    await expect(f.getSpotPricing([], {})).rejects.toThrow(/#18/);
  });
});
