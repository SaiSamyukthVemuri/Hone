import { describe, expect, it } from "vitest";
import { buildGettingStarted, checklistLinkDestination, type GettingStartedSignals } from "@/lib/onboarding/getting-started";

// The link on each checklist row names where it goes, never the status sentence beside it.

describe("checklistLinkDestination", () => {
  it.each([
    ["/settings/profile", "profile settings"], ["/settings/services", "services"], ["/settings/booking", "booking settings"],
    ["/settings/payments", "payment settings"], ["/settings/consent", "consent settings"], ["/settings/studio/email", "email settings"],
    ["/calendar", "calendar"], ["/clients", "clients"], ["/dashboard", "dashboard"],
    ["/records?section=sterile", "records"], ["/records/print?section=sterile", "records"],
  ])("%s -> %s", (href, noun) => expect(checklistLinkDestination(href)).toBe(noun));
  it("falls back to a neutral phrase for an unknown destination, never to a status sentence", () => {
    expect(checklistLinkDestination("/somewhere/new")).toBe("this step");
  });
  it("every linked row of the real checklist gets a named destination, and none reuses its status label", () => {
    const signals = {
      studioName: "Studio", practitionerName: "Name", hasSlug: true, activeServices: 1, appointments: 1, clients: 1, sessions: 1,
      treatmentAreas: 1, hasFrequency: true, hasProbe: true, hasProbeLot: true, hasReactionOrTolerance: true, hasNextVisitNote: true,
      liveTreatmentConsent: true, sterileItems: 1, disinfectants: 1, paymentAttempts: 1, runtimeLivemode: false, nextStepSignalsAvailable: true,
    } as unknown as GettingStartedSignals;
    const items = buildGettingStarted(signals).sections.flatMap((s) => s.items).filter((i) => i.href !== null);
    expect(items.length).toBeGreaterThan(5);
    for (const item of items) {
      const noun = checklistLinkDestination(item.href as string);
      expect(noun, `${item.key} has a named destination`).not.toBe("this step");
    }
  });
});
