import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

describe("0235 owns the current derived migration guard", () => {
  it("is allocated once and is the repository maximum", () => {
    expect(countVersion("0235")).toBe(1);
    expect(fileForVersion("0235")).toBe("0235_machine_finite_readings.sql");
    expect(isRepoMax("0235")).toBe(true);
  });
});
