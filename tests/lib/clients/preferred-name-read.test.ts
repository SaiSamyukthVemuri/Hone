import { describe, expect, it, vi } from "vitest";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";

// HON-58: a read that adds preferred_name must keep working BEFORE migration
// 0258 exists, and must never hide a real failure.

const MISSING = { code: "42703", message: 'column clients_1.preferred_name does not exist' };

describe("readWithPreferredName", () => {
  it("runs once, with the column, when the database has it", async () => {
    const attempt = vi.fn(async (_with: boolean) => ({ data: ["row"], error: null }));
    const res = await readWithPreferredName(attempt);
    expect(res.data).toEqual(["row"]);
    expect(attempt.mock.calls).toEqual([[true]]);
  });

  it("retries once WITHOUT the column only when preferred_name itself is missing", async () => {
    const attempt = vi.fn(async (withPreferred: boolean) =>
      withPreferred ? { data: null, error: MISSING } : { data: ["legacy"], error: null });
    const res = await readWithPreferredName(attempt);
    expect(res.data).toEqual(["legacy"]);
    expect(attempt.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ["a timeout", { code: "57014", message: "canceling statement due to statement timeout" }],
    ["a permission error", { code: "42501", message: "permission denied for table clients" }],
    ["a DIFFERENT missing column", { code: "42703", message: "column clients_1.calendar_color does not exist" }],
  ])("never retries or swallows %s", async (_l, error) => {
    const attempt = vi.fn(async (_with: boolean) => ({ data: null, error }));
    const res = await readWithPreferredName(attempt);
    expect(res.error).toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("returns the second attempt's own error if the legacy read also fails", async () => {
    const second = { code: "57014", message: "timeout" };
    const attempt = vi.fn(async (withPreferred: boolean) => ({ data: null, error: withPreferred ? MISSING : second }));
    expect((await readWithPreferredName(attempt)).error).toBe(second);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("preferredNameColumn", () => {
  it("is the select fragment, or nothing", () => {
    expect(preferredNameColumn(true)).toBe("preferred_name, ");
    expect(preferredNameColumn(false)).toBe("");
  });
});
