import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { buildOnboardingModel, type OnboardingPersisted, type OnboardingSignals } from "@/lib/onboarding/steps";

// WHAT THE WIZARD RENDERS FOR THE BOOKING STEP. The page's link and the copy control must appear only when the step is done:
// a source pin cannot show that every block offering the link is gated, so this runs the real component through react-dom/server.
// (No jsdom here: this proves the output per state, not a click-through.)

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/(app)/dashboard/onboarding-actions", () => ({
  acknowledgeWelcomeAction: async () => ({ ok: true }),
  markCelebrationShownAction: async () => ({ ok: true }),
  setOnboardingStepAction: async () => ({ ok: true }),
  skipPaymentsAction: async () => ({ ok: true }),
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { OnboardingWizard } = await import("@/app/(app)/dashboard/onboarding/OnboardingWizard");

const URL_ = "https://example.test/book/studio-x";

function signals(over: Partial<OnboardingSignals>): OnboardingSignals {
  return {
    studioName: "Studio X",
    hasSlug: true,
    hasService: true,
    hasAvailability: true,
    isPubliclyBookable: true,
    bookingReadiness: { state: "ready" },
    publicBookingUrl: URL_,
    paymentsReady: false,
    ...over,
  };
}

function renderBooking(over: Partial<OnboardingSignals>): string {
  const persisted: OnboardingPersisted = {
    currentStep: "booking",
    completedSteps: ["welcome"],
    skippedSteps: [],
    dismissedAt: null,
    completedAt: null,
    celebratedAt: null,
  };
  const base = buildOnboardingModel(signals(over), persisted);
  const model = { ...base, currentStep: "booking" as const };
  return renderToStaticMarkup(
    createElement(OnboardingWizard, { model, open: true, onDismiss: () => undefined, onComplete: () => undefined }),
  );
}

describe("the wizard's booking step offers the page link only when it is done", () => {
  it("done: the link and the copy control are offered", () => {
    const html = renderBooking({});
    expect(html).toContain("Your booking page is live");
    expect(html).toContain("Open booking page");
    expect(html).toContain(URL_);
  });
  it("blocked: no link, no copy control, no URL anywhere in the step", () => {
    const html = renderBooking({
      bookingReadiness: { state: "blocked", next: { label: "Add a treatment consent form", href: "/settings/consent" } },
    });
    expect(html).toContain("Get your booking page ready");
    expect(html).not.toContain("Open booking page");
    expect(html).not.toContain(URL_);
    expect(html).not.toContain("Your booking page is live");
  });
  it("unknown: no link and no URL either", () => {
    const html = renderBooking({ bookingReadiness: { state: "unknown" } });
    expect(html).not.toContain("Open booking page");
    expect(html).not.toContain(URL_);
  });
});
