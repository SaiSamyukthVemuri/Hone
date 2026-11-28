import { beforeEach, describe, expect, it, vi } from "vitest";

// Hosted public.waitlist has no `source` column, so a write that names it fails with PGRST204 and the signup is lost.
// The signup is saved by the service-role-only command record_platform_early_access_signup (0213, LEAD-ALERT-01), which is
// handed the email ALONE; where the column exists its default ('landing', migration 0004) fills it.

const rpc = vi.fn();
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc }),
}));
vi.mock("@/lib/platform-leads/alert-delivery", () => ({ schedulePlatformLeadAlert: vi.fn() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitWaitlistSubmit: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "limited",
}));

import { submitWaitlistEntry } from "@/app/actions/waitlist";

// Hosted public.waitlist columns. Change this list only with hosted evidence, never from the repo's migrations.
const HOSTED_WAITLIST_COLUMNS = ["id", "email", "practice_name", "created_at"];
const ABSENT_ON_HOSTED = ["source"];

beforeEach(() => {
  rpc.mockReset();
});

describe("submitWaitlistEntry command payload", () => {
  it("sends the normalized email and nothing else (no source key)", async () => {
    rpc.mockResolvedValue({ data: [{ result: "recorded", alert_id: "a1" }], error: null });
    expect(await submitWaitlistEntry("  Person@Example.com ")).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("record_platform_early_access_signup", { p_email: "person@example.com" });
  });

  it("names only the email, a column that exists on hosted, and never one that does not", async () => {
    rpc.mockResolvedValue({ data: [{ result: "recorded", alert_id: "a1" }], error: null });
    await submitWaitlistEntry("a@b.co");
    const keys = Object.keys(rpc.mock.calls[0][1]).map((k) => k.replace(/^p_/, ""));
    expect(keys).toEqual(["email"]);
    for (const k of keys) expect(HOSTED_WAITLIST_COLUMNS).toContain(k);
    for (const absent of ABSENT_ON_HOSTED) expect(keys).not.toContain(absent);
  });

  it("treats a duplicate as success", async () => {
    rpc.mockResolvedValue({ data: [{ result: "duplicate", alert_id: null }], error: null });
    expect(await submitWaitlistEntry("a@b.co")).toEqual({ ok: true });
  });

  it("returns the generic error for any database error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST204", message: "column missing" } });
    expect(await submitWaitlistEntry("a@b.co")).toEqual({
      ok: false,
      error: "Something went wrong. Try again in a moment.",
    });
  });

  it("never reaches the command for an invalid email", async () => {
    expect(await submitWaitlistEntry("nope")).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});
