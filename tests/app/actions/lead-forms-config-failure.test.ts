import { beforeEach, describe, expect, it, vi } from "vitest";

// A missing or invalid service-role configuration throws from createAdminClient(). On the two public lead forms that must be the
// form's own generic failure, never an unhandled throw, and nothing may be scheduled.

const schedule = vi.fn();
const admin = vi.hoisted(() => ({ throws: true, rpc: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    if (admin.throws) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return { rpc: admin.rpc };
  },
}));
vi.mock("@/lib/platform-leads/alert-delivery", () => ({ schedulePlatformLeadAlert: (id: string) => schedule(id) }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitWaitlistSubmit: async () => ({ allowed: true }),
  limitDemoRequestSubmit: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "limited",
}));

import { submitDemoRequest } from "@/app/actions/demo";
import { submitWaitlistEntry } from "@/app/actions/waitlist";

const DEMO = {
  name: "Avery Lead",
  email: "avery@example.test",
  practice_name: "Maple Clinic",
  location: "",
  practice_type: "" as const,
  practitioner_count: "" as const,
  current_tool: "",
  notes: "",
};

beforeEach(() => {
  schedule.mockReset();
  admin.rpc.mockReset();
  admin.throws = true;
});

describe("service-role configuration missing", () => {
  it("the demo form answers its generic failure, saves nothing and schedules nothing", async () => {
    const out = await submitDemoRequest(DEMO);
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(/didn't send/i);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("the early-access form answers its generic failure and schedules nothing", async () => {
    expect(await submitWaitlistEntry("a@b.co")).toEqual({
      ok: false,
      error: "Something went wrong. Try again in a moment.",
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("a command that throws (not just returns an error) is the same generic failure", async () => {
    admin.throws = false;
    admin.rpc.mockRejectedValue(new Error("fetch failed"));
    expect(await submitDemoRequest(DEMO)).toMatchObject({ ok: false });
    expect(await submitWaitlistEntry("a@b.co")).toMatchObject({ ok: false });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("with configuration present, a recorded lead still schedules exactly one alert (the wrapper changed nothing)", async () => {
    admin.throws = false;
    admin.rpc.mockResolvedValue({ data: [{ result: "recorded", alert_id: "alert-1" }], error: null });
    expect(await submitDemoRequest(DEMO)).toMatchObject({ ok: true });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("alert-1");
  });
});
