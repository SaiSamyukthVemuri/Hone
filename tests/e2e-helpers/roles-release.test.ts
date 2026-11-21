import { describe, expect, it } from "vitest";
import { RELEASE_KEYS, releaseBlockedReason, unreleasedKeys, type KeyQuery } from "../../e2e/helpers/roles-release";

// The Roles slot specs skip (BLOCKED, not FAIL) while any key is unreleased. A fake release table stands in for permission_key_release.
const table = (released: string[]): KeyQuery => async (_text, params) => {
  const wanted = params[0] as string[];
  return released.filter((k) => wanted.includes(k)).map((key) => ({ key }));
};

describe("roles slot specs: release precondition", () => {
  it("every key released: nothing is blocked", async () => {
    expect(await unreleasedKeys(table([...RELEASE_KEYS]), RELEASE_KEYS)).toEqual([]);
  });
  it("a fresh stack (nothing released, or rows missing) blocks on every key, in order", async () => {
    expect(await unreleasedKeys(table([]), RELEASE_KEYS)).toEqual([...RELEASE_KEYS]);
  });
  it("one pending key blocks, and only that key is named", async () => {
    const gap = await unreleasedKeys(table(RELEASE_KEYS.filter((k) => k !== "clin.view_intake")), RELEASE_KEYS);
    expect(gap).toEqual(["clin.view_intake"]);
    expect(releaseBlockedReason(gap)).toContain("BLOCKED, not FAIL");
    expect(releaseBlockedReason(gap)).toContain("clin.view_intake");
  });
  it("asks only for the keys it was given", async () => {
    expect(await unreleasedKeys(table(["appt.move"]), ["appt.move", "appt.cancel"])).toEqual(["appt.cancel"]);
  });
  it("covers the keys the 0287 seed marks pending (7 full + 6 narrow)", () => {
    expect(RELEASE_KEYS).toHaveLength(13);
  });
});
