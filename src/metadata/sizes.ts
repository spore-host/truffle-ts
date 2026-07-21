// Size-category catalog — a direct port of the Go tool's pkg/metadata/sizes.go.
// Maps qualitative size categories to the instance size suffixes they cover.

import type { SizeCategory } from "./types.js";

/** Maps size category names to their instance size suffixes. */
export const SizeCategories: Record<string, SizeCategory> = {
  tiny: { name: "tiny", sizes: ["nano", "micro"] },
  small: { name: "small", sizes: ["small", "medium"] },
  medium: { name: "medium", sizes: ["large", "xlarge"] },
  large: { name: "large", sizes: ["2xlarge", "4xlarge"] },
  huge: {
    name: "huge",
    sizes: ["8xlarge", "12xlarge", "16xlarge", "24xlarge", "32xlarge", "48xlarge", "56xlarge", "112xlarge", "metal"],
  },
};

/** The instance size suffixes for a category, or [] if unknown. */
export function getSizesForCategory(category: string): string[] {
  return SizeCategories[category]?.sizes ?? [];
}
