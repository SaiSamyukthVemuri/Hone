// First-time studio-owner onboarding — step vocabulary + progress model.
//
// PURE module: no DB, no Stripe, no I/O. Given the derived signals (real data)
// and the persisted studio_onboarding row (acknowledgements / skips / stamps),
// it produces the wizard model consumed by the overlay wizard, the pinned
// dashboard progress card, and the admin onboarding-% view — ONE source of
// truth so those surfaces never disagree.
//
// Honesty rules (carried over from lib/onboarding/getting-started.ts):
//   * A data-backed step is "done" ONLY when real data proves it (a service
//     exists, an open availability day exists, the public page is bookable,
//     Stripe is genuinely ready). It flips back to "todo" if that data goes
//     away — no false green.
//   * Payments is OPTIONAL; bookings work without Stripe. It is "done" when
//     truly ready OR explicitly skipped by the owner.
//   * "welcome" and "done" are framing steps (no data signal); they advance on
//     explicit acknowledgement.

export type OnboardingStepKey =
  | "welcome"
  | "service"
  | "availability"
  | "booking"
  | "payments"
  | "done";

export const ONBOARDING_STEP_ORDER: OnboardingStepKey[] = [
  "welcome",
  "service",
  "availability",
  "booking",
  "payments",
  "done",
];

// The steps whose completion is REQUIRED for a studio to accept its first
// booking. Payments is optional; welcome/done are framing.
export const REQUIRED_STEP_KEYS: OnboardingStepKey[] = [
  "service",
  "availability",
  "booking",
];

export type OnboardingStepKind = "intro" | "data" | "optional" | "success";

export type OnboardingStepDef = {
  key: OnboardingStepKey;
  // Short heading shown in the wizard + progress card.
  title: string;
  // One-line "why this matters" — no long paragraphs, no overclaims.
  blurb: string;
  kind: OnboardingStepKind;
  // Primary CTA for the step, when it has an action to take. `href` deep-links
  // to the authoritative settings surface (resolves the historic deep-link
  // drift between getting-started and readiness). The booking step's live URL
  // is filled in from signals at render time.
  cta: { label: string; href: string } | null;
  // Optional steps can be skipped without blocking completion.
  optional?: boolean;
};

export const ONBOARDING_STEPS: Record<OnboardingStepKey, OnboardingStepDef> = {
  welcome: {
    key: "welcome",
    title: "Welcome to Hone",
    blurb:
      "Bookings, client history, treatment memory, photos and notes in one place. Let's get your studio ready to take its first booking — about five minutes.",
    kind: "intro",
    cta: null,
  },
  service: {
    key: "service",
    title: "Create your first service",
    blurb:
      "Clients book from your service menu, so a studio with no service can't be booked. Add one to start.",
    kind: "data",
    cta: { label: "Create a service", href: "/settings/services" },
  },
  availability: {
    key: "availability",
    title: "Set your availability",
    blurb:
      "Clients can only book the times you open. Set the days and hours you see clients.",
    kind: "data",
    cta: { label: "Configure availability", href: "/settings/availability" },
  },
  booking: {
    key: "booking",
    title: "Your booking page is live",
    blurb:
      "This is the page your clients use to book. Preview it and copy the link to share.",
    kind: "data",
    cta: { label: "Booking settings", href: "/settings/booking" },
  },
  payments: {
    key: "payments",
    title: "Connect payments (optional)",
    blurb:
      "Bookings work without Stripe. Connect it when you're ready to take payment for cancellations or services.",
    kind: "optional",
    cta: { label: "Connect Stripe", href: "/settings/payments" },
    optional: true,
  },
  done: {
    key: "done",
    title: "You're ready",
    blurb:
      "Your studio can take its first booking. Share your link, and everything else is on your dashboard when you need it.",
    kind: "success",
    cta: null,
  },
};

// ---------------------------------------------------------------------------
// Derived signals (from real data) + persisted state -> the wizard model.
// ---------------------------------------------------------------------------

export type OnboardingSignals = {
  studioName: string;
  hasSlug: boolean;
  hasService: boolean;
  hasAvailability: boolean;
  // The public /book/<slug> page will actually accept a booking (slug + a
  // visible service + at least one open day). This is stricter than hasSlug and
  // is what makes the "booking page is live" step honest.
  isPubliclyBookable: boolean;
  // Stripe Connect is genuinely ready to charge (charges + payouts + enabled).
  paymentsReady: boolean;
  // '' when there is no slug to address.
  publicBookingUrl: string;
};

// The persisted bits the model needs (subset of StudioOnboarding).
export type OnboardingPersisted = {
  currentStep: string;
  completedSteps: string[];
  skippedSteps: string[];
  dismissedAt: string | null;
  completedAt: string | null;
  celebratedAt: string | null;
};

export type OnboardingStepStatus = "done" | "todo" | "skipped";

export type OnboardingStepState = OnboardingStepDef & {
  status: OnboardingStepStatus;
  // The booking step's cta href is rewritten to the live public URL when known.
  resolvedHref: string | null;
};

export type OnboardingModel = {
  steps: OnboardingStepState[];
  // Resume pointer: the step the wizard should open on. Always a valid key.
  currentStep: OnboardingStepKey;
  doneCount: number;
  totalCount: number;
  // service + availability + booking are all done -> the studio can be booked.
  requiredComplete: boolean;
  // requiredComplete AND the owner has acknowledged the success step (persisted
  // completedAt), i.e. onboarding is finished.
  isComplete: boolean;
  // Fire the one-time celebration: required setup just went green and the
  // celebration hasn't been shown yet.
  shouldCelebrate: boolean;
  dismissed: boolean;
  publicBookingUrl: string;
};

function isDataStepDone(
  key: OnboardingStepKey,
  s: OnboardingSignals,
): boolean {
  switch (key) {
    case "service":
      return s.hasService;
    case "availability":
      return s.hasAvailability;
    case "booking":
      return s.isPubliclyBookable;
    default:
      return false;
  }
}

function stepStatus(
  def: OnboardingStepDef,
  s: OnboardingSignals,
  p: OnboardingPersisted,
): OnboardingStepStatus {
  switch (def.key) {
    case "welcome":
      return p.completedSteps.includes("welcome") ? "done" : "todo";
    case "service":
    case "availability":
    case "booking":
      return isDataStepDone(def.key, s) ? "done" : "todo";
    case "payments":
      if (s.paymentsReady) return "done";
      if (p.skippedSteps.includes("payments")) return "skipped";
      return "todo";
    case "done":
      return p.completedAt ? "done" : "todo";
    default:
      return "todo";
  }
}

function clampStep(candidate: string): OnboardingStepKey | null {
  return (ONBOARDING_STEP_ORDER as string[]).includes(candidate)
    ? (candidate as OnboardingStepKey)
    : null;
}

export function buildOnboardingModel(
  signals: OnboardingSignals,
  persisted: OnboardingPersisted,
): OnboardingModel {
  const steps: OnboardingStepState[] = ONBOARDING_STEP_ORDER.map((key) => {
    const def = ONBOARDING_STEPS[key];
    const status = stepStatus(def, signals, persisted);
    const resolvedHref =
      key === "booking" && signals.publicBookingUrl
        ? signals.publicBookingUrl
        : (def.cta?.href ?? null);
    return { ...def, status, resolvedHref };
  });

  const doneCount = steps.filter((st) => st.status === "done").length;
  const requiredComplete = REQUIRED_STEP_KEYS.every((k) =>
    isDataStepDone(k, signals),
  );
  const isComplete = requiredComplete && !!persisted.completedAt;
  const shouldCelebrate = requiredComplete && !persisted.celebratedAt;

  // Resume pointer. Honour the persisted position ONLY while that step is still
  // actionable ('todo'); otherwise auto-advance to the first open step — so a
  // data step completed on a settings page shows the NEXT step on return (the
  // "automatically continue" behaviour), a skipped step is stepped past, and
  // when nothing is left the success step is shown.
  const persistedStep = clampStep(persisted.currentStep);
  const stepByKey = new Map(steps.map((st) => [st.key, st]));
  const firstTodo = steps.find(
    (st) => st.status === "todo" && st.key !== "done",
  );
  const persistedUsable =
    persistedStep && stepByKey.get(persistedStep)?.status === "todo"
      ? persistedStep
      : null;
  const currentStep: OnboardingStepKey =
    persistedUsable ?? firstTodo?.key ?? "done";

  return {
    steps,
    currentStep,
    doneCount,
    totalCount: ONBOARDING_STEP_ORDER.length,
    requiredComplete,
    isComplete,
    shouldCelebrate,
    dismissed: !!persisted.dismissedAt,
    publicBookingUrl: signals.publicBookingUrl,
  };
}
