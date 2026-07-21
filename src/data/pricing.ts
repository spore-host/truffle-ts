// Static on-demand pricing — a seed of the Go dep spore-host/libs/pricing
// (ec2.go). Prices are approximate us-east-1 On-Demand rates "as of 2026-01",
// NOT live. The exact-match table covers common types; estimatePriceByFamily is
// the fallback heuristic (family "large" base price × size multiplier) for
// anything not listed — the same model the Go tool ships as its offline pricer.
//
// Live pricing (the authenticated AWS Price List Query API) is not browser-
// feasible; it belongs behind the Finder seam. This is the offline default.

/** Approximate us-east-1 on-demand $/hr, "as of 2026-01". */
export const EC2Pricing: Record<string, number> = {
  // General purpose
  "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416, "t3.large": 0.0832, "t3.xlarge": 0.1664, "t3.2xlarge": 0.3328,
  "t4g.micro": 0.0084, "t4g.small": 0.0168, "t4g.medium": 0.0336, "t4g.large": 0.0672, "t4g.xlarge": 0.1344, "t4g.2xlarge": 0.2688,
  "m5.large": 0.096, "m5.xlarge": 0.192, "m5.2xlarge": 0.384, "m5.4xlarge": 0.768,
  "m6i.large": 0.096, "m6i.xlarge": 0.192, "m6i.2xlarge": 0.384, "m6i.4xlarge": 0.768,
  "m7i.large": 0.1008, "m7i.xlarge": 0.2016, "m7i.2xlarge": 0.4032, "m7i.4xlarge": 0.8064,
  "m7g.large": 0.0816, "m7g.xlarge": 0.1632, "m7g.2xlarge": 0.3264, "m7g.4xlarge": 0.6528,
  "m7a.large": 0.11592, "m7a.xlarge": 0.23184, "m7a.2xlarge": 0.46368,
  // Compute optimized
  "c5.large": 0.085, "c5.xlarge": 0.17, "c5.2xlarge": 0.34, "c5.4xlarge": 0.68,
  "c6i.large": 0.085, "c6i.xlarge": 0.17, "c6i.2xlarge": 0.34, "c6i.4xlarge": 0.68,
  "c7i.large": 0.0893, "c7i.xlarge": 0.1785, "c7i.2xlarge": 0.357, "c7i.4xlarge": 0.714,
  "c7g.large": 0.0725, "c7g.xlarge": 0.145, "c7g.2xlarge": 0.29, "c7g.4xlarge": 0.58,
  "c6a.large": 0.0765, "c6a.xlarge": 0.153, "c6a.2xlarge": 0.306, "c6a.4xlarge": 0.612,
  // Memory optimized
  "r5.large": 0.126, "r5.xlarge": 0.252, "r5.2xlarge": 0.504,
  "r6i.large": 0.126, "r6i.xlarge": 0.252, "r6i.2xlarge": 0.504,
  "r7g.large": 0.10584, "r7g.xlarge": 0.21168, "r7g.2xlarge": 0.42336,
  "r8g.large": 0.11844, "r8g.xlarge": 0.23688, "r8g.2xlarge": 0.47376,
  // GPU / accelerated
  "g4dn.xlarge": 0.526, "g4dn.2xlarge": 0.752, "g4dn.12xlarge": 3.912,
  "g5.xlarge": 1.006, "g5.2xlarge": 1.212, "g5.12xlarge": 5.672, "g5.48xlarge": 16.288,
  "g6.xlarge": 0.8048, "g6.12xlarge": 4.6016,
  "g6e.xlarge": 1.861,
  "p3.2xlarge": 3.06, "p3.8xlarge": 12.24, "p3.16xlarge": 24.48,
  "p4d.24xlarge": 32.7726,
  "p5.48xlarge": 98.32,
  // AWS accelerators
  "inf2.xlarge": 0.7582, "inf2.48xlarge": 12.98,
  "trn1.2xlarge": 1.3438, "trn1.32xlarge": 21.5,
};

// Family "large" (2 vCPU) base $/hr, ported from libs/pricing estimatePriceByFamily.
const basePriceLarge: Record<string, number> = {
  t2: 0.0928, t3: 0.0832, t3a: 0.0752, t4g: 0.0672,
  m5: 0.096, m5a: 0.086, m5n: 0.119, m6i: 0.096, m6a: 0.086, m7i: 0.1008,
  c5: 0.085, c5a: 0.077, c5n: 0.108, c6i: 0.085, c6a: 0.077, c7i: 0.0893,
  r5: 0.126, r5a: 0.113, r6i: 0.126,
  g4dn: 0.263, g5: 0.503, p3: 0.765, p4d: 0.6827,
};

// Size multiplier relative to "large" = 1.0, ported from libs/pricing.
const sizeMultiplier: Record<string, number> = {
  nano: 0.0625, micro: 0.125, small: 0.25, medium: 0.5, large: 1.0,
  xlarge: 2.0, "2xlarge": 4.0, "4xlarge": 8.0, "8xlarge": 16.0,
  "12xlarge": 24.0, "16xlarge": 32.0, "24xlarge": 48.0, "48xlarge": 96.0, metal: 48.0,
};

/**
 * Rough on-demand $/hr for an instance type not in the exact table: the family's
 * "large" base price × a size multiplier. Falls back to $0.10 base / 2× (xlarge)
 * multiplier for unknowns. Ports Go estimatePriceByFamily.
 */
export function estimatePriceByFamily(instanceType: string): number {
  const parts = instanceType.split(".");
  if (parts.length < 2) return 0.1;
  const [family, size] = parts;
  const base = basePriceLarge[family] ?? 0.1;
  const mult = sizeMultiplier[size] ?? 2.0;
  return base * mult;
}

/** On-demand $/hr — the exact table if present, else the family estimate. */
export function onDemandPrice(instanceType: string): number {
  return EC2Pricing[instanceType] ?? estimatePriceByFamily(instanceType);
}
