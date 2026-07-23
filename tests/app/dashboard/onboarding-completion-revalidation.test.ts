import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Server-authoritative onboarding completion. completeOnboarding /
// markCelebrationShown must NOT trust the client's claim that setup is finished:
// they rebuild the live model from real signals + the persisted row and refuse
// unless the REQUIRED data steps are genuinely green. Exactly ONE wizard_completed
// analytics DISPATCH is scheduled for the first successful transition (analytics
// are best-effort / no outbox, so this is a one-dispatch-scheduled guarantee, not
// a once-delivered one). All deps mocked; NO db, NO network.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/onboarding/signals", () => ({ getOnboardingSignals: vi.fn() }));
vi.mock("@/lib/onboarding/state", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/onboarding/state")>();
  return {
    ...actual, // keep toPersisted (pure) real
    getOnboardingRow: vi.fn(),
    completeOnboarding: vi.fn(),
    markCelebrated: vi.fn(),
  };
});

import {
  completeOnboardingAction,
  markCelebrationShownAction,
} from "@/app/(app)/dashboard/onboarding-actions";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { captureServerEvent } from "@/lib/analytics/server";
import { getOnboardingSignals } from "@/lib/onboarding/signals";
import {
  getOnboardingRow,
  completeOnboarding,
  markCelebrated,
} from "@/lib/onboarding/state";
import type { OnboardingSignals } from "@/lib/onboarding/steps";

const whoami = getCurrentPractitionerWithStudio as unknown as Mock;
const event = captureServerEvent as unknown as Mock;
const signals = getOnboardingSignals as unknown as Mock;
const row = getOnboardingRow as unknown as Mock;
const complete = completeOnboarding as unknown as Mock;
const celebrate = markCelebrated as unknown as Mock;

function setCaller(role: "owner" | "practitioner", flagOn: boolean): void {
  whoami.mockResolvedValue({
    practitioner: { id: "prac-1", user_id: "user-1", role, display_name: "Alex" },
    studio: { id: "studio-1", name: "Rivera", onboarding_v2_enabled: flagOn },
  });
}

// requiredComplete = hasService && hasAvailability && isPubliclyBookable.
function setSignals(requiredComplete: boolean): void {
  const s: OnboardingSignals = {
    studioName: "Rivera",
    hasSlug: true,
    hasService: requiredComplete,
    hasAvailability: requiredComplete,
    isPubliclyBookable: requiredComplete,
    paymentsReady: false,
    publicBookingUrl: requiredComplete ? "https://hone.care/book/rivera" : "",
  };
  signals.mockResolvedValue(s);
}

function setRow(completedAt: string | null): void {
  row.mockResolvedValue(
    completedAt
      ? { studio_id: "studio-1", completed_at: completedAt, status: "completed" }
      : null,
  );
}

beforeEach(() => {
  // The atomic RPC reports whether THIS call performed the transition; the
  // action emits the analytics event iff transitioned === true.
  complete.mockResolvedValue({ ok: true, transitioned: true });
  celebrate.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("completeOnboardingAction — server-authoritative gate", () => {
  it("non-owner is refused; nothing written, no event", async () => {
    setCaller("practitioner", true);
    const res = await completeOnboardingAction();
    expect(res).toEqual({ ok: false, error: "not_allowed" });
    expect(complete).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });

  it("flag OFF is refused even for the owner", async () => {
    setCaller("owner", false);
    const res = await completeOnboardingAction();
    expect(res).toEqual({ ok: false, error: "not_allowed" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("REJECTS completion when required setup is not actually green", async () => {
    setCaller("owner", true);
    setSignals(false); // studio not bookable
    setRow(null);
    const res = await completeOnboardingAction();
    expect(res).toEqual({ ok: false, error: "not_ready" });
    expect(complete).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });

  it("schedules ONE dispatch only when the atomic RPC reports transitioned=true", async () => {
    setCaller("owner", true);
    setSignals(true);
    setRow(null);
    complete.mockResolvedValueOnce({ ok: true, transitioned: true });
    const res = await completeOnboardingAction();
    expect(res).toEqual({ ok: true });
    // The session user id (never a browser value) is passed to the trusted command.
    expect(complete).toHaveBeenCalledWith("user-1", "studio-1");
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith({
      actor: { kind: "user", id: "prac-1" },
      event: "onboarding_wizard_completed",
      properties: { studio_id: "studio-1" },
    });
  });

  it("the concurrent LOSER (transitioned=false) writes but emits NO event", async () => {
    setCaller("owner", true);
    setSignals(true);
    setRow(null);
    complete.mockResolvedValueOnce({ ok: true, transitioned: false });
    const res = await completeOnboardingAction();
    expect(res).toEqual({ ok: true });
    expect(complete).toHaveBeenCalledWith("user-1", "studio-1");
    expect(event).not.toHaveBeenCalled();
  });

  it("a persistence error returns FIXED copy (no raw DB text) and suppresses the event", async () => {
    setCaller("owner", true);
    setSignals(true);
    setRow(null);
    complete.mockResolvedValueOnce({ ok: false, transitioned: false });
    const res = await completeOnboardingAction();
    expect(res).toEqual({ ok: false, error: "complete_failed" });
    expect(event).not.toHaveBeenCalled();
  });
});

describe("markCelebrationShownAction — live-completion guard + idempotent", () => {
  it("does NOT consume the one-time stamp while setup is incomplete", async () => {
    setCaller("owner", true);
    setSignals(false);
    setRow(null);
    const res = await markCelebrationShownAction();
    expect(res).toEqual({ ok: false, error: "not_ready" });
    expect(celebrate).not.toHaveBeenCalled();
  });

  it("stamps the celebration once required setup is genuinely green", async () => {
    setCaller("owner", true);
    setSignals(true);
    setRow(null);
    const res = await markCelebrationShownAction();
    expect(res).toEqual({ ok: true });
    expect(celebrate).toHaveBeenCalledWith("user-1", "studio-1");
  });

  it("non-owner is refused", async () => {
    setCaller("practitioner", true);
    const res = await markCelebrationShownAction();
    expect(res).toEqual({ ok: false, error: "not_allowed" });
    expect(celebrate).not.toHaveBeenCalled();
  });
});
