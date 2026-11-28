import { describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db/helpers/harness", () => ({ adminQuery: (...a: unknown[]) => query(...a) }));
const { assertMayMutateFrontDeskRollout } = await import("../db/helpers/rollout-mutation-guard");

describe("rollout mutation guard", () => {
  it("allows a pristine disposable stack", async () => {
    query.mockResolvedValue({ rows: [{ mode: "off", listed: 0, foreign_listed: 0 }] });
    await expect(assertMayMutateFrontDeskRollout()).resolves.toBeUndefined();
  });
  it("refuses a declared rehearsal stack before reading anything", async () => {
    query.mockClear();
    vi.stubEnv("HONE_REHEARSAL_STACK", "1");
    await expect(assertMayMutateFrontDeskRollout()).rejects.toThrow(/HONE_REHEARSAL_STACK/);
    expect(query).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it("allows a stack other suites' fixtures left in pilot with only their own studios listed", async () => {
    query.mockResolvedValue({ rows: [{ mode: "pilot", listed: 40, foreign_listed: 0 }] });
    await expect(assertMayMutateFrontDeskRollout()).resolves.toBeUndefined();
  });
  it("refuses a stack with a studio that is not a fixture, an unlisted pilot, or no front_desk row", async () => {
    for (const row of [{ mode: "pilot", listed: 0, foreign_listed: 0 }, { mode: "off", listed: 1, foreign_listed: 1 }, { mode: "pilot", listed: 3, foreign_listed: 1 }, { mode: null, listed: 0, foreign_listed: 0 }]) {
      query.mockResolvedValue({ rows: [row] });
      await expect(assertMayMutateFrontDeskRollout()).rejects.toThrow(/not pristine/);
    }
  });
});
