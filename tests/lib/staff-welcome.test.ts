import { describe, expect, it } from "vitest";
import {
  staffWelcomeKey,
  staffWelcomeSteps,
} from "@/lib/onboarding/staff-welcome";
describe("staff introductions", () => {
  it("keeps progress per role and membership", () => {
    expect(staffWelcomeKey("practitioner", "a")).not.toEqual(
      staffWelcomeKey("receptionist", "a"),
    );
    expect(staffWelcomeKey("practitioner", "a")).not.toEqual(
      staffWelcomeKey("practitioner", "b"),
    );
  });
  it("introduces clinical work only to practitioners and booking only on an enabled desk", () => {
    expect(
      staffWelcomeSteps("practitioner", false).map((s) => s.href),
    ).toContain("/calendar");
    expect(
      JSON.stringify(staffWelcomeSteps("receptionist", false)),
    ).not.toMatch(/charting|Find time|profile/);
    expect(JSON.stringify(staffWelcomeSteps("receptionist", true))).toContain(
      "Find time",
    );
  });
});

import { afterEach, beforeEach, vi } from "vitest";
const h = vi.hoisted(() => ({
  desk: vi.fn(),
  practitioner: vi.fn(),
  update: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("@/lib/desk/guard", () => ({ requireReceptionistWithStudio: h.desk }));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: h.practitioner,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { updateUser: h.update } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
import { completeStaffWelcome } from "@/components/onboarding/staff-welcome-action";

describe("finish a staff introduction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HONE_STAFF_ONBOARDING_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("checks the active receptionist membership before saving the preference", async () => {
    h.desk.mockResolvedValue({ receptionistId: "desk-1" });
    h.update.mockResolvedValue({ error: null });
    expect(await completeStaffWelcome("receptionist", "other")).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
    expect(await completeStaffWelcome("receptionist", "desk-1")).toBe(true);
    expect(h.update).toHaveBeenCalledWith({
      data: { "hone_welcome_receptionist_desk-1": true },
    });
  });
  it("only marks a practitioner introduction on a practitioner membership", async () => {
    h.practitioner.mockResolvedValueOnce({
      practitioner: { role: "owner", id: "p" },
    });
    expect(await completeStaffWelcome("practitioner", "p")).toBe(false);
    h.practitioner.mockResolvedValueOnce({
      practitioner: { role: "practitioner", id: "p" },
    });
    h.update.mockResolvedValue({ error: null });
    expect(await completeStaffWelcome("practitioner", "p")).toBe(true);
    expect(h.revalidate).toHaveBeenCalledWith("/dashboard");
  });
});
