import { describe, expect, it } from "vitest";
import {
  buildOnboardingModel,
  ONBOARDING_STEP_ORDER,
  type OnboardingSignals,
  type OnboardingPersisted,
} from "@/lib/onboarding/steps";

// Fresh studio: nothing set up, no persisted progress.
const EMPTY_SIGNALS: OnboardingSignals = {
  studioName: "Test Studio",
  hasSlug: true,
  hasService: false,
  hasAvailability: false,
  isPubliclyBookable: false,
  paymentsReady: false,
  publicBookingUrl: "",
};

const FRESH_PERSISTED: OnboardingPersisted = {
  currentStep: "welcome",
  completedSteps: [],
  skippedSteps: [],
  dismissedAt: null,
  completedAt: null,
  celebratedAt: null,
};

const READY_SIGNALS: OnboardingSignals = {
  studioName: "Test Studio",
  hasSlug: true,
  hasService: true,
  hasAvailability: true,
  isPubliclyBookable: true,
  paymentsReady: false,
  publicBookingUrl: "https://hone.care/book/test",
};

describe("buildOnboardingModel: progress + honesty", () => {
  it("a brand-new studio has zero done and is not complete", () => {
    const m = buildOnboardingModel(EMPTY_SIGNALS, FRESH_PERSISTED);
    expect(m.doneCount).toBe(0);
    expect(m.totalCount).toBe(ONBOARDING_STEP_ORDER.length);
    expect(m.requiredComplete).toBe(false);
    expect(m.isComplete).toBe(false);
    expect(m.currentStep).toBe("welcome");
  });

  it("data-backed steps flip done ONLY when data proves it", () => {
    const m = buildOnboardingModel(READY_SIGNALS, FRESH_PERSISTED);
    const status = (k: string) => m.steps.find((s) => s.key === k)!.status;
    expect(status("service")).toBe("done");
    expect(status("availability")).toBe("done");
    expect(status("booking")).toBe("done");
    expect(m.requiredComplete).toBe(true);
    // Payments not ready, not skipped -> still todo (never false green).
    expect(status("payments")).toBe("todo");
  });

  it("a data step regresses to todo if its data goes away (no false green)", () => {
    const m = buildOnboardingModel(
      { ...READY_SIGNALS, hasAvailability: false, isPubliclyBookable: false },
      { ...FRESH_PERSISTED, completedSteps: ["welcome"] },
    );
    expect(m.steps.find((s) => s.key === "availability")!.status).toBe("todo");
    expect(m.requiredComplete).toBe(false);
  });

  it("welcome/done advance only on persisted acknowledgement", () => {
    const beforeAck = buildOnboardingModel(EMPTY_SIGNALS, FRESH_PERSISTED);
    expect(beforeAck.steps.find((s) => s.key === "welcome")!.status).toBe(
      "todo",
    );
    const afterAck = buildOnboardingModel(EMPTY_SIGNALS, {
      ...FRESH_PERSISTED,
      completedSteps: ["welcome"],
    });
    expect(afterAck.steps.find((s) => s.key === "welcome")!.status).toBe(
      "done",
    );
    expect(afterAck.doneCount).toBe(1);
  });
});

describe("buildOnboardingModel: payments optionality", () => {
  it("payments is 'skipped' when the owner skipped it and it isn't ready", () => {
    const m = buildOnboardingModel(READY_SIGNALS, {
      ...FRESH_PERSISTED,
      skippedSteps: ["payments"],
    });
    expect(m.steps.find((s) => s.key === "payments")!.status).toBe("skipped");
    // Skipping payments does not block required completion.
    expect(m.requiredComplete).toBe(true);
  });

  it("payments 'done' (ready) wins even if also in skipped list", () => {
    const m = buildOnboardingModel(
      { ...READY_SIGNALS, paymentsReady: true },
      { ...FRESH_PERSISTED, skippedSteps: ["payments"] },
    );
    expect(m.steps.find((s) => s.key === "payments")!.status).toBe("done");
  });
});

describe("buildOnboardingModel: completion + celebrate-once", () => {
  it("isComplete requires BOTH required data done AND the success acknowledgement", () => {
    const notAcked = buildOnboardingModel(READY_SIGNALS, FRESH_PERSISTED);
    expect(notAcked.requiredComplete).toBe(true);
    expect(notAcked.isComplete).toBe(false);

    const acked = buildOnboardingModel(READY_SIGNALS, {
      ...FRESH_PERSISTED,
      completedAt: "2026-07-21T00:00:00Z",
    });
    expect(acked.isComplete).toBe(true);
    expect(acked.steps.find((s) => s.key === "done")!.status).toBe("done");
  });

  it("shouldCelebrate fires once required setup is green and never again after celebrated", () => {
    const first = buildOnboardingModel(READY_SIGNALS, FRESH_PERSISTED);
    expect(first.shouldCelebrate).toBe(true);

    const afterCelebrated = buildOnboardingModel(READY_SIGNALS, {
      ...FRESH_PERSISTED,
      celebratedAt: "2026-07-21T00:00:00Z",
    });
    expect(afterCelebrated.shouldCelebrate).toBe(false);
  });

  it("does not celebrate before required setup is complete", () => {
    const m = buildOnboardingModel(EMPTY_SIGNALS, FRESH_PERSISTED);
    expect(m.shouldCelebrate).toBe(false);
  });
});

describe("buildOnboardingModel: resume pointer", () => {
  it("honours a valid persisted current_step", () => {
    const m = buildOnboardingModel(EMPTY_SIGNALS, {
      ...FRESH_PERSISTED,
      currentStep: "availability",
    });
    expect(m.currentStep).toBe("availability");
  });

  it("falls back to the first open step when persisted step is invalid", () => {
    const m = buildOnboardingModel(
      { ...EMPTY_SIGNALS, hasService: true },
      { ...FRESH_PERSISTED, currentStep: "bogus", completedSteps: ["welcome"] },
    );
    // welcome done, service done (data) -> first open is availability.
    expect(m.currentStep).toBe("availability");
  });

  it("resumes at the optional payments step when it's the only thing left", () => {
    // welcome acknowledged, required done, payments still todo -> next open step.
    const m = buildOnboardingModel(READY_SIGNALS, {
      ...FRESH_PERSISTED,
      currentStep: "not-a-step",
      completedSteps: ["welcome"],
    });
    expect(m.currentStep).toBe("payments");
  });

  it("points at 'done' when nothing is left to do", () => {
    const m = buildOnboardingModel(
      { ...READY_SIGNALS, paymentsReady: true },
      {
        ...FRESH_PERSISTED,
        currentStep: "not-a-step",
        completedSteps: ["welcome"],
      },
    );
    expect(m.currentStep).toBe("done");
  });

  it("steps past a completed data step even if it's the persisted pointer", () => {
    // persisted at 'service' but service is now done -> auto-advance.
    const m = buildOnboardingModel(READY_SIGNALS, {
      ...FRESH_PERSISTED,
      currentStep: "service",
      completedSteps: ["welcome"],
    });
    expect(m.currentStep).toBe("payments");
  });

  it("an unacknowledged welcome is always the first stop, even if setup is done", () => {
    // A studio configured via settings before opening the wizard still starts
    // at the welcome intro.
    const m = buildOnboardingModel(READY_SIGNALS, FRESH_PERSISTED);
    expect(m.currentStep).toBe("welcome");
  });

  it("booking step resolves its href to the live public URL when known", () => {
    const m = buildOnboardingModel(READY_SIGNALS, FRESH_PERSISTED);
    expect(m.steps.find((s) => s.key === "booking")!.resolvedHref).toBe(
      "https://hone.care/book/test",
    );
  });
});
