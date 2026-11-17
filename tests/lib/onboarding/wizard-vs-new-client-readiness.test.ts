import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOnboardingModel, type OnboardingPersisted, type OnboardingSignals } from "@/lib/onboarding/steps";
import { deriveBookingSignals } from "@/lib/onboarding/booking-signals";
import { isBookableByNewClient } from "@/lib/booking/consultation";
import { computeNewClientReadiness, type NewClientReadinessEvidence } from "@/lib/booking/new-client-readiness";

// HON-77 (onboarding readiness). The wizard agrees with the canonical new-client readiness: it is never ready while a new client
// cannot book. The booking step is done only when `isPubliclyBookable` AND the canonical readiness (the answer the dashboard
// setup card and /settings/launch give) is ready. An admission the owner chose to pause is not unfinished setup, and an
// authority that could not answer is never green and never called missing.
//
// Every case runs the REAL pure functions over real-shaped evidence. The agreement controls from the reproduction are kept.

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

// The SAME pure function signals.ts calls, over the same evidence: no mirror to drift. Only the two reads signals.ts performs
// (the services count and the availability rows) are supplied by the fixture; the verdict is the real canonical compute.
function wizardSignals(e: NewClientReadinessEvidence): OnboardingSignals {
  return {
    studioName: STUDIO.name,
    ...deriveBookingSignals({
      studio: { ...STUDIO, address: null },
      activeServicesCount: e.services.ok ? e.services.services.length : 0,
      availabilityDefaults: e.availability.ok ? e.availability.days : [],
      readiness: computeNewClientReadiness(e),
      appOrigin: "https://example.test",
    }),
    paymentsReady: false,
  };
}
const FRESH: OnboardingPersisted = {
  currentStep: "service", completedSteps: ["welcome"], skippedSteps: [], dismissedAt: null, completedAt: null, celebratedAt: null,
};

const bookingStep = (e: NewClientReadinessEvidence) =>
  buildOnboardingModel(wizardSignals(e), FRESH).steps.find((x) => x.key === "booking")!;

describe("the wizard is ready only when a new client can book", () => {
  it("one ordinary treatment and one open day: the wizard is NOT ready, does not celebrate, and names the missing consultation", () => {
    const e = evidence({ services: { ok: true, services: [ORDINARY_TREATMENT] } });
    const model = buildOnboardingModel(wizardSignals(e), FRESH);
    expect(model.requiredComplete).toBe(false);
    expect(model.shouldCelebrate).toBe(false);
    expect(isBookableByNewClient(ORDINARY_TREATMENT as never)).toBe(false);
    const step = bookingStep(e);
    expect(step.status).toBe("todo");
    expect(step.blurb).toMatch(/consultation service/i);
    expect(step.cta?.label).toBe("Open setup");
  });

  it("a consultation and an open day but no live treatment consent form: the wizard is NOT ready and names the consent form", () => {
    const e = evidence({ treatmentConsent: { ok: true, ready: false } });
    expect(buildOnboardingModel(wizardSignals(e), FRESH).requiredComplete).toBe(false);
    expect(bookingStep(e).blurb).toMatch(/consent/i);
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

  it("an authority that could not answer is never green and is not called missing", () => {
    const e = evidence({ treatmentConsent: { ok: false } });
    const model = buildOnboardingModel(wizardSignals(e), FRESH);
    expect(model.requiredComplete).toBe(false);
    const step = model.steps.find((x) => x.key === "booking")!;
    expect(step.status).toBe("todo");
    expect(step.blurb).toMatch(/could not check/i);
    expect(step.blurb).not.toMatch(/consent/i);
    expect(step.cta).toBeNull();
  });

  it("an admission the owner chose to pause (waitlist or closed) does not hold the wizard back", () => {
    for (const mode of ["waitlist", "closed"] as const) {
      const e = evidence({ admission: { ok: true, mode, source: "persisted" } });
      expect(computeNewClientReadiness(e).status).toBe("not_ready");
      expect(buildOnboardingModel(wizardSignals(e), FRESH).requiredComplete).toBe(true);
    }
  });

  it("a paused admission AND a missing consultation is still blocked: the choice never masks a structural blocker", () => {
    const e = evidence({
      services: { ok: true, services: [ORDINARY_TREATMENT] },
      admission: { ok: true, mode: "waitlist", source: "persisted" },
    });
    expect(buildOnboardingModel(wizardSignals(e), FRESH).requiredComplete).toBe(false);
  });

  it("the completion gate and the signals read the canonical readiness (the wiring the behaviour above depends on)", () => {
    const code = (p: string) =>
      readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const signals = code("lib/onboarding/signals.ts");
    const actions = code("app/(app)/dashboard/onboarding-actions.ts");
    // signals.ts hands the canonical verdict to the one pure function and spreads its result; it computes none of it itself.
    expect(signals).toMatch(/getNewClientReadiness\(studio\)/);
    expect(signals).toMatch(/deriveBookingSignals\(\{[\s\S]*?readiness,/);
    expect(signals).toMatch(/\.\.\.booking,/);
    expect(signals).not.toMatch(/isPubliclyBookable|computeBookingReadiness|is_open/);
    // Both the completion and the celebration gates read the live model, so they inherit the rule; neither restates it.
    expect(actions.match(/model\.requiredComplete/g)?.length).toBe(2);
    expect(actions).not.toMatch(/isPubliclyBookable/);
  });
});

describe("deriveBookingSignals (the one function the page and these tests share)", () => {
  const base = { studio: { ...STUDIO, address: null }, appOrigin: "https://example.test" };
  const ready = computeNewClientReadiness(evidence({}));

  it("a failed readiness read is unknown, never ready", () => {
    const s = deriveBookingSignals({ ...base, activeServicesCount: 1, availabilityDefaults: [OPEN_DAY], readiness: null });
    expect(s.bookingReadiness).toEqual({ state: "unknown" });
  });
  it("an open day needs open and close times, the same predicate the canonical readiness applies", () => {
    const closedByMissingTime = { is_open: true, open_time: "", close_time: "17:00:00" };
    const s = deriveBookingSignals({ ...base, activeServicesCount: 1, availabilityDefaults: [closedByMissingTime], readiness: ready });
    expect(s.hasAvailability).toBe(false);
    expect(s.isPubliclyBookable).toBe(false);
  });
  it("no slug means no public URL and not bookable, whatever the services say", () => {
    const s = deriveBookingSignals({
      ...base, studio: { ...STUDIO, slug: "  ", address: null }, activeServicesCount: 1, availabilityDefaults: [OPEN_DAY], readiness: ready,
    });
    expect(s.hasSlug).toBe(false);
    expect(s.isPubliclyBookable).toBe(false);
    expect(s.publicBookingUrl).toBe("");
  });
});
