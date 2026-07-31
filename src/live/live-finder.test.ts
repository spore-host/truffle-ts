// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EC2Client,
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
  DescribeSpotPriceHistoryCommand,
} from "@aws-sdk/client-ec2";
import { PricingClient } from "@aws-sdk/client-pricing";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { AwsLiveFinder, exactTypeName } from "./live-finder.js";
import { QUOTA_FAMILIES } from "./quotas.js";
import type { InstanceType } from "../core/types.js";

afterEach(() => vi.restoreAllMocks());

// Canned DescribeInstanceTypes records (AWS shape).
const M7I_LARGE = { InstanceType: "m7i.large", VCpuInfo: { DefaultVCpus: 2, DefaultCores: 1, DefaultThreadsPerCore: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ["x86_64"] } };
const M7I_4XL = { InstanceType: "m7i.4xlarge", VCpuInfo: { DefaultVCpus: 16, DefaultCores: 8, DefaultThreadsPerCore: 2 }, MemoryInfo: { SizeInMiB: 65536 }, ProcessorInfo: { SupportedArchitectures: ["x86_64"] } };
const C7G_LARGE = { InstanceType: "c7g.large", VCpuInfo: { DefaultVCpus: 2, DefaultCores: 2, DefaultThreadsPerCore: 1 }, MemoryInfo: { SizeInMiB: 4096 }, ProcessorInfo: { SupportedArchitectures: ["arm64"] } };

/**
 * Stub EC2Client.send; `handler(cmd, region)` returns the canned response.
 *
 * `config.region` is a resolver FUNCTION, not a string, so it has to be awaited
 * before a handler can branch on it — comparing it directly silently never
 * matches, which makes any per-region test vacuously green.
 */
function stubEc2(handler: (cmd: any, region: string) => any) {
  const sent: { cmd: any; region: string }[] = [];
  vi.spyOn(EC2Client.prototype, "send").mockImplementation(async function (this: any, cmd: any) {
    const r = this.config.region;
    const region: string = typeof r === "function" ? await r() : r;
    sent.push({ cmd, region });
    return handler(cmd, region);
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

});

/** A minimal InstanceType for the spot/quota paths (specs beyond these are unused). */
const it_ = (instanceType: string, vcpus = 2): InstanceType => ({
  instanceType,
  instanceFamily: instanceType.split(".")[0],
  vcpus,
  memoryMib: 8192,
  architecture: "x86_64",
});

const spotEntry = (az: string, price: string) => ({
  AvailabilityZone: az,
  SpotPrice: price,
  ProductDescription: "Linux/UNIX",
  Timestamp: new Date("2026-07-30T12:00:00.000Z"),
});

describe("AwsLiveFinder.getSpotPricing", () => {
  it("returns nothing (and makes no call) for an empty instance list", async () => {
    const sent = stubEc2(() => ({}));
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    expect(await f.getSpotPricing([], {})).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("queries each distinct type once, per region, and tags the region", async () => {
    const sent = stubEc2((_cmd, region) => ({
      SpotPriceHistory: [spotEntry(`${region}a`, "0.10")],
    }));
    const f = new AwsLiveFinder({ regions: ["us-east-1", "us-west-2"] });
    const out = await f.getSpotPricing([it_("m7i.large"), it_("m7i.large"), it_("c7g.large")], {});
    // 2 distinct types × 2 regions = 4 queries, not 3 × 2.
    expect(sent.filter((s) => s.cmd instanceof DescribeSpotPriceHistoryCommand)).toHaveLength(4);
    expect(new Set(out.map((r) => r.region))).toEqual(new Set(["us-east-1", "us-west-2"]));
    expect(new Set(out.map((r) => r.instanceType))).toEqual(new Set(["m7i.large", "c7g.large"]));
  });

  it("shares ONE start time across every region and type", async () => {
    const sent = stubEc2(() => ({ SpotPriceHistory: [] }));
    const f = new AwsLiveFinder({ regions: ["us-east-1", "us-west-2"] });
    await f.getSpotPricing([it_("m7i.large"), it_("c7g.large")], { lookbackHours: 6 });
    const starts = sent
      .filter((s) => s.cmd instanceof DescribeSpotPriceHistoryCommand)
      .map((s) => (s.cmd.input.StartTime as Date).getTime());
    expect(new Set(starts).size).toBe(1); // a comparable window for the whole batch
  });

  it("keeps the surviving region's prices when another region fails", async () => {
    stubEc2((_cmd, region) => {
      if (region === "eu-west-1") throw new Error("region boom");
      return { SpotPriceHistory: [spotEntry("us-east-1a", "0.10")] };
    });
    const f = new AwsLiveFinder({ regions: ["us-east-1", "eu-west-1"] });
    const out = await f.getSpotPricing([it_("m7i.large")], {});
    expect(out.map((r) => r.region)).toEqual(["us-east-1"]);
  });

  it("tolerates ONE type failing while another succeeds in the same region", async () => {
    stubEc2((cmd) => {
      if (cmd instanceof DescribeSpotPriceHistoryCommand) {
        if (cmd.input.InstanceTypes?.[0] === "c7g.large") throw new Error("type boom");
        return { SpotPriceHistory: [spotEntry("us-east-1a", "0.10")] };
      }
      return {};
    });
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    const out = await f.getSpotPricing([it_("m7i.large"), it_("c7g.large")], {});
    expect(out.map((r) => r.instanceType)).toEqual(["m7i.large"]);
  });

  it("throws when EVERY region fails, rather than returning an empty list", async () => {
    // #63 invariant: total failure must not look like "no spot capacity/data".
    stubEc2(() => { throw new Error("all spot boom"); });
    const f = new AwsLiveFinder({ regions: ["us-east-1", "eu-west-1"] });
    await expect(f.getSpotPricing([it_("m7i.large")], {})).rejects.toThrow(/all regions/);
  });

  it("throws when every TYPE fails in the only region", async () => {
    // The per-type tolerance must not swallow a region-wide failure.
    stubEc2(() => { throw new Error("all types boom"); });
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    await expect(f.getSpotPricing([it_("m7i.large"), it_("c7g.large")], {})).rejects.toThrow(/all regions/);
  });

  it("annotates savings from the Pricing API, once per type", async () => {
    stubEc2(() => ({ SpotPriceHistory: [spotEntry("us-east-1a", "0.20"), spotEntry("us-east-1b", "0.25")] }));
    const priceProduct = JSON.stringify({
      terms: { OnDemand: { a: { priceDimensions: { b: { pricePerUnit: { USD: "0.8000" } } } } } },
    });
    const pricingSent: any[] = [];
    vi.spyOn(PricingClient.prototype, "send").mockImplementation(function (this: unknown, cmd: any) {
      pricingSent.push(cmd);
      return Promise.resolve({ PriceList: [priceProduct] });
    } as any);

    const f = new AwsLiveFinder({ regions: "us-east-1" });
    const out = await f.getSpotPricing([it_("m7i.large")], { showSavings: true });
    expect(out).toHaveLength(2); // two AZs
    expect(out.every((r) => r.onDemandPrice === 0.8)).toBe(true);
    // On-demand doesn't vary by AZ, so it's fetched once for the type, not per AZ.
    expect(pricingSent).toHaveLength(1);
  });

  it("still returns spot prices when the on-demand lookup fails", async () => {
    stubEc2(() => ({ SpotPriceHistory: [spotEntry("us-east-1a", "0.20")] }));
    vi.spyOn(PricingClient.prototype, "send").mockImplementation(() => Promise.reject(new Error("pricing boom")) as any);
    const f = new AwsLiveFinder({ regions: "us-east-1" });
    const out = await f.getSpotPricing([it_("m7i.large")], { showSavings: true });
    expect(out[0].spotPrice).toBe(0.2);
    expect(out[0].savingsPercent).toBeUndefined(); // the annotation is lost, the price isn't
  });
});

/** Stub ServiceQuotas.send to answer every GetServiceQuota with `value`. */
function stubQuotasAll(value: number) {
  vi.spyOn(ServiceQuotasClient.prototype, "send").mockImplementation(
    () => Promise.resolve({ Quota: { Value: value } }) as any,
  );
}

describe("AwsLiveFinder.getQuotas", () => {
  it("returns limits plus usage for the primary region", async () => {
    stubQuotasAll(64);
    stubEc2(() => ({ Reservations: [{ Instances: [{ InstanceType: "m7i.4xlarge" }] }] }));
    const f = new AwsLiveFinder({
      regions: "us-east-1",
      serviceQuotasClientFor: (region) => new ServiceQuotasClient({ region }),
    });
    const q = await f.getQuotas();
    expect(q.region).toBe("us-east-1");
    expect(q.onDemand.Standard).toBe(64);
    expect(q.spot.Standard).toBe(64);
    expect(q.usage.Standard).toBe(16);
    expect(q.runningInstances).toBe(1);
    expect(q.incomplete).toBeUndefined();
  });

  it("honours an explicit region override", async () => {
    stubQuotasAll(8);
    stubEc2(() => ({ Reservations: [] }));
    const f = new AwsLiveFinder({
      regions: "us-east-1",
      serviceQuotasClientFor: (region) => new ServiceQuotasClient({ region }),
    });
    expect((await f.getQuotas({ region: "eu-west-1" })).region).toBe("eu-west-1");
  });

  it("skips the DescribeInstances pass when skipUsage is set", async () => {
    stubQuotasAll(64);
    const sent = stubEc2(() => ({ Reservations: [] }));
    const f = new AwsLiveFinder({
      regions: "us-east-1",
      serviceQuotasClientFor: (region) => new ServiceQuotasClient({ region }),
    });
    const q = await f.getQuotas({ skipUsage: true });
    expect(q.usage).toEqual({});
    expect(q.runningInstances).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("marks EVERY family incomplete when the usage pass fails", async () => {
    // 0 used OVERSTATES headroom, so an unavailable usage read must not present
    // as a clean slate — every family's arithmetic is now untrustworthy.
    stubQuotasAll(64);
    stubEc2(() => { throw new Error("describe boom"); });
    const f = new AwsLiveFinder({
      regions: "us-east-1",
      serviceQuotasClientFor: (region) => new ServiceQuotasClient({ region }),
    });
    const q = await f.getQuotas();
    expect(q.usage).toEqual({});
    expect(q.incomplete?.sort()).toEqual([...QUOTA_FAMILIES].sort());
    expect(q.onDemand.Standard).toBe(64); // limits survived
  });

  it("propagates a total quota-lookup failure", async () => {
    vi.spyOn(ServiceQuotasClient.prototype, "send").mockImplementation(
      () => Promise.reject(new Error("quota boom")) as any,
    );
    stubEc2(() => ({ Reservations: [] }));
    const f = new AwsLiveFinder({
      regions: "us-east-1",
      serviceQuotasClientFor: (region) => new ServiceQuotasClient({ region }),
    });
    await expect(f.getQuotas()).rejects.toThrow(/quota lookups failed/);
  });

  it("canLaunch checks an instance against a fetched snapshot", async () => {
    stubQuotasAll(32);
    stubEc2(() => ({ Reservations: [{ Instances: [{ InstanceType: "m7i.4xlarge" }] }] })); // 16 used
    const f = new AwsLiveFinder({
      regions: "us-east-1",
      serviceQuotasClientFor: (region) => new ServiceQuotasClient({ region }),
    });
    const q = await f.getQuotas();
    expect(f.canLaunch(it_("m7i.2xlarge", 8), q).canLaunch).toBe(true); // 8 <= 16 free
    expect(f.canLaunch(it_("m7i.8xlarge", 32), q).canLaunch).toBe(false); // 32 > 16 free
  });
});
