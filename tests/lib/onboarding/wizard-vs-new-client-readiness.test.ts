import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOnboardingModel, type OnboardingPersisted, type OnboardingSignals } from "@/lib/onboarding/steps";
import { isPubliclyBookable } from "@/lib/booking/readiness";
import { isBookableByNewClient } from "@/lib/booking/consultation";
import { computeNewClientReadiness, isOpenDay, type NewClientReadinessEvidence } from "@/lib/booking/new-client-readiness";

// HON-77 (onboarding readiness). TODAY'S BEHAVIOUR, pinned as a known gap: the onboarding wizard reports a studio ready when a
// new client cannot book.
//
// The wizard's required steps come from `isPubliclyBookable` (one active service, one open day). The booking action refuses a
// new client unless the service is an active consultation, and the canonical new-client readiness (the owner's primary answer
// on the dashboard card and /settings/launch) also asks for a live treatment consent form. The wizard consumes none of that.
//
// Every case below runs the REAL pure functions over real-shaped evidence. The two "known gap" cases are written to be GREEN
// today and to go RED when the wizard starts agreeing with the canonical authority; whoever fixes it flips them on purpose.

const STUDIO = {
  name: "Synthetic Studio",
  slug: "synthetic-studio",
  timezone: "America/Toronto",
  default_appointment_duration_minutes: 60,
  buffer_minutes: 15,
  public_booking_horizon_months: 3 as const,
};
const OPEN_DAY = { is_open: true, open_time: "09:00:00", close_time: "17:00:00" };
const CONSULTATION = {
  id: "s-consult", name: "New Client Consultation", modality: "consultation", active: true, default_duration_minutes: 60,
} as never;
const ORDINARY_TREATMENT = {
  id: "s-treat", name: "Hair removal session", modality: "electrolysis", active: true, default_duration_minutes: 60,
} as never;

function evidence(over: Partial<NewClientReadinessEvidence>): NewClientReadinessEvidence {
  return {
    studio: STUDIO,
    services: { ok: true, services: [CONSULTATION] },
    availability: { ok: true, days: [OPEN_DAY] },
    treatmentConsent: { ok: true, ready: true },
    admission: { ok: true, mode: "open", source: "persisted" },
    ...over,
  };
}

// Mirrors lib/onboarding/signals.ts (server-only, so it cannot be imported here); the source test below pins that mirror.
function wizardSignals(e: NewClientReadinessEvidence): OnboardingSignals {
  const services = e.services.ok ? e.services.services : [];
  const days = e.availability.ok ? e.availability.days : [];
  const activeServicesCount = services.length;
  const openAvailabilityDaysCount = days.filter((d) => isOpenDay(d)).length;
  return {
    studioName: STUDIO.name,
    hasSlug: true,
    hasService: activeServicesCount >= 1,
    hasAvailability: openAvailabilityDaysCount >= 1,
    isPubliclyBookable: isPubliclyBookable({ activeServicesCount, openAvailabilityDaysCount }),
    paymentsReady: false,
    publicBookingUrl: "https://example.test/book/synthetic-studio",
  };
}
const FRESH: OnboardingPersisted = {
  currentStep: "service", completedSteps: ["welcome"], skippedSteps: [], dismissedAt: null, completedAt: null, celebratedAt: null,
};

describe("the wizard reports ready when a new client cannot book (known gap, pinned as today's behaviour)", () => {
  it("one ordinary treatment and one open day: the wizard is ready and celebrates, the booking rule refuses a new client", () => {
    const e = evidence({ services: { ok: true, services: [ORDINARY_TREATMENT] } });
    const model = buildOnboardingModel(wizardSignals(e), FRESH);
    expect(model.requiredComplete).toBe(true);
    expect(model.shouldCelebrate).toBe(true);
    expect(isBookableByNewClient(ORDINARY_TREATMENT as never)).toBe(false);
    const canonical = computeNewClientReadiness(e);
    expect(canonical.status).toBe("not_ready");
    if (canonical.status !== "not_ready") throw new Error("unreachable");
    expect(canonical.blockers.map((b) => b.key)).toContain("consultation_service");
  });

  it("a consultation and an open day but no live treatment consent form: the wizard is ready, the canonical readiness is not", () => {
    const e = evidence({ treatmentConsent: { ok: true, ready: false } });
    const model = buildOnboardingModel(wizardSignals(e), FRESH);
    expect(model.requiredComplete).toBe(true);
    const canonical = computeNewClientReadiness(e);
    expect(canonical.status).toBe("not_ready");
    if (canonical.status !== "not_ready") throw new Error("unreachable");
    expect(canonical.blockers.map((b) => b.key)).toEqual(["treatment_consent"]);
  });

  it("control: with a consultation, an open day and a live consent form, both agree the studio is ready", () => {
    const e = evidence({});
    expect(buildOnboardingModel(wizardSignals(e), FRESH).requiredComplete).toBe(true);
    expect(computeNewClientReadiness(e)).toEqual({ status: "ready" });
  });

  it("control: with no service at all, both agree the studio is not ready", () => {
    const e = evidence({ services: { ok: true, services: [] } });
    expect(buildOnboardingModel(wizardSignals(e), FRESH).requiredComplete).toBe(false);
    expect(computeNewClientReadiness(e).status).toBe("not_ready");
  });

  it("the wizard's signals and its completion action do not consult the canonical readiness (the flip point)", () => {
    const code = (p: string) =>
      readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const signals = code("lib/onboarding/signals.ts");
    const actions = code("app/(app)/dashboard/onboarding-actions.ts");
    // The mirror above is only honest while signals.ts builds the booking step this way.
    expect(signals).toMatch(/isPubliclyBookable\(\{ activeServicesCount, openAvailabilityDaysCount \}\)/);
    expect(signals).not.toMatch(/new-client-readiness/);
    expect(actions).not.toMatch(/new-client-readiness/);
  });
});
