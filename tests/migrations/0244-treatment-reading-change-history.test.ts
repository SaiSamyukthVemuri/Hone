import { describe, expect, it } from "vitest";
import { EXPORT_RESOURCE_REGISTRY, exportedResources } from "../../lib/export/resource-registry";
describe("0244 export registry disposition", () => {
  it("registers clinical diffs PENDING field review without export emission", () => {
    expect(EXPORT_RESOURCE_REGISTRY.treatment_reading_change_events).toMatchObject({ kind: "pending", fieldReviewRequired: true, tier: 1 });
    expect(exportedResources().some(row => row.resource === "treatment_reading_change_events")).toBe(false);
  });
});
