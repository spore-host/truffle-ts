// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EC2Client,
  DescribeInstanceTypesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeAvailabilityZonesCommand,
} from "@aws-sdk/client-ec2";
import {
  azsByInstanceType,
  fetchAvailabilityZones,
  fetchZoneInfos,
  extractRegionsFromAZs,
  filterByAZs,
  filterByMinAZCount,
  filterToLocalZones,
  sortAZResults,
  summarizeAZRegions,
  summarizeAZs,
  isExtendedZone,
  zoneLabel,
  AZ_BATCH_SIZE,
} from "./az.js";
import { AwsLiveFinder } from "./live-finder.js";
import type { InstanceType } from "../core/types.js";

afterEach(() => vi.restoreAllMocks());

const row = (instanceType: string, region: string, availableAZs: string[]): InstanceType => ({
  instanceType, instanceFamily: instanceType.split(".")[0], vcpus: 2, memoryMib: 8192, architecture: "x86_64", region, availableAZs,
});

describe("azsByInstanceType (Go TestAZsByInstanceType_OrderIndependent, #217)", () => {
  it("groups, dedupes and zone-orders however the offerings arrive", () => {
    const offerings: any[] = [];
    for (const az of ["us-west-2a", "us-west-2b", "us-west-2c", "us-west-2d", "us-west-2-lax-1a"]) offerings.push({ InstanceType: "m8a.4xlarge", Location: az });
    for (const az of ["us-west-2b", "us-west-2c"]) offerings.push({ InstanceType: "c8a.large", Location: az });
    offerings.push({ InstanceType: "c8a.large", Location: "us-west-2b" }, { InstanceType: "c8a.large" });
    const want = {
      "m8a.4xlarge": ["us-west-2a", "us-west-2b", "us-west-2c", "us-west-2d", "us-west-2-lax-1a"],
      "c8a.large": ["us-west-2b", "us-west-2c"],
    };
    let seed = 217;
    for (let i = 0; i < 50; i++) {
      const s = [...offerings];
      for (let k = s.length - 1; k > 0; k--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (k + 1);
        [s[k], s[j]] = [s[j], s[k]];
      }
      expect(Object.fromEntries(azsByInstanceType(s))).toEqual(want);
    }
  });
});

describe("the az filters (Go cmd/az.go)", () => {
  const rs = [
    row("m7i.large", "us-east-1", ["us-east-1a", "us-east-1b", "us-east-1c"]),
    row("m7i.large", "us-west-2", ["us-west-2a", "us-west-2-lax-1a"]),
    row("c7i.large", "us-east-1", ["us-east-1b"]),
  ];
  it("filterByAZs rewrites each row to the matched AZs", () => {
    expect(filterByAZs(rs, ["us-east-1b", "us-west-2a"]).map((r) => [r.instanceType, r.region, r.availableAZs])).toEqual([
      ["m7i.large", "us-east-1", ["us-east-1b"]],
      ["m7i.large", "us-west-2", ["us-west-2a"]],
      ["c7i.large", "us-east-1", ["us-east-1b"]],
    ]);
    expect(rs[0].availableAZs).toHaveLength(3); // input untouched
  });
  it("filterByMinAZCount and the AZ-count sort", () => {
    expect(filterByMinAZCount(rs, 2).map((r) => r.region)).toEqual(["us-east-1", "us-west-2"]);
    expect(sortAZResults(rs).map((r) => `${r.instanceType}@${r.region}`)).toEqual(["m7i.large@us-east-1", "m7i.large@us-west-2", "c7i.large@us-east-1"]);
  });
  it("filterToLocalZones keeps edge zones only and drops rows with none (#164)", () => {
    expect(filterToLocalZones(rs, new Set(["us-west-2-lax-1a"]))).toEqual([row("m7i.large", "us-west-2", ["us-west-2-lax-1a"])]);
  });
  it("extractRegionsFromAZs, including a Local Zone (where Go's drop-a-char rule breaks)", () => {
    expect(extractRegionsFromAZs(["us-east-1a", "us-east-1b", "us-west-2-lax-1a", "us-gov-west-1a"])).toEqual(["us-east-1", "us-gov-west-1", "us-west-2"]);
  });
  it("summarizeAZRegions: one row per region, standard AZs first (Go TestSummarizeAZRegions_ZoneOrder, #199)", () => {
    const got = summarizeAZRegions([
      row("g4dn.xlarge", "us-west-2", ["us-west-2-lax-1a", "us-west-2b"]),
      row("g5.xlarge", "us-west-2", ["us-west-2a"]),
    ]);
    expect(got).toEqual([
      { region: "us-west-2", azCount: 3, availabilityZones: ["us-west-2a", "us-west-2b", "us-west-2-lax-1a"], instanceTypes: ["g4dn.xlarge", "g5.xlarge"] },
    ]);
    expect(summarizeAZRegions(rs).map((s) => [s.region, s.azCount])).toEqual([["us-east-1", 3], ["us-west-2", 2]]);
  });
  it("summarizeAZs (Go printAZSummary)", () => {
    expect(summarizeAZs(rs)).toEqual({ instanceTypes: 2, regionResults: 3, minAZs: 1, maxAZs: 3, averageAZs: 2 });
    expect(summarizeAZs([])).toEqual({ instanceTypes: 0, regionResults: 0, minAZs: 0, maxAZs: 0, averageAZs: 0 });
  });
  it("classifies zone types", () => {
    expect(isExtendedZone({ zoneType: "local-zone" })).toBe(true);
    expect(isExtendedZone({ zoneType: "wavelength-zone" })).toBe(true);
    expect(isExtendedZone({ zoneType: "availability-zone" })).toBe(false);
    expect([zoneLabel({ zoneType: "local-zone" }), zoneLabel({ zoneType: "wavelength-zone" }), zoneLabel({ zoneType: "availability-zone" })]).toEqual(["Local Zone", "Wavelength", ""]);
  });
});

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

describe("fetchAvailabilityZones (Go getAvailabilityZonesBatch)", () => {
  it("batches AZ_BATCH_SIZE types per call and reports a failed batch instead of hiding it", async () => {
    const types = Array.from({ length: AZ_BATCH_SIZE + 5 }, (_, i) => `m7i.t${i}`);
    let call = 0;
    const sent = stubEc2((cmd) => {
      call++;
      if (call === 2) throw new Error("throttled");
      return { InstanceTypeOfferings: cmd.input.Filters[0].Values.map((t: string) => ({ InstanceType: t, Location: "us-east-1a" })) };
    });
    const r = await fetchAvailabilityZones(new EC2Client({ region: "us-east-1" }), types);
    expect(sent).toHaveLength(2);
    expect(sent[0].cmd).toBeInstanceOf(DescribeInstanceTypeOfferingsCommand);
    expect(sent[0].cmd.input.LocationType).toBe("availability-zone");
    expect(sent[0].cmd.input.Filters[0].Values).toHaveLength(AZ_BATCH_SIZE);
    expect(r.azs.size).toBe(AZ_BATCH_SIZE);
    expect(r.failedTypes).toHaveLength(5);
    expect(r.errors).toEqual(["throttled"]);
  });
});

describe("fetchZoneInfos (Go ZoneInfos)", () => {
  it("asks for ALL zones and keeps the classification fields", async () => {
    const sent = stubEc2(() => ({
      AvailabilityZones: [
        { ZoneName: "us-west-2a", ZoneId: "usw2-az1", ZoneType: "availability-zone", OptInStatus: "opt-in-not-required" },
        { ZoneName: "us-west-2-lax-1a", ZoneId: "usw2-lax1-az1", ZoneType: "local-zone", ParentZoneName: "us-west-2d", GroupName: "us-west-2-lax-1" },
      ],
    }));
    const z = await fetchZoneInfos(new EC2Client({ region: "us-west-2" }), "us-west-2");
    expect(sent[0].cmd).toBeInstanceOf(DescribeAvailabilityZonesCommand);
    expect(sent[0].cmd.input.AllAvailabilityZones).toBe(true);
    expect(z.get("us-west-2-lax-1a")).toEqual({
      zoneName: "us-west-2-lax-1a", zoneId: "usw2-lax1-az1", zoneType: "local-zone", parentZoneName: "us-west-2d", groupName: "us-west-2-lax-1", region: "us-west-2",
    });
  });
});

const M7I = { InstanceType: "m7i.large", VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ["x86_64"] } };

describe("AwsLiveFinder.searchAZs (Go truffle az)", () => {
  it("fills AZs, filters by --az (which also picks the regions), labels Local Zones", async () => {
    const sent = stubEc2((cmd, region) => {
      if (cmd instanceof DescribeInstanceTypesCommand) return { InstanceTypes: [M7I] };
      if (cmd instanceof DescribeInstanceTypeOfferingsCommand) {
        return {
          InstanceTypeOfferings: (region === "us-west-2"
            ? ["us-west-2b", "us-west-2-lax-1a", "us-west-2a"]
            : ["us-east-1a"]
          ).map((Location) => ({ InstanceType: "m7i.large", Location })),
        };
      }
      if (cmd instanceof DescribeAvailabilityZonesCommand) {
        return { AvailabilityZones: [{ ZoneName: "us-west-2-lax-1a", ZoneType: "local-zone" }, { ZoneName: "us-west-2a", ZoneType: "availability-zone" }] };
      }
      return {};
    });
    const f = new AwsLiveFinder({ regions: ["us-east-1"] });
    const r = await f.searchAZs(/^m7i\.large$/, {}, { azs: ["us-west-2a", "us-west-2-lax-1a"] });
    // The configured us-east-1 was NOT searched: --az chose us-west-2.
    expect(new Set(sent.map((s) => s.region))).toEqual(new Set(["us-west-2"]));
    expect(r.results.map((x) => [x.region, x.availableAZs])).toEqual([["us-west-2", ["us-west-2a", "us-west-2-lax-1a"]]]);
    expect(r.localZones).toEqual(["us-west-2-lax-1a"]);

    const edge = await f.searchAZs(/^m7i\.large$/, {}, { azs: ["us-west-2a", "us-west-2-lax-1a"], localZonesOnly: true });
    expect(edge.results.map((x) => x.availableAZs)).toEqual([["us-west-2-lax-1a"]]);
  });

  it("applies minAZCount across regions", async () => {
    stubEc2((cmd, region) => {
      if (cmd instanceof DescribeInstanceTypesCommand) return { InstanceTypes: [M7I] };
      if (cmd instanceof DescribeInstanceTypeOfferingsCommand) {
        const azs = region === "us-east-1" ? ["us-east-1a", "us-east-1b", "us-east-1c"] : ["us-west-2a"];
        return { InstanceTypeOfferings: azs.map((Location) => ({ InstanceType: "m7i.large", Location })) };
      }
      return { AvailabilityZones: [] };
    });
    const f = new AwsLiveFinder({ regions: ["us-east-1", "us-west-2"] });
    const r = await f.searchAZs(/^m7i\.large$/, {}, { minAZCount: 3 });
    expect(r.results.map((x) => x.region)).toEqual(["us-east-1"]);
  });

  it("includeAZs fills availableAZs on plain search", async () => {
    stubEc2((cmd) => {
      if (cmd instanceof DescribeInstanceTypesCommand) return { InstanceTypes: [M7I] };
      return { InstanceTypeOfferings: [{ InstanceType: "m7i.large", Location: "us-east-1b" }, { InstanceType: "m7i.large", Location: "us-east-1a" }] };
    });
    const [it] = await new AwsLiveFinder({ regions: "us-east-1", includeAZs: true }).search(/^m7i\.large$/, {});
    expect(it.availableAZs).toEqual(["us-east-1a", "us-east-1b"]);
  });
});

describe("AwsLiveFinder.listInstanceTypes (Go truffle list)", () => {
  it("paginates DescribeInstanceTypes in one region and returns sorted names", async () => {
    let page = 0;
    const sent = stubEc2(() => (++page === 1 ? { InstanceTypes: [{ InstanceType: "m7i.large" }], NextToken: "t" } : { InstanceTypes: [{ InstanceType: "c7i.large" }] }));
    const names = await new AwsLiveFinder({ regions: ["us-west-2", "us-east-1"] }).listInstanceTypes();
    expect(names).toEqual(["c7i.large", "m7i.large"]);
    expect(new Set(sent.map((s) => s.region))).toEqual(new Set(["us-west-2"]));
  });
});
