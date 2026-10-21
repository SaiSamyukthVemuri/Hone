import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

describe("0235 remains allocated after the 0243 current-max handoff", () => {
  it("is allocated once with its original governed file", () => {
    expect(countVersion("0235")).toBe(1);
    expect(fileForVersion("0235")).toBe("0235_machine_finite_readings.sql");
    // Maximum ownership follows the highest authored owner; central guards derive it.
  });
});
