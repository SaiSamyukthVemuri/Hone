import { beforeEach, describe, expect, it, vi } from "vitest";

// Hosted public.waitlist has no `source` column (R1, 2026-11-01), so an insert
// that names it fails with PGRST204 and the signup is lost. The action sends the
// email only; where the column exists its default ('landing', migration 0004)
// fills it.

const insert = vi.fn();
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => ({ insert }) }),
}));
vi.mock("@/lib/rate-limit/public", () => ({
  limitWaitlistSubmit: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "limited",
}));

import { submitWaitlistEntry } from "@/app/actions/waitlist";

// Hosted public.waitlist columns, from the catalog Sam relayed (R1, 2026-11-01):
// id, email (NOT NULL, UNIQUE), practice_name (nullable), created_at. `source`,
// which repo migration 0004 declares, is ABSENT on hosted. Change this list only
// with hosted evidence, never from the repo's migrations.
const HOSTED_WAITLIST_COLUMNS = ["id", "email", "practice_name", "created_at"];
const ABSENT_ON_HOSTED = ["source"];

beforeEach(() => {
  insert.mockReset();
});

describe("submitWaitlistEntry insert payload", () => {
  it("sends the normalized email and nothing else (no source key)", async () => {
    insert.mockResolvedValue({ error: null });
    expect(await submitWaitlistEntry("  Person@Example.com ")).toEqual({
      ok: true,
    });
    expect(insert).toHaveBeenCalledWith({ email: "person@example.com" });
  });

  it("names only the email, a column that exists on hosted, and never one that does not", async () => {
    insert.mockResolvedValue({ error: null });
    await submitWaitlistEntry("a@b.co");
    const keys = Object.keys(insert.mock.calls[0][0]);
    // The action collects no practice name, so the email alone is sent.
    expect(keys).toEqual(["email"]);
    for (const k of keys) expect(HOSTED_WAITLIST_COLUMNS).toContain(k);
    for (const absent of ABSENT_ON_HOSTED) expect(keys).not.toContain(absent);
  });

  it("treats a duplicate as success", async () => {
    insert.mockResolvedValue({ error: { code: "23505", message: "dup" } });
    expect(await submitWaitlistEntry("a@b.co")).toEqual({ ok: true });
  });

  it("returns the generic error for any other database error", async () => {
    insert.mockResolvedValue({
      error: { code: "PGRST204", message: "column missing" },
    });
    expect(await submitWaitlistEntry("a@b.co")).toEqual({
      ok: false,
      error: "Something went wrong. Try again in a moment.",
    });
  });

  it("never reaches the insert for an invalid email", async () => {
    expect(await submitWaitlistEntry("nope")).toMatchObject({ ok: false });
    expect(insert).not.toHaveBeenCalled();
  });
});
