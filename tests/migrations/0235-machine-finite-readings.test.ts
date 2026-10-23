import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

describe("0235 owns the current derived migration guard", () => {
  it("is allocated once at its registered path", () => {
    expect(countVersion("0235")).toBe(1);
    expect(fileForVersion("0235")).toBe("0235_machine_finite_readings.sql");
  });
});
